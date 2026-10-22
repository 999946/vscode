/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { basename, extname } from '../../../base/common/resources.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ISpacesSettings } from './spacesConfig.js';
import { ISpaceTabState } from './spacesTabs.js';

/**
 * Spaces group several fully independent workbench windows behind one
 * visible frame. Every Space is backed by its own window (own renderer,
 * extension host, terminals, storage and lifecycle); only the active Space
 * is visible. See `docs/spaces-architecture-notes.md`.
 */

export const SPACES_ENABLED_SETTING = 'workbench.experimental.spaces.enabled';

export const SPACES_CHANNEL_NAME = 'spaces';

export type SpaceState = 'active' | 'inactive';

export interface ISpaceWorkspace {
	readonly kind: 'folder' | 'workspace';
	readonly uri: URI;
}

export interface ISpace {
	readonly id: string;
	readonly name: string;
	/** Identifier of the window that hosts this Space. */
	readonly windowId: number;
	/** `undefined` for an empty Space. */
	readonly workspace: ISpaceWorkspace | undefined;
	readonly createdAt: number;
	readonly lastActiveAt: number;
	readonly state: SpaceState;
	/**
	 * `true` when the Space asked for attention (a modal dialog or a window
	 * attention request) while it was inactive. Cleared when it becomes active.
	 */
	readonly needsAttention: boolean;
}

export interface ISpacesSnapshot {
	/** Spaces in creation order. */
	readonly spaces: readonly ISpace[];
	readonly activeSpaceId: string | undefined;
}

export const enum SpaceOperationResult {
	Ok = 'ok',
	UnknownSpace = 'unknownSpace',
	UnsupportedWindow = 'unsupportedWindow',
	NativeFullScreen = 'nativeFullScreen',
	OpenFailed = 'openFailed'
}

export interface ISpaceOperationResult {
	readonly result: SpaceOperationResult;
	readonly space?: ISpace;
}

/**
 * Service surface shared by the main process implementation and the renderer
 * proxy. The main process variant resolves the calling Space from the calling
 * window id (`WebContentsView.id`), passed as the first argument.
 */
export interface ICommonSpacesService {

	readonly _serviceBrand: undefined;

	readonly onDidChangeSpaces: Event<ISpacesSnapshot>;

	getSpaces(): Promise<ISpacesSnapshot>;

	/** Opens a new empty window as Space and makes it active. The calling window becomes a Space if it is not one yet. */
	createEmptySpace(): Promise<ISpaceOperationResult>;

	/** Opens a folder in a new window as Space and makes it active. If the folder is already open in a window, that window becomes the Space. */
	openFolderAsSpace(folderUri: UriComponents): Promise<ISpaceOperationResult>;

	/** Same as `openFolderAsSpace` for a `.code-workspace` file. */
	openWorkspaceAsSpace(workspaceUri: UriComponents): Promise<ISpaceOperationResult>;

	/** Adds the calling window as a Space without opening anything. */
	addCurrentWindowAsSpace(): Promise<ISpaceOperationResult>;

	switchToSpace(spaceId: string): Promise<ISpaceOperationResult>;

	/** Closes the Space's window through the regular window lifecycle (may be vetoed, e.g. for unsaved changes). */
	closeSpace(spaceId: string): Promise<ISpaceOperationResult>;

	renameSpace(spaceId: string, name: string): Promise<ISpaceOperationResult>;

	/** Makes the calling window the active Space if it is a hidden Space. */
	revealCurrentSpace(): Promise<void>;

	/** Marks the calling window's Space as needing attention if it is inactive. */
	requestAttention(): Promise<void>;

	/** Reads the user-facing Spaces settings that drive the shared sidebar. */
	getSidebarSettings(): Promise<ISpacesSettings>;

	/** Writes a single user-facing Spaces setting (e.g. `spacesRoot`). */
	setSidebarSetting(key: string, value: unknown): Promise<void>;

	/** Reads the persisted tab state of a Space (editors/terminals/preview). */
	getSpaceTabs(spaceId: string): Promise<ISpaceTabState>;

	/**
	 * Persists the tab state of the calling Space reported by its workbench.
	 * The main process resolves the Space from the calling window id.
	 */
	updateSpaceTabs(state: ISpaceTabState): Promise<void>;

	/**
	 * Reads the persisted tab state of the calling Space. The main process
	 * resolves the Space from the calling window id.
	 */
	getPersistedTabStateForWindow(): Promise<ISpaceTabState>;

	/** Creates a Space with the given name (under the configured spaces root if set). */
	createSpace(name: string): Promise<ISpaceOperationResult>;

	/** Closes and deletes a Space, removing its persisted tab state. */
	deleteSpace(spaceId: string): Promise<ISpaceOperationResult>;

	/** Sends an internal message to a Space's workbench renderer. */
	sendToSpace(spaceId: string, channel: string, ...args: unknown[]): Promise<void>;
}

export const ISpacesService = createDecorator<ISpacesService>('spacesService');
export interface ISpacesService extends ICommonSpacesService { }

export function getDefaultSpaceName(workspace: ISpaceWorkspace | undefined, emptyIndex: number): string {
	if (!workspace) {
		return localize('emptySpaceName', "Empty Space {0}", emptyIndex);
	}

	const name = basename(workspace.uri);
	if (workspace.kind === 'workspace') {
		const extension = extname(workspace.uri);
		return extension ? name.substring(0, name.length - extension.length) : name;
	}

	return name || workspace.uri.authority || workspace.uri.toString();
}
