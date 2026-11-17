/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, ChildProcess } from 'child_process';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { ILogService } from '../../log/common/log.js';
import { IFileService } from '../../files/common/files.js';
import { ISpaceInfo } from '../common/spacesLifecycle.js';
import {
	DEFAULT_SPACE_INFO_SCRIPT, ISpaceScriptDispatchResult, ISpaceScriptEvent, ISpaceScriptFile,
	SPACE_SCRIPT_DISPATCH_TIMEOUT, applyScriptResults, makeSpaceScriptEvent, resolveNodeBinary,
	scriptStderrTail
} from '../common/spacesScripts.js';

/**
 * Hosts Terax-style user scripts in the main process. A directory (default
 * `~/git`) holds `<name>.mjs` scripts; each lifecycle event dispatched by
 * `SpacesViewService` is forwarded to every script over a Node sub-process
 * (JSON-RPC over stdio), then any `space.info.updated` / `spaces.info.updated`
 * results are merged into a per-Space info map that `SpacesSidebarHost`
 * renders as a status/subtitle.
 *
 * The execution model mirrors Terax `plugin/process.rs`:
 * - one `node --input-type=module -e <wrapper>` process per event;
 * - the wrapper lines up on stdin/stdout (a request line -> one result line);
 * - a `?paracode=<ms>` cache-busting query forces a fresh import so edits to
 *   a script apply on the very next event;
 * - a 5s timeout kills a hung script and surfaces its stderr tail.
 *
 * Scripts are intentionally lazy: with the default `~/git` directory they only
 * activate if that directory already exists (nothing is auto-created on the
 * user's home). When the user explicitly configures `spaces.scriptsDir`, the
 * directory is created and a built-in `space-info.mjs` example is seeded once.
 */

export interface ISpaceScriptHost<T extends ISpaceScriptEvent = ISpaceScriptEvent> {
	readonly onDidChangeInfo: Event<void>;
	/** Fires when any script produced an error, so the UI can surface it. */
	readonly onDidDispatchError: Event<string>;
	/** Whether scripts can actually run (directory configured/existing + node found). */
	isAvailable(): boolean;
	/**
	 * Ensures an explicitly-configured scripts directory exists, seeding the
	 * built-in example script once. Lazy: with the implicit `~/git` default
	 * nothing is created.
	 */
	ensureScriptsDirectory(): Promise<void>;
	/** Dispatches one lifecycle event to all scripts (async, never throws). */
	dispatch(kind: ISpaceScriptEvent['type'], buildPayload: () => unknown): Promise<void>;
}

interface IScriptHostOptions {
	logService: ILogService;
	fileService: IFileService;
	/** Resolves the absolute scripts directory; `undefined` disables scripts. */
	resolveScriptsDir(): string | undefined;
	/** True when the user explicitly configured the scripts directory. */
	isExplicitScriptsDir(): boolean;
	/** Delegate for launching the Node sub-process (injectable for tests). */
	spawnScript?(nodeBin: string, scriptPath: string, event: ISpaceScriptEvent): Promise<ISpaceScriptDispatchResult>;
}

export class SpacesScriptHost extends Disposable implements ISpaceScriptHost {

	private readonly logService: ILogService;
	private readonly fileService: IFileService;
	private readonly resolveScriptsDir: () => string | undefined;
	private readonly isExplicitScriptsDir: () => boolean;
	private readonly spawnScriptImpl: (nodeBin: string, scriptPath: string, event: ISpaceScriptEvent) => Promise<ISpaceScriptDispatchResult>;

	private readonly _onDidChangeInfo = this._register(new Emitter<void>());
	readonly onDidChangeInfo = this._onDidChangeInfo.event;

	private readonly _onDidDispatchError = this._register(new Emitter<string>());
	readonly onDidDispatchError = this._onDidDispatchError.event;

	private nodeBinValue: string | undefined;
	private infoBySpace = new Map<string, ISpaceInfo>();
	/** Cached directory availability (unknown | exists | absent) to avoid re-statting. */
	private dirProbed: Promise<'exists' | 'absent'> | undefined;
	private seeded = false;

	constructor(options: IScriptHostOptions) {
		super();
		this.logService = options.logService;
		this.fileService = options.fileService;
		this.resolveScriptsDir = options.resolveScriptsDir;
		this.isExplicitScriptsDir = options.isExplicitScriptsDir;
		this.spawnScriptImpl = options.spawnScript ?? defaultSpawnScript;
	}

	getInfoBySpace(): ReadonlyMap<string, ISpaceInfo> {
		return this.infoBySpace;
	}

	isAvailable(): boolean {
		this.ensureNodeBin();
		return !!this.resolveScriptsDir() && !!this.nodeBinValue;
	}

	private ensureNodeBin(): string | undefined {
		if (this.nodeBinValue === undefined) {
			this.nodeBinValue = resolveNodeBinary() ?? '';
		}
		return this.nodeBinValue || undefined;
	}

	async ensureScriptsDirectory(): Promise<void> {
		// Only an explicitly-configured directory is materialised; the implicit
		// `~/git` default is never auto-created on the user's home.
		if (!this.isExplicitScriptsDir() || this.seeded) {
			return;
		}
		let dir: string | undefined;
		try {
			dir = this.resolveScriptsDir();
		} catch {
			this.logService.error('[spaces:script] could not resolve scripts directory');
			return;
		}
		if (!dir) {
			return;
		}
		try {
			const dirUri = URI.file(dir);
			const stat = await this.fileService.resolve(dirUri).catch(() => undefined);
			if (stat?.isDirectory) {
				this.seeded = true;
				return;
			}
			await this.fileService.createFolder(dirUri);
			const seedUri = URI.file(`${dir}/space-info.mjs`);
			try {
				await this.fileService.createFile(seedUri, VSBuffer.fromString(DEFAULT_SPACE_INFO_SCRIPT));
			} catch (error) {
				this.logService.warn(`[spaces:script] could not seed space-info.mjs: ${String(error)}`);
			}
			this.seeded = true;
			this.logService.info(`[spaces:script] seeded built-in space-info.mjs into '${dir}'`);
		} catch (error) {
			this.logService.error(`[spaces:script] could not prepare scripts directory '${dir}': ${String(error)}`);
		}
	}

	async dispatch(kind: ISpaceScriptEvent['type'], buildPayload: () => unknown): Promise<void> {
		const payload = buildPayload();
		// Terax parity: the built-in example only handles root-backed Spaces.
		// Dispatch on a payload with no root-backed Spaces (or an empty Space)
		// is useless and would touch disk for nothing — skip it.
		const list = (payload as { spaces?: unknown[] } | undefined)?.spaces;
		if (list && list.length === 0) {
			return;
		}
		const single = (payload as { space?: { root?: string } } | undefined)?.space;
		if (single && !single.root) {
			return;
		}
		return this.dispatchRaw(makeSpaceScriptEvent(kind, payload));
	}

	private async dispatchRaw(event: ISpaceScriptEvent): Promise<void> {
		const scriptsDir = this.resolveScriptsDir();
		if (!scriptsDir) {
			return;
		}
		const nodeBin = this.ensureNodeBin();
		if (!nodeBin) {
			this._onDidDispatchError.fire('no Node executable found (scripts disabled)');
			return;
		}

		// Probe the directory once per service lifetime; when absent (e.g. the
		// implicit `~/git` that the user never created) scripts stay dormant.
		if (!this.dirProbed) {
			this.dirProbed = this.probeDirectory(scriptsDir);
		}
		const dirState = await this.dirProbed;
		if (dirState === 'absent') {
			return;
		}

		let scripts: ISpaceScriptFile[];
		try {
			scripts = await this.readScriptEntries(scriptsDir);
		} catch (error) {
			this.logService.warn(`[spaces:script] could not read scripts directory '${scriptsDir}': ${String(error)}`);
			return;
		}
		if (scripts.length === 0) {
			return;
		}

		const results: ISpaceScriptDispatchResult[] = [];
		for (const script of scripts) {
			try {
				const result = await this.spawnScriptImpl(nodeBin, `${scriptsDir}/${script.name}`, event);
				results.push({ ...result, pluginId: script.id });
			} catch (error) {
				this.logService.warn(`[spaces:script] ${script.id} dispatch failed: ${String(error)}`);
				results.push({ pluginId: script.id, result: undefined, error: String(error) });
			}
		}

		const { info, errors } = applyScriptResults(this.infoBySpace, results);
		this.infoBySpace = new Map(info);
		this._onDidChangeInfo.fire();
		for (const error of errors) {
			this.logService.warn(`[spaces:script] ${error}`);
			this._onDidDispatchError.fire(error);
		}
	}

	private async probeDirectory(dir: string): Promise<'exists' | 'absent'> {
		try {
			const stat = await this.fileService.resolve(URI.file(dir));
			return stat?.isDirectory ? 'exists' : 'absent';
		} catch {
			return 'absent';
		}
	}

	private async readScriptEntries(dir: string): Promise<ISpaceScriptFile[]> {
		const stat = await this.fileService.resolve(URI.file(dir));
		if (!stat.isDirectory) {
			return [];
		}
		const { scanScriptDirectory } = await import('../common/spacesScripts.js');
		return scanScriptDirectory((stat.children ?? []).map(child => ({ name: child.name, isDirectory: child.isDirectory })));
	}
}

/**
 * Default Node sub-process runner: spawns `node --input-type=module -e
 * <wrapper>` with the script path, writes one JSON-RPC request line, drains
 * stdout/stderr, and enforces the 5s dispatch timeout.
 */
export async function defaultSpawnScript(nodeBin: string, scriptPath: string, event: ISpaceScriptEvent): Promise<ISpaceScriptDispatchResult> {
	const pluginId = scriptPath.substring(scriptPath.lastIndexOf('/') + 1).replace(/\.mjs$|\.js$|\.cjs$/i, '');
	const wrapper = `
import readline from 'node:readline';
const modulePath = process.argv[1];
const loaded = await import(modulePath + '?paracode=' + Date.now());
const handlers = loaded.default;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
	let request;
	try { request = JSON.parse(line); } catch { continue; }
	try {
		const handler = handlers?.[request.event?.type];
		const result = typeof handler === 'function'
			? await handler(request.event.payload)
			: { type: 'handled' };
		process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
	} catch (error) {
		process.stdout.write(JSON.stringify({ id: request.id, error: String(error?.message ?? error) }) + '\\n');
	}
}
` as string;

	return new Promise<ISpaceScriptDispatchResult>((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(nodeBin, ['--input-type=module', '-e', wrapper, scriptPath], {
				stdio: ['pipe', 'pipe', 'pipe']
			});
		} catch (error) {
			resolve({ pluginId, result: undefined, error: String(error) });
			return;
		}

		let stdout = '';
		let stderr = '';
		let settled = false;

		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				try { child.kill(); } catch { /* already gone */ }
				resolve({ pluginId, result: undefined, error: 'script timed out (no response within 5s)' });
			}
		}, SPACE_SCRIPT_DISPATCH_TIMEOUT);

		child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
		child.stderr?.on('data', (chunk) => { stderr += String(chunk); });

		child.on('error', (error) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({ pluginId, result: undefined, error: String(error) });
			}
		});

		child.on('exit', () => {
			if (settled) {
				return;
			}
			clearTimeout(timer);
			const firstLine = stdout.split(/\r?\n/)[0] ?? '';
			if (!firstLine.trim()) {
				const tail = scriptStderrTail(stderr);
				settled = true;
				resolve({
					pluginId,
					result: undefined,
					error: tail ? `no output from script\n${tail}` : 'script produced no output'
				});
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(firstLine);
			} catch {
				settled = true;
				resolve({ pluginId, result: undefined, error: `script produced no parseable output: ${firstLine.slice(0, 200)}` });
				return;
			}
			const response = parsed as { error?: string; result?: { type: 'handled' } | { type: 'space.info.updated'; spaceId: string; info: ISpaceInfo } | { type: 'spaces.info.updated'; spaces: Record<string, ISpaceInfo> } };
			if (response?.error) {
				const tail = scriptStderrTail(stderr);
				settled = true;
				resolve({ pluginId, result: undefined, error: tail ? `${response.error}\n${tail}` : response.error });
				return;
			}
			settled = true;
			resolve({ pluginId, result: response?.result ?? { type: 'handled' }, error: undefined });
		});

		const writeRequest = () => {
			if (!child.stdin?.writable) {
				return;
			}
			child.stdin.write(JSON.stringify({ id: 1, event }) + '\n', () => {
				try { child.stdin?.end(); } catch { /* ignore */ }
			});
		};
		child.stdin?.on('error', () => { /* ignore broken pipe */ });
		if (child.stdin?.writable) {
			writeRequest();
		} else {
			child.stdin?.once('open', writeRequest);
		}
	});
}
