/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IWorkbenchHost } from '../../electron-main/workbenchHost.js';
import { getFocusedWorkbenchHost, getLastFocusedWorkbenchHost, hasAnyWorkbenchHost, shouldShowNativeNoUpdateDialog, shouldShowWorkbenchDialog } from '../../electron-main/workbenchFocus.js';

/**
 * Minimal `IWorkbenchHost` stand-in. Only the members the focus helpers read are
 * meaningful; everything else throws, so a future refactor that starts relying
 * on more of the surface fails loudly here instead of silently changing
 * behaviour.
 */
function makeHost(id: number, options?: { lastFocusTime?: number; webContentsId?: number; webContents?: null }): IWorkbenchHost {
	const webContentsId = options?.webContentsId ?? id;
	return {
		id,
		lastFocusTime: options?.lastFocusTime ?? 0,
		webContents: options?.webContents === null ? null : { id: webContentsId } as unknown as Electron.WebContents,
		visible: true,
		config: undefined,
		openedWorkspace: undefined,
		isReady: true,
		whenClosedOrLoaded: Promise.resolve(),
		show() { },
		hide() { },
		setReady() { },
		close() { },
		load() { },
		send() { },
		sendWhenReady() { },
		focus() { },
		getBounds() { return { x: 0, y: 0, width: 0, height: 0 }; },
		matches() { return false; },
		get onWillLoad() { throw new Error('unused'); },
		get onDidSignalReady() { throw new Error('unused'); },
		get onDidClose() { throw new Error('unused'); },
		get onDidDestroy() { throw new Error('unused'); },
		get onWillFocus() { throw new Error('unused'); },
		get onDidRequestAttention() { throw new Error('unused'); },
		dispose() { },
	} as unknown as IWorkbenchHost;
}

suite('WorkbenchFocus', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('getFocusedWorkbenchHost', () => {

		test('returns undefined when no webContents is focused', () => {
			assert.strictEqual(getFocusedWorkbenchHost([makeHost(1)], null), undefined);
		});

		test('returns undefined when there are no hosts', () => {
			assert.strictEqual(getFocusedWorkbenchHost([], { id: 7 }), undefined);
		});

		test('matches a Spaces view host by its id (equal to its webContents id)', () => {
			const spacesHost = makeHost(6);
			assert.strictEqual(getFocusedWorkbenchHost([spacesHost], { id: 6 }), spacesHost);
		});

		test('matches a CodeWindow host whose BrowserWindow id differs from its webContents id', () => {
			const codeWindowHost = makeHost(2, { webContentsId: 9 });
			assert.strictEqual(getFocusedWorkbenchHost([codeWindowHost], { id: 9 }), codeWindowHost);
		});

		test('picks the focused host out of several Spaces sharing one frame', () => {
			const inactive = makeHost(5);
			const active = makeHost(6);
			assert.strictEqual(getFocusedWorkbenchHost([inactive, active], { id: 6 }), active);
		});

		test('does not match a host that is neither id nor webContents id', () => {
			const host = makeHost(3, { webContentsId: 11 });
			assert.strictEqual(getFocusedWorkbenchHost([host], { id: 12 }), undefined);
		});

		test('still matches by host id when webContents is null', () => {
			const host = makeHost(4, { webContents: null });
			assert.strictEqual(getFocusedWorkbenchHost([host], { id: 4 }), host);
		});
	});

	suite('getLastFocusedWorkbenchHost', () => {

		test('returns undefined for an empty list', () => {
			assert.strictEqual(getLastFocusedWorkbenchHost([]), undefined);
		});

		test('returns the single host', () => {
			const host = makeHost(1, { lastFocusTime: 100 });
			assert.strictEqual(getLastFocusedWorkbenchHost([host]), host);
		});

		test('returns the host with the newest focus timestamp', () => {
			const older = makeHost(1, { lastFocusTime: 100 });
			const newer = makeHost(2, { lastFocusTime: 500 });
			const newest = makeHost(3, { lastFocusTime: 900 });
			assert.strictEqual(getLastFocusedWorkbenchHost([newer, older, newest]), newest);
		});

		test('breaks ties by keeping the first host seen', () => {
			const first = makeHost(1, { lastFocusTime: 100 });
			const second = makeHost(2, { lastFocusTime: 100 });
			assert.strictEqual(getLastFocusedWorkbenchHost([first, second]), first);
		});

		test('prefers a focused host over a never-focused one', () => {
			const neverFocused = makeHost(1, { lastFocusTime: 0 });
			const focused = makeHost(2, { lastFocusTime: 1 });
			assert.strictEqual(getLastFocusedWorkbenchHost([neverFocused, focused]), focused);
		});

		test('returns a lone never-focused host rather than undefined', () => {
			const neverFocused = makeHost(1, { lastFocusTime: 0 });
			assert.strictEqual(getLastFocusedWorkbenchHost([neverFocused]), neverFocused);
		});
	});

	suite('shouldShowWorkbenchDialog', () => {

		test('shows in the focused Spaces workbench', () => {
			assert.strictEqual(shouldShowWorkbenchDialog(6, [makeHost(6)], { id: 6 }), true);
		});

		test('does not show in a workbench that lacks focus while another is focused', () => {
			const active = makeHost(6);
			const inactive = makeHost(5);
			assert.strictEqual(shouldShowWorkbenchDialog(5, [active, inactive], { id: 6 }), false);
		});

		test('falls back to the last focused workbench when nothing is focused', () => {
			// Regression guard: dismissing an OS menu can transiently report no
			// focused webContents. Dropping the dialog in that window is exactly the
			// "Check for Updates does nothing" bug.
			const oldHost = makeHost(1, { lastFocusTime: 100 });
			const lastHost = makeHost(2, { lastFocusTime: 900 });
			assert.strictEqual(shouldShowWorkbenchDialog(2, [oldHost, lastHost], null), true);
			assert.strictEqual(shouldShowWorkbenchDialog(1, [oldHost, lastHost], null), false);
		});

		test('does not show when there are no workbenches at all', () => {
			assert.strictEqual(shouldShowWorkbenchDialog(1, [], null), false);
		});

		test('does not show for an unrelated renderer id', () => {
			assert.strictEqual(shouldShowWorkbenchDialog(99, [makeHost(2)], { id: 2 }), false);
		});
	});

	suite('hasAnyWorkbenchHost', () => {

		test('is false without hosts', () => {
			assert.strictEqual(hasAnyWorkbenchHost([]), false);
		});

		test('is true with a Spaces view host', () => {
			assert.strictEqual(hasAnyWorkbenchHost([makeHost(6)]), true);
		});
	});

	suite('shouldShowNativeNoUpdateDialog', () => {

		test('shows natively on macOS when no workbench is open', () => {
			assert.strictEqual(shouldShowNativeNoUpdateDialog({ isMacintosh: true, workbenchHostCount: 0 }), true);
		});

		test('does not show natively while a Spaces workbench is open', () => {
			// Regression guard: Spaces workbenches are WebContentsViews, so a
			// BrowserWindow count would be 0 and would produce a duplicate dialog.
			assert.strictEqual(shouldShowNativeNoUpdateDialog({ isMacintosh: true, workbenchHostCount: 1 }), false);
		});

		test('does not show natively with several workbenches', () => {
			assert.strictEqual(shouldShowNativeNoUpdateDialog({ isMacintosh: true, workbenchHostCount: 3 }), false);
		});

		test('never shows natively off macOS', () => {
			assert.strictEqual(shouldShowNativeNoUpdateDialog({ isMacintosh: false, workbenchHostCount: 0 }), false);
		});
	});
});
