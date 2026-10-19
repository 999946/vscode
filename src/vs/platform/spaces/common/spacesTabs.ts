/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Serialized form of a Space's tabs, mirroring Terax `serialize.ts`:
 * - terminal tabs restore their working directory (plus optional custom title)
 * - editor tabs restore the file path
 * - preview tabs restore their URL
 *
 * The workbench side serializes its live editors/terminals, the main process
 * persists them per Space, and the sidebar renders the list. On startup the
 * persisted state is handed back to a Space's workbench which re-opens editors
 * and re-creates terminals.
 */

export const SPACES_TAB_STATE_STORAGE_PREFIX = 'spaces.tabState.';

/** A terminal pane in the simplified (flat) serialization. */
export interface ISerializedSpaceTab {
	readonly kind: 'editor' | 'terminal' | 'preview';
	/** Primary label: file name for editors, terminal title for terminals. */
	readonly label: string;
	/** Secondary detail: parent directory (editors) / cwd (terminals). */
	readonly detail?: string;
	/** Editor: absolute fs path. Terminal: cwd. Preview: URL. */
	readonly value?: string;
	/** Terminal custom title if the user renamed it. */
	readonly customTitle?: string;
}

/** Per-Space persisted tab state. */
export interface ISpaceTabState {
	readonly tabs: ISerializedSpaceTab[];
	/** Index into `tabs` that was active when the state was captured. */
	readonly activeTabIndex: number;
}

export function emptySpaceTabState(): ISpaceTabState {
	return { tabs: [], activeTabIndex: 0 };
}

export function serializeSpaceTabState(tabs: ISerializedSpaceTab[], activeTabIndex: number): ISpaceTabState {
	return { tabs, activeTabIndex };
}
