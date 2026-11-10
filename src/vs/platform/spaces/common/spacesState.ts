/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI, UriComponents } from '../../../base/common/uri.js';
import { ISpaceWorkspace } from './spaces.js';
import { generateUuid } from '../../../base/common/uuid.js';

/**
 * Persisted "Spaces mode" state: which Spaces existed, in which order, and
 * which one was active. Restored before the first window opens so a user who
 * switched to Spaces mode gets Spaces mode again on the next launch instead
 * of a regular window.
 *
 * Parsing is defensive: a corrupt or stale file must never block startup, it
 * simply yields `undefined` and the app opens a normal window.
 */

export const SPACES_STATE_STORAGE_VERSION = 1;

export interface IPersistedSpaceWorkspace {
	readonly kind: 'folder' | 'workspace';
	readonly uri: UriComponents;
}

export interface IPersistedSpace {
	readonly id: string;
	readonly workspace?: IPersistedSpaceWorkspace;
}

export interface IPersistedSpacesState {
	readonly version: number;
	/** Spaces in display order. */
	readonly spaces: readonly IPersistedSpace[];
	/** Id of the Space that was active; must reference one of `spaces`. */
	readonly activeSpaceId?: string;
}

export function toPersistedWorkspace(workspace: ISpaceWorkspace | undefined): IPersistedSpaceWorkspace | undefined {
	if (!workspace) {
		return undefined;
	}
	return { kind: workspace.kind, uri: workspace.uri.toJSON() };
}

export function fromPersistedWorkspace(workspace: IPersistedSpaceWorkspace | undefined): ISpaceWorkspace | undefined {
	if (!workspace) {
		return undefined;
	}
	return { kind: workspace.kind, uri: URI.revive(workspace.uri) };
}

export function serializeSpacesState(state: IPersistedSpacesState): string {
	return JSON.stringify(state);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWorkspace(value: unknown): IPersistedSpaceWorkspace | undefined | null {
	// `undefined` -> no workspace (an empty Space is valid), `null` -> invalid.
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		return null;
	}

	const kind = value.kind;
	if (kind !== 'folder' && kind !== 'workspace') {
		return null;
	}

	const uri = value.uri;
	if (!isRecord(uri) || typeof uri.scheme !== 'string' || !uri.scheme) {
		return null;
	}
	if (typeof uri.path !== 'string') {
		return null;
	}

	try {
		return { kind, uri: uri as unknown as UriComponents };
	} catch {
		return null;
	}
}

/**
 * Parses a persisted Spaces state (string or already parsed value).
 * Returns `undefined` when the input cannot describe a restorable state.
 */
export function parseSpacesState(raw: unknown): IPersistedSpacesState | undefined {
	let value: unknown = raw;
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw);
		} catch {
			return undefined;
		}
	}

	if (!isRecord(value)) {
		return undefined;
	}
	if (value.version !== SPACES_STATE_STORAGE_VERSION) {
		return undefined;
	}
	if (!Array.isArray(value.spaces)) {
		return undefined;
	}

	const spaces: IPersistedSpace[] = [];
	const ids = new Set<string>();
	const seenPaths = new Set<string>();

	for (const entry of value.spaces) {
		if (!isRecord(entry)) {
			continue;
		}
		const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id : undefined;
		if (!id || ids.has(id)) {
			continue;
		}

		const workspace = parseWorkspace(entry.workspace);
		if (workspace === null) {
			continue;
		}

		// The same folder must not be restored twice (e.g. after a manual edit).
		if (workspace) {
			const key = URI.revive(workspace.uri).toString();
			if (seenPaths.has(key)) {
				continue;
			}
			seenPaths.add(key);
		}

		ids.add(id);
		spaces.push(workspace ? { id, workspace } : { id });
	}

	const activeSpaceId = typeof value.activeSpaceId === 'string' && ids.has(value.activeSpaceId)
		? value.activeSpaceId
		: undefined;

	if (spaces.length === 0) {
		// Nothing to restore: treat it like a missing state so the app opens a
		// regular window instead of an empty Spaces frame.
		return undefined;
	}

	return { version: SPACES_STATE_STORAGE_VERSION, spaces, activeSpaceId };
}

/** Builds a state object from the live model data. */
export function buildSpacesState(spaces: readonly { id: string; workspace?: ISpaceWorkspace }[], activeSpaceId: string | undefined): IPersistedSpacesState {
	const persisted: IPersistedSpace[] = [];
	const ids = new Set<string>();

	for (const space of spaces) {
		const id = space.id && !ids.has(space.id) ? space.id : generateUuid();
		ids.add(id);
		const workspace = toPersistedWorkspace(space.workspace);
		persisted.push(workspace ? { id, workspace } : { id });
	}

	return {
		version: SPACES_STATE_STORAGE_VERSION,
		spaces: persisted,
		activeSpaceId: activeSpaceId && ids.has(activeSpaceId) ? activeSpaceId : undefined
	};
}
