/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IAuxiliaryWindowsMainService } from '../../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { IEnvironmentMainService } from '../../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../../lifecycle/electron-main/lifecycleMainService.js';
import { NullLogService } from '../../../log/common/log.js';
import { FocusMode } from '../../../native/common/native.js';
import { ILoadEvent, LoadReason } from '../../../window/electron-main/window.js';
import { IOpenConfiguration, IWindowsMainService } from '../../../windows/electron-main/windows.js';
import { IWorkbenchHostRegistry } from '../../../window/electron-main/workbenchHostRegistry.js';
import { ISingleFolderWorkspaceIdentifier } from '../../../workspace/common/workspace.js';
import { ISpace, ISpacesSnapshot, SpaceOperationResult } from '../../common/spaces.js';
import { SpacesMainService } from '../../electron-main/spacesMainService.js';

interface IBounds { x: number; y: number; width: number; height: number }

/**
 * Minimal `BrowserWindow` stand-in. Like Electron on macOS, programmatic
 * `show()`, `hide()` and `focus()` emit no events and `focus()` does not show
 * a hidden window.
 */
class FakeBrowserWindow {
	visible = true;
	minimized = false;
	maximized = false;
	destroyed = false;
	focused = false;
	bounds: IBounds;

	private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

	constructor(bounds: IBounds) {
		this.bounds = { ...bounds };
	}

	on(event: string, listener: (...args: unknown[]) => void): this {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
		return this;
	}

	removeListener(event: string, listener: (...args: unknown[]) => void): this {
		this.listeners.get(event)?.delete(listener);
		return this;
	}

	emit(event: string): void {
		for (const listener of [...this.listeners.get(event) ?? []]) {
			listener();
		}
	}

	isVisible(): boolean { return this.visible; }
	isMinimized(): boolean { return this.minimized; }
	isMaximized(): boolean { return this.maximized; }
	isDestroyed(): boolean { return this.destroyed; }
	show(): void { this.visible = true; }
	showInactive(): void { this.visible = true; }
	hide(): void { this.visible = false; }
	focus(): void { this.focused = true; }
	maximize(): void { this.maximized = true; }
	unmaximize(): void { this.maximized = false; }
	getNormalBounds(): IBounds { return { ...this.bounds }; }
	setBounds(bounds: IBounds): void { this.bounds = { ...bounds }; }
}

class FakeCodeWindow {
	readonly win: FakeBrowserWindow;
	readonly isExtensionDevelopmentHost: boolean;
	readonly isExtensionTestHost = false;
	readonly config = { isSessionsWindow: false };
	isFullScreen = false;
	openedWorkspace: ISingleFolderWorkspaceIdentifier | undefined;
	focusCalls = 0;

	private readonly _onWillFocus: Emitter<void>;
	readonly onWillFocus;
	private readonly _onDidRequestAttention: Emitter<void>;
	readonly onDidRequestAttention;
	private readonly _onDidClose: Emitter<void>;
	readonly onDidClose;
	private readonly _onDidDestroy: Emitter<void>;
	readonly onDidDestroy;
	private readonly _onWillLoad: Emitter<ILoadEvent>;
	readonly onWillLoad;

	constructor(readonly id: number, folder: string | undefined, bounds: IBounds, store: Pick<DisposableStore, 'add'>, options?: { extensionDevelopmentHost?: boolean }) {
		this.win = new FakeBrowserWindow(bounds);
		this.openedWorkspace = folder ? { id: folder, uri: URI.file(folder) } : undefined;
		this.isExtensionDevelopmentHost = !!options?.extensionDevelopmentHost;
		this._onWillFocus = store.add(new Emitter<void>());
		this.onWillFocus = this._onWillFocus.event;
		this._onDidRequestAttention = store.add(new Emitter<void>());
		this.onDidRequestAttention = this._onDidRequestAttention.event;
		this._onDidClose = store.add(new Emitter<void>());
		this.onDidClose = this._onDidClose.event;
		this._onDidDestroy = store.add(new Emitter<void>());
		this.onDidDestroy = this._onDidDestroy.event;
		this._onWillLoad = store.add(new Emitter<ILoadEvent>());
		this.onWillLoad = this._onWillLoad.event;
	}

	/** Mirrors `BaseWindow.focus`. */
	focus(options?: { mode: FocusMode }): void {
		if (options?.mode === FocusMode.Notify) {
			this._onDidRequestAttention.fire();
			return;
		}

		this._onWillFocus.fire();
		this.focusCalls++;
		this.win.focus();
	}

	// `IWorkbenchHost` surface (mirrors a `WebContentsView`-backed host)
	get webContents(): Electron.WebContents | null {
		return { id: this.id, isDestroyed: () => this.win.destroyed } as unknown as Electron.WebContents;
	}
	get visible(): boolean { return this.win.visible; }
	show(): void { this.win.show(); }
	hide(): void { this.win.hide(); }
	getBounds(): Electron.Rectangle { return { x: 0, y: 0, width: this.win.bounds.width, height: this.win.bounds.height }; }
	setReady(): void { }
	close(): void { this.win.emit('close'); this.win.destroyed = true; this._onDidClose.fire(); }
	send(channel: string, ...args: unknown[]): void { }
	sendWhenReady(channel: string, token: import('../../../../base/common/cancellation.js').CancellationToken, ...args: unknown[]): void { }
	load(config: import('../../../window/common/window.js').INativeWindowConfiguration, options?: { isReload?: boolean }): void { }
	whenClosedOrLoaded: Promise<void> = new Promise(() => { });

	fireDidClose(): void {
		this.win.emit('close');
		this.win.destroyed = true;
		this._onDidClose.fire();
	}

	fireDidDestroy(): void {
		this._onDidDestroy.fire();
	}

	fireWillLoad(folder: string): void {
		this.openedWorkspace = { id: folder, uri: URI.file(folder) };
		this._onWillLoad.fire({ workspace: this.openedWorkspace, reason: LoadReason.LOAD });
	}
}

class FakeWindowsMainService {
	private readonly _onDidOpenWindow: Emitter<FakeCodeWindow>;
	readonly onDidOpenWindow;

	readonly windows = new Map<number, FakeCodeWindow>();
	readonly openCalls: IOpenConfiguration[] = [];

	/** Invoked by `open`/`openEmptyWindow`; returns the windows the real service would use. */
	onOpen: (config: IOpenConfiguration) => FakeCodeWindow[] = () => [];

	constructor(private readonly store: Pick<DisposableStore, 'add'>) {
		this._onDidOpenWindow = store.add(new Emitter<FakeCodeWindow>());
		this.onDidOpenWindow = this._onDidOpenWindow.event;
	}

	createWindow(id: number, folder: string | undefined, bounds: IBounds = { x: 10 * id, y: 10 * id, width: 1000, height: 700 }, options?: { extensionDevelopmentHost?: boolean }): FakeCodeWindow {
		const window = new FakeCodeWindow(id, folder, bounds, this.store, options);
		this.windows.set(id, window);
		this._onDidOpenWindow.fire(window);
		return window;
	}

	/** Mirrors window close: removed from the service, then `onDidClose`. */
	closeWindow(window: FakeCodeWindow): void {
		this.windows.delete(window.id);
		window.fireDidClose();
	}

	async open(config: IOpenConfiguration): Promise<FakeCodeWindow[]> {
		this.openCalls.push(config);
		return this.onOpen(config);
	}

	async openEmptyWindow(config: IOpenConfiguration): Promise<FakeCodeWindow[]> {
		return this.open(config);
	}

	getWindowById(id: number): FakeCodeWindow | undefined {
		return this.windows.get(id);
	}
}

class FakeAuxiliaryWindow {
	readonly win: FakeBrowserWindow;

	constructor(readonly id: number, readonly parentId: number) {
		this.win = new FakeBrowserWindow({ x: 0, y: 0, width: 400, height: 300 });
	}
}

suite('SpacesMainService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let windowsMainService: FakeWindowsMainService;
	let auxiliaryWindows: FakeAuxiliaryWindow[];
	let lifecycleMainService: { quitRequested: boolean };
	let service: SpacesMainService;
	let changes: ISpacesSnapshot[];

	setup(() => {
		windowsMainService = new FakeWindowsMainService(store);
		auxiliaryWindows = [];
		lifecycleMainService = { quitRequested: false };
		changes = [];

		service = store.add(new SpacesMainService(
			windowsMainService as unknown as IWindowsMainService,
			{ getHostById: () => undefined, getHostByWebContents: () => undefined } as unknown as IWorkbenchHostRegistry,
			{ getWindows: () => auxiliaryWindows } as unknown as IAuxiliaryWindowsMainService,
			{ args: { _: [] } } as unknown as IEnvironmentMainService,
			lifecycleMainService as unknown as ILifecycleMainService,
			new TestConfigurationService(),
			new NullLogService()
		));
		store.add(service.onDidChangeSpaces(snapshot => changes.push(snapshot)));
	});

	async function spaceOf(window: FakeCodeWindow): Promise<ISpace> {
		const space = (await service.getSpaces(undefined)).spaces.find(space => space.windowId === window.id);
		assert.ok(space, `window ${window.id} is not a space`);
		return space;
	}

	async function activeWindowId(): Promise<number | undefined> {
		const snapshot = await service.getSpaces(undefined);
		return snapshot.spaces.find(space => space.id === snapshot.activeSpaceId)?.windowId;
	}

	/** Window 1 (caller, project-a) and window 2 (project-b, active). */
	async function createTwoSpaces(): Promise<{ a: FakeCodeWindow; b: FakeCodeWindow }> {
		const a = windowsMainService.createWindow(1, '/work/project-a', { x: 100, y: 100, width: 1200, height: 800 });
		let b: FakeCodeWindow | undefined;
		windowsMainService.onOpen = () => [b = windowsMainService.createWindow(2, '/work/project-b')];

		const result = await service.openFolderAsSpace(a.id, URI.file('/work/project-b'));
		assert.strictEqual(result.result, SpaceOperationResult.Ok);
		assert.ok(b);

		return { a, b };
	}

	test('adopts the calling window as the active space', async () => {
		const a = windowsMainService.createWindow(1, '/work/project-a');

		const result = await service.addCurrentWindowAsSpace(a.id);

		assert.strictEqual(result.result, SpaceOperationResult.Ok);
		const snapshot = await service.getSpaces(a.id);
		assert.deepStrictEqual(snapshot.spaces.map(space => [space.windowId, space.name, space.state]), [[1, 'project-a', 'active']]);
		assert.strictEqual(a.win.visible, true);
		assert.strictEqual(changes.at(-1)?.activeSpaceId, snapshot.spaces[0].id);
	});

	test('does not adopt extension development host windows', async () => {
		const host = windowsMainService.createWindow(1, '/work/extension', undefined, { extensionDevelopmentHost: true });

		assert.strictEqual((await service.addCurrentWindowAsSpace(host.id)).result, SpaceOperationResult.UnsupportedWindow);
		assert.strictEqual((await service.getSpaces(host.id)).spaces.length, 0);
	});

	test('opening a folder as space opens a new window in the same frame and hides the caller', async () => {
		const { a, b } = await createTwoSpaces();

		assert.strictEqual(windowsMainService.openCalls.length, 1);
		assert.strictEqual(windowsMainService.openCalls[0].forceNewWindow, true);
		assert.strictEqual(windowsMainService.openCalls[0].urisToOpen?.length, 1);

		assert.deepStrictEqual((await service.getSpaces(a.id)).spaces.map(space => space.name), ['project-a', 'project-b']);
		assert.strictEqual(await activeWindowId(), b.id);
		assert.strictEqual(a.win.visible, false);
		assert.strictEqual(b.win.visible, true);
		assert.ok(b.focusCalls > 0);
		assert.deepStrictEqual(b.win.bounds, a.win.bounds, 'target takes over the frame');
	});

	test('switching hides the previous space and shows and focuses the target', async () => {
		const { a, b } = await createTwoSpaces();
		const focusCallsBefore = a.focusCalls;

		const result = await service.switchToSpace(b.id, (await spaceOf(a)).id);

		assert.strictEqual(result.result, SpaceOperationResult.Ok);
		assert.strictEqual(await activeWindowId(), a.id);
		assert.strictEqual(a.win.visible, true);
		assert.strictEqual(b.win.visible, false);
		assert.ok(a.focusCalls > focusCallsBefore);
		assert.strictEqual((await spaceOf(a)).state, 'active');
		assert.strictEqual((await spaceOf(b)).state, 'inactive');
	});

	test('closing the active space reveals the most recently active space in the same frame', async () => {
		const { a, b } = await createTwoSpaces();
		b.win.setBounds({ x: 5, y: 6, width: 900, height: 600 });

		windowsMainService.closeWindow(b);

		assert.deepStrictEqual((await service.getSpaces(a.id)).spaces.map(space => space.windowId), [a.id]);
		assert.strictEqual(await activeWindowId(), a.id);
		assert.strictEqual(a.win.visible, true);
		assert.deepStrictEqual(a.win.bounds, { x: 5, y: 6, width: 900, height: 600 });
	});

	test('closing an inactive space does not affect the active space', async () => {
		const { a, b } = await createTwoSpaces();
		const focusCallsBefore = b.focusCalls;

		windowsMainService.closeWindow(a);

		assert.deepStrictEqual((await service.getSpaces(b.id)).spaces.map(space => space.windowId), [b.id]);
		assert.strictEqual(await activeWindowId(), b.id);
		assert.strictEqual(b.win.visible, true);
		assert.strictEqual(b.focusCalls, focusCallsBefore);
	});

	test('programmatic focus of a hidden space activates and reveals it', async () => {
		const { a, b } = await createTwoSpaces();

		a.focus(); // e.g. Switch Window, `code <folder>`, opening a file into that window

		assert.strictEqual(await activeWindowId(), a.id);
		assert.strictEqual(a.win.visible, true);
		assert.strictEqual(b.win.visible, false);
	});

	test('native focus event of a hidden space activates it', async () => {
		const { a, b } = await createTwoSpaces();

		a.win.emit('focus');

		assert.strictEqual(await activeWindowId(), a.id);
		assert.strictEqual(a.win.visible, true);
		assert.strictEqual(b.win.visible, false);
	});

	test('opening a folder that already belongs to a hidden space switches to it instead of duplicating', async () => {
		const { a, b } = await createTwoSpaces();

		// The windows service finds the existing window and focuses it
		windowsMainService.onOpen = () => {
			a.focus();
			return [a];
		};
		const result = await service.openFolderAsSpace(b.id, URI.file('/work/project-a'));

		assert.strictEqual(result.result, SpaceOperationResult.Ok);
		assert.strictEqual((await service.getSpaces(b.id)).spaces.length, 2);
		assert.strictEqual(await activeWindowId(), a.id);
		assert.strictEqual(a.win.visible, true);
		assert.strictEqual(b.win.visible, false);
	});

	test('auxiliary windows are hidden and restored with their space', async () => {
		const { a, b } = await createTwoSpaces();
		const auxiliary = new FakeAuxiliaryWindow(100, b.id);
		const minimizedAuxiliary = new FakeAuxiliaryWindow(101, b.id);
		minimizedAuxiliary.win.minimized = true;
		const otherAuxiliary = new FakeAuxiliaryWindow(102, 99);
		auxiliaryWindows.push(auxiliary, minimizedAuxiliary, otherAuxiliary);

		await service.switchToSpace(b.id, (await spaceOf(a)).id);
		assert.strictEqual(auxiliary.win.visible, false);
		assert.strictEqual(minimizedAuxiliary.win.visible, true, 'minimized auxiliary windows are left alone');
		assert.strictEqual(otherAuxiliary.win.visible, true);

		await service.switchToSpace(a.id, (await spaceOf(b)).id);
		assert.strictEqual(auxiliary.win.visible, true);
		assert.strictEqual(auxiliary.win.focused, false, 'restored without taking focus');
	});

	test('does not reveal another space while the application quits', async () => {
		const { a, b } = await createTwoSpaces();
		lifecycleMainService.quitRequested = true;

		windowsMainService.closeWindow(b);

		assert.strictEqual(a.win.visible, false);
		assert.strictEqual(await activeWindowId(), undefined);
	});

	test('revealCurrentSpace shows a hidden space, e.g. for a save prompt during shutdown', async () => {
		const { a, b } = await createTwoSpaces();

		await service.revealCurrentSpace(a.id);

		assert.strictEqual(await activeWindowId(), a.id);
		assert.strictEqual(a.win.visible, true);
		assert.strictEqual(b.win.visible, false);
	});

	(isMacintosh ? test : test.skip)('refuses to switch away from or open next to a native fullscreen space', async () => {
		const { a, b } = await createTwoSpaces();
		b.isFullScreen = true;

		assert.strictEqual((await service.switchToSpace(b.id, (await spaceOf(a)).id)).result, SpaceOperationResult.NativeFullScreen);
		assert.strictEqual(b.win.visible, true);
		assert.strictEqual(a.win.visible, false);

		const openCallsBefore = windowsMainService.openCalls.length;
		assert.strictEqual((await service.openFolderAsSpace(b.id, URI.file('/work/project-c'))).result, SpaceOperationResult.NativeFullScreen);
		assert.strictEqual(windowsMainService.openCalls.length, openCallsBefore);
	});

	test('attention request of a hidden space marks it until it becomes active', async () => {
		const { a, b } = await createTwoSpaces();

		a.focus({ mode: FocusMode.Notify });
		assert.strictEqual((await spaceOf(a)).needsAttention, true);
		assert.strictEqual(a.win.visible, false, 'attention requests do not switch spaces');

		b.focus({ mode: FocusMode.Notify });
		assert.strictEqual((await spaceOf(b)).needsAttention, false, 'the active space is visible');

		await service.switchToSpace(b.id, (await spaceOf(a)).id);
		assert.strictEqual((await spaceOf(a)).needsAttention, false);
	});

	test('loading another folder in a space updates its name', async () => {
		const { b } = await createTwoSpaces();

		b.fireWillLoad('/work/project-c');

		assert.strictEqual((await spaceOf(b)).name, 'project-c');
	});

	test('reopening a crashed active space keeps the space in the replacement window', async () => {
		const { a, b } = await createTwoSpaces();
		const spaceB = await spaceOf(b);
		b.win.setBounds({ x: 7, y: 8, width: 1100, height: 750 });

		// Order in `CodeWindow.destroyWindow(reopen: true)`: destroy event, replacement window opens, crashed window closes
		b.fireDidDestroy();
		windowsMainService.windows.delete(b.id);
		const replacement = windowsMainService.createWindow(3, '/work/project-b');
		replacement.focus();
		b.fireDidClose();

		const snapshot = await service.getSpaces(undefined);
		assert.deepStrictEqual(snapshot.spaces.map(space => [space.id, space.windowId]), [[(await spaceOf(a)).id, a.id], [spaceB.id, replacement.id]]);
		assert.strictEqual(snapshot.activeSpaceId, spaceB.id);
		assert.strictEqual(replacement.win.visible, true);
		assert.strictEqual(a.win.visible, false, 'no second space is revealed next to the replacement');
		assert.deepStrictEqual(replacement.win.bounds, { x: 7, y: 8, width: 1100, height: 750 });

		// The replacement behaves like any other space window afterwards
		a.focus();
		assert.strictEqual(replacement.win.visible, false);
		windowsMainService.closeWindow(a);
		assert.strictEqual(replacement.win.visible, true);
	});

	test('reopening a crashed hidden space activates the replacement window', async () => {
		const { a, b } = await createTwoSpaces();
		const spaceA = await spaceOf(a);

		a.fireDidDestroy();
		windowsMainService.windows.delete(a.id);
		const replacement = windowsMainService.createWindow(3, '/work/project-a');
		a.fireDidClose();

		assert.strictEqual((await service.getSpaces(undefined)).activeSpaceId, spaceA.id);
		assert.strictEqual((await spaceOf(replacement)).id, spaceA.id);
		assert.strictEqual(replacement.win.visible, true);
		assert.strictEqual(b.win.visible, false);
	});

	test('closing a crashed space instead of reopening it removes the space', async () => {
		const { a, b } = await createTwoSpaces();

		b.fireDidDestroy();
		windowsMainService.windows.delete(b.id);
		b.fireDidClose();

		assert.deepStrictEqual((await service.getSpaces(undefined)).spaces.map(space => space.windowId), [a.id]);
		assert.strictEqual(a.win.visible, true);

		// A window opened later is not mistaken for a replacement
		windowsMainService.createWindow(4, '/work/project-d');
		assert.strictEqual((await service.getSpaces(undefined)).spaces.length, 1);
	});
});
