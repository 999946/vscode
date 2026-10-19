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
 */

/** The channel the sidebar uses for request/response RPC. */
export const SPACES_SIDEBAR_CHANNEL = 'vscode:spacesSidebar';

/** The channel the main process uses to push Space-change events to the sidebar. */
export const SPACES_SIDEBAR_CHANGED_CHANNEL = 'vscode:spacesSidebarChanged';

export interface ISpacesSidebarRpcRequest {
	readonly method: SpacesSidebarRpcMethod;
	readonly args: unknown[];
}

export type SpacesSidebarRpcMethod =
	| 'getSpaces'
	| 'createEmptySpace'
	| 'openFolderAsSpace'
	| 'switchToSpace'
	| 'closeSpace'
	| 'renameSpace';

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
}

export interface ISpacesSidebarData {
	readonly spaces: ISpacesSidebarSpace[];
}
