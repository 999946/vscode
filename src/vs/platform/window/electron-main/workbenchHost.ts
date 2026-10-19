/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Event } from '../../../base/common/event.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { FocusMode } from '../../native/common/native.js';
import { ISingleFolderWorkspaceIdentifier, IWorkspaceIdentifier } from '../../workspace/common/workspace.js';
import { INativeWindowConfiguration } from '../common/window.js';
import { ILoadEvent } from './window.js';

/**
 * A host that can load and run a full workbench renderer, independent of the
 * concrete Electron container that renders it.
 *
 * `CodeWindow` is the original implementation: a full `BrowserWindow`. Spaces
 * use `WebContentsViewWorkbenchHost`, which runs the workbench inside a
 * `WebContentsView` attached to a shared frame `BrowserWindow`. Both are
 * interchangeable from the point of view of services that only need to load,
 * message, focus and hide a workbench.
 *
 * The surface deliberately overlaps with `IBaseWindow`/`ICodeWindow` (which
 * both implement this contract via `CodeWindow`); the members declared here
 * are the ones a view-based host needs that are NOT already declared by
 * `IBaseWindow`/`ICodeWindow`.
 */
export interface IWorkbenchHost extends IDisposable {

	/**
	 * The `WebContents` the workbench renderer runs in. `null` while the host
	 * has not loaded yet or has been destroyed.
	 */
	readonly webContents: Electron.WebContents | null;

	/**
	 * Present the host in its frame, making it the visible workbench.
	 * No unload/load lifecycle runs, matching `BrowserWindow.show()`.
	 */
	show(): void;

	/**
	 * Remove the host from its frame without running any unload/load lifecycle,
	 * matching `BrowserWindow.hide()`.
	 */
	hide(): void;

	/** @returns `true` while the workbench renderer is visible to the user. */
	readonly visible: boolean;

	// The following mirror `IBaseWindow`/`ICodeWindow` so that host-agnostic
	// services (e.g. Spaces) can be written against `IWorkbenchHost` only.
	readonly id: number;
	readonly config: INativeWindowConfiguration | undefined;
	readonly openedWorkspace?: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier;
	readonly isReady: boolean;
	readonly whenClosedOrLoaded: Promise<void>;

	/** Mark the host as ready once the renderer reported it (see `NativeHostMainService.notifyReady`). */
	setReady(): void;

	/** Close the host. For a window-backed host this closes the frame window; for a view host it destroys the renderer. */
	close(): void;

	load(config: INativeWindowConfiguration, options?: { isReload?: boolean }): void;

	send(channel: string, ...args: unknown[]): void;
	sendWhenReady(channel: string, token: CancellationToken, ...args: unknown[]): void;

	focus(options?: { mode: FocusMode }): void;
	getBounds(): Electron.Rectangle;

	/**
	 * Positions the host inside its frame's content area. Implemented by
	 * view-based hosts (e.g. `WebContentsViewWorkbenchHost`); window-based hosts
	 * (`CodeWindow`) own their frame so they have nothing to position.
	 */
	setBounds?(frameContentBounds: Electron.Rectangle): void;
	matches(webContents: Electron.WebContents): boolean;

	readonly onWillLoad: Event<ILoadEvent>;
	readonly onDidSignalReady: Event<void>;
	readonly onDidClose: Event<void>;
	readonly onDidDestroy: Event<void>;
	readonly onWillFocus: Event<void>;
	readonly onDidRequestAttention: Event<void>;
}
