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
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IWorkspaceSession, WorkspaceSessionState } from '../../common/workspaceSession.js';
import { IAnyWorkspaceIdentifier } from '../../../../../platform/workspace/common/workspace.js';
import { TestFileEditorInput, registerTestEditor, createEditorParts, workbenchInstantiationService, workbenchTeardown } from '../../../../test/browser/workbenchTestServices.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

class TestWorkspaceSession implements IWorkspaceSession {

	readonly state = WorkspaceSessionState.Running;
	readonly ready: Promise<void> = Promise.resolve();

	constructor(
		readonly sessionId: string,
		readonly scopedInstantiationService: IInstantiationService,
		readonly context: { sessionId: string; workspace: IAnyWorkspaceIdentifier; rootUris: readonly URI[] },
	) { }

	dispose(): void { }
}

suite('WorkspaceSession - Session Editor Part', () => {

	const TEST_EDITOR_ID = 'MyFileEditorForSessionEditorPart';
	const TEST_EDITOR_INPUT_ID = 'testEditorInputForSessionEditorPart';

	const disposables = new DisposableStore();

	setup(() => {
		disposables.add(registerTestEditor(TEST_EDITOR_ID, [new SyncDescriptor(TestFileEditorInput)], TEST_EDITOR_INPUT_ID));
	});

	teardown(async () => {
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('creates a dedicated part per session with isolated tabs', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, disposables);

		const partA = parts.createSessionEditorPart(createTestSession(instantiationService, 'session-a', '/a'));
		const partB = parts.createSessionEditorPart(createTestSession(instantiationService, 'session-b', '/b'));

		assert.notStrictEqual(partA, partB);
		assert.strictEqual(parts.parts.length, 3); // main + session A + session B

		// Open a distinct file in each session part; tabs stay isolated
		await partA.activeGroup.openEditor(disposables.add(new TestFileEditorInput(URI.file('/a/foo'), TEST_EDITOR_INPUT_ID)), { pinned: true });
		await partB.activeGroup.openEditor(disposables.add(new TestFileEditorInput(URI.file('/b/foo'), TEST_EDITOR_INPUT_ID)), { pinned: true });

		assert.strictEqual(partA.activeGroup.activeEditor?.resource?.fsPath, '/a/foo');
		assert.strictEqual(partB.activeGroup.activeEditor?.resource?.fsPath, '/b/foo');

		// Opening extra tabs in A does not touch B
		await partA.activeGroup.openEditor(disposables.add(new TestFileEditorInput(URI.file('/a/bar'), TEST_EDITOR_INPUT_ID)), { pinned: true });
		assert.strictEqual(partA.activeGroup.count, 2);
		assert.strictEqual(partB.activeGroup.count, 1);

		await workbenchTeardown(instantiationService);
	});

	test('reuses the existing part for the same session', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, disposables);

		const session = createTestSession(instantiationService, 'session-x', '/x');

		const partA = parts.createSessionEditorPart(session);
		const partB = parts.createSessionEditorPart(session);

		assert.strictEqual(partA, partB);
		assert.strictEqual(parts.parts.length, 2);

		await workbenchTeardown(instantiationService);
	});

	test('disposing a session part cleans itself up and can be recreated', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, disposables);

		const session = createTestSession(instantiationService, 'session-y', '/y');
		const part = parts.createSessionEditorPart(session);

		await part.activeGroup.openEditor(disposables.add(new TestFileEditorInput(URI.file('/y/foo'), TEST_EDITOR_INPUT_ID)), { pinned: true });
		assert.strictEqual(part.activeGroup.activeEditor?.resource?.fsPath, '/y/foo');

		part.dispose();

		// Recreating for the same session returns a fresh part (old maps were cleaned up)
		const part2 = parts.createSessionEditorPart(session);
		assert.notStrictEqual(part, part2);
		assert.strictEqual(parts.parts.length, 2);

		await workbenchTeardown(instantiationService);
	});

	function createTestSession(instantiationService: IInstantiationService, sessionId: string, folderPath: string): IWorkspaceSession {
		const child = instantiationService.createChild(new ServiceCollection());
		disposables.add(child);

		return new TestWorkspaceSession(sessionId, child, {
			sessionId,
			workspace: { id: `ws-${sessionId}`, uri: URI.file(folderPath) },
			rootUris: [URI.file(folderPath)]
		});
	}
});