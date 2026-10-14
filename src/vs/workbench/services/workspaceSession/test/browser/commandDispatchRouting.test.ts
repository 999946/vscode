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

suite('WorkspaceSession - Global Command Routing', () => {

	const TEST_EDITOR_ID = 'MyFileEditorForCommandRouting';
	const TEST_EDITOR_INPUT_ID = 'testEditorInputForCommandRouting';

	const disposables = new DisposableStore();

	// Commands whose handlers read the workspace context / open editors, so a
	// routed handler can be told apart from a non-routed one by its result.
	let routeCmdId: string;
	let openCmdId: string;

	setup(() => {
		disposables.add(registerTestEditor(TEST_EDITOR_ID, [new SyncDescriptor(TestFileEditorInput)], TEST_EDITOR_INPUT_ID));

		// Returns the workspace root the handler resolved through its
		// instantiation service: the session root when routed to the session
		// part, the main root otherwise.
		routeCmdId = 'test.routeContext';
		disposables.add(CommandsRegistry.registerCommand(routeCmdId, accessor => {
			const contextService = accessor.get(IWorkspaceContextService);
			return contextService.getWorkspace().folders[0].uri.toString();
		}));

		// Opens an editor through the handler's resolved editor service, which
		// is part-scoped when routed to a session part.
		openCmdId = 'test.routeOpen';
		disposables.add(CommandsRegistry.registerCommand(openCmdId, async accessor => {
			const editorService = accessor.get(IEditorService);
			const input = new TestFileEditorInput(URI.file('/routing/foo'), TEST_EDITOR_INPUT_ID);
			await editorService.openEditor(input, { pinned: true });
			return editorService.activeEditor?.resource?.fsPath;
		}));
	});

	teardown(async () => {
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	// Creates the workbench with a real EditorParts instance (stubbed as
	// IEditorGroupsService) and the real window-level command service. The
	// command service resolves IEditorGroupsService from the container, so it
	// routes handlers to the active session part when one is active.
	async function createWorkbench(): Promise<{ instantiationService: IInstantiationService; parts: Awaited<ReturnType<typeof createEditorParts>> }> {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, disposables);

		// Substitute a real editor service and route it at the test parts (the
		// mock group's onWillDispose never fires, which would leak group
		// listeners otherwise).
		instantiationService.stub(IEditorGroupsService, parts);
		const realEditorService = disposables.add(instantiationService.createInstance(EditorService, undefined));
		instantiationService.stub(IEditorService, realEditorService);
		instantiationService.stub(ICommandService, disposables.add(instantiationService.createInstance(CommandService)));

		return { instantiationService, parts };
	}

	// Mirrors the production createSession: a child service collection with a
	// workspace context bound to the session's folder and a command service
	// scoped to the session.
	function createTestSession(instantiationService: IInstantiationService, sessionId: string, folderPath: string): IWorkspaceSession {
		const services = new ServiceCollection();
		services.set(IWorkspaceContextService, new TestContextService(testWorkspace(URI.file(folderPath))));

		const child = instantiationService.createChild(services);
		disposables.add(child);

		const commandService = child.createInstance(CommandService);
		services.set(ICommandService, commandService);
		disposables.add(commandService);

		return new TestWorkspaceSession(sessionId, child, {
			sessionId,
			workspace: { id: `ws-${sessionId}`, uri: URI.file(folderPath) },
			rootUris: [URI.file(folderPath)]
		});
	}

	test('window command service routes to the active session part when it is active', async () => {
		const { instantiationService, parts } = await createWorkbench();
		const globalCmd = instantiationService.invokeFunction(a => a.get(ICommandService));

		// Before any session part exists the handler resolves the main root.
		assert.strictEqual(await globalCmd.executeCommand(routeCmdId), TestWorkspace.folders[0].uri.toString());

		const session = createTestSession(instantiationService, 'session-routing', '/routing');
		const sessionPart = parts.createSessionEditorPart(session);

		// The session part is the active part (most recently created /
		// focused), so the same global command now resolves the session root.
		assert.strictEqual(parts.activePart, sessionPart);
		assert.strictEqual(await globalCmd.executeCommand(routeCmdId), URI.file('/routing').toString());

		await workbenchTeardown(instantiationService);
	});

	test('focusing the main editor part routes window commands back to the main workspace', async () => {
		const { instantiationService, parts } = await createWorkbench();
		const globalCmd = instantiationService.invokeFunction(a => a.get(ICommandService));

		const session = createTestSession(instantiationService, 'session-routing', '/routing');
		const sessionPart = parts.createSessionEditorPart(session);
		assert.strictEqual(await globalCmd.executeCommand(routeCmdId), URI.file('/routing').toString());

		// Focus the main part's active group; group focus propagates to the
		// part and bumps the main part to the top of the active-parts MRU.
		parts.mainPart.activeGroup.focus();
		assert.strictEqual(parts.activePart, parts.mainPart);
		assert.strictEqual(await globalCmd.executeCommand(routeCmdId), TestWorkspace.folders[0].uri.toString());

		await workbenchTeardown(instantiationService);
	});

	test('routing switches between multiple session parts as the active part changes', async () => {
		const { instantiationService, parts } = await createWorkbench();
		const globalCmd = instantiationService.invokeFunction(a => a.get(ICommandService));

		const sessionA = createTestSession(instantiationService, 'session-routing-a', '/routing-a');
		const partA = parts.createSessionEditorPart(sessionA);
		const sessionB = createTestSession(instantiationService, 'session-routing-b', '/routing-b');
		const partB = parts.createSessionEditorPart(sessionB);

		// partB is the most recently created / focused, so commands route there.
		assert.strictEqual(parts.activePart, partB);
		assert.strictEqual(await globalCmd.executeCommand(routeCmdId), URI.file('/routing-b').toString());

		// Focusing partA's group routes commands to session A.
		parts.getSessionEditorPart('session-routing-a')!.activeGroup.focus();
		assert.strictEqual(parts.activePart, partA);
		assert.strictEqual(await globalCmd.executeCommand(routeCmdId), URI.file('/routing-a').toString());

		await workbenchTeardown(instantiationService);
	});

	test('routed handlers resolve a part-scoped editor service bound to the active session part', async () => {
		const { instantiationService, parts } = await createWorkbench();
		const globalCmd = instantiationService.invokeFunction(a => a.get(ICommandService));

		const session = createTestSession(instantiationService, 'session-routing', '/routing');
		const sessionPart = parts.createSessionEditorPart(session);

		// The routed handler's editor service is scoped to the session part, so
		// the editor opens in the session part's group only.
		const openedPath = await globalCmd.executeCommand(openCmdId);
		assert.strictEqual(openedPath, '/routing/foo');
		assert.strictEqual(sessionPart.activeGroup.activeEditor?.resource?.fsPath, '/routing/foo');
		assert.strictEqual(parts.mainPart.activeGroup.count, 0);

		await workbenchTeardown(instantiationService);
	});
});
