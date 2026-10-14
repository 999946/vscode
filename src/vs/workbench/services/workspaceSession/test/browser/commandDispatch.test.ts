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
import { IAnyWorkspaceIdentifier, IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ICommandService, CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { EditorService } from '../../../../services/editor/browser/editorService.js';
import { testWorkspace, TestWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
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

suite('WorkspaceSession - Command Dispatch', () => {

	const TEST_EDITOR_ID = 'MyFileEditorForCommandDispatch';
	const TEST_EDITOR_INPUT_ID = 'testEditorInputForCommandDispatch';

	const disposables = new DisposableStore();

	setup(() => {
		disposables.add(registerTestEditor(TEST_EDITOR_ID, [new SyncDescriptor(TestFileEditorInput)], TEST_EDITOR_INPUT_ID));
	});

	teardown(async () => {
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('creates a session-scoped command service distinct from the global one', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(ICommandService, disposables.add(instantiationService.createInstance(CommandService)));

		const session = createTestSession(instantiationService, 'session-dispatch', '/dispatch');

		const globalCmd = instantiationService.invokeFunction(a => a.get(ICommandService));
		const sessionCmd = session.scopedInstantiationService.invokeFunction(a => a.get(ICommandService));

		assert.notStrictEqual(globalCmd, sessionCmd);

		await workbenchTeardown(instantiationService);
	});

	test('command handler resolves the session workspace context, isolated from the global one', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(ICommandService, disposables.add(instantiationService.createInstance(CommandService)));

		const cmdId = 'test.dispatchCommand';
		disposables.add(CommandsRegistry.registerCommand(cmdId, accessor => {
			const contextService = accessor.get(IWorkspaceContextService);
			return contextService.getWorkspace().folders[0].uri.toString();
		}));

		const session = createTestSession(instantiationService, 'session-dispatch', '/dispatch');

		// Executed through the session's command service the handler sees the
		// session's workspace root ...
		const sessionCmd = session.scopedInstantiationService.invokeFunction(a => a.get(ICommandService));
		const result = await sessionCmd.executeCommand(cmdId);
		assert.strictEqual(result, URI.file('/dispatch').toString());

		// ... while through the global command service it sees the main root.
		const globalCmd = instantiationService.invokeFunction(a => a.get(ICommandService));
		const globalResult = await globalCmd.executeCommand(cmdId);
		assert.strictEqual(globalResult, TestWorkspace.folders[0].uri.toString());

		await workbenchTeardown(instantiationService);
	});

	test('session part dispatch service provides a scoped editor service bound to the session part', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, disposables);

		// Substitute a real editor service: TestEditorService.createScoped
		// returns itself (not truly scoped), which would not exercise the
		// per-part binding produced by getScopedInstantiationService. Route it
		// at the test parts rather than the default TestEditorGroupsService so
		// its group listeners attach to real groups (the mock group's
		// onWillDispose never fires, which would leak).
		instantiationService.stub(IEditorGroupsService, parts);
		const realEditorService = disposables.add(instantiationService.createInstance(EditorService, undefined));
		instantiationService.stub(IEditorService, realEditorService);

		const session = createTestSession(instantiationService, 'session-dispatch', '/dispatch');
		const part = parts.createSessionEditorPart(session);

		const sessionDispatchIS = parts.getScopedInstantiationService(part);
		assert.notStrictEqual(sessionDispatchIS, session.scopedInstantiationService);

		// The dispatch service resolves the session's command service through
		// the session scoped services chain.
		assert.strictEqual(
			sessionDispatchIS.invokeFunction(a => a.get(ICommandService)),
			session.scopedInstantiationService.invokeFunction(a => a.get(ICommandService))
		);

		// Its editor service is scoped to the session part's groups: opening an
		// editor into the session part goes there only.
		const sessionEditorService = sessionDispatchIS.invokeFunction(a => a.get(IEditorService));
		await sessionEditorService.openEditor(disposables.add(new TestFileEditorInput(URI.file('/dispatch/foo'), TEST_EDITOR_INPUT_ID)), { pinned: true }, part.activeGroup);
		assert.strictEqual(sessionEditorService.activeEditor?.resource?.fsPath, '/dispatch/foo');
		assert.strictEqual(part.activeGroup.activeEditor?.resource?.fsPath, '/dispatch/foo');
		assert.strictEqual(parts.mainPart.activeGroup.count, 0);

		await workbenchTeardown(instantiationService);
	});

	function createTestSession(instantiationService: IInstantiationService, sessionId: string, folderPath: string): IWorkspaceSession {
		const services = new ServiceCollection();

		// Workspace context bound to this session's folder (distinct from the
		// global TestWorkspace root).
		services.set(IWorkspaceContextService, new TestContextService(testWorkspace(URI.file(folderPath))));

		const child = instantiationService.createChild(services);
		disposables.add(child);

		// Mirror what the production createSession does: a command service that
		// resolves its handler dependencies through this session's scoped
		// services. `services.set` after `createChild` is fine since service
		// resolution is lazy.
		const commandService = child.createInstance(CommandService);
		services.set(ICommandService, commandService);
		disposables.add(commandService);

		return new TestWorkspaceSession(sessionId, child, {
			sessionId,
			workspace: { id: `ws-${sessionId}`, uri: URI.file(folderPath) },
			rootUris: [URI.file(folderPath)]
		});
	}
});