/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Scripted lifecycle validation for the experimental Spaces feature.
//
// Prerequisites (see docs/spaces-mvp-validation.md):
// - Code OSS running with `workbench.experimental.spaces.enabled: true`, folder A opened,
//   `--inspect=<mainInspectPort>` and the environment variables
//   `SPACES_PROBE_DIR=<probeDir>` and `SPACES_PROBE_CONTROL=1`
// - the probe extension installed (node test/spaces/installSpacesProbe.ts <extensionsDir>)
//
// Usage: node test/spaces/validateSpaces.ts <probeDir> <mainInspectPort> <folderA> <folderB> [backgroundSeconds]

import * as fs from 'fs';
import * as path from 'path';

interface IProbeState {
	readonly workspaceName: string;
	readonly pid: number;
	readonly activationCount: number;
	readonly ticks: number;
	readonly now: number;
	readonly controlPort?: number;
	readonly terminals: Array<{ name: string; processId?: number }>;
	readonly dirtyDocuments: Array<{ uri: string; preview: string }>;
	readonly gitRepositories?: Array<{ root: string; changes: number }>;
}

interface IMainWindow {
	readonly title: string;
	readonly visible: boolean;
	readonly bounds: { x: number; y: number; width: number; height: number };
	/** aria-label of the Spaces title bar entry, e.g. `Space: project-a, 1 Space needs attention` */
	readonly titleBarLabel: string;
	/** `false` for auxiliary windows (editors moved into a new window) */
	readonly workbench: boolean;
}

const [probeDir, mainInspectPortArg, folderA, folderB, backgroundSecondsArg] = process.argv.slice(2);
if (!probeDir || !mainInspectPortArg || !folderA || !folderB) {
	console.error('Usage: node test/spaces/validateSpaces.ts <probeDir> <mainInspectPort> <folderA> <folderB> [backgroundSeconds]');
	process.exit(2);
}

const mainInspectPort = Number(mainInspectPortArg);
const backgroundSeconds = Number(backgroundSecondsArg ?? 20);
const nameA = path.basename(folderA);
const nameB = path.basename(folderB);

const results: Array<{ check: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail: unknown): void {
	results.push({ check: name, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function readState(workspaceName: string): IProbeState | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(probeDir, `${workspaceName}.json`), 'utf8'));
	} catch {
		return undefined;
	}
}

async function waitFor<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 60000): Promise<T> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = await fn();
		if (value) {
			return value;
		}
		await sleep(500);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

async function control(state: IProbeState, route: string, body: unknown): Promise<unknown> {
	const response = await fetch(`http://127.0.0.1:${state.controlPort}${route}`, { method: 'POST', body: JSON.stringify(body) });
	return response.json();
}

function isAlive(pid: number | undefined): boolean {
	if (!pid) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Evaluates an async function body in the main process (`electron` is in scope) and returns its string result. */
async function evaluateInMain(body: string): Promise<string> {
	const [target]: Array<{ webSocketDebuggerUrl: string }> = await (await fetch(`http://127.0.0.1:${mainInspectPort}/json/list`)).json();
	const expression = `(async () => {
		const electron = process.getBuiltinModule('module').createRequire(process.cwd() + '/')('electron');
		${body}
	})()`;

	return new Promise<string>((resolve, reject) => {
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
		socket.onmessage = event => {
			const message = JSON.parse(String(event.data));
			if (message.id === 1) {
				socket.close();
				resolve(message.result.result?.value);
			}
		};
		socket.onerror = () => reject(new Error('Main process inspector connection failed'));
	});
}

// Window visibility is read from the main process: on macOS a hidden window's
// renderer keeps reporting `document.visibilityState === 'visible'`.
async function getWindows(): Promise<IMainWindow[]> {
	return JSON.parse(await evaluateInMain(`return JSON.stringify(await Promise.all(electron.BrowserWindow.getAllWindows().map(async win => ({
		title: win.getTitle(),
		visible: win.isVisible(),
		bounds: win.getBounds(),
		titleBarLabel: await win.webContents.executeJavaScript("document.querySelector('.spaces-titlebar-widget')?.getAttribute('aria-label') ?? ''"),
		workbench: /workbench(-dev)?\\.html/.test(win.webContents.getURL())
	}))));`));
}

async function visibleWindowTitles(): Promise<string[]> {
	return (await getWindows()).filter(win => win.workbench && win.visible).map(win => win.title);
}

async function evalInWindow(titleIncludes: string, expression: string): Promise<string> {
	return evaluateInMain(`
		const win = electron.BrowserWindow.getAllWindows().find(win => /workbench(-dev)?\\.html/.test(win.webContents.getURL()) && win.getTitle().includes(${JSON.stringify(titleIncludes)}));
		return win ? String(await win.webContents.executeJavaScript(${JSON.stringify(expression)})) : '';`);
}

function maxGapSeconds(logFile: string, fromSeconds: number): { lines: number; maxGap: number } {
	const stamps = fs.readFileSync(logFile, 'utf8').split('\n').map(Number).filter(stamp => stamp >= fromSeconds);
	let maxGap = 0;
	for (let i = 1; i < stamps.length; i++) {
		maxGap = Math.max(maxGap, stamps[i] - stamps[i - 1]);
	}
	return { lines: stamps.length, maxGap };
}

async function main(): Promise<void> {
	const termLogA = path.join(probeDir, 'terminal-a.log');
	const termLogB = path.join(probeDir, 'terminal-b.log');
	fs.rmSync(termLogA, { force: true });
	fs.rmSync(termLogB, { force: true });

	// --- Space A: terminal loop + unsaved editor
	const a0 = await waitFor(`probe state of ${nameA}`, () => { const state = readState(nameA); return state?.controlPort ? state : undefined; });
	const terminalA = await control(a0, '/terminal', { name: 'loop-a', text: `while true; do date +%s >> '${termLogA}'; sleep 1; done` }) as { processId: number };
	await control(a0, '/untitled', { content: 'unsaved in A' });

	// --- Create Space B through the Spaces command (no dialog)
	await control(a0, '/command', { id: 'workbench.action.spaces.openFolderAsNewSpace', args: [{ $file: folderB }] });
	const b0 = await waitFor(`probe state of ${nameB}`, () => { const state = readState(nameB); return state?.controlPort ? state : undefined; });
	const terminalB = await control(b0, '/terminal', { name: 'loop-b', text: `while true; do date +%s >> '${termLogB}'; sleep 1; done` }) as { processId: number };
	await control(b0, '/untitled', { content: 'unsaved in B' });

	check('separate extension hosts per Space', a0.pid !== b0.pid, { [nameA]: a0.pid, [nameB]: b0.pid });

	await sleep(2000);
	const visibleWithB = await visibleWindowTitles();
	check('only Space B visible after creating it', visibleWithB.length === 1 && visibleWithB[0].includes(nameB), visibleWithB);
	const frames = (await getWindows()).filter(win => win.workbench).map(win => JSON.stringify(win.bounds));
	check('Spaces share one frame', frames.length === 2 && frames[0] === frames[1], frames);

	// --- Space A runs in the background
	const backgroundStart = Math.floor(Date.now() / 1000);
	const a1 = readState(nameA)!;
	console.log(`… Space ${nameB} active, waiting ${backgroundSeconds}s with ${nameA} in background`);
	await sleep(backgroundSeconds * 1000);
	const a2 = readState(nameA)!;

	check('inactive Space extension host kept same PID', a2.pid === a0.pid && isAlive(a2.pid), { before: a0.pid, after: a2.pid, alive: isAlive(a2.pid) });
	check('inactive Space extension not re-activated', a2.activationCount === a0.activationCount, { before: a0.activationCount, after: a2.activationCount });
	check('inactive Space extension kept ticking', a2.ticks - a1.ticks >= backgroundSeconds - 3, { ticksDuringBackground: a2.ticks - a1.ticks, expected: backgroundSeconds });
	check('inactive Space terminal process alive', isAlive(terminalA.processId), { pid: terminalA.processId });
	const gapA = maxGapSeconds(termLogA, backgroundStart);
	check('inactive Space terminal output continuous', gapA.lines >= backgroundSeconds - 3 && gapA.maxGap <= 3, gapA);

	// --- Switch back to A
	await control(b0, '/command', { id: 'workbench.action.spaces.switchSpace', args: [nameA] });
	await sleep(2000);
	const visibleWithA = await visibleWindowTitles();
	check('only Space A visible after switching back', visibleWithA.length === 1 && visibleWithA[0].includes(nameA), visibleWithA);

	await sleep(backgroundSeconds * 1000 / 2);
	const a3 = readState(nameA)!;
	const b3 = readState(nameB)!;
	check('Space A extension host unchanged after switch back', a3.pid === a0.pid && a3.activationCount === a0.activationCount, { pid: a3.pid, activationCount: a3.activationCount });
	check('Space B extension host unchanged while inactive', b3.pid === b0.pid && b3.activationCount === b0.activationCount && isAlive(b3.pid), { pid: b3.pid, activationCount: b3.activationCount });
	check('Space B terminal process alive while inactive', isAlive(terminalB.processId), { pid: terminalB.processId });
	const previewsA = a3.dirtyDocuments.map(document => document.preview);
	const previewsB = b3.dirtyDocuments.map(document => document.preview);
	check('unsaved editors scoped per Space', previewsA.includes('unsaved in A') && !previewsA.includes('unsaved in B') && previewsB.includes('unsaved in B') && !previewsB.includes('unsaved in A'), { [nameA]: previewsA, [nameB]: previewsB });
	const rootsA = (a3.gitRepositories ?? []).map(repository => path.basename(repository.root));
	const rootsB = (b3.gitRepositories ?? []).map(repository => path.basename(repository.root));
	check('git repositories scoped per Space', rootsA.length === 1 && rootsA[0] === nameA && rootsB.length === 1 && rootsB[0] === nameB, { [nameA]: a3.gitRepositories, [nameB]: b3.gitRepositories });

	// --- The Spaces picker stays correct when Spaces change while it is open
	await control(a0, '/command', { id: 'workbench.action.spaces.listSpaces', args: [] });
	await sleep(1000);
	const initiallyFocusedRow = await evalInWindow(nameA, `document.querySelector('.quick-input-widget .monaco-list-row.focused')?.textContent ?? ''`);
	check('picker initially selects the current Space', initiallyFocusedRow.includes(nameA) && !initiallyFocusedRow.includes(nameB), initiallyFocusedRow.slice(0, 120));
	await control(b0, '/command', { id: 'workbench.action.spaces.renameCurrentSpace', args: ['Renamed B'] });
	await sleep(1500);
	const pickerRows = await evalInWindow(nameA, `Array.from(document.querySelectorAll('.quick-input-widget .monaco-list-row')).map(row => row.textContent).join(' | ')`);
	check('open picker updates correctly on Spaces change', pickerRows.includes('Renamed B') && pickerRows.includes(folderB) && !pickerRows.includes('undefined'), pickerRows.slice(0, 200));
	await control(b0, '/command', { id: 'workbench.action.spaces.renameCurrentSpace', args: [''] });
	await evalInWindow(nameA, `document.querySelector('.quick-input-widget input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }))`);

	// --- Auxiliary windows (editor moved into a new window) follow the visibility of their Space
	await control(a0, '/command', { id: 'workbench.action.moveEditorToNewWindow', args: [] });
	await sleep(3000);
	const auxiliaryVisibleInA = (await getWindows()).filter(win => !win.workbench && win.visible).length;

	// --- Opening Space A's folder from Space B (e.g. a project manager extension) reveals Space A instead of a new window
	await control(b0, '/command', { id: 'workbench.action.spaces.switchSpace', args: [nameB] });
	await sleep(1000);
	const auxiliaryVisibleInB = (await getWindows()).filter(win => !win.workbench && win.visible).length;
	check('auxiliary window of hidden Space is hidden', auxiliaryVisibleInA === 1 && auxiliaryVisibleInB === 0, { whileActive: auxiliaryVisibleInA, whileHidden: auxiliaryVisibleInB });

	// --- A modal dialog in hidden Space A marks it as needing attention in Space B's UI.
	// Requires `window.dialogStyle: custom` (set by launch-validation.sh): a native
	// dialog sheet makes macOS show the hidden window, which switches Spaces instead.
	await control(a0, '/modal', { message: 'Spaces validation: attention marker' });
	await sleep(2000);
	const windowsWithModal = await getWindows();
	const spaceBWindow = windowsWithModal.find(win => win.workbench && win.title.includes(nameB));
	const spaceAWindow = windowsWithModal.find(win => win.workbench && win.title.includes(nameA));
	check('modal in hidden Space marks it as needing attention', !!spaceBWindow?.visible && spaceAWindow?.visible === false && /needs attention/.test(spaceBWindow.titleBarLabel), { visible: windowsWithModal.filter(win => win.visible).map(win => win.title), titleBar: spaceBWindow?.titleBarLabel });

	await control(b0, '/command', { id: 'vscode.openFolder', args: [{ $file: folderA }, { forceNewWindow: true }] });
	await sleep(2000);
	const windowsAfterReopen = (await getWindows()).filter(win => win.workbench);
	const visibleAfterReopen = windowsAfterReopen.filter(win => win.visible).map(win => win.title);
	check('opening an existing Space folder switches to that Space', windowsAfterReopen.length === 2 && visibleAfterReopen.length === 1 && visibleAfterReopen[0].includes(nameA) && readState(nameA)!.pid === a0.pid, { windows: windowsAfterReopen.length, visible: visibleAfterReopen });
	const auxiliaryVisibleAgain = (await getWindows()).filter(win => !win.workbench && win.visible).length;
	check('auxiliary window shown again with its Space', auxiliaryVisibleAgain === 1, { visibleAuxiliaryWindows: auxiliaryVisibleAgain });
	const reopenedA = windowsAfterReopen.find(win => win.visible);
	check('attention marker cleared when the Space becomes active', !!reopenedA && !/needs attention/.test(reopenedA.titleBarLabel), { titleBar: reopenedA?.titleBarLabel });

	// --- Close Space B (discard its unsaved editor first so no prompt blocks automation)
	await control(b0, '/command', { id: 'workbench.action.spaces.switchSpace', args: [nameB] });
	await sleep(1000);
	await control(b0, '/command', { id: 'workbench.action.revertAndCloseActiveEditor', args: [] });
	control(b0, '/command', { id: 'workbench.action.spaces.closeCurrentSpace', args: [] }).catch(() => { /* extension host of B goes away */ });

	const closed = await waitFor('Space B extension host exit', () => !isAlive(b0.pid) && !isAlive(terminalB.processId), 30000).catch(() => false);
	check('closing Space B stops its extension host and terminal', closed === true, { extHostAlive: isAlive(b0.pid), terminalAlive: isAlive(terminalB.processId) });

	await sleep(2000);
	const a4 = readState(nameA)!;
	const visibleAfterClose = await visibleWindowTitles();
	check('Space A shown and untouched after closing B', visibleAfterClose.length === 1 && visibleAfterClose[0].includes(nameA) && a4.pid === a0.pid && isAlive(terminalA.processId), { visible: visibleAfterClose, pid: a4.pid, terminalAlive: isAlive(terminalA.processId) });

	// --- Renderer crash of a Space followed by "Reopen" keeps the replacement window in the Space
	await control(a0, '/command', { id: 'workbench.action.spaces.openFolderAsNewSpace', args: [{ $file: folderB }] });
	const b5 = await waitFor(`new probe state of ${nameB}`, () => { const state = readState(nameB); return state?.controlPort && state.pid !== b0.pid ? state : undefined; });
	await sleep(2000);
	await evaluateInMain(`
		electron.dialog.showMessageBox = async () => ({ response: 0 /* Reopen */, checkboxChecked: false });
		electron.BrowserWindow.getAllWindows().find(win => win.isVisible() && win.getTitle().includes(${JSON.stringify(nameB)}))?.webContents.forcefullyCrashRenderer();
		return 'crashed';`);
	await waitFor(`reopened ${nameB}`, () => { const state = readState(nameB); return state?.controlPort && state.pid !== b5.pid ? state : undefined; });
	await sleep(3000);
	const windowsAfterReopen2 = (await getWindows()).filter(win => win.workbench);
	const visibleAfterCrash = windowsAfterReopen2.filter(win => win.visible);
	check('crash and Reopen keep the Space and its single visible frame', visibleAfterCrash.length === 1 && visibleAfterCrash[0].title.includes(nameB) && /^Space: /.test(visibleAfterCrash[0].titleBarLabel) && windowsAfterReopen2.length === 2, { visible: visibleAfterCrash.map(win => [win.title, win.titleBarLabel]), windows: windowsAfterReopen2.length });

	const failed = results.filter(result => !result.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
	process.exit(failed.length ? 1 : 0);
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
