/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { StorageScope, StorageTarget } from '../../storage/common/storage.js';
import { ILogService } from '../../log/common/log.js';
import { ISpaceTabState, emptySpaceTabState, SPACES_TAB_STATE_STORAGE_PREFIX } from '../common/spacesTabs.js';

/**
 * Persists each Space's tab state in the application storage database.
 * The workbench side reports live editors/terminals, the main process stores
 * them per Space (keyed by Space id), and the sidebar renders the list on
 * request. On startup the state is handed back so a Space can re-open editors
 * and re-create terminals.
 */
export class SpacesTabStore {

	constructor(
		@IApplicationStorageMainService private readonly applicationStorageMainService: IApplicationStorageMainService,
		@ILogService private readonly logService: ILogService
	) {
	}

	private key(spaceId: string): string {
		return `${SPACES_TAB_STATE_STORAGE_PREFIX}${spaceId}`;
	}

	/** Read a Space's persisted tab state. Missing/corrupt state yields an empty state. */
	get(spaceId: string): ISpaceTabState {
		try {
			const raw = this.applicationStorageMainService.get(this.key(spaceId), StorageScope.APPLICATION, undefined);
			if (typeof raw !== 'string') {
				return emptySpaceTabState();
			}
			const parsed = JSON.parse(raw) as ISpaceTabState;
			if (!Array.isArray(parsed.tabs)) {
				return emptySpaceTabState();
			}
			return { tabs: parsed.tabs, activeTabIndex: typeof parsed.activeTabIndex === 'number' ? parsed.activeTabIndex : 0 };
		} catch (error) {
			this.logService.warn(`[spaces:tabs] failed to read tab state for '${spaceId}': ${error}`);
			return emptySpaceTabState();
		}
	}

	/** Write a Space's tab state. Passing `undefined` clears it. */
	set(spaceId: string, state: ISpaceTabState | undefined): void {
		try {
			if (!state) {
				this.applicationStorageMainService.remove(this.key(spaceId), StorageScope.APPLICATION);
				return;
			}
			this.applicationStorageMainService.store(
				this.key(spaceId),
				JSON.stringify(state),
				StorageScope.APPLICATION,
				StorageTarget.MACHINE
			);
		} catch (error) {
			this.logService.warn(`[spaces:tabs] failed to write tab state for '${spaceId}': ${error}`);
		}
	}

	/** Read all persisted tab states (used by the sidebar to show every Space). */
	readAll(): Map<string, ISpaceTabState> {
		const result = new Map<string, ISpaceTabState>();
		for (const key of this.applicationStorageMainService.keys(StorageScope.APPLICATION, StorageTarget.MACHINE)) {
			if (key.startsWith(SPACES_TAB_STATE_STORAGE_PREFIX)) {
				const spaceId = key.slice(SPACES_TAB_STATE_STORAGE_PREFIX.length);
				result.set(spaceId, this.get(spaceId));
			}
		}
		return result;
	}
}
