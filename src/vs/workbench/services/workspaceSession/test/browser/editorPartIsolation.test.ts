/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IEditorFactoryRegistry, EditorExtensions } from '../../../../common/editor.js';
import { GroupDirection } from '../../../editor/common/editorGroupsService.js';
import { TestFileEditorInput, registerTestEditor, createEditorPart, workbenchInstantiationService, workbenchTeardown } from '../../../../test/browser/workbenchTestServices.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('WorkspaceSession - EditorPart Isolation', () => {

	const TEST_EDITOR_ID = 'MyFileEditorForWorkspaceSession';
	const TEST_EDITOR_INPUT_ID = 'testEditorInputForWorkspaceSession';

	const disposables = new DisposableStore();

	setup(() => {
		disposables.add(registerTestEditor(TEST_EDITOR_ID, [new SyncDescriptor(TestFileEditorInput)], TEST_EDITOR_INPUT_ID));
	});

	teardown(async () => {
		disposables.clear();
	});

	// Registered after the teardown above so the leak check runs last, once
	// the editor parts and services created via `disposables` are gone.
	ensureNoDisposablesAreLeakedInTestSuite();

	test('two independent editor parts keep their tabs separate', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));

		// Create part A and part B, each mounted on its own DOM container
		const partA = await createEditorPart(instantiationService, disposables);
		const partB = await createEditorPart(instantiationService, disposables);

		// Each part is its own container with its own groups
		assert.strictEqual(partA.count, 1);
		assert.strictEqual(partB.count, 1);

		const groupA = partA.activeGroup;
		const groupB = partB.activeGroup;

		// Open a distinct file in each part
		const inputA = disposables.add(new TestFileEditorInput(URI.file('foo/barA'), TEST_EDITOR_INPUT_ID));
		const inputB = disposables.add(new TestFileEditorInput(URI.file('foo/barB'), TEST_EDITOR_INPUT_ID));

		await groupA.openEditor(inputA, { pinned: true });
		await groupB.openEditor(inputB, { pinned: true });

		// Both parts still have exactly one group each
		assert.strictEqual(partA.count, 1);
		assert.strictEqual(partB.count, 1);

		// Part A owns only its own editor; part B owns only its own
		assert.strictEqual(partA.activeGroup.activeEditor, inputA);
		assert.strictEqual(partB.activeGroup.activeEditor, inputB);
		assert.notStrictEqual(partA.activeGroup.activeEditor, partB.activeGroup.activeEditor);

		await workbenchTeardown(instantiationService);
	});

	test('same resource opens in each part independently', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));

		const partA = await createEditorPart(instantiationService, disposables);
		const partB = await createEditorPart(instantiationService, disposables);

		// Open the *same* logical resource in both parts. Each container must
		// track its own active editor instance (this is the core "same URI in
		// A/B" routing requirement).
		const resourceA = URI.file('foo/shared');
		const resourceB = URI.file('foo/shared');

		await partA.activeGroup.openEditor(disposables.add(new TestFileEditorInput(resourceA, TEST_EDITOR_INPUT_ID)), { pinned: true });
		await partB.activeGroup.openEditor(disposables.add(new TestFileEditorInput(resourceB, TEST_EDITOR_INPUT_ID)), { pinned: true });

		// Both parts hold their own editor for the same URI, independently
		assert.strictEqual(partA.count, 1);
		assert.strictEqual(partB.count, 1);
		assert.strictEqual(partA.activeGroup.activeEditor?.resource, resourceA);
		assert.strictEqual(partB.activeGroup.activeEditor?.resource, resourceB);

		// Opening an extra editor in part A must not touch part B
		await partA.activeGroup.openEditor(disposables.add(new TestFileEditorInput(URI.file('foo/barA2'), TEST_EDITOR_INPUT_ID)), { pinned: true });
		assert.strictEqual(partA.activeGroup.count, 2);
		assert.strictEqual(partB.activeGroup.count, 1);
		assert.strictEqual(partB.activeGroup.activeEditor?.resource, resourceB);

		await workbenchTeardown(instantiationService);
	});

	test('closing a group in one part does not affect the other part', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));

		const partA = await createEditorPart(instantiationService, disposables);
		const partB = await createEditorPart(instantiationService, disposables);

		// Give part A a second group so we can remove one of them
		const groupA1 = partA.activeGroup;
		const groupA2 = partA.addGroup(groupA1, GroupDirection.RIGHT);

		const inputA = disposables.add(new TestFileEditorInput(URI.file('foo/barA'), TEST_EDITOR_INPUT_ID));
		const inputB = disposables.add(new TestFileEditorInput(URI.file('foo/barB'), TEST_EDITOR_INPUT_ID));

		await groupA1.openEditor(inputA, { pinned: true });
		await partB.activeGroup.openEditor(inputB, { pinned: true });

		// Remove the (empty) second group from part A - part B must be untouched
		partA.removeGroup(groupA2);

		assert.strictEqual(partA.count, 1);
		assert.strictEqual(partB.count, 1);
		assert.strictEqual(partB.activeGroup.activeEditor, inputB);

		await workbenchTeardown(instantiationService);
	});

	test('disposing one part does not affect the other part', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));

		const partA = await createEditorPart(instantiationService, disposables);
		const partB = await createEditorPart(instantiationService, disposables);

		const inputA = disposables.add(new TestFileEditorInput(URI.file('foo/barA'), TEST_EDITOR_INPUT_ID));
		const inputB = disposables.add(new TestFileEditorInput(URI.file('foo/barB'), TEST_EDITOR_INPUT_ID));

		await partA.activeGroup.openEditor(inputA, { pinned: true });
		await partB.activeGroup.openEditor(inputB, { pinned: true });

		partA.dispose();

		// Part B still works after part A is gone
		assert.strictEqual(partB.count, 1);
		assert.strictEqual(partB.activeGroup.activeEditor, inputB);

		await workbenchTeardown(instantiationService);
	});
});
