/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { join } from '../../../base/common/path.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IPersistedSpacesState, parseSpacesState, serializeSpacesState } from '../common/spacesState.js';

/**
 * Persists the Spaces-mode state as a small JSON file in the user data
 * directory.
 *
 * Deliberately file based and synchronous: the state must be readable *before*
 * the first window opens (`openFirstWindow`), while the main-process
 * application storage database is only initialised once a window starts
 * loading. Reading storage earlier would observe an empty in-memory store and
 * silently lose Spaces mode on every launch.
 */
export class SpacesStateStore {

	private readonly statePath: string;

	constructor(
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@ILogService private readonly logService: ILogService
	) {
		this.statePath = join(environmentMainService.userDataPath, 'spaces-state.json');
	}

	get path(): string {
		return this.statePath;
	}

	/** Reads the persisted state. Missing, unreadable or corrupt state yields `undefined`. */
	read(): IPersistedSpacesState | undefined {
		let raw: string;
		try {
			// eslint-disable-next-line local/code-no-sync-fs -- Must be readable before the first window opens, when the async storage DB is not initialised yet.
			raw = fs.readFileSync(this.statePath, 'utf8');
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== 'ENOENT') {
				this.logService.warn(`[spaces:state] failed to read '${this.statePath}': ${error}`);
			}
			return undefined;
		}

		const state = parseSpacesState(raw);
		if (!state) {
			this.logService.warn(`[spaces:state] ignoring unusable state file '${this.statePath}'`);
		}
		return state;
	}

	/** Writes the state atomically (temp file + rename). */
	write(state: IPersistedSpacesState): void {
		const tempPath = `${this.statePath}.${process.pid}.tmp`;
		try {
			// eslint-disable-next-line local/code-no-sync-fs -- A tiny atomic write that must also be available during early shutdown paths.
			fs.writeFileSync(tempPath, serializeSpacesState(state), 'utf8');
			// eslint-disable-next-line local/code-no-sync-fs -- Atomic rename, see above.
			fs.renameSync(tempPath, this.statePath);
		} catch (error) {
			this.logService.warn(`[spaces:state] failed to write '${this.statePath}': ${error}`);
			// eslint-disable-next-line local/code-no-sync-fs -- Best-effort temp cleanup; must not await during failure handling.
			try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
		}
	}

	/** Removes the state, i.e. the next launch opens a regular window. */
	clear(): void {
		try {
			// eslint-disable-next-line local/code-no-sync-fs -- Must be readable/writable before the first window opens, when the async storage DB is not initialised yet.
			fs.unlinkSync(this.statePath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== 'ENOENT') {
				this.logService.warn(`[spaces:state] failed to delete '${this.statePath}': ${error}`);
			}
		}
	}
}
