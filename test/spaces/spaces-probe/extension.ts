/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Spaces validation probe.
 *
 * Writes `<probeDir>/<workspace>.json` every second with the extension host
 * PID, how often the extension was activated for this workspace, and a tick
 * counter that only advances while this extension host is alive. If a Space
 * switch restarted the extension host, the PID changes, `activationCount`
 * increments and `ticks` restarts from 0.
 *
 * With `SPACES_PROBE_CONTROL=1` in the environment, a control endpoint bound
 * to 127.0.0.1 on a random port (written to the state file) allows scripted
 * validation: run commands, create terminals, dirty editors and modal dialogs.
 */

// Authored as erasable-syntax TypeScript and loaded as CommonJS: `installSpacesProbe.ts`
// strips the types with Node's `module.stripTypeScriptTypes`, so no build step is needed.
import type * as vscodeApi from 'vscode';
import type * as httpApi from 'http';

declare const require: <T>(id: string) => T;
declare const module: { exports: unknown };

const vscode = require<typeof vscodeApi>('vscode');
const fs = require<typeof import('fs')>('fs');
const http = require<typeof httpApi>('http');
const os = require<typeof import('os')>('os');
const path = require<typeof import('path')>('path');

const ACTIVATIONS_KEY = 'spacesProbe.activations';

function activate(context: vscodeApi.ExtensionContext): void {
	const probeDir = process.env['SPACES_PROBE_DIR'] || path.join(os.tmpdir(), 'spaces-probe');
	fs.mkdirSync(probeDir, { recursive: true });

	const folder = vscode.workspace.workspaceFolders?.[0];
	const workspaceName = vscode.workspace.name ?? `empty-${process.pid}`;
	const stateFile = path.join(probeDir, `${workspaceName.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);

	const activationCount = (context.workspaceState.get(ACTIVATIONS_KEY, 0)) + 1;
	context.workspaceState.update(ACTIVATIONS_KEY, activationCount);

	const activatedAt = Date.now();
	let ticks = 0;
	let controlPort: number | undefined;

	fs.appendFileSync(path.join(probeDir, 'activations.log'), `${new Date(activatedAt).toISOString()} activate workspace=${workspaceName} pid=${process.pid} activation=${activationCount}\n`);

	const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1000);
	statusItem.command = 'spacesProbe.showState';
	statusItem.show();
	context.subscriptions.push(statusItem);

	const snapshot = async () => ({
		workspaceName,
		folder: folder?.uri.fsPath,
		pid: process.pid,
		activatedAt,
		activationCount,
		ticks,
		now: Date.now(),
		focused: vscode.window.state.focused,
		controlPort,
		terminals: await Promise.all(vscode.window.terminals.map(async terminal => ({ name: terminal.name, processId: await terminal.processId }))),
		dirtyDocuments: vscode.workspace.textDocuments.filter(document => document.isDirty).map(document => ({ uri: document.uri.toString(), preview: document.getText().slice(0, 40) })),
		gitRepositories: getGitRepositories()
	});

	const timer = setInterval(async () => {
		ticks++;
		statusItem.text = `$(pulse) probe pid ${process.pid} · act #${activationCount} · ${ticks}s`;
		try {
			fs.writeFileSync(stateFile, JSON.stringify(await snapshot(), undefined, '\t'));
		} catch (error) {
			console.error('[spaces-probe] failed to write state', error);
		}
	}, 1000);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });

	context.subscriptions.push(vscode.commands.registerCommand('spacesProbe.showState', async () => {
		const state = await snapshot();
		vscode.window.showInformationMessage(`Spaces probe: ${state.workspaceName} · extension host pid ${state.pid} · activation #${state.activationCount} · alive ${state.ticks}s · ${state.terminals.length} terminal(s)`);
	}));

	if (process.env['SPACES_PROBE_CONTROL'] === '1') {
		const server = http.createServer((request, response) => handleControlRequest(request, response, snapshot));
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			controlPort = typeof address === 'object' && address ? address.port : undefined;
		});
		context.subscriptions.push({ dispose: () => server.close() });
	}
}

interface IGitRepositoryLike {
	readonly rootUri: vscodeApi.Uri;
	readonly state: { readonly workingTreeChanges: readonly unknown[] };
}

function getGitRepositories(): Array<{ root: string; changes: number }> | undefined {
	const git = vscode.extensions.getExtension<{ getAPI(version: 1): { repositories: IGitRepositoryLike[] } }>('vscode.git');
	if (!git?.isActive) {
		return undefined;
	}

	return git.exports.getAPI(1).repositories.map(repository => ({ root: repository.rootUri.fsPath, changes: repository.state.workingTreeChanges.length }));
}

function handleControlRequest(request: httpApi.IncomingMessage, response: httpApi.ServerResponse, snapshot: () => Promise<unknown>): void {
	let body = '';
	request.on('data', chunk => body += chunk);
	request.on('end', async () => {
		try {
			const payload = body ? JSON.parse(body) : {};
			let result: unknown;
			switch (request.url) {
				case '/state':
					result = await snapshot();
					break;
				case '/command': {
					// `{ "$file": "/path" }` arguments are converted to file URIs
					const args = (payload.args ?? []).map((arg: unknown) => {
						const file = typeof arg === 'object' && arg ? (arg as { $file?: unknown }).$file : undefined;
						return typeof file === 'string' ? vscode.Uri.file(file) : arg;
					});
					result = await vscode.commands.executeCommand(payload.id, ...args);
					break;
				}
				case '/terminal': {
					const terminal = vscode.window.createTerminal({ name: payload.name ?? 'probe' });
					terminal.show(true);
					if (payload.text) {
						terminal.sendText(payload.text);
					}
					result = { processId: await terminal.processId };
					break;
				}
				case '/modal': {
					// Not awaited: the dialog stays open until the user answers it
					vscode.window.showWarningMessage(payload.message ?? 'Spaces probe modal', { modal: true }, 'OK');
					result = { shown: true };
					break;
				}
				case '/untitled': {
					const document = await vscode.workspace.openTextDocument({ content: payload.content ?? '' });
					await vscode.window.showTextDocument(document, { preview: false });
					result = { uri: document.uri.toString(), isDirty: document.isDirty };
					break;
				}
				default:
					response.writeHead(404).end();
					return;
			}
			response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result ?? null));
		} catch (error) {
			response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
		}
	});
}

function deactivate(): void { }

module.exports = { activate, deactivate };
