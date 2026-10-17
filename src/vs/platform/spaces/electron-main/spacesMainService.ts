/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import electron from 'electron';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { AddFirstParameterToFunctions } from '../../../base/common/types.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { IAuxiliaryWindowsMainService } from '../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { useNativeFullScreen } from '../../window/common/window.js';
import { ICodeWindow } from '../../window/electron-main/window.js';
import { IWindowsMainService, OpenContext } from '../../windows/electron-main/windows.js';
import { ISingleFolderWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, IWorkspaceIdentifier } from '../../workspace/common/workspace.js';
import { ICommonSpacesService, ISpaceOperationResult, ISpacesSnapshot, ISpaceWorkspace, SpaceOperationResult } from '../common/spaces.js';
import { SpacesModel } from '../common/spacesModel.js';

export const ISpacesMainService = createDecorator<ISpacesMainService>('spacesMainService');

export interface ISpacesMainService extends AddFirstParameterToFunctions<ICommonSpacesService, Promise<unknown> /* only methods, not events */, number | undefined /* window ID */> { }

interface ISpaceFrame {
	readonly bounds: electron.Rectangle;
	readonly maximized: boolean;
}

/**
 * Hosts Spaces as regular code windows that share one on-screen frame:
 * the active Space's window is shown, all other Space windows are hidden
 * with `BrowserWindow.hide()`.
 *
 * Hiding a window runs none of the unload/load lifecycle, so extension hosts
 * (bound to window load/close in `WindowUtilityProcess`), terminals (killed
 * only on renderer shutdown) and all workbench state of inactive Spaces stay
 * alive.
 */
export class SpacesMainService extends Disposable implements ISpacesMainService {

	declare readonly _serviceBrand: undefined;

	private readonly model = this._register(new SpacesModel());

	private readonly _onDidChangeSpaces = this._register(new Emitter<ISpacesSnapshot>());
	readonly onDidChangeSpaces = this._onDidChangeSpaces.event;

	private readonly windowListeners = this._register(new DisposableMap<number, DisposableStore>());

	/** Frame of the most recently visible Space, used when the active Space window is gone. */
	private lastFrame: ISpaceFrame | undefined;

	/** Auxiliary windows (e.g. editors moved into a new window) hidden together with their Space, by Space window id. */
	private readonly hiddenAuxiliaryWindows = new Map<number, number[]>();

	/**
	 * Space whose window is being destroyed after its renderer crashed. When the
	 * user picks "Reopen", the replacement window opens before the crashed
	 * window closes and takes over the Space.
	 */
	private destroyedSpace: { readonly spaceId: string; readonly windowId: number; readonly frame: ISpaceFrame | undefined } | undefined;

	constructor(
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IAuxiliaryWindowsMainService private readonly auxiliaryWindowsMainService: IAuxiliaryWindowsMainService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this._register(this.model.onDidChange(() => this._onDidChangeSpaces.fire(this.model.snapshot())));
		this._register(this.windowsMainService.onDidOpenWindow(window => this.onDidOpenWindow(window)));
	}

	async getSpaces(windowId: number | undefined): Promise<ISpacesSnapshot> {
		return this.model.snapshot();
	}

	async addCurrentWindowAsSpace(windowId: number | undefined): Promise<ISpaceOperationResult> {
		const window = this.getSupportedWindow(windowId);
		if (!window) {
			return { result: SpaceOperationResult.UnsupportedWindow };
		}

		return this.adoptAsActiveSpace(window);
	}

	async createEmptySpace(windowId: number | undefined): Promise<ISpaceOperationResult> {
		return this.openAsSpace(windowId, () => this.windowsMainService.openEmptyWindow({
			context: OpenContext.API,
			contextWindowId: windowId
		}));
	}

	async openFolderAsSpace(windowId: number | undefined, folderUri: UriComponents): Promise<ISpaceOperationResult> {
		return this.openAsSpace(windowId, () => this.windowsMainService.open({
			context: OpenContext.API,
			contextWindowId: windowId,
			cli: this.environmentMainService.args,
			urisToOpen: [{ folderUri: URI.revive(folderUri) }],
			forceNewWindow: true
		}));
	}

	async openWorkspaceAsSpace(windowId: number | undefined, workspaceUri: UriComponents): Promise<ISpaceOperationResult> {
		return this.openAsSpace(windowId, () => this.windowsMainService.open({
			context: OpenContext.API,
			contextWindowId: windowId,
			cli: this.environmentMainService.args,
			urisToOpen: [{ workspaceUri: URI.revive(workspaceUri) }],
			forceNewWindow: true
		}));
	}

	async switchToSpace(windowId: number | undefined, spaceId: string): Promise<ISpaceOperationResult> {
		return this.activate(spaceId);
	}

	async closeSpace(windowId: number | undefined, spaceId: string): Promise<ISpaceOperationResult> {
		const space = this.model.getSpace(spaceId);
		const window = space ? this.windowsMainService.getWindowById(space.windowId) : undefined;
		if (!space || !window?.win) {
			return { result: SpaceOperationResult.UnknownSpace };
		}

		// Show the Space first so that a veto dialog (e.g. unsaved changes) is visible
		const activation = this.activate(spaceId);
		if (activation.result !== SpaceOperationResult.Ok) {
			return activation;
		}

		// Regular window close: goes through the lifecycle and may be vetoed.
		// Removal and activation of the next Space happen in `onDidCloseWindow`.
		window.win.close();

		return { result: SpaceOperationResult.Ok, space };
	}

	async renameSpace(windowId: number | undefined, spaceId: string, name: string): Promise<ISpaceOperationResult> {
		if (!this.model.rename(spaceId, name)) {
			return { result: SpaceOperationResult.UnknownSpace };
		}

		return { result: SpaceOperationResult.Ok, space: this.model.getSpace(spaceId) };
	}

	async revealCurrentSpace(windowId: number | undefined): Promise<void> {
		const space = typeof windowId === 'number' ? this.model.getSpaceByWindowId(windowId) : undefined;
		if (space && space.state !== 'active') {
			this.activate(space.id);
		}
	}

	async requestAttention(windowId: number | undefined): Promise<void> {
		const space = typeof windowId === 'number' ? this.model.getSpaceByWindowId(windowId) : undefined;
		if (space) {
			this.markNeedsAttention(space.id);
		}
	}

	private markNeedsAttention(spaceId: string): void {
		if (this.model.setNeedsAttention(spaceId)) {
			this.logService.trace(`[spaces] Space ${spaceId} needs attention`);
		}
	}

	private async openAsSpace(callerWindowId: number | undefined, open: () => Promise<ICodeWindow[]>): Promise<ISpaceOperationResult> {

		// Hiding a native fullscreen window leaves an empty desktop behind on macOS
		const activeWindow = this.getActiveSpaceWindow();
		if (activeWindow && this.isInNativeFullScreen(activeWindow)) {
			return { result: SpaceOperationResult.NativeFullScreen };
		}

		// The window that runs the first Spaces command becomes a Space itself
		const callerWindow = this.getSupportedWindow(callerWindowId);
		if (callerWindow) {
			const adoption = this.adoptAsActiveSpace(callerWindow);
			if (adoption.result !== SpaceOperationResult.Ok) {
				return adoption;
			}
		}

		const [window] = await open();
		if (!window?.win || !this.isSupportedWindow(window)) {
			return { result: SpaceOperationResult.OpenFailed };
		}

		const space = this.adopt(window);

		return this.activate(space.id);
	}

	/**
	 * Adds the window as Space and makes it the active one without moving it:
	 * the window keeps its own frame and the previously active Space is hidden.
	 */
	private adoptAsActiveSpace(window: ICodeWindow): ISpaceOperationResult {
		const space = this.adopt(window);

		return this.activate(space.id, { keepTargetFrame: true });
	}

	private adopt(window: ICodeWindow) {
		const existing = this.model.getSpaceByWindowId(window.id);
		if (existing) {
			return existing;
		}

		const space = this.model.add({ windowId: window.id, workspace: toSpaceWorkspace(window.openedWorkspace) });
		this.logService.info(`[spaces] window ${window.id} added as Space '${space.name}' (${space.id})`);

		this.registerWindowListeners(window, space.id);

		return space;
	}

	private registerWindowListeners(window: ICodeWindow, spaceId: string): void {
		const disposables = new DisposableStore();

		// A hidden Space that gets focused by any other route (window switcher,
		// opening a file into it, dock, CLI) becomes the active Space. Programmatic
		// focus of a hidden window emits no Electron events on macOS, so listen
		// on the window's own focus request; the native `focus` event covers
		// the user focusing the window directly.
		disposables.add(window.onWillFocus(() => this.onDidRevealWindow(window)));

		// Attention requests (dock bounce / taskbar flash, e.g. chat waiting for
		// input or a finished task) of a hidden Space are surfaced in the Spaces UI
		disposables.add(window.onDidRequestAttention(() => this.markNeedsAttention(spaceId)));

		const win = window.win;
		if (win) {
			disposables.add(Event.fromNodeEventEmitter(win, 'focus')(() => this.onDidRevealWindow(window)));

			// Remember the frame before the window is destroyed so the next Space can take its place
			disposables.add(Event.fromNodeEventEmitter(win, 'close')(() => {
				if (this.model.getSpaceByWindowId(window.id)?.state === 'active' && !win.isDestroyed()) {
					this.lastFrame = captureFrame(win);
				}
			}));
		}

		disposables.add(window.onDidDestroy(() => {
			this.destroyedSpace = { spaceId, windowId: window.id, frame: win && !win.isDestroyed() ? captureFrame(win) : undefined };
		}));
		disposables.add(window.onWillLoad(e => this.model.updateWorkspace(spaceId, toSpaceWorkspace(e.workspace))));
		disposables.add(window.onDidClose(() => this.onDidCloseWindow(window.id)));

		this.windowListeners.set(window.id, disposables);
	}

	private activate(spaceId: string, options?: { keepTargetFrame?: boolean }): ISpaceOperationResult {
		const target = this.model.getSpace(spaceId);
		const targetWindow = target ? this.windowsMainService.getWindowById(target.windowId) : undefined;
		const targetWin = targetWindow?.win;
		if (!target || !targetWindow || !targetWin || targetWin.isDestroyed()) {
			return { result: SpaceOperationResult.UnknownSpace };
		}

		const previousWindow = this.getActiveSpaceWindow();
		if (previousWindow === targetWindow) {
			if (!targetWin.isVisible()) {
				targetWin.show();
				this.showAuxiliaryWindows(targetWindow.id);
			}
			targetWindow.focus();

			return { result: SpaceOperationResult.Ok, space: target };
		}

		if (previousWindow && this.isInNativeFullScreen(previousWindow)) {
			return { result: SpaceOperationResult.NativeFullScreen };
		}

		const previousWin = previousWindow?.win && !previousWindow.win.isDestroyed() ? previousWindow.win : undefined;

		// Update the model first: the `show` and `focus` events fired below
		// must see the target as already active
		const activation = this.model.activate(target.id);
		this.logService.trace(`[spaces] switching from '${activation?.previous?.name}' to '${target.name}'`);

		if (!options?.keepTargetFrame) {
			const frame = previousWin ? captureFrame(previousWin) : this.lastFrame;
			if (frame) {
				applyFrame(targetWin, frame);
			}
		}

		// Show the target before hiding the previous Space so that the
		// application never ends up without a visible window mid-switch
		if (!targetWin.isVisible()) {
			targetWin.show();
		}
		this.showAuxiliaryWindows(targetWindow.id);
		targetWindow.focus();

		if (previousWindow && previousWin?.isVisible()) {
			this.lastFrame = captureFrame(previousWin);
			this.hideAuxiliaryWindows(previousWindow.id);
			previousWin.hide();
		}

		return { result: SpaceOperationResult.Ok, space: this.model.getSpace(target.id) };
	}

	/**
	 * Auxiliary windows are independent Electron windows (not child windows),
	 * so they have to follow the visibility of their Space explicitly.
	 */
	private hideAuxiliaryWindows(spaceWindowId: number): void {
		const hidden: number[] = [];
		for (const auxiliaryWindow of this.auxiliaryWindowsMainService.getWindows()) {
			const win = auxiliaryWindow.parentId === spaceWindowId ? auxiliaryWindow.win : null;
			if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) {
				win.hide();
				hidden.push(auxiliaryWindow.id);
			}
		}

		this.hiddenAuxiliaryWindows.set(spaceWindowId, hidden);
	}

	private showAuxiliaryWindows(spaceWindowId: number): void {
		const hidden = this.hiddenAuxiliaryWindows.get(spaceWindowId);
		this.hiddenAuxiliaryWindows.delete(spaceWindowId);
		if (!hidden?.length) {
			return;
		}

		for (const auxiliaryWindow of this.auxiliaryWindowsMainService.getWindows()) {
			const win = hidden.includes(auxiliaryWindow.id) ? auxiliaryWindow.win : null;
			if (win && !win.isDestroyed() && !win.isVisible()) {
				win.showInactive(); // keep focus on the Space's main window
			}
		}
	}

	private onDidRevealWindow(window: ICodeWindow): void {
		const space = this.model.getSpaceByWindowId(window.id);
		if (space && space.state !== 'active') {
			this.activate(space.id);
		}
	}

	/**
	 * "Reopen" after a renderer crash destroys the crashed window and opens a
	 * new one for the same workspace (`CodeWindow.destroyWindow`). Move the
	 * Space to that window instead of dropping it, so that the replacement does
	 * not end up as a separate window next to another revealed Space.
	 */
	private onDidOpenWindow(window: ICodeWindow): void {
		const destroyed = this.destroyedSpace;
		this.destroyedSpace = undefined;
		if (!destroyed || !this.isSupportedWindow(window)) {
			return;
		}

		const space = this.model.getSpace(destroyed.spaceId);
		if (!space || space.windowId !== destroyed.windowId) {
			return;
		}

		this.windowListeners.deleteAndDispose(destroyed.windowId);
		this.hiddenAuxiliaryWindows.delete(destroyed.windowId);
		this.model.rebindWindow(space.id, window.id);
		this.registerWindowListeners(window, space.id);
		this.logService.info(`[spaces] Space '${space.name}' (${space.id}) moved from crashed window ${destroyed.windowId} to window ${window.id}`);

		if (space.state === 'active') {
			if (destroyed.frame && window.win) {
				applyFrame(window.win, destroyed.frame);
			}
		} else {
			this.activate(space.id); // the replacement window opens visible
		}
	}

	private onDidCloseWindow(windowId: number): void {
		this.windowListeners.deleteAndDispose(windowId);
		this.hiddenAuxiliaryWindows.delete(windowId);
		if (this.destroyedSpace?.windowId === windowId) {
			this.destroyedSpace = undefined; // closed instead of reopened
		}

		const space = this.model.getSpaceByWindowId(windowId);
		if (!space) {
			return;
		}

		const removal = this.model.remove(space.id);
		this.logService.info(`[spaces] Space '${space.name}' (${space.id}) closed`);

		// Do not flash hidden Spaces while the application is quitting
		if (removal?.nextActiveSpace && !this.lifecycleMainService.quitRequested) {
			this.activate(removal.nextActiveSpace.id);
		}
	}

	private getActiveSpaceWindow(): ICodeWindow | undefined {
		const active = this.model.getActiveSpace();

		return active ? this.windowsMainService.getWindowById(active.windowId) : undefined;
	}

	private getSupportedWindow(windowId: number | undefined): ICodeWindow | undefined {
		const window = typeof windowId === 'number' ? this.windowsMainService.getWindowById(windowId) : undefined;

		return window && this.isSupportedWindow(window) ? window : undefined;
	}

	private isSupportedWindow(window: ICodeWindow): boolean {
		return !!window.win
			&& !window.config?.isSessionsWindow
			&& !window.isExtensionDevelopmentHost
			&& !window.isExtensionTestHost;
	}

	private isInNativeFullScreen(window: ICodeWindow): boolean {
		return isMacintosh && window.isFullScreen && useNativeFullScreen(this.configurationService);
	}
}

function toSpaceWorkspace(workspace: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined): ISpaceWorkspace | undefined {
	if (isSingleFolderWorkspaceIdentifier(workspace)) {
		return { kind: 'folder', uri: workspace.uri };
	}

	if (isWorkspaceIdentifier(workspace)) {
		return { kind: 'workspace', uri: workspace.configPath };
	}

	return undefined;
}

function captureFrame(win: electron.BrowserWindow): ISpaceFrame {
	return { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
}

function applyFrame(win: electron.BrowserWindow, frame: ISpaceFrame): void {
	if (frame.maximized) {
		win.setBounds(frame.bounds);
		if (!win.isMaximized()) {
			win.maximize();
		}
	} else {
		if (win.isMaximized()) {
			win.unmaximize();
		}
		win.setBounds(frame.bounds);
	}
}
