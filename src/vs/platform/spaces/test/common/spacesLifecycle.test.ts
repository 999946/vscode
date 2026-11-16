/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ISpace } from '../../common/spaces.js';
import { ISpacesLifecycleEvent, spacesFootprint, SpacesLifecycleService, toLifecycleSpace } from '../../common/spacesLifecycle.js';

suite('SpacesLifecycle', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function makeSpace(id: string, name: string, fsPath?: string): ISpace {
		return {
			id,
			name,
			windowId: 0,
			workspace: fsPath === undefined ? undefined : { kind: 'folder', uri: URI.file(fsPath) },
			createdAt: 0,
			lastActiveAt: 0,
			state: 'inactive',
			needsAttention: false
		};
	}

	function snapshot(spaces: ISpace[], activeSpaceId?: string) {
		return { spaces, activeSpaceId };
	}

	test('toLifecycleSpace maps id/name/root, empty workspace root is empty string', () => {
		const withWs = toLifecycleSpace(makeSpace('a', 'Alpha', '/work/alpha'));
		assert.deepStrictEqual(withWs, { id: 'a', name: 'Alpha', root: '/work/alpha' });

		const empty = toLifecycleSpace(makeSpace('b', 'Empty Space 1'));
		assert.deepStrictEqual(empty, { id: 'b', name: 'Empty Space 1', root: '' });
	});

	test('spacesFootprint is stable per list and changes when membership/name/workspace changes', () => {
		const a = makeSpace('a', 'Alpha', '/work/alpha');
		const b = makeSpace('b', 'Beta', '/work/beta');

		const empty = snapshot([]);
		const one = snapshot([a]);
		const two = snapshot([a, b]);

		assert.strictEqual(spacesFootprint(snapshot([a])), spacesFootprint(one));
		assert.notStrictEqual(spacesFootprint(empty), spacesFootprint(one));
		assert.notStrictEqual(spacesFootprint(one), spacesFootprint(two));
		// Renaming changes footprint.
		assert.notStrictEqual(spacesFootprint(snapshot([{ ...a, name: 'Renamed' }])), spacesFootprint(one));
		// Active mark alone does not change footprint (activation has its own event).
		assert.strictEqual(spacesFootprint(snapshot([a, b], 'b')), spacesFootprint(snapshot([a, b], 'a')));
	});

	test('fireAppStarted emits once and records the event', () => {
		const svc = store.add(new SpacesLifecycleService());
		const events: ISpacesLifecycleEvent[] = [];
		store.add(svc.onDidFireLifecycleEvent(e => events.push(e)));

		svc.fireAppStarted(snapshot([]));

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].kind, 'app.started');
		assert.strictEqual(svc.getLifecycleEvents().length, 1);
	});

	test('fireLoaded is idempotent (fires at most once)', () => {
		const svc = store.add(new SpacesLifecycleService());
		const events: ISpacesLifecycleEvent[] = [];
		store.add(svc.onDidFireLifecycleEvent(e => events.push(e)));

		svc.fireLoaded(snapshot([makeSpace('a', 'Alpha', '/work/alpha')]));
		svc.fireLoaded(snapshot([makeSpace('a', 'Alpha', '/work/alpha'), makeSpace('b', 'Beta', '/work/beta')]));
		svc.fireLoaded(snapshot([]));

		assert.strictEqual(events.filter(e => e.kind === 'spaces.loaded').length, 1);
		assert.strictEqual(svc.getLifecycleEvents().length, 1);
	});

	test('fireChanged deduplicates by footprint', () => {
		const svc = store.add(new SpacesLifecycleService());
		const events: ISpacesLifecycleEvent[] = [];
		store.add(svc.onDidFireLifecycleEvent(e => events.push(e)));

		const a = makeSpace('a', 'Alpha', '/work/alpha');
		svc.fireChanged(snapshot([a]));
		svc.fireChanged(snapshot([a]));       // identical -> dedup
		svc.fireChanged(snapshot([a, makeSpace('b', 'Beta', '/work/beta')]));
		svc.fireChanged(snapshot([a, makeSpace('b', 'Beta', '/work/beta')])); // identical -> dedup

		assert.strictEqual(events.filter(e => e.kind === 'spaces.changed').length, 2);
	});

	test('fireActivation emits deactivated + activated pair on a real switch', () => {
		const svc = store.add(new SpacesLifecycleService());
		const events: ISpacesLifecycleEvent[] = [];
		store.add(svc.onDidFireLifecycleEvent(e => events.push(e)));

		const a = makeSpace('a', 'Alpha', '/work/alpha');
		const b = makeSpace('b', 'Beta', '/work/beta');

		// First activation (no previous active Space): only `space.activated`.
		svc.fireActivation(snapshot([a, b], 'a'), undefined, a);
		assert.deepStrictEqual(events.map(e => e.kind), ['space.activated']);
		assert.strictEqual(events[0].spaceId, 'a');

		// Switch A -> B: deactivated(A) then activated(B).
		svc.fireActivation(snapshot([a, b], 'b'), a, b);
		assert.deepStrictEqual(events.map(e => e.kind), ['space.activated', 'space.deactivated', 'space.activated']);
		assert.strictEqual(events[1].spaceId, 'a');
		assert.strictEqual(events[2].spaceId, 'b');

		// Reactivating the same Space is idempotent.
		svc.fireActivation(snapshot([a, b], 'b'), b, b);
		assert.strictEqual(events.length, 3);
	});

	test('fireActivation ignores unknown current Space', () => {
		const svc = store.add(new SpacesLifecycleService());
		const events: ISpacesLifecycleEvent[] = [];
		store.add(svc.onDidFireLifecycleEvent(e => events.push(e)));

		svc.fireActivation(snapshot([]), undefined, undefined);
		assert.strictEqual(events.length, 0);
	});

	test('event log is bounded to the configured limit', () => {
		const svc = store.add(new SpacesLifecycleService());
		for (let i = 0; i < 120; i++) {
			svc.fireChanged(snapshot([makeSpace(`s${i}`, `Space ${i}`, `/work/s${i}`)]));
		}
		assert.strictEqual(svc.getLifecycleEvents().length, 50);
		const last = svc.getLifecycleEvents()[49]!;
		assert.strictEqual(last.stateSnapshot.spaces[0].id, 's119', 'oldest 70 dropped, newest kept');
		assert.strictEqual(last.kind, 'spaces.changed');
	});
});
