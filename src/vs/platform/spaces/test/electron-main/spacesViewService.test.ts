/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILifecycleMainService } from '../../../lifecycle/electron-main/lifecycleMainService.js';
import { NullLogService } from '../../../log/common/log.js';
import { IWorkbenchHost } from '../../../window/electron-main/workbenchHost.js';
import { IWindowsMainService } from '../../../windows/electron-main/windows.js';
import { ISingleFolderWorkspaceIdentifier, IWorkspaceIdentifier } from '../../../workspace/common/workspace.js';
import { ILoadEvent, LoadReason } from '../../../window/electron-main/window.js';
import { ISpace, ISpacesSnapshot, SpaceOperationResult } from '../../common/spaces.js';
import { ISpacesFrameProvider, SpacesViewService } from '../../electron-main/spacesViewService.js';

/**
 * Fake `WebContentsView`-backed host. Tracks its own visibility like a view in
 * a frame would, independently of the frame window.
 */
class FakeViewHost implements IWorkbenchHost {
	visible = false;
	isReady = false;
	openedWorkspace: ISingleFolderWorkspaceIdentifier | IWorkspaceIdentifier | undefined;
	config = undefined;
	webContents: Electron.WebContents | null;
	focusCalls = 0;
	closed = false;

	private readonly _onWillFocus = new Emitter<void>();
	readonly onWillFocus = this._onWillFocus.event;
	private readonly _onDidRequestAttention = new Emitter<void>();
	readonly onDidRequestAttention = this._onDidRequestAttention.event;
	private readonly _onDidClose = new Emitter<void>();
	readonly onDidClose = this._onDidClose.event;
	private readonly _onDidDestroy = new Emitter<void>();
	readonly onDidDestroy = this._onDidDestroy.event;
	private readonly _onWillLoad = new Emitter<ILoadEvent>();
	readonly onWillLoad = this._onWillLoad.event;
	private readonly _onDidSignalReady = new Emitter<void>();
	readonly onDidSignalReady = this._onDidSignalReady.event;

	constructor(readonly id: number) {
		this.webContents = { id, isDestroyed: () => false } as unknown as Electron.WebContents;
	}

	show(): void { this.visible = true; }
	hide(): void { this.visible = false; }
	focus(): void { this.focusCalls++; this._onWillFocus.fire(); }
	getBounds(): Electron.Rectangle { return { x: 0, y: 0, width: 1200, height: 800 }; }
	matches(webContents: Electron.WebContents): boolean { return false; }
	send(channel: string, ...args: unknown[]): void { throw new Error('Method not implemented.'); }
	sendWhenReady(channel: string, token: import('../../../../base/common/cancellation.js').CancellationToken, ...args: unknown[]): void { throw new Error('Method not implemented.'); }
	load(config: import('../../../window/common/window.js').INativeWindowConfiguration, options?: { isReload?: boolean }): void {
		this.openedWorkspace = config.workspace;
	}
	setReady(): void { this.isReady = true; this._onDidSignalReady.fire(); }
	whenClosedOrLoaded: Promise<void> = new Promise(() => { });
	close(): void {
		if (!this.closed) {
			this.closed = true;
			this._onDidClose.fire();
		}
	}

	fireFocus(): void { this._onWillFocus.fire(); }
	fireDestroyed(): void { this._onDidDestroy.fire(); }
	fireWillLoad(folder: string): void {
		this.openedWorkspace = { id: folder, uri: URI.file(folder) };
		this._onWillLoad.fire({ workspace: this.openedWorkspace, reason: LoadReason.LOAD });
	}
	dispose(): void { }
}

class FakeFrameProvider implements ISpacesFrameProvider {
	private index = 0;
	createFrame(): import('electron').BrowserWindow | undefined {
		return { id: ++this.index, isDestroyed: () => false } as unknown as import('electron').BrowserWindow;
	}
}

class FakeWindowsMainService implements Pick<IWindowsMainService, 'createWorkbenchHostInFrame' | 'getWindowById' | 'getWindows'> {
	nextHostId = 100;
	hosts = new Map<number, FakeViewHost>();
	createdResources: Array<{ workspace: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined }> = [];

	async createWorkbenchHostInFrame(frame: import('electron').BrowserWindow, options: { workspace?: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier }): Promise<IWorkbenchHost> {
		this.createdResources.push({ workspace: options.workspace });
		const host = new FakeViewHost(this.nextHostId++);
		this.hosts.set(host.id, host);
		return host;
	}

	getWindowById(windowId: number): import('../../../window/electron-main/window.js').ICodeWindow | undefined {
		return undefined;
	}

	getWindows(): import('../../../window/electron-main/window.js').ICodeWindow[] {
		return [];
	}
}

suite('SpacesViewService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let windowsMainService: FakeWindowsMainService;
	let lifecycleMainService: { quitRequested: boolean };
	let service: SpacesViewService;
	let changes: ISpacesSnapshot[];

	function makeService(): SpacesViewService {
		const svc = store.add(new SpacesViewService(
			windowsMainService as unknown as IWindowsMainService,
			lifecycleMainService as unknown as ILifecycleMainService,
			new FakeFrameProvider(),
			{} as import('../../../../platform/instantiation/common/instantiation.js').IInstantiationService,
			new NullLogService()
		));
		store.add(svc.onDidChangeSpaces(snapshot => changes.push(snapshot)));
		return svc;
	}

	setup(() => {
		windowsMainService = new FakeWindowsMainService();
		lifecycleMainService = { quitRequested: false };
		changes = [];
		service = makeService();
	});

	async function spaceOf(hostId: number): Promise<ISpace> {
		const space = (await service.getSpaces(undefined)).spaces.find(space => space.windowId === hostId);
		assert.ok(space, `host ${hostId} is not a space`);
		return space;
	}

	async function createTwoSpaces(): Promise<{ a: FakeViewHost; b: FakeViewHost }> {
		// First space: empty
		await service.createEmptySpace(undefined);
		const hosts = [...windowsMainService.hosts.values()];
		assert.strictEqual(hosts.length, 1);
		const a = hosts[0];

		// Second space: folder
		const result = await service.openFolderAsSpace(undefined, URI.file('/work/project-b'));
		assert.strictEqual(result.result, SpaceOperationResult.Ok);
		const hostsAfter = [...windowsMainService.hosts.values()];
		assert.strictEqual(hostsAfter.length, 2);
		const b = hostsAfter.find(host => host.id !== a.id)!;

		return { a, b };
	}

	test('adopts the calling window as a view host in the frame', async () => {
		// A "current window" (CodeWindow) with a folder becomes the first space;
		// the original window is closed and one view host owns the frame.
		const config = { workspace: { id: '/work/project-a', uri: URI.file('/work/project-a') } } as import('../../../window/common/window.js').INativeWindowConfiguration;
		const currentWindow = { id: 1, config, openedWorkspace: config.workspace, closed: false, close() { (this as { closed: boolean }).closed = true; } } as unknown as import('../../../window/electron-main/window.js').ICodeWindow;

		windowsMainService.getWindowById = () => currentWindow;

		const result = await service.addCurrentWindowAsSpace(1);

		assert.strictEqual(result.result, SpaceOperationResult.Ok);
		const snapshot = await service.getSpaces(1);
		assert.strictEqual(snapshot.spaces.length, 1);
		const host = [...windowsMainService.hosts.values()][0]!;
		assert.strictEqual(snapshot.spaces[0].windowId, host.id);
		assert.strictEqual(host.visible, true);
		assert.strictEqual((currentWindow as unknown as { closed: boolean }).closed, true, 'original window is closed');
	});

	test('opening a folder as space creates a view host and activates it', async () => {
		const result = await service.openFolderAsSpace(undefined, URI.file('/work/project-a'));

		assert.strictEqual(result.result, SpaceOperationResult.Ok);
		assert.strictEqual(windowsMainService.createdResources.length, 1);
		const created = windowsMainService.createdResources[0]?.workspace;
		assert.ok(created, 'expected a workspace to be loaded');
		const folder = created as ISingleFolderWorkspaceIdentifier;
		assert.strictEqual(folder.id, '/work/project-a');
		assert.strictEqual(folder.uri.toString(), URI.file('/work/project-a').toString());

		const host = [...windowsMainService.hosts.values()][0]!;
		assert.strictEqual(host.visible, true, 'active space is visible');
	});

	test('switching spaces swaps the visible view', async () => {
		const { a, b } = await createTwoSpaces();

		// b is active
		assert.strictEqual(b.visible, true);
		assert.strictEqual(a.visible, false);

		const result = await service.switchToSpace(undefined, (await spaceOf(a.id)).id);

		assert.strictEqual(result.result, SpaceOperationResult.Ok);
		assert.strictEqual(a.visible, true);
		assert.strictEqual(b.visible, false);
		assert.ok(a.focusCalls > 0);
	});

	test('switching back to the active space keeps it visible', async () => {
		const { a, b } = await createTwoSpaces();
		const spaceA = await spaceOf(a.id);
		const focusCallsBefore = a.focusCalls;

		await service.switchToSpace(undefined, spaceA.id);
		await service.switchToSpace(undefined, spaceA.id);

		assert.strictEqual(a.visible, true);
		assert.strictEqual(b.visible, false);
		assert.ok(a.focusCalls > focusCallsBefore);
	});

	test('closing the active space activates the most recently active space', async () => {
		const { a, b } = await createTwoSpaces();
		const spaceB = await spaceOf(b.id);

		await service.switchToSpace(undefined, (await spaceOf(a.id)).id);
		await service.closeSpace(undefined, spaceB.id);

		const snapshot = await service.getSpaces(undefined);
		assert.deepStrictEqual(snapshot.spaces.map(space => space.id), [(await spaceOf(a.id)).id]);
		assert.strictEqual(snapshot.activeSpaceId, (await spaceOf(a.id)).id);
		assert.strictEqual(a.visible, true, 'most recently active space takes the frame');
	});

	test('closing a space removes only that space', async () => {
		const { a, b } = await createTwoSpaces();
		const closedVisible = b.visible;

		await service.closeSpace(undefined, (await spaceOf(b.id)).id);

		assert.strictEqual(closedVisible, true, 'the active space was visible before closing');
		assert.deepStrictEqual((await service.getSpaces(undefined)).spaces.map(space => space.windowId), [a.id]);
		assert.strictEqual(a.visible, true);
		assert.strictEqual((await spaceOf(a.id)).state, 'active');
	});

	test('attention request of an inactive space marks it until it becomes active', async () => {
		const { a, b } = await createTwoSpaces();
		const spaceA = await spaceOf(a.id);

		a.fireFocus(); // programmatic focus reveals + activates
		await service.switchToSpace(undefined, (await spaceOf(b.id)).id);
		await service.requestAttention(a.id);

		assert.strictEqual((await spaceOf(a.id)).needsAttention, true);
		assert.strictEqual(a.visible, false, 'attention requests do not switch spaces');

		await service.switchToSpace(undefined, spaceA.id);
		assert.strictEqual((await spaceOf(a.id)).needsAttention, false);
	});

	test('loading another folder in a space updates its name', async () => {
		const { b } = await createTwoSpaces();
		const spaceB = await spaceOf(b.id);

		b.fireWillLoad('/work/project-c');

		assert.strictEqual((await spaceOf(b.id)).id, spaceB.id);
		assert.strictEqual((await spaceOf(b.id)).name, 'project-c');
	});

	test('host close event removes the space', async () => {
		const { a, b } = await createTwoSpaces();
		const spaceB = await spaceOf(b.id);

		b.close();

		const snapshot = await service.getSpaces(undefined);
		assert.deepStrictEqual(snapshot.spaces.map(space => space.windowId), [a.id]);
		assert.strictEqual(snapshot.activeSpaceId, (await spaceOf(a.id)).id);
		assert.strictEqual(a.visible, true);
		assert.strictEqual(snapshot.spaces.some(space => space.id === spaceB.id), false);
	});

	test('does not reveal another space while the application quits', async () => {
		const { a, b } = await createTwoSpaces();
		lifecycleMainService.quitRequested = true;

		b.close();

		assert.strictEqual(a.visible, false, 'do not flash a space while quitting');
		assert.strictEqual(await (async () => (await service.getSpaces(undefined)).activeSpaceId)(), undefined);
	});
});
