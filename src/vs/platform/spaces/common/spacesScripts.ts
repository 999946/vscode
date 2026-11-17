/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ISpacesSnapshot } from './spaces.js';
import type { SpacesLifecycleEventKind, ISpacesLifecycleSpace, ISpaceInfo } from './spacesLifecycle.js';

/**
 * Terax-style user scripts that customise how Space data (status/subtitle) is
 * produced. A directory (default: `~/git`, overridable via the
 * `spaces.scriptsDir` setting) holds `.mjs` scripts. Each script is a standalone
 * ESM module whose default export is a map of lifecycle event types to async
 * handlers:
 *
 * ```js
 * export default {
 *   "spaces.loaded": async ({ spaces }) => ({
 *     type: "spaces.info.updated",
 *     spaces: Object.fromEntries(spaces.map(s => [s.id, { summary: "Local", status: "online", onlineAt: null, lastTestedAt: null }]))
 *   }),
 * };
 * ```
 *
 * The vocabulary and dispatch timing mirror Terax's plugin bridge 1:1
 * (`app.started`, `spaces.loaded`, `spaces.changed`, `space.activated`,
 * `space.deactivated`, `file.saved`) so scripts written for Terax behave the
 * same way here. How scripts are executed (Node sub-process, JSON-RPC over
 * stdio, timeout) lives in the electron-main `SpacesScriptHost`; this module
 * holds the pure, unit-testable contract.
 */

/** A script file the user placed inside the scripts directory. */
export interface ISpaceScriptFile {
	/** File name (basename) inside the scripts directory. */
	readonly name: string;
	/** Id: basename without extension, used as the Terax plugin id. */
	readonly id: string;
}

/** Terax `SpaceContext`: what a space handler receives. */
export interface ISpaceScriptContext {
	readonly id: string;
	readonly name: string;
	readonly root: string;
}

/** Terax `FileContext`: what a `file.saved` handler receives. */
export interface IFileScriptContext {
	readonly path: string;
	readonly language: string | null;
	readonly byteLength: number | null;
	readonly isNew: boolean;
}

/** Event envelope exactly like Terax's `PluginEvent`. */
export interface ISpaceScriptEvent {
	readonly type: SpacesLifecycleEventKind | 'file.saved';
	readonly version: 1;
	readonly payload: unknown;
	readonly context: {
		readonly eventId: string;
		readonly eventType: SpacesLifecycleEventKind | 'file.saved';
		readonly eventVersion: 1;
		readonly emittedAt: string;
	};
}

/** One script's verdict for an event, mirroring Terax's `PluginEventResult`. */
export type ISpaceScriptResult =
	| { readonly type: 'handled' }
	| { readonly type: 'space.info.updated'; readonly spaceId: string; readonly info: ISpaceInfo }
	| { readonly type: 'spaces.info.updated'; readonly spaces: Record<string, ISpaceInfo> };

/** Outcome of dispatching one event to one script. */
export interface ISpaceScriptDispatchResult {
	readonly pluginId: string;
	readonly result: ISpaceScriptResult | undefined;
	readonly error: string | undefined;
}

/** Terax dispatch timeout: a hung script may not freeze Spaces for longer. */
export const SPACE_SCRIPT_DISPATCH_TIMEOUT = 5000;

/** Only keep the tail of a script's stderr so a noisy script can't balloon. */
export const SCRIPT_STDERR_TAIL_LINES = 12;

let scriptEventSequence = 0;

/** Builds an event envelope, exactly like Terax's `makeEvent`. */
export function makeSpaceScriptEvent(
	type: SpacesLifecycleEventKind | 'file.saved',
	payload: unknown
): ISpaceScriptEvent {
	scriptEventSequence += 1;
	return {
		type,
		version: 1,
		payload,
		context: {
			eventId: `${type}-${scriptEventSequence}-${Date.now().toString(36)}`,
			eventType: type,
			eventVersion: 1,
			emittedAt: new Date().toISOString()
		}
	};
}

/** Terax `toSpaceContext`: the space payload handed to space handlers. */
export function toSpaceScriptContext(space: Pick<ISpacesLifecycleSpace, 'id' | 'name' | 'root'>): ISpaceScriptContext {
	return {
		id: space.id,
		name: space.name,
		root: space.root ?? ''
	};
}

/** Builds the lifecycle payload for a Space-list event, mirroring Terax. */
export function spacesPayload(snapshot: ISpacesSnapshot): { spaces: ISpaceScriptContext[] } {
	return {
		spaces: snapshot.spaces
			.filter(space => !!space.workspace)
			.map(space => toSpaceScriptContext({ id: space.id, name: space.name, root: space.workspace?.uri.fsPath ?? '' }))
	};
}

/** Builds the payload for an event about one Space. */
export function spacePayload(space: Pick<ISpacesLifecycleSpace, 'id' | 'name' | 'root'>): { space: ISpaceScriptContext } {
	return { space: toSpaceScriptContext(space) };
}

/**
 * Merges dispatch results into a per-Space info map (Terax `store.ts`). Only
 * `space.info.updated` / `spaces.info.updated` results contribute; errors are
 * returned verbatim so callers can surface them in the UI.
 */
export function applyScriptResults(
	infoBySpace: ReadonlyMap<string, ISpaceInfo>,
	results: readonly ISpaceScriptDispatchResult[]
): { readonly info: ReadonlyMap<string, ISpaceInfo>; readonly errors: readonly string[] } {
	const info = new Map(infoBySpace);
	const errors: string[] = [];
	for (const item of results) {
		if (item.error) {
			errors.push(`${item.pluginId}: ${item.error}`);
			continue;
		}
		const result = item.result;
		if (result?.type === 'space.info.updated') {
			info.set(result.spaceId, result.info);
		} else if (result?.type === 'spaces.info.updated') {
			for (const [spaceId, entry] of Object.entries(result.spaces)) {
				info.set(spaceId, entry);
			}
		}
	}
	return { info, errors };
}

/**
 * Scans a scripts directory's entries for loadable script files. Terax stores
 * each plugin as a single `.mjs`; we accept `.mjs`, `.cjs` and `.js` so a
 * user's existing helpers can be reused. Files are ordered by id so dispatch
 * order is deterministic.
 */
export function scanScriptDirectory(entries: readonly { name: string; isDirectory: boolean }[]): ISpaceScriptFile[] {
	const regex = /\.(mjs|cjs|js)$/i;
	const out: ISpaceScriptFile[] = [];
	for (const entry of entries) {
		if (entry.isDirectory) {
			continue;
		}
		const match = regex.exec(entry.name);
		if (!match) {
			continue;
		}
		const id = entry.name.slice(0, entry.name.length - match[0].length);
		if (!id || entry.name.startsWith('.')) {
			continue;
		}
		out.push({ id, name: entry.name });
	}
	out.sort((a, b) => a.id.localeCompare(b.id));
	return out;
}

/**
 * The built-in space-info script, seeded once into the scripts directory so
 * the default experience already shows a per-Space status/subtitle. Mirrors
 * Terax's `scripts/plugin/index.mjs` behavior: a Local workspace is
 * `online`; a WSL-backed workspace is surfaced as `unknown` with a `WSL · …`
 * summary.
 */
export const DEFAULT_SPACE_INFO_SCRIPT = `function toSpaceInfo(space) {
	const env = space?.env;
	const isWsl = env?.kind === "wsl";
	return {
		summary: isWsl ? \`WSL · \${env.distro}\` : "Local",
		status: isWsl ? "unknown" : "online",
		onlineAt: null,
		lastTestedAt: null,
	};
}

export default {
	"spaces.loaded": async ({ spaces }) => ({
		type: "spaces.info.updated",
		spaces: Object.fromEntries(
			(Array.isArray(spaces) ? spaces : [])
				.filter((space) => space && typeof space.id === "string")
				.map((space) => [space.id, toSpaceInfo(space)]),
		),
	}),

	"space.activated": async ({ space }) => ({
		type: "space.info.updated",
		spaceId: space.id,
		info: toSpaceInfo(space),
	}),
};
`;

/**
 * Human readable tail of a script's stderr so a failing script surfaces *why*
 * it failed instead of leaving a blank UI.
 */
export function scriptStderrTail(stderr: string): string {
	const trimmed = (stderr ?? '').trim();
	if (!trimmed) {
		return '';
	}
	const lines = trimmed.split(/\r?\n/);
	if (lines.length <= SCRIPT_STDERR_TAIL_LINES) {
		return trimmed;
	}
	return lines.slice(-SCRIPT_STDERR_TAIL_LINES).join('\n');
}

/**
 * Locates a usable `node` binary, mirroring Terax's `node_bin()` resolution
 * order: explicit `PARACODE_NODE` override → the user's login-shell PATH
 * (homebrew/mise/volta/nvm shims) → version-manager install roots under
 * `$HOME` (fnm/volta), newest nvm version. A GUI-launched app often lacks node
 * on PATH, so the version-manager roots keep scripts working anyway.
 *
 * `splitPath` and `listSubdirs` are injectable so the resolution order itself
 * is unit-testable without a real filesystem; the default implementations use
 * lazy `node:fs` (this file is otherwise import-pure).
 */
export function resolveNodeBinary(
	env: NodeJS.ProcessEnv = process.env,
	isExecutable: (p: string) => boolean = defaultIsExecutable
): string | undefined {
	const override = env.PARACODE_NODE?.trim();
	if (override && (override === 'node' || isExecutable(override))) {
		return override;
	}

	const onPath = resolveFromPath(env.PATH, isExecutable);
	if (onPath) {
		return onPath;
	}

	const home = env.HOME ?? env.USERPROFILE;
	if (home && isExecutable) {
		const roots = versionManagerCandidates(home, listNvmVersions, isExecutable);
		for (const candidate of roots) {
			if (isExecutable(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

/** Whether a path points to a real file (best-effort stat). */
function defaultIsExecutable(_p: string): boolean {
	const fs = nodeFs();
	if (!fs || typeof fs.statSync !== 'function') {
		return false;
	}
	try {
		return fs.statSync(_p).isFile();
	} catch {
		return false;
	}
}

/**
 * Synchronously resolves `node:fs` in whatever module environment runs us:
 * ESM can use `process.getBuiltinModule` (Node 20.16+), CJS/electron-main can
 * use the global `require`. Renderer / sandboxed contexts return `undefined`
 * so resolution fails closed without a hard crash. This keeps the module
 * import-pure (no top-level `node:fs` import that a browser would choke on).
 */
function nodeFs(): (typeof import('node:fs')) | undefined {
	const g = globalThis as { process?: { getBuiltinModule?(name: string): unknown }; require?: ((name: string) => unknown) };
	try {
		if (typeof g.process?.getBuiltinModule === 'function') {
			const mod = g.process.getBuiltinModule('node:fs');
			if (mod) {
				return mod as typeof import('node:fs');
			}
		}
	} catch {
		// fall through to require
	}
	try {
		if (typeof g.require === 'function') {
			return g.require('node:fs') as typeof import('node:fs');
		}
	} catch {
		// no require — renderer/browser
	}
	return undefined;
}

function resolveFromPath(pathValue: string | undefined, isExecutable: (p: string) => boolean): string | undefined {
	if (!pathValue) {
		return undefined;
	}
	const parts = pathValue.split(/[:;]/);
	for (const raw of parts) {
		const dir = raw.replace(/[\\/]+$/, '');
		const candidate = dir ? `${dir}/node` : 'node';
		if (isExecutable(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

interface IListVersions {
	(versionRoot: string): string[];
}

/** fnm/volta/nvm roots, in Terax's precedence order. */
export function versionManagerCandidates(
	home: string,
	listVersions: IListVersions = listNvmVersions,
	isExecutable: (p: string) => boolean = defaultIsExecutable
): string[] {
	const roots: string[] = [];
	// fnm alias, then fnm store layout (newer fnm installs to node-versions).
	roots.push(`${home}/.local/share/fnm/aliases/default/bin/node`);
	roots.push(`${home}/.fnm/aliases/default/bin/node`);
	roots.push(`${home}/.volta/bin/node`);
	try {
		const storeRoot = `${home}/.local/share/fnm/node-versions`;
		const versions = listVersions(storeRoot);
		const newest = [...versions].sort()[versions.length - 1];
		if (newest && isExecutable(`${storeRoot}/${newest}/installation/bin/node`)) {
			roots.push(`${storeRoot}/${newest}/installation/bin/node`);
		}
	} catch {
		// fnm store absent — fine.
	}
	// nvm: one dir per version under ~/.nvm/versions/node; prefer the newest.
	const nvmRoot = `${home}/.nvm/versions/node`;
	try {
		const versions = listVersions(nvmRoot);
		// Sort ascending lexically so the last entry is the newest (v10 < v9).
		const newest = versions.sort()[versions.length - 1];
		if (newest && isExecutable(`${nvmRoot}/${newest}/bin/node`)) {
			roots.push(`${nvmRoot}/${newest}/bin/node`);
		}
	} catch {
		// nvm absent — fine.
	}
	return roots;
}

/** Default nvm version reader (lazy fs), empty when fs is unavailable. */
function listNvmVersions(root: string): string[] {
	const fs = nodeFs();
	if (!fs || typeof fs.readdirSync !== 'function') {
		return [];
	}
	try {
		return fs.readdirSync(root).filter(name => name.startsWith('v'));
	} catch {
		return [];
	}
}

