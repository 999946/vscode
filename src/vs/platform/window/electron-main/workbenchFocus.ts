/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorkbenchHost } from './workbenchHost.js';

/**
 * The tiny surface of Electron's `webContents` module this helper needs. Kept
 * structural so the focus logic below can be unit tested without Electron.
 */
export interface IFocusedWebContentsProvider {
	getFocusedWebContents(): { readonly id: number } | null;
}

/**
 * Resolves the workbench host that currently owns keyboard focus.
 *
 * This must go through `webContents.getFocusedWebContents()` rather than
 * `BrowserWindow.getFocusedWindow()`, because Spaces renders workbenches in
 * `WebContentsView`s that have no `BrowserWindow` of their own. A view host's
 * id is its `webContents.id`, and that is also the id the renderer receives as
 * `configuration.windowId`, so comparing those two ids is meaningful for both
 * window-backed and view-backed workbenches.
 */
export function getFocusedWorkbenchHost(hosts: readonly IWorkbenchHost[], focusedContents: { readonly id: number } | null): IWorkbenchHost | undefined {
	if (!focusedContents) {
		return undefined;
	}

	for (const host of hosts) {
		if (matchesHostId(host, focusedContents.id)) {
			return host;
		}
	}

	return undefined;
}

/**
 * Mirrors `getLastFocused()` from `windows.ts` for `IWorkbenchHost`s: picks the
 * host whose focus timestamp is newest. Used to choose the workbench that
 * should surface a themed dialog when none is focused right now (for example
 * right after the user dismissed an OS menu).
 */
export function getLastFocusedWorkbenchHost(hosts: readonly IWorkbenchHost[]): IWorkbenchHost | undefined {
	let lastFocused: IWorkbenchHost | undefined = undefined;
	let maxLastFocusTime = Number.NEGATIVE_INFINITY;

	for (const host of hosts) {
		if (host.lastFocusTime > maxLastFocusTime) {
			maxLastFocusTime = host.lastFocusTime;
			lastFocused = host;
		}
	}

	return lastFocused;
}

/**
 * Decides whether the renderer identified by `rendererWindowId` is the one the
 * user interacted with last, and therefore the one that should show a themed
 * dialog. `undefined` means "no workbench is focused", which callers treat as
 * "the main process has to show a native dialog instead".
 *
 * Edge cases deliberately covered:
 * - A `WebContentsView` host is focused: its id is the focused webContents id.
 * - A regular `CodeWindow` is focused: its id is the `BrowserWindow` id, which
 *   is also the renderer's `windowId`.
 * - Nothing is focused but hosts exist (e.g. the app is in the background, or
 *   the user just used the menu bar): fall back to the last focused host so the
 *   dialog is not silently dropped.
 * - Several Spaces share one frame: only the focused (visible) view host
 *   matches, other views never claim the dialog.
 */
export function shouldShowWorkbenchDialog(rendererWindowId: number, hosts: readonly IWorkbenchHost[], focusedContents: { readonly id: number } | null): boolean {
	const focused = getFocusedWorkbenchHost(hosts, focusedContents);
	if (focused) {
		return focused.id === rendererWindowId;
	}

	const lastFocused = getLastFocusedWorkbenchHost(hosts);
	return !!lastFocused && lastFocused.id === rendererWindowId;
}

/**
 * True when at least one workbench exists, regardless of the container. The
 * main process uses this to decide whether a themed dialog is possible at all:
 * if only Space views exist there is no `CodeWindow`, so counting
 * `BrowserWindow`s would wrongly report "no windows" and show a duplicate
 * native dialog.
 */
export function hasAnyWorkbenchHost(hosts: readonly IWorkbenchHost[]): boolean {
	return hosts.length > 0;
}

function matchesHostId(host: IWorkbenchHost, webContentsId: number): boolean {
	// A `WebContentsView` host id *is* its webContents id. A `CodeWindow` id is
	// the `BrowserWindow` id, so compare through the renderer's own webContents.
	if (host.id === webContentsId) {
		return true;
	}

	return !!host.webContents && host.webContents.id === webContentsId;
}

/**
 * Decides whether the main process must show a native "no updates available"
 * dialog. The themed dialog lives in the workbench, which only exists when at
 * least one workbench renderer is alive; on macOS with no workbench at all
 * (all windows closed, app still in the dock) the main process has to speak up
 * itself.
 *
 * Note this deliberately keys off *workbench hosts* rather than
 * `BrowserWindow`s: Spaces workbenches are `WebContentsView`s, so a window
 * count would be 0 while the user is actively looking at a workbench, which
 * would show a duplicate native dialog on top of the themed one.
 */
export function shouldShowNativeNoUpdateDialog(options: {
	readonly isMacintosh: boolean;
	readonly workbenchHostCount: number;
}): boolean {
	return options.isMacintosh && options.workbenchHostCount === 0;
}
