/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { UriComponents } from '../../../base/common/uri.js';

/**
 * IPC contract between the shared Spaces sidebar view (a small standalone
 * `WebContentsView` inside the frame window) and the main process
 * (`SpacesSidebarHost`). The sidebar is deliberately a plain DOM page, so the
 * main process resolves and serializes everything it needs to render — it
 * never has to build vscode URIs or reach into workbench services itself.
 *
 * The surface mirrors the Terax spaces panel: a foldable/pinnable space list
 * with per-space tab lists that can be persisted and restored. Sidebar panel
 * chrome state (collapsed/pinned/width) is the sidebar's own concern and is
 * kept in the sidebar renderer's `localStorage`, exactly like Terax.
 */

/** The channel the sidebar uses for request/response RPC. */
export const SPACES_SIDEBAR_CHANNEL = 'vscode:spacesSidebar';

/** The channel the main process uses to push Space-change events to the sidebar. */
export const SPACES_SIDEBAR_CHANGED_CHANNEL = 'vscode:spacesSidebarChanged';

/** User-facing configuration that drives the sidebar, mirroring Terax preferences. */
export interface ISpacesSidebarSettings {
	/**
	 * Root folder whose first-level sub-folders each become a Space.
	 * `null` means folders are not auto-tracked (Terax `spacesRoot`).
	 */
	readonly spacesRoot: string | null;
	/** Show each Space's tab list in the panel (Terax `showSpaceTabs`). */
	readonly showSpaceTabs: boolean;
	/** Use the Space name's first letter as its avatar (Terax `showSpaceInitials`). */
	readonly showSpaceInitials: boolean;
}

/** A mutable setting the sidebar can write back to the main process. */
export type SpacesSidebarSettingKey = 'spacesRoot' | 'showSpaceTabs' | 'showSpaceInitials';

/** A serializable, restored tab shown inside an expanded Space row. */
export interface ISpacesSidebarTab {
	readonly id: string;
	readonly kind: 'editor' | 'terminal' | 'preview';
	/** Primary label (file name / terminal title). */
	readonly label: string;
	/** Secondary detail line (parent directory / cwd tail). */
	readonly detail: string | undefined;
	readonly active: boolean;
}

export interface ISpacesSidebarRpcRequest {
	readonly method: SpacesSidebarRpcMethod;
	readonly args: unknown[];
}

export type SpacesSidebarRpcMethod =
	| 'getSpaces'
	| 'getSettings'
	| 'setSetting'
	| 'createEmptySpace'
	| 'createSpace'
	| 'openFolderAsSpace'
	| 'switchToSpace'
	| 'closeSpace'
	| 'deleteSpace'
	| 'renameSpace'
	| 'getSpaceTabs'
	| 'newTabInSpace'
	| 'closeTab'
	| 'openSettings';

/** A fully serializable representation of a Space for the sidebar UI. */
export interface ISpacesSidebarSpace {
	readonly id: string;
	readonly name: string;
	/** User-facing label of the workspace/folder, or `undefined` for an empty Space. */
	readonly workspaceLabel: string | undefined;
	readonly workspaceUri: UriComponents | undefined;
	readonly state: 'active' | 'inactive';
	readonly needsAttention: boolean;
	readonly isCurrent: boolean;
	/** Number of restored tabs of this Space (shown as a count badge). */
	readonly tabCount: number;
}

export interface ISpacesSidebarData {
	readonly spaces: ISpacesSidebarSpace[];
}
