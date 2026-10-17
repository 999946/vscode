/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isEqual } from '../../../base/common/resources.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { getDefaultSpaceName, ISpace, ISpacesSnapshot, ISpaceWorkspace } from './spaces.js';

export interface ISpaceInit {
	readonly windowId: number;
	readonly workspace?: ISpaceWorkspace;
}

export interface ISpaceActivation {
	/** The previously active Space, which is the same as `current` when nothing changed. */
	readonly previous: ISpace | undefined;
	readonly current: ISpace;
}

export interface ISpaceRemoval {
	readonly removed: ISpace;
	/** Set when the removed Space was active and another Space should take its place. */
	readonly nextActiveSpace: ISpace | undefined;
}

interface IMutableSpace {
	readonly id: string;
	windowId: number;
	readonly createdAt: number;
	emptyIndex: number;
	customName: string | undefined;
	workspace: ISpaceWorkspace | undefined;
	lastActiveAt: number;
	needsAttention: boolean;
}

/**
 * Presentation independent state of a Space group: which Spaces exist, which
 * one is active and how they are named. Contains no window handling so that
 * it can be unit tested and reused if Spaces move to a different host model.
 */
export class SpacesModel extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly spaces: IMutableSpace[] = [];
	private activeSpaceId: string | undefined;
	private emptySpaceCounter = 0;

	constructor(
		private readonly idFactory: () => string = generateUuid,
		private readonly now: () => number = Date.now
	) {
		super();
	}

	get size(): number {
		return this.spaces.length;
	}

	getSpace(spaceId: string): ISpace | undefined {
		const space = this.spaces.find(space => space.id === spaceId);
		return space ? this.toSpace(space) : undefined;
	}

	getSpaceByWindowId(windowId: number): ISpace | undefined {
		const space = this.spaces.find(space => space.windowId === windowId);
		return space ? this.toSpace(space) : undefined;
	}

	getActiveSpace(): ISpace | undefined {
		return this.activeSpaceId ? this.getSpace(this.activeSpaceId) : undefined;
	}

	snapshot(): ISpacesSnapshot {
		return {
			spaces: this.spaces.map(space => this.toSpace(space)),
			activeSpaceId: this.activeSpaceId
		};
	}

	add(init: ISpaceInit): ISpace {
		const existing = this.spaces.find(space => space.windowId === init.windowId);
		if (existing) {
			return this.toSpace(existing);
		}

		const space: IMutableSpace = {
			id: this.idFactory(),
			windowId: init.windowId,
			createdAt: this.now(),
			emptyIndex: init.workspace ? 0 : ++this.emptySpaceCounter,
			customName: undefined,
			workspace: init.workspace,
			lastActiveAt: 0,
			needsAttention: false
		};
		this.spaces.push(space);
		this._onDidChange.fire();

		return this.toSpace(space);
	}

	remove(spaceId: string): ISpaceRemoval | undefined {
		const index = this.spaces.findIndex(space => space.id === spaceId);
		if (index === -1) {
			return undefined;
		}

		const [space] = this.spaces.splice(index, 1);
		const removed = this.toSpace(space);

		let nextActiveSpace: ISpace | undefined;
		if (this.activeSpaceId === spaceId) {
			this.activeSpaceId = undefined;

			let candidate: IMutableSpace | undefined;
			for (const other of this.spaces) {
				if (!candidate || other.lastActiveAt >= candidate.lastActiveAt) {
					candidate = other;
				}
			}
			nextActiveSpace = candidate ? this.toSpace(candidate) : undefined;
		}

		this._onDidChange.fire();

		return { removed, nextActiveSpace };
	}

	activate(spaceId: string): ISpaceActivation | undefined {
		const space = this.spaces.find(space => space.id === spaceId);
		if (!space) {
			return undefined;
		}

		const previous = this.getActiveSpace();
		if (previous?.id === spaceId) {
			return { previous, current: previous };
		}

		this.activeSpaceId = space.id;
		space.lastActiveAt = this.now();
		space.needsAttention = false;
		this._onDidChange.fire();

		return { previous, current: this.toSpace(space) };
	}

	/**
	 * Sets a custom name. A blank name restores the default name that follows
	 * the Space's workspace.
	 */
	rename(spaceId: string, name: string): boolean {
		const space = this.spaces.find(space => space.id === spaceId);
		if (!space) {
			return false;
		}

		const trimmed = name.trim();
		space.customName = trimmed.length > 0 ? trimmed : undefined;
		this._onDidChange.fire();

		return true;
	}

	/**
	 * Moves a Space to another window, e.g. the window that replaces a crashed
	 * one. Returns `false` if the Space is unknown or the window already hosts
	 * a Space.
	 */
	rebindWindow(spaceId: string, windowId: number): boolean {
		const space = this.spaces.find(space => space.id === spaceId);
		if (!space || this.spaces.some(other => other.windowId === windowId)) {
			return false;
		}

		space.windowId = windowId;
		this._onDidChange.fire();

		return true;
	}

	/**
	 * Marks an inactive Space as needing attention. Returns whether the Space is
	 * marked; the active Space is visible and never needs a marker.
	 */
	setNeedsAttention(spaceId: string): boolean {
		const space = this.spaces.find(space => space.id === spaceId);
		if (!space || space.id === this.activeSpaceId) {
			return false;
		}

		if (!space.needsAttention) {
			space.needsAttention = true;
			this._onDidChange.fire();
		}

		return true;
	}

	updateWorkspace(spaceId: string, workspace: ISpaceWorkspace | undefined): void {
		const space = this.spaces.find(space => space.id === spaceId);
		if (!space) {
			return;
		}

		if (space.workspace?.kind === workspace?.kind && isEqual(space.workspace?.uri, workspace?.uri)) {
			return;
		}

		space.workspace = workspace;
		if (!workspace && !space.emptyIndex) {
			space.emptyIndex = ++this.emptySpaceCounter;
		}
		this._onDidChange.fire();
	}

	private toSpace(space: IMutableSpace): ISpace {
		return {
			id: space.id,
			name: space.customName ?? getDefaultSpaceName(space.workspace, space.emptyIndex),
			windowId: space.windowId,
			workspace: space.workspace,
			createdAt: space.createdAt,
			lastActiveAt: space.lastActiveAt,
			state: space.id === this.activeSpaceId ? 'active' : 'inactive',
			needsAttention: space.needsAttention
		};
	}
}
