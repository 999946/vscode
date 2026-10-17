/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getDefaultSpaceName } from '../../common/spaces.js';
import { SpacesModel } from '../../common/spacesModel.js';

suite('SpacesModel', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let clock: number;
	let idCounter: number;

	function createModel(): SpacesModel {
		clock = 1000;
		idCounter = 0;
		return store.add(new SpacesModel(() => `space-${++idCounter}`, () => clock));
	}

	const folderA = { kind: 'folder' as const, uri: URI.file('/work/project-a') };
	const folderB = { kind: 'folder' as const, uri: URI.file('/work/project-b') };
	const workspaceC = { kind: 'workspace' as const, uri: URI.file('/work/project-c.code-workspace') };

	test('add creates inactive space with default name and is idempotent per window', () => {
		const model = createModel();

		const a = model.add({ windowId: 1, workspace: folderA });
		assert.strictEqual(a.id, 'space-1');
		assert.strictEqual(a.name, 'project-a');
		assert.strictEqual(a.windowId, 1);
		assert.strictEqual(a.state, 'inactive');
		assert.strictEqual(a.createdAt, 1000);
		assert.strictEqual(model.getActiveSpace(), undefined);

		const again = model.add({ windowId: 1, workspace: folderB });
		assert.strictEqual(again.id, a.id);
		assert.strictEqual(model.snapshot().spaces.length, 1);
	});

	test('default names for folders, workspaces and empty spaces', () => {
		assert.strictEqual(getDefaultSpaceName(folderA, 1), 'project-a');
		assert.strictEqual(getDefaultSpaceName(workspaceC, 1), 'project-c');
		assert.strictEqual(getDefaultSpaceName(undefined, 3), 'Empty Space 3');

		const model = createModel();
		assert.strictEqual(model.add({ windowId: 1 }).name, 'Empty Space 1');
		assert.strictEqual(model.add({ windowId: 2 }).name, 'Empty Space 2');
	});

	test('activate is exclusive and returns previous space', () => {
		const model = createModel();
		const a = model.add({ windowId: 1, workspace: folderA });
		const b = model.add({ windowId: 2, workspace: folderB });

		const first = model.activate(a.id);
		assert.strictEqual(first?.previous, undefined);
		assert.strictEqual(first?.current.id, a.id);

		clock = 2000;
		const second = model.activate(b.id);
		assert.strictEqual(second?.previous?.id, a.id);
		assert.strictEqual(second?.current.id, b.id);

		const snapshot = model.snapshot();
		assert.strictEqual(snapshot.activeSpaceId, b.id);
		assert.deepStrictEqual(snapshot.spaces.map(s => [s.id, s.state]), [[a.id, 'inactive'], [b.id, 'active']]);
		assert.strictEqual(model.getSpace(b.id)?.lastActiveAt, 2000);

		assert.strictEqual(model.activate('unknown'), undefined);
	});

	test('activating the active space does not fire change', () => {
		const model = createModel();
		const a = model.add({ windowId: 1 });
		model.activate(a.id);

		let changes = 0;
		store.add(model.onDidChange(() => changes++));
		const result = model.activate(a.id);
		assert.strictEqual(result?.previous?.id, a.id);
		assert.strictEqual(changes, 0);
	});

	test('removing the active space suggests most recently active remaining space', () => {
		const model = createModel();
		const a = model.add({ windowId: 1, workspace: folderA });
		const b = model.add({ windowId: 2, workspace: folderB });
		const c = model.add({ windowId: 3, workspace: workspaceC });

		clock = 2000; model.activate(b.id);
		clock = 3000; model.activate(a.id);
		clock = 4000; model.activate(c.id);

		const removal = model.remove(c.id);
		assert.strictEqual(removal?.removed.id, c.id);
		assert.strictEqual(removal?.nextActiveSpace?.id, a.id);
		assert.strictEqual(model.getActiveSpace(), undefined);
		assert.strictEqual(model.getSpaceByWindowId(3), undefined);
	});

	test('removing an inactive space keeps active space', () => {
		const model = createModel();
		const a = model.add({ windowId: 1 });
		const b = model.add({ windowId: 2 });
		model.activate(a.id);

		const removal = model.remove(b.id);
		assert.strictEqual(removal?.nextActiveSpace, undefined);
		assert.strictEqual(model.getActiveSpace()?.id, a.id);
		assert.strictEqual(model.remove(b.id), undefined);
	});

	test('removing last space leaves empty model', () => {
		const model = createModel();
		const a = model.add({ windowId: 1 });
		model.activate(a.id);

		const removal = model.remove(a.id);
		assert.strictEqual(removal?.nextActiveSpace, undefined);
		assert.deepStrictEqual(model.snapshot(), { spaces: [], activeSpaceId: undefined });
	});

	test('rename sets custom name; blank name restores default', () => {
		const model = createModel();
		const a = model.add({ windowId: 1, workspace: folderA });

		assert.strictEqual(model.rename(a.id, '  Frontend  '), true);
		assert.strictEqual(model.getSpace(a.id)?.name, 'Frontend');

		model.updateWorkspace(a.id, folderB);
		assert.strictEqual(model.getSpace(a.id)?.name, 'Frontend', 'custom name survives workspace change');

		assert.strictEqual(model.rename(a.id, '   '), true);
		assert.strictEqual(model.getSpace(a.id)?.name, 'project-b');

		assert.strictEqual(model.rename('unknown', 'x'), false);
	});

	test('workspace change updates default name and fires change', () => {
		const model = createModel();
		const a = model.add({ windowId: 1, workspace: folderA });

		let changes = 0;
		store.add(model.onDidChange(() => changes++));

		model.updateWorkspace(a.id, workspaceC);
		assert.strictEqual(model.getSpace(a.id)?.name, 'project-c');
		assert.strictEqual(model.getSpace(a.id)?.workspace?.kind, 'workspace');
		assert.strictEqual(changes, 1);

		model.updateWorkspace(a.id, workspaceC);
		assert.strictEqual(changes, 1, 'same workspace is a no-op');
	});

	test('snapshots are detached from later mutations', () => {
		const model = createModel();
		const a = model.add({ windowId: 1, workspace: folderA });
		const before = model.snapshot();

		model.activate(a.id);
		model.rename(a.id, 'Renamed');

		assert.strictEqual(before.activeSpaceId, undefined);
		assert.strictEqual(before.spaces[0].name, 'project-a');
		assert.strictEqual(before.spaces[0].state, 'inactive');
	});

	test('attention is only recorded for inactive spaces and cleared on activation', () => {
		const model = createModel();
		const a = model.add({ windowId: 1, workspace: folderA });
		const b = model.add({ windowId: 2, workspace: folderB });
		model.activate(a.id);

		assert.strictEqual(model.getSpace(b.id)?.needsAttention, false);

		assert.strictEqual(model.setNeedsAttention(a.id), false, 'active space never needs attention');
		assert.strictEqual(model.getSpace(a.id)?.needsAttention, false);

		assert.strictEqual(model.setNeedsAttention(b.id), true);
		assert.strictEqual(model.getSpace(b.id)?.needsAttention, true);
		assert.strictEqual(model.snapshot().spaces.find(space => space.id === b.id)?.needsAttention, true);

		model.activate(b.id);
		assert.strictEqual(model.getSpace(b.id)?.needsAttention, false);

		assert.strictEqual(model.setNeedsAttention('unknown'), false);
	});

	test('attention fires change only when the marker changes', () => {
		const model = createModel();
		const a = model.add({ windowId: 1 });
		const b = model.add({ windowId: 2 });
		model.activate(a.id);

		let changes = 0;
		store.add(model.onDidChange(() => changes++));

		model.setNeedsAttention(b.id);
		model.setNeedsAttention(b.id);
		assert.strictEqual(changes, 1);

		model.activate(b.id);
		assert.strictEqual(changes, 2);
	});

	test('rebindWindow moves a space to a replacement window and keeps its identity', () => {
		const model = createModel();
		const a = model.add({ windowId: 1, workspace: folderA });
		const b = model.add({ windowId: 2, workspace: folderB });
		model.activate(a.id);
		model.rename(a.id, 'Frontend');

		assert.strictEqual(model.rebindWindow(a.id, 3), true);
		const rebound = model.getSpace(a.id);
		assert.strictEqual(rebound?.windowId, 3);
		assert.strictEqual(rebound?.name, 'Frontend');
		assert.strictEqual(rebound?.state, 'active');
		assert.strictEqual(model.getSpaceByWindowId(1), undefined);
		assert.strictEqual(model.getSpaceByWindowId(3)?.id, a.id);

		assert.strictEqual(model.rebindWindow(a.id, 2), false, 'window already hosts another space');
		assert.strictEqual(model.getSpace(b.id)?.windowId, 2);
		assert.strictEqual(model.rebindWindow('unknown', 4), false);
	});

	test('fires change for add, activate, rename and remove', () => {
		const model = createModel();
		let changes = 0;
		store.add(model.onDidChange(() => changes++));

		const a = model.add({ windowId: 1 });
		model.add({ windowId: 1 }); // idempotent, no event
		model.activate(a.id);
		model.rename(a.id, 'X');
		model.remove(a.id);

		assert.strictEqual(changes, 4);
	});
});
