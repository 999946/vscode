/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ISpace, ISpacesSnapshot } from './spaces.js';

/**
 * Spaces lifecycle events, mirroring Terax's plugin lifecycle surface
 * (`app.started`, `spaces.loaded`, `spaces.changed`, `space.activated`,
 * `space.deactivated`). In ParaCode the shared frame's `SpacesViewService`
 * emits these events while the sidebar subscribes to them, so the UI can
 * render lightweight per-Space activity/status information without a full
 * plugin host. The vocabulary stays aligned with Terax so a future Terax-style
 * plugin bridge can map 1:1 onto it.
 *
 * Semantics (Terax-compatible):
 * - `app.started`      — emitted once when the Spaces service comes up.
 * - `spaces.loaded`    — emitted once after a persisted restore completes.
 * - `spaces.changed`    — membership/name/root changed (deduplicated by
 *                          footprint, so re-renders do not spam listeners).
 * - `space.activated`   — a Space became the visible active Space.
 * - `space.deactivated` — the previously active Space was switched away from
 *                          (always paired with the following `space.activated`).
 */

export type SpacesLifecycleEventKind =
	| 'app.started'
	| 'spaces.loaded'
	| 'spaces.changed'
	| 'space.activated'
	| 'space.deactivated';

/** Serializable snapshot of a Space used in lifecycle event payloads. */
export interface ISpacesLifecycleSpace {
	readonly id: string;
	readonly name: string;
	/** Absolute path of the Space's workspace root, or `''` for an empty Space. */
	readonly root: string;
}

/** Terax `SpaceInfo`: status/summary a plugin may attach to a Space. */
export interface ISpaceInfo {
	readonly summary: string;
	readonly status: 'online' | 'offline' | 'degraded' | 'unknown';
	readonly onlineAt: string | null;
	readonly lastTestedAt: string | null;
}

/** One lifecycle event. `spaceId`/`space` are set for `activated`/`deactivated`. */
export interface ISpacesLifecycleEvent {
	readonly kind: SpacesLifecycleEventKind;
	/** ms epoch at emission time. */
	readonly timestamp: number;
	readonly spaceId: string | undefined;
	readonly space: ISpacesLifecycleSpace | undefined;
	/** Space list at the moment the event was emitted. */
	readonly stateSnapshot: ISpacesSnapshot;
}

/** Number of recent events kept for late subscribers / diagnostics. */
export const SPACES_LIFECYCLE_EVENT_LIMIT = 50;

/** The event surface exposed to subscribers (sidebar host, diagnostics). */
export interface ISpacesLifecycleEvents {
	readonly onDidFireLifecycleEvent: Event<ISpacesLifecycleEvent>;
	/** Most recent events, oldest first. Bounded by `SPACES_LIFECYCLE_EVENT_LIMIT`. */
	getLifecycleEvents(): readonly ISpacesLifecycleEvent[];
}

/** Builds a Terax-style lifecycle Space from a model Space. */
export function toLifecycleSpace(space: Pick<ISpace, 'id' | 'name' | 'workspace'>): ISpacesLifecycleSpace {
	return {
		id: space.id,
		name: space.name,
		root: space.workspace ? space.workspace.uri.fsPath : ''
	};
}

/**
 * Lightweight helper that serializes the Space list into a footprint used to
 * deduplicate `spaces.changed` events. Ids, names and workspace roots are
 * included; the active mark is deliberately excluded (activation is expressed
 * through `space.activated`/`space.deactivated` instead).
 */
export function spacesFootprint(snapshot: ISpacesSnapshot): string {
	let out = '';
	for (const space of snapshot.spaces) {
		out += `${space.id}\u0001${space.name}\u0001${space.workspace?.uri.toString() ?? ''}\u0002`;
	}
	return out;
}

/**
 * Emits and records Spaces lifecycle events with idempotency/deduplication
 * guards. Pure state, no Electron dependencies, so it is unit-testable in
 * isolation from the window/frame machinery.
 */
export class SpacesLifecycleService extends Disposable implements ISpacesLifecycleEvents {

	private readonly _onDidFireLifecycleEvent = this._register(new Emitter<ISpacesLifecycleEvent>());
	readonly onDidFireLifecycleEvent = this._onDidFireLifecycleEvent.event;

	private readonly log: ISpacesLifecycleEvent[] = [];
	private loadedFired = false;
	private lastFootprint: string | undefined;
	private lastActivatedId: string | undefined;

	getLifecycleEvents(): readonly ISpacesLifecycleEvent[] {
		return this.log;
	}

	/** Clears recorded state (used by tests and before a restore). */
	reset(): void {
		this.log.length = 0;
		this.loadedFired = false;
		this.lastFootprint = undefined;
		this.lastActivatedId = undefined;
	}

	fireAppStarted(snapshot: ISpacesSnapshot): void {
		this.emit('app.started', snapshot, undefined, undefined);
	}

	/** Fires `spaces.loaded` at most once per service lifetime. */
	fireLoaded(snapshot: ISpacesSnapshot): void {
		if (this.loadedFired) {
			return;
		}
		this.loadedFired = true;
		this.emit('spaces.loaded', snapshot, undefined, undefined);
	}

	/** Fires `spaces.changed`, deduplicated by the Space-list footprint. */
	fireChanged(snapshot: ISpacesSnapshot): void {
		const footprint = spacesFootprint(snapshot);
		if (footprint === this.lastFootprint) {
			return;
		}
		this.lastFootprint = footprint;
		this.emit('spaces.changed', snapshot, undefined, undefined);
	}

	/**
	 * Emits the `space.deactivated` -> `space.activated` pair for a real switch.
	 * Reactivating the same Space or an unknown target is a no-op.
	 */
	fireActivation(snapshot: ISpacesSnapshot, previous: ISpace | undefined, current: ISpace | undefined): void {
		if (!current) {
			return;
		}
		if (previous && previous.id !== current.id) {
			this.emit('space.deactivated', snapshot, previous.id, toLifecycleSpace(previous));
		}
		if (this.lastActivatedId !== current.id) {
			this.lastActivatedId = current.id;
			this.emit('space.activated', snapshot, current.id, toLifecycleSpace(current));
		}
	}

	private emit(kind: SpacesLifecycleEventKind, snapshot: ISpacesSnapshot, spaceId: string | undefined, space: ISpacesLifecycleSpace | undefined): void {
		const event: ISpacesLifecycleEvent = {
			kind,
			timestamp: Date.now(),
			spaceId,
			space,
			stateSnapshot: snapshot
		};
		this.log.push(event);
		if (this.log.length > SPACES_LIFECYCLE_EVENT_LIMIT) {
			this.log.splice(0, this.log.length - SPACES_LIFECYCLE_EVENT_LIMIT);
		}
		this._onDidFireLifecycleEvent.fire(event);
	}
}
