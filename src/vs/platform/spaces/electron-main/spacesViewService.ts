/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import electron from 'electron';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../base/common/lifecycle.js';
import { AddFirstParameterToFunctions } from '../../../base/common/types.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { basename } from '../../../base/common/resources.js';
import { createDecorator, IInstantiationService } from '../../instantiation/common/instantiation.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IFileService } from '../../files/common/files.js';
import { ConfigurationTarget, IConfigurationService } from '../../configuration/common/configuration.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { isMacintosh, isWindows } from '../../../base/common/platform.js';
import { ISpacesSettings, SPACES_ROOT_SETTING, SPACES_SHOW_INITIALS_SETTING, SPACES_SHOW_TABS_SETTING } from '../common/spacesConfig.js';
import { ISpaceTabState, emptySpaceTabState } from '../common/spacesTabs.js';
import { buildSpacesState, fromPersistedWorkspace } from '../common/spacesState.js';
import { isDirectChildOfRoot, joinRootFolder, pathKey, scanRootFolders, trimRootPath } from '../common/spacesRoot.js';
import { SpacesTabStore } from './spacesTabStore.js';
import { SpacesStateStore } from './spacesStateStore.js';
import { IWorkbenchHost } from '../../window/electron-main/workbenchHost.js';
import { IWindowsMainService, defaultBrowserWindowOptions } from '../../windows/electron-main/windows.js';
import { WindowMode, defaultWindowState } from '../../window/electron-main/window.js';
import { ISingleFolderWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, IWorkspaceIdentifier } from '../../workspace/common/workspace.js';
import { ICommonSpacesService, ISpaceOperationResult, ISpacesSnapshot, ISpaceWorkspace, SpaceOperationResult } from '../common/spaces.js';
import { SpacesModel } from '../common/spacesModel.js';
import { SpacesSidebarHost, SPACES_SIDEBAR_WIDTH } from './spacesSidebarHost.js';
import { WebContentsViewWorkbenchHost } from './webContentsViewWorkbenchHost.js';

export const ISpacesViewService = createDecorator<ISpacesViewService>('spacesViewService');

export interface ISpacesViewService extends AddFirstParameterToFunctions<ICommonSpacesService, Promise<unknown> /* only methods, not events */, number | undefined /* window ID */> {

	/**
	 * Restores the persisted Spaces mode: recreates the frame, every Space
	 * host and the active Space. Returns `true` when at least one Space has
	 * been restored, so the caller can skip opening a regular window.
	 */
	restorePersistedState(): Promise<boolean>;

	/** Whether a persisted Spaces state exists (checked before opening the first window). */
	hasPersistedState(): boolean;

	/** Synchronises the Space list with the folders inside `spaces.root`. */
	scanSpacesRoot(): Promise<void>;
}

/**
 * Creates the single shared frame window that hosts all Space views.
 * Injectable so tests can substitute a fake `BrowserWindow`.
 */
export const ISpacesFrameProvider = createDecorator<ISpacesFrameProvider>('spacesFrameProvider');

export interface ISpacesFrameProvider {
	createFrame(): electron.BrowserWindow | undefined;
}

export class DefaultSpacesFrameProvider implements ISpacesFrameProvider {

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) { }

	createFrame(): electron.BrowserWindow | undefined {
		const state = defaultWindowState(WindowMode.Normal, true);
		const options = this.instantiationService.invokeFunction(defaultBrowserWindowOptions, state);

		return new electron.BrowserWindow({
			...options,
			title: 'ParaCode',
			webPreferences: {
				...options.webPreferences,
				backgroundThrottling: false
			}
		});
	}
}

/**
 * Presents Spaces as workbenches hosted inside `WebContentsView`s attached to a
 * single frame `BrowserWindow`. This is the end-state WebContentsView child
 * architecture described in the Spaces design:
 *
 * - one shared on-screen frame (`SpacesViewService.frame`)
 * - one `WebContentsViewWorkbenchHost` per Space, each with its own renderer,
 *   IPC context (`windowId`), extension-host pairing and lifecycle
 * - switching Spaces swaps which view is attached/visible in the frame, it
 *   never unloads or reloads a renderer
 *
 * This is the only Spaces presentation: every Space is a
 * `WebContentsViewWorkbenchHost` in the shared frame, there are no per-Space
 * `BrowserWindow`s. All Spaces share one model (`SpacesModel`) and service
 * interface (`ICommonSpacesService`).
 */
export class SpacesViewService extends Disposable implements ISpacesViewService {

	declare readonly _serviceBrand: undefined;

	private readonly model = this._register(new SpacesModel());

	private readonly tabStore: SpacesTabStore;

	private readonly stateStore: SpacesStateStore;

	/** Set while restoring so intermediate model changes do not overwrite the file. */
	private restoring = false;

	/** Guards against overlapping root scans (config change + explicit scan). */
	private scanPromise: Promise<void> | undefined;

	/** Set while a root scan is executing, to prevent nested scans. */
	private scanningRoot = false;

	private readonly _onDidChangeSpaces = this._register(new Emitter<ISpacesSnapshot>());
	readonly onDidChangeSpaces = this._onDidChangeSpaces.event;

	/** The single frame window hosting all Space views. */
	private _frame: electron.BrowserWindow | undefined = undefined;
	get frame(): electron.BrowserWindow | undefined { return this._frame; }

	/** The shared Spaces sidebar host in the frame (created with the frame). */
	private sidebarHost: SpacesSidebarHost | undefined = undefined;
	get sidebar(): SpacesSidebarHost | undefined { return this.sidebarHost; }

	/** host per Space, mapped by Space id. */
	private readonly hosts = new Map<string, IWorkbenchHost>();

	private readonly hostListeners = this._register(new DisposableMap<string, DisposableStore>());

	constructor(
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
		@ISpacesFrameProvider private readonly frameProvider: ISpacesFrameProvider,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IApplicationStorageMainService applicationStorageMainService: IApplicationStorageMainService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService
	) {
		super();
		this.tabStore = new SpacesTabStore(applicationStorageMainService, logService);
		this.stateStore = new SpacesStateStore(environmentMainService, logService);

		this._register(this.model.onDidChange(() => {
			this._onDidChangeSpaces.fire(this.model.snapshot());
			this.persistState();
		}));

		// A changed `spaces.root` must be reflected in the Space list.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SPACES_ROOT_SETTING)) {
				void this.scanSpacesRoot().then(() => this._onDidChangeSpaces.fire(this.model.snapshot()));
			}
		}));
	}

	async getSpaces(windowId: number | undefined): Promise<ISpacesSnapshot> {
		return this.model.snapshot();
	}

	async getSidebarSettings(windowId: number | undefined): Promise<ISpacesSettings> {
		return {
			spacesRoot: this.configurationService.getValue<string>(SPACES_ROOT_SETTING) ?? null,
			showSpaceTabs: this.configurationService.getValue<boolean>(SPACES_SHOW_TABS_SETTING) ?? false,
			showSpaceInitials: this.configurationService.getValue<boolean>(SPACES_SHOW_INITIALS_SETTING) ?? false
		};
	}

	async setSidebarSetting(windowId: number | undefined, key: string, value: unknown): Promise<void> {
		const setting = key === 'spacesRoot' ? SPACES_ROOT_SETTING : key === 'showSpaceTabs' ? SPACES_SHOW_TABS_SETTING : key === 'showSpaceInitials' ? SPACES_SHOW_INITIALS_SETTING : undefined;
		if (setting) {
			await this.configurationService.updateValue(setting, value, ConfigurationTarget.USER);
		}
	}

	async getSpaceTabs(windowId: number | undefined, spaceId: string): Promise<ISpaceTabState> {
		return this.tabStore.get(spaceId);
	}

	async updateSpaceTabs(windowId: number | undefined, state: ISpaceTabState): Promise<void> {
		const space = typeof windowId === 'number' ? this.model.getSpaceByWindowId(windowId) : undefined;
		if (!space) {
			return;
		}
		this.tabStore.set(space.id, state);
		this._onDidChangeSpaces.fire(this.model.snapshot());
	}

	async getPersistedTabStateForWindow(windowId: number | undefined): Promise<ISpaceTabState> {
		const space = typeof windowId === 'number' ? this.model.getSpaceByWindowId(windowId) : undefined;
		if (!space) {
			return emptySpaceTabState();
		}
		return this.tabStore.get(space.id);
	}

	async addCurrentWindowAsSpace(windowId: number | undefined): Promise<ISpaceOperationResult> {
		const currentWindow = typeof windowId === 'number' ? this.windowsMainService.getWindowById(windowId) : undefined;
		if (!currentWindow?.config) {
			return { result: SpaceOperationResult.UnsupportedWindow };
		}

		const workspace = currentWindow.openedWorkspace;
		return this.createHostAndAdopt(windowId, workspace);
	}

	async createEmptySpace(windowId: number | undefined): Promise<ISpaceOperationResult> {
		return this.createHostAndAdopt(windowId, undefined);
	}

	async openFolderAsSpace(windowId: number | undefined, folderUri: UriComponents): Promise<ISpaceOperationResult> {
		const uri = URI.revive(folderUri);
		return this.createHostAndAdopt(windowId, { id: uri.fsPath, uri });
	}

	async openWorkspaceAsSpace(windowId: number | undefined, workspaceUri: UriComponents): Promise<ISpaceOperationResult> {
		const uri = URI.revive(workspaceUri);
		return this.createHostAndAdopt(windowId, { id: uri.fsPath, uri });
	}

	async switchToSpace(windowId: number | undefined, spaceId: string): Promise<ISpaceOperationResult> {
		return this.activate(spaceId);
	}

	async createSpace(windowId: number | undefined, name: string): Promise<ISpaceOperationResult> {
		const spacesRoot = this.configurationService.getValue<string>(SPACES_ROOT_SETTING);
		if (spacesRoot) {
			// Create the Space folder on disk, then open it as a Space.
			const folderUri = URI.file(joinRootFolder(spacesRoot, name));
			try {
				await this.fileService.createFolder(folderUri);
			} catch (error) {
				this.logService.warn(`[spaces:view] failed to create Space folder '${folderUri.fsPath}': ${error}`);
				return { result: SpaceOperationResult.OpenFailed };
			}
			return this.createHostAndAdopt(windowId, { id: folderUri.fsPath, uri: folderUri });
		}
		return this.createHostAndAdopt(windowId, undefined);
	}

	/**
	 * Creates a new Space host inside the shared frame and, when the calling
	 * window is a regular `CodeWindow` that has not been adopted into the frame
	 * yet, closes it through the regular lifecycle so that only a single frame
	 * window remains. A vetoed close (e.g. unsaved changes) leaves the calling
	 * window alive while the new Space keeps running in the frame.
	 *
	 * Frame-internal callers (the sidebar RPC passes `undefined`, and a Space
	 * host's id is its `WebContentsView.id`, which never resolves through
	 * `getWindowById`) have no matching `CodeWindow` and are left untouched.
	 */
	private async createHostAndAdopt(windowId: number | undefined, workspace: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined, spaceId?: string): Promise<ISpaceOperationResult> {
		this.logService.info(`[spaces:view] creating Space host (workspace=${workspace ? 'yes' : 'empty'})`);
		const creation = await this.createHostAsSpace(workspace, spaceId);
		if (creation.result !== SpaceOperationResult.Ok) {
			this.logService.error(`[spaces:view] Space host creation failed; keeping calling window open`);
			return creation;
		}

		const callingWindow = typeof windowId === 'number' ? this.windowsMainService.getWindowById(windowId) : undefined;
		if (callingWindow) {
			// The calling window is a regular `CodeWindow`; close it through the
			// standard lifecycle so unsaved changes can veto the adoption.
			callingWindow.close();
		}

		return creation;
	}

	async deleteSpace(windowId: number | undefined, spaceId: string): Promise<ISpaceOperationResult> {
		const space = this.model.getSpace(spaceId);
		if (!space) {
			return { result: SpaceOperationResult.UnknownSpace };
		}

		const host = this.hosts.get(spaceId);
		if (host) {
			this.activate(spaceId);
			host.close();
		}

		// If the Space lives under the configured root, remove its folder too.
		const spacesRoot = this.configurationService.getValue<string>(SPACES_ROOT_SETTING);
		if (spacesRoot && space.workspace?.kind === 'folder') {
			if (isDirectChildOfRoot(space.workspace.uri.fsPath, spacesRoot, this.isCaseInsensitiveFs())) {
				try {
					await this.fileService.del(space.workspace.uri, { recursive: true, useTrash: false });
				} catch (error) {
					this.logService.warn(`[spaces:view] failed to delete Space folder '${space.workspace.uri.fsPath}': ${error}`);
				}
			}
		}

		if (!host) {
			// No host (e.g. a space restored from a root folder without a live
			// view): remove straight from the model.
			const removal = this.model.remove(spaceId);
			if (removal?.nextActiveSpace && !this.lifecycleMainService.quitRequested) {
				this.activate(removal.nextActiveSpace.id);
			}
		}

		this.tabStore.set(spaceId, undefined);

		return { result: SpaceOperationResult.Ok };
	}

	async sendToSpace(windowId: number | undefined, spaceId: string, channel: string, ...args: unknown[]): Promise<void> {
		const host = this.hosts.get(spaceId);
		if (host?.webContents && !host.webContents.isDestroyed()) {
			host.send(channel, ...args);
		}
	}

	async closeSpace(windowId: number | undefined, spaceId: string): Promise<ISpaceOperationResult> {
		const host = this.hosts.get(spaceId);
		if (!host) {
			return { result: SpaceOperationResult.UnknownSpace };
		}

		this.activate(spaceId);
		host.close();

		return { result: SpaceOperationResult.Ok, space: this.model.getSpace(spaceId) };
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
			this.logService.trace(`[spaces:view] Space ${spaceId} needs attention`);
		}
	}

	private async createHostAsSpace(workspace: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined, spaceId?: string): Promise<ISpaceOperationResult> {

		// Make sure the frame exists before we load any view into it
		this.logService.trace('[spaces:view] ensuring shared frame');
		const frame = this.ensureFrame();
		if (!frame) {
			const message = 'The shared Spaces window could not be created.';
			this.logService.error(`[spaces:view] ${message}`);
			this.sidebarHost?.showError('Space could not be opened', message);
			return { result: SpaceOperationResult.OpenFailed };
		}

		// Create and load the host through the windows service so the renderer
		// gets a complete `INativeWindowConfiguration` (same as a real window).
		let host: IWorkbenchHost;
		try {
			this.logService.trace('[spaces:view] creating workbench host');
			const hostPromise = this.windowsMainService.createWorkbenchHostInFrame(frame, { workspace });
			host = await withTimeout(hostPromise, HOST_CREATION_TIMEOUT, lateHost => {
				// Configuration resolution can finish after the timeout (for example
				// while the macOS keychain is blocked). Do not leave an invisible
				// renderer attached to the shared frame in that case.
				this.logService.warn(`[spaces:view] disposing late-created host ${lateHost.id}`);
				lateHost.close();
			});
			this.logService.trace(`[spaces:view] workbench host created (id=${host.id})`);
		} catch (error) {
			const message = toErrorMessage(error);
			this.logService.error(`[spaces:view] Failed to create host in frame: ${message}`);
			this.sidebarHost?.showError('Space could not be opened', message);
			return { result: SpaceOperationResult.OpenFailed };
		}

		// Place the workbench to the right of the shared sidebar and lay it out.
		if (host instanceof WebContentsViewWorkbenchHost) {
			host.setOffsetX(SPACES_SIDEBAR_WIDTH);
		}
		if (!frame.isDestroyed()) {
			host.setBounds?.(frame.getContentBounds());
		}

		const space = this.model.add({ windowId: host.id, workspace: workspace ? toSpaceWorkspace(workspace) : undefined, id: spaceId });
		this.hosts.set(space.id, host);
		this.registerHostListeners(host, space.id);
		this.logService.info(`[spaces:view] added Space '${space.name}' (${space.id}) as view host ${host.id}`);

		// Entering Spaces mode for the first time must also materialise every
		// first-level sub-folder of `spaces.root` as a Space. Restores skip this
		// here; `restorePersistedState` scans once after all Spaces are back.
		this.maybeAutoScanSpacesRoot();

		return this.activate(space.id);
	}

	/**
	 * When the very first Space is created outside of a state restore, keep the
	 * list in sync with the configured `spaces.root` right away. Checks `size`
	 * after the Space has been added so the freshly created Space itself is
	 * skipped by the scan, and `restoring` so the restore path does not scan
	 * twice.
	 */
	private maybeAutoScanSpacesRoot(): void {
		if (this.restoring || this.model.size !== 1) {
			return;
		}
		void this.scanSpacesRoot();
	}

	private registerHostListeners(host: IWorkbenchHost, spaceId: string): void {
		const disposables = new DisposableStore();

		disposables.add(host.onWillFocus(() => {
			const space = this.model.getSpace(spaceId);
			if (space && space.state !== 'active') {
				this.activate(space.id);
			}
		}));

		disposables.add(host.onDidRequestAttention(() => {
			if (this.model.getSpace(spaceId)) {
				this.markNeedsAttention(spaceId);
			}
		}));

		disposables.add(host.onDidClose(() => {
			this.hostListeners.deleteAndDispose(spaceId);
			this.hosts.delete(spaceId);
			this.onDidCloseSpace(spaceId);
		}));

		disposables.add(host.onWillLoad(e => {
			if (this.model.getSpace(spaceId)) {
				this.model.updateWorkspace(spaceId, toSpaceWorkspace(e.workspace));
			}
		}));

		this.hostListeners.set(spaceId, disposables);
	}

	private onDidCloseSpace(spaceId: string): void {
		const space = this.model.getSpace(spaceId);
		if (!space) {
			return;
		}

		const removal = this.model.remove(space.id);
		this.logService.info(`[spaces:view] Space '${space.name}' (${space.id}) closed`);

		if (removal?.nextActiveSpace && !this.lifecycleMainService.quitRequested) {
			this.activate(removal.nextActiveSpace.id);
		}
	}

	/**
	 * Closes the shared frame (and every host in it). Used when a restore
	 * attempt has to be abandoned.
	 */
	private teardownFrame(): void {
		for (const [id, host] of [...this.hosts]) {
			this.hostListeners.deleteAndDispose(id);
			this.hosts.delete(id);
			try { host.close(); } catch { /* ignore */ }
		}

		const frame = this._frame;
		this._frame = undefined;
		this.sidebarHost?.dispose();
		this.sidebarHost = undefined;
		if (frame && !frame.isDestroyed()) {
			frame.destroy();
		}
	}

	private ensureFrame(): electron.BrowserWindow | undefined {
		if (this._frame && !this._frame.isDestroyed()) {
			return this._frame;
		}

		const frame = this.frameProvider.createFrame();
		if (!frame) {
			return undefined;
		}

		// Real `BrowserWindow`s emit `closed`; tests substitute a minimal fake
		// that only models the surface SpacesViewService uses.
		if (typeof (frame as { on?: (event: string, cb: () => void) => void }).on === 'function') {
			(frame as { on: (event: string, cb: () => void) => void }).on('closed', () => {
				this._frame = undefined;
				this.sidebarHost?.dispose();
				this.sidebarHost = undefined;
			});
		}

		// Listen to content resizes so the shared sidebar and every Space view
		// stay correctly positioned. Only real frames have `on`.
		if (typeof (frame as { on?: (event: string, cb: () => void) => void }).on === 'function') {
			(frame as { on: (event: string, cb: () => void) => void }).on('resize', () => {
				this.layoutViews();
			});
		}

		this._frame = frame;

		// Create the shared sidebar and lay out Space views. Tests substitute a
		// minimal fake frame without a `contentView`, so guard on the surface we
		// actually need — a real BrowserWindow always satisfies it.
		const hasFrameSurface =
			typeof (frame as { getContentBounds?: () => Electron.Rectangle }).getContentBounds === 'function' &&
			typeof (frame as { contentView?: { addChildView?: unknown } }).contentView?.addChildView === 'function';

		if (hasFrameSurface) {
			try {
				this.sidebarHost = this.instantiationService.createInstance(SpacesSidebarHost, frame, this);
			} catch (error) {
				this.logService.error(`[spaces:view] failed to create shared sidebar: ${error}`);
			}

			this.layoutViews();
		}

		this.logService.debug('[spaces:view] created shared frame window');

		return frame;
	}

	/**
	 * Re-positions the shared sidebar (left) and every Space workbench view
	 * (right of the sidebar) to the current frame content bounds.
	 */
	private layoutViews(): void {
		if (!this._frame || this._frame.isDestroyed()) {
			return;
		}
		const bounds = this._frame.getContentBounds();
		this.sidebarHost?.setBounds(bounds);
		for (const host of this.hosts.values()) {
			host.setBounds?.(bounds);
		}
	}


	//#region Spaces mode persistence

	/** Whether a usable persisted Spaces state exists. */
	hasPersistedState(): boolean {
		return !!this.stateStore.read();
	}

	private persistState(): void {
		if (this.restoring) {
			return;
		}
		const snapshot = this.model.snapshot();
		if (snapshot.spaces.length === 0) {
			// No Spaces left: the next launch must open a regular window.
			this.stateStore.clear();
			return;
		}
		this.stateStore.write(buildSpacesState(snapshot.spaces, snapshot.activeSpaceId));
	}

	/**
	 * Recreates the Spaces mode from the persisted state: the shared frame,
	 * one host per persisted Space and the previously active Space.
	 *
	 * Every Space id is restored verbatim so its persisted tab state keeps
	 * matching. Folders that disappeared from disk are still restored (the
	 * workbench shows its usual "folder does not exist" state) — silently
	 * dropping Spaces would lose the user's layout.
	 *
	 * Returns `true` when at least one Space was restored.
	 */
	async restorePersistedState(): Promise<boolean> {
		const state = this.stateStore.read();
		if (!state || state.spaces.length === 0) {
			return false;
		}

		this.logService.info(`[spaces:view] restoring ${state.spaces.length} Space(s) from the previous session`);

		this.restoring = true;
		const restored: string[] = [];
		try {
			for (const persisted of state.spaces) {
				const workspace = fromPersistedWorkspace(persisted.workspace);
				const result = await this.createHostAndAdopt(undefined, toWorkspaceIdentifierForRestore(workspace), persisted.id);
				if (result.result === SpaceOperationResult.Ok && result.space) {
					restored.push(result.space.id);
				} else {
					this.logService.warn(`[spaces:view] could not restore Space '${persisted.id}' (${result.result})`);
				}
			}

			const target = state.activeSpaceId && restored.includes(state.activeSpaceId)
				? state.activeSpaceId
				: restored[0];
			if (target) {
				this.activate(target);
			}
		} catch (error) {
			this.logService.error(`[spaces:view] failed to restore Spaces mode: ${toErrorMessage(error)}`);
		} finally {
			this.restoring = false;
		}

		if (restored.length === 0) {
			// Nothing could be restored. Drop the half-built state and close the
			// frame we may have created, so the caller's regular window is the
			// only window on screen (a leftover empty frame would look like the
			// black window this restore path is supposed to prevent).
			this.logService.warn('[spaces:view] Spaces mode could not be restored; falling back to a regular window');
			this.stateStore.clear();
			this.teardownFrame();
			return false;
		}

		this.persistState();

		// Keep the Space list in sync with the folders under the root.
		await this.scanSpacesRoot();

		return true;
	}

	//#endregion

	//#region Spaces root

	/**
	 * Synchronises the Space list with the first-level sub-folders of
	 * `spaces.root`: every sub-folder becomes a Space, existing Spaces stay
	 * untouched (matched by folder path), and Spaces whose folder vanished
	 * from the root are left alone (the root may be temporarily unavailable).
	 */
	scanSpacesRoot(): Promise<void> {
		// Serialise scans: a config change and the sidebar RPC can race, which
		// would otherwise create the same folder twice.
		const previous = this.scanPromise ?? Promise.resolve();
		const next = previous.then(() => this.doScanSpacesRoot()).catch(error => {
			this.logService.error(`[spaces:view] Spaces root scan failed: ${toErrorMessage(error)}`);
		});
		this.scanPromise = next;
		return next;
	}

	private async doScanSpacesRoot(): Promise<void> {
		if (this.scanningRoot) {
			return;
		}
		this.scanningRoot = true;
		try {
			await this.doScanSpacesRootCore();
		} finally {
			this.scanningRoot = false;
		}
	}

	private async doScanSpacesRootCore(): Promise<void> {
		const spacesRoot = this.configurationService.getValue<string>(SPACES_ROOT_SETTING);
		const root = trimRootPath(spacesRoot ?? '');
		if (!root) {
			return;
		}

		const rootUri = URI.file(root);
		let entries: readonly { name: string; isDirectory: boolean }[];
		try {
			const stat = await this.fileService.resolve(rootUri);
			if (!stat.isDirectory) {
				this.logService.warn(`[spaces:view] Spaces root '${root}' is not a directory`);
				this.sidebarHost?.showTransientError('Spaces root is not a folder', root);
				return;
			}
			entries = (stat.children ?? [])
				.filter(child => !child.isSymbolicLink || child.isDirectory)
				.map(child => ({ name: basename(child.resource), isDirectory: child.isDirectory }));
		} catch (error) {
			const message = toErrorMessage(error);
			this.logService.warn(`[spaces:view] failed to scan Spaces root '${root}': ${message}`);
			this.sidebarHost?.showTransientError('Could not read the Spaces root', `${root}\n${message}`);
			return;
		}

		const existing = this.model.snapshot().spaces
			.filter(space => space.workspace?.kind === 'folder')
			.map(space => space.workspace!.uri.fsPath);

		const caseInsensitive = this.isCaseInsensitiveFs();
		const known = new Set(existing.map(p => pathKey(p, caseInsensitive)));
		const scan = scanRootFolders(root, entries, existing, { caseInsensitive });

		this.logService.info(`[spaces:view] Spaces root '${root}': ${scan.folders.length} folder(s), ${scan.skipped.length} skipped`);

		for (const folder of scan.folders) {
			if (known.has(pathKey(folder.fsPath, caseInsensitive))) {
				continue;
			}
			known.add(pathKey(folder.fsPath, caseInsensitive));
			const folderUri = URI.file(folder.fsPath);
			const id = `root:${pathKey(folder.fsPath, caseInsensitive)}`;
			const result = await this.createHostAndAdopt(undefined, { id: folder.fsPath, uri: folderUri }, id);
			if (result.result !== SpaceOperationResult.Ok) {
				this.logService.warn(`[spaces:view] failed to add root folder '${folder.fsPath}' as a Space (${result.result})`);
			}
		}

		// Persist the (possibly) enlarged list right away so a crash before
		// the next model change does not lose the scan result.
		this.persistState();
	}


	private isCaseInsensitiveFs(): boolean {
		return isMacintosh || isWindows;
	}

	//#endregion

	private activate(spaceId: string): ISpaceOperationResult {
		const target = this.model.getSpace(spaceId);
		if (!target) {
			return { result: SpaceOperationResult.UnknownSpace };
		}

		const targetHost = this.hosts.get(spaceId);
		if (!targetHost?.webContents || targetHost.webContents.isDestroyed()) {
			return { result: SpaceOperationResult.UnknownSpace };
		}

		const previous = this.model.getActiveSpace();

		const activation = this.model.activate(target.id);
		if (previous === target) {
			targetHost.show();
			targetHost.focus();
			return { result: SpaceOperationResult.Ok, space: target };
		}

		this.logService.trace(`[spaces:view] switching from '${activation?.previous?.name}' to '${target.name}'`);

		// Show target first so the frame never ends up empty mid-switch
		targetHost.show();
		targetHost.focus();

		// Hide all other hosts
		for (const [id, host] of this.hosts) {
			if (id !== spaceId && host.visible) {
				host.hide();
			}
		}

		return { result: SpaceOperationResult.Ok, space: this.model.getSpace(target.id) };
	}
}

const HOST_CREATION_TIMEOUT = 20000;

function withTimeout<T>(promise: Promise<T>, timeout: number, onLateValue?: (value: T) => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			reject(new Error(`Timed out after ${timeout}ms while creating the Space view`));
		}, timeout);
		promise.then(value => {
			clearTimeout(timer);
			if (timedOut) { onLateValue?.(value); } else { resolve(value); }
		}, error => {
			clearTimeout(timer);
			if (!timedOut) { reject(error); }
		});
	});
}

/**
 * Turns a persisted workspace back into the identifier the windows service
 * expects. `undefined` restores an empty Space.
 */
function toWorkspaceIdentifierForRestore(workspace: ISpaceWorkspace | undefined): IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined {
	if (!workspace) {
		return undefined;
	}
	if (workspace.kind === 'workspace') {
		return { id: workspace.uri.fsPath, configPath: workspace.uri };
	}
	return { id: workspace.uri.fsPath, uri: workspace.uri };
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
