/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../../base/common/path.js';
import { Emitter } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILifecycleMainService } from '../../../lifecycle/electron-main/lifecycleMainService.js';
import { NullLogService } from '../../../log/common/log.js';
import { IWorkbenchHost } from '../../../window/electron-main/workbenchHost.js';
import { IWindowsMainService } from '../../../windows/electron-main/windows.js';
import { ISingleFolderWorkspaceIdentifier, IWorkspaceIdentifier } from '../../../workspace/common/workspace.js';
import { ILoadEvent, LoadReason } from '../../../window/electron-main/window.js';
import { ISpace, ISpacesSnapshot, SpaceOperationResult, SPACES_NEW_TAB_CHANNEL } from '../../common/spaces.js';
import { ISpacesFrameProvider, SpacesViewService } from '../../electron-main/spacesViewService.js';
import { IConfigurationService } from '../../../configuration/common/configuration.js';
import { IFileService } from '../../../files/common/files.js';
import { IEnvironmentMainService } from '../../../environment/electron-main/environmentMainService.js';
import { IApplicationStorageMainService } from '../../../storage/electron-main/storageMainService.js';

/**
 * Fake `WebContentsView`-backed host. Tracks its own visibility like a view in
 * a frame would, independently of the frame window.
 */
class FakeViewHost implements IWorkbenchHost {
	visible = false;
	lastFocusTime = Date.now();
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
	creationError: Error | undefined;

	async createWorkbenchHostInFrame(frame: import('electron').BrowserWindow, options: { workspace?: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier }): Promise<IWorkbenchHost> {
		this.createdResources.push({ workspace: options.workspace });
		if (this.creationError) {
			throw this.creationError;
		}
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

function makeConfigService(values: Record<string, unknown> = {}): IConfigurationService {
	return {
		_serviceBrand: undefined,
		getValue: (key?: string) => {
			if (key && Object.hasOwn(values, key)) {
				return values[key];
			}
			return key === 'spaces.root' ? null : false;
		},
		updateValue: async () => { },
		onDidChangeConfiguration: (listener: () => void) => {
			// Config-change listeners are not exercised by these tests.
			return { dispose: () => { } };
		}
	} as unknown as IConfigurationService;
}

function makeFileService(): IFileService {
	/** Overridden per test to simulate folders under the Spaces root. */
	let resolveImplementation: ((r: import('../../../../base/common/uri.js').URI) => Promise<unknown>) | undefined;
	const svc = {
		_serviceBrand: undefined,
		createFolder: async () => ({}) as never,
		del: async () => { },
		readdir: async () => [],
		resolve: (r: import('../../../../base/common/uri.js').URI) => resolveImplementation
			? resolveImplementation(r)
			: Promise.reject(new Error(`No resolve implementation for ${r.fsPath} (set it in the test)`))
	} as unknown as IFileService & { __setResolve: (fn: (r: import('../../../../base/common/uri.js').URI) => Promise<unknown>) => void };
	(svc as unknown as { __setResolve: (fn: (r: import('../../../../base/common/uri.js').URI) => Promise<unknown>) => void }).__setResolve = (fn) => { resolveImplementation = fn; };
	return svc as IFileService;
}

function makeAppStorageService(): IApplicationStorageMainService {
	const map = new Map<string, string>();
	return {
		_serviceBrand: undefined,
		whenReady: Promise.resolve(),
		get: (key: string) => map.get(key),
		store: (key: string, value: string | boolean | number | undefined | null) => {
			if (value === undefined || value === null) { map.delete(key); }
			else { map.set(key, String(value)); }
		},
		remove: (key: string) => { map.delete(key); },
		keys: () => [...map.keys()],
		getBoolean: () => false,
		getNumber: () => 0,
		switch: () => { throw new Error('not implemented'); },
		isNew: () => false
	} as unknown as IApplicationStorageMainService;
}

suite('SpacesViewService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let windowsMainService: FakeWindowsMainService;
	let lifecycleMainService: { quitRequested: boolean };
	let service: SpacesViewService;
	let changes: ISpacesSnapshot[];

	function makeService(userDataPath = join(os.tmpdir(), 'spaces-test-data')): SpacesViewService {
		if (!fs.existsSync(userDataPath)) {
			fs.mkdirSync(userDataPath, { recursive: true });
		}
		const svc = store.add(new SpacesViewService(
			windowsMainService as unknown as IWindowsMainService,
			lifecycleMainService as unknown as ILifecycleMainService,
			new FakeFrameProvider(),
			{} as import('../../../../platform/instantiation/common/instantiation.js').IInstantiationService,
			new NullLogService(),
			makeConfigService(),
			makeFileService(),
			makeAppStorageService(),
			{ userDataPath } as IEnvironmentMainService
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

	test('a failed host creation keeps the calling window open', async () => {
		const config = { workspace: { id: '/work/project-a', uri: URI.file('/work/project-a') } } as import('../../../window/common/window.js').INativeWindowConfiguration;
		const currentWindow = { id: 1, config, openedWorkspace: config.workspace, closed: false, close() { (this as { closed: boolean }).closed = true; } } as unknown as import('../../../window/electron-main/window.js').ICodeWindow;

		windowsMainService.getWindowById = () => currentWindow;
		windowsMainService.creationError = new Error('renderer failed to start');

		const result = await service.addCurrentWindowAsSpace(1);

		assert.strictEqual(result.result, SpaceOperationResult.OpenFailed);
		assert.strictEqual((currentWindow as unknown as { closed: boolean }).closed, false, 'calling window stays open');
		assert.strictEqual((await service.getSpaces(undefined)).spaces.length, 0, 'no space is registered');
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

	test('updateSpaceTabs persists per-Space tab state and getSpaceTabs reads it back', async () => {
		const { a } = await createTwoSpaces();
		const spaceA = await spaceOf(a.id);

		await service.updateSpaceTabs(spaceA.windowId, {
			tabs: [
				{ kind: 'editor', label: 'a.ts', value: '/work/a.ts', detail: '/work' },
				{ kind: 'terminal', label: 'bash', value: '/work' }
			], activeTabIndex: 0
		});

		const state = await service.getSpaceTabs(undefined, spaceA.id);
		assert.strictEqual(state.tabs.length, 2);
		assert.strictEqual(state.tabs[0].kind, 'editor');
		assert.strictEqual(state.tabs[0].value, '/work/a.ts');
		assert.strictEqual(state.tabs[1].kind, 'terminal');
		assert.strictEqual(state.activeTabIndex, 0);
	});

	test('getPersistedTabStateForWindow resolves the calling Space by window id', async () => {
		const { a } = await createTwoSpaces();
		const spaceA = await spaceOf(a.id);

		await service.updateSpaceTabs(spaceA.windowId, { tabs: [{ kind: 'editor', label: 'x.ts', value: '/x.ts' }], activeTabIndex: 0 });
		const state = await service.getPersistedTabStateForWindow(spaceA.windowId);
		assert.strictEqual(state.tabs.length, 1);
		assert.strictEqual(state.tabs[0].value, '/x.ts');

		// Unknown window yields empty state.
		const empty = await service.getPersistedTabStateForWindow(99999);
		assert.deepStrictEqual(empty, { tabs: [], activeTabIndex: 0 });
	});

	test('getSidebarSettings reads the configured spaces settings', async () => {
		const settings = await service.getSidebarSettings(undefined);
		assert.strictEqual(settings.spacesRoot, null);
		assert.strictEqual(settings.showSpaceTabs, false);
		assert.strictEqual(settings.showSpaceInitials, false);
	});

	test('sendToSpace routes a message to the Space host renderer', async () => {
		const { a } = await createTwoSpaces();
		const spaceA = await spaceOf(a.id);
		const messages: Array<{ channel: string; args: unknown[] }> = [];
		a.send = (channel: string, ...args: unknown[]) => {
			messages.push({ channel, args });
		};

		await service.sendToSpace(undefined, spaceA.id, SPACES_NEW_TAB_CHANNEL);
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0].channel, SPACES_NEW_TAB_CHANNEL);
	});

	test('hasPersistedState is false before any Space exists and true after creating one', async () => {
		const dataPath = join(os.tmpdir(), `spaces-state-${Date.now()}-${Math.random()}`);
		const svc = makeService(dataPath);
		assert.strictEqual(svc.hasPersistedState(), false);

		await svc.createEmptySpace(undefined);
		assert.strictEqual(svc.hasPersistedState(), true);
	});

	test('restorePersistedState recreates Spaces with their ids and the active one', async () => {
		const dataPath = join(os.tmpdir(), `spaces-state-${Date.now()}-${Math.random()}`);
		const svc = makeService(dataPath);

		await svc.openFolderAsSpace(undefined, URI.file('/work/project-a'));
		const hostA = [...windowsMainService.hosts.values()][0]!;
		const spaceA = (await svc.getSpaces(undefined)).spaces.find(s => s.windowId === hostA.id)!;
		assert.ok(spaceA, 'first Space exists');

		await svc.createEmptySpace(undefined);
		const spaceB = (await svc.getSpaces(undefined)).spaces.find(s => s.id !== spaceA.id)!;
		await svc.switchToSpace(undefined, spaceB.id);

		// "Restart": a fresh service with the same user data directory.
		const restarted = makeService(dataPath);
		assert.strictEqual(restarted.hasPersistedState(), true);
		const restored = await restarted.restorePersistedState();
		assert.strictEqual(restored, true);

		const snapshot = await restarted.getSpaces(undefined);
		assert.strictEqual(snapshot.spaces.length, 2);
		assert.ok(snapshot.spaces.some(s => s.id === spaceA.id), 'Space A id is restored');
		assert.ok(snapshot.spaces.some(s => s.id === spaceB.id), 'Space B id is restored');
		assert.strictEqual(snapshot.activeSpaceId, spaceB.id, 'the previously active Space stays active');
	});

	test('restorePersistedState with an empty or missing state returns false', async () => {
		const dataPath = join(os.tmpdir(), `spaces-state-${Date.now()}-${Math.random()}`);
		const svc = makeService(dataPath);
		assert.strictEqual(await svc.restorePersistedState(), false);

		// A state file with zero Spaces is also not restorable.
		fs.writeFileSync(join(dataPath, 'spaces-state.json'), JSON.stringify({ version: 1, spaces: [] }), 'utf8');
		assert.strictEqual(svc.hasPersistedState(), false);
		assert.strictEqual(await svc.restorePersistedState(), false);
	});

	test('scanSpacesRoot adds every first-level sub-folder of the root as a Space', async () => {
		const svc = makeService();
		const fileService = (svc as unknown as { fileService: IFileService }).fileService as IFileService & { __setResolve: (fn: (r: import('../../../../base/common/uri.js').URI) => Promise<unknown>) => void };
		fileService.__setResolve(async (r) => {
			const children = [
				{ resource: URI.file('/spaces-root/alpha'), isDirectory: true, isSymbolicLink: false, children: undefined },
				{ resource: URI.file('/spaces-root/beta'), isDirectory: true, isSymbolicLink: false, children: undefined },
				{ resource: URI.file('/spaces-root/notes.md'), isDirectory: false, isSymbolicLink: false, children: undefined },
				{ resource: URI.file('/spaces-root/.hidden'), isDirectory: true, isSymbolicLink: false, children: undefined }
			];
			return { isDirectory: true, children };
		});
		const configService = (svc as unknown as { configurationService: IConfigurationService }).configurationService as { getValue: (k?: string) => unknown };
		configService.getValue = (key?: string) => key === 'spaces.root' ? '/spaces-root' : false;

		await svc.scanSpacesRoot();

		const snapshot = await svc.getSpaces(undefined);
		assert.deepStrictEqual(snapshot.spaces.map(s => s.workspace?.uri.fsPath).sort(), ['/spaces-root/alpha', '/spaces-root/beta']);
		assert.strictEqual(snapshot.spaces.filter(s => s.state === 'active').length, 1, 'exactly one Space is active');
	});

	test('scanSpacesRoot skips folders that are already open as a Space', async () => {
		const svc = makeService();
		const fileService = (svc as unknown as { fileService: IFileService }).fileService as IFileService & { __setResolve: (fn: (r: import('../../../../base/common/uri.js').URI) => Promise<unknown>) => void };
		const configService = (svc as unknown as { configurationService: IConfigurationService }).configurationService as { getValue: (k?: string) => unknown };
		configService.getValue = (key?: string) => key === 'spaces.root' ? '/spaces-root' : false;

		// alpha is already open as a Space.
		await svc.openFolderAsSpace(undefined, URI.file('/spaces-root/alpha'));

		fileService.__setResolve(async () => {
			return {
				isDirectory: true,
				children: [
					{ resource: URI.file('/spaces-root/alpha'), isDirectory: true, isSymbolicLink: false, children: undefined },
					{ resource: URI.file('/spaces-root/beta'), isDirectory: true, isSymbolicLink: false, children: undefined }
				]
			};
		});

		await svc.scanSpacesRoot();

		const snapshot = await svc.getSpaces(undefined);
		assert.deepStrictEqual(snapshot.spaces.map(s => s.workspace?.uri.fsPath).sort(), ['/spaces-root/alpha', '/spaces-root/beta']);
	});

	test('scanSpacesRoot with an unreadable root keeps existing Spaces and does not throw', async () => {
		const svc = makeService();
		const fileService = (svc as unknown as { fileService: IFileService }).fileService as IFileService & { __setResolve: (fn: (r: import('../../../../base/common/uri.js').URI) => Promise<unknown>) => void };
		const configService = (svc as unknown as { configurationService: IConfigurationService }).configurationService as { getValue: (k?: string) => unknown };
		configService.getValue = (key?: string) => key === 'spaces.root' ? '/missing-root' : false;
		fileService.__setResolve(async () => Promise.reject(new Error('ENOENT: no such file')));

		await svc.openFolderAsSpace(undefined, URI.file('/work/existing'));

		await svc.scanSpacesRoot(); // must not reject

		const snapshot = await svc.getSpaces(undefined);
		assert.strictEqual(snapshot.spaces.length, 1);
		assert.strictEqual(snapshot.spaces[0].workspace?.uri.fsPath, '/work/existing');
	});

	test('createSpace creates a folder under the configured spaces root', async () => {
		// Configure a spaces root through the fake config service.
		const fakeConfig = (service as unknown as { configurationService: IConfigurationService }).configurationService as { getValue: (k?: string) => unknown };
		fakeConfig.getValue = (key?: string) => key === 'spaces.root' ? '/tmp/spaces' : false;
		const fakeFile = (service as unknown as { fileService: IFileService }).fileService as { createFolder: (uri: import('../../../../base/common/uri.js').URI) => Promise<unknown> };
		const created: unknown[] = [];
		fakeFile.createFolder = async (uri) => { created.push(uri); return {} as never; };

		const result = await service.createSpace(undefined, 'my space');
		assert.strictEqual(result.result, SpaceOperationResult.Ok);
		assert.strictEqual(created.length, 1);
	});

});
