/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import electron from 'electron';
import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { FileAccess } from '../../../base/common/network.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { getMarks } from '../../../base/common/performance.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { FocusMode } from '../../native/common/native.js';
import { IProtocolMainService } from '../../protocol/electron-main/protocol.js';
import { IThemeMainService } from '../../theme/electron-main/themeMainService.js';
import { INativeWindowConfiguration } from '../../window/common/window.js';
import { IWorkbenchHost } from '../../window/electron-main/workbenchHost.js';
import { IWorkbenchHostRegistry } from '../../window/electron-main/workbenchHostRegistry.js';
import { ILoadEvent, LoadReason } from '../../window/electron-main/window.js';
import { ISingleFolderWorkspaceIdentifier, IWorkspaceIdentifier } from '../../workspace/common/workspace.js';

/**
 * A `IWorkbenchHost` that runs the workbench renderer inside a
 * `WebContentsView` attached to a shared frame `electron.BrowserWindow`, instead of a
 * full `electron.BrowserWindow` of its own.
 *
 * Every Space gets one of these hosts. `SpacesViewService` swaps the visible
 * view by adding/removing the view from the frame's `contentView`. Because
 * each `WebContentsView` owns an independent `WebContents`, the renderer gets
 * its own IPC context (`ipc.electron.ts` scopes `vscode:hello`/`vscode:message`
 * by `sender.id`), its own `windowId` (from `--vscode-window-config`) and its
 * own renderer/extension-host pairing - exactly like a `CodeWindow`, but
 * without an OS frame per Space.
 *
 * Window-level concerns (title, traffic lights, fullscreen, menubar, native
 * frame) belong to the shared frame and are intentionally NOT part of this
 * host.
 */
export class WebContentsViewWorkbenchHost extends Disposable implements IWorkbenchHost {

	private readonly _view: electron.WebContentsView;

	private readonly configObjectUrl = this._register(this.protocolMainService.createIPCObjectUrl<INativeWindowConfiguration>());

	private readonly _onWillLoad = this._register(new Emitter<ILoadEvent>());
	readonly onWillLoad = this._onWillLoad.event;

	private readonly _onDidSignalReady = this._register(new Emitter<void>());
	readonly onDidSignalReady = this._onDidSignalReady.event;

	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose = this._onDidClose.event;

	private readonly _onDidDestroy = this._register(new Emitter<void>());
	readonly onDidDestroy = this._onDidDestroy.event;

	private readonly _onWillFocus = this._register(new Emitter<void>());
	readonly onWillFocus = this._onWillFocus.event;

	private readonly _onDidRequestAttention = this._register(new Emitter<void>());
	readonly onDidRequestAttention = this._onDidRequestAttention.event;

	private _config: INativeWindowConfiguration | undefined;
	get config(): INativeWindowConfiguration | undefined { return this._config; }

	get openedWorkspace(): IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined { return this._config?.workspace; }

	get webContents(): Electron.WebContents | null {
		return this._view.webContents.isDestroyed() ? null : this._view.webContents;
	}

	get id(): number { return this._view.webContents.id; }

	private readyState: 'none' | 'navigating' | 'ready' = 'none';
	get isReady(): boolean { return this.readyState === 'ready'; }

	private whenReadyCallbacks: { (): void }[] = [];

	setReady(): void {
		this.readyState = 'ready';
		while (this.whenReadyCallbacks.length) {
			this.whenReadyCallbacks.pop()!();
		}
		this._onDidSignalReady.fire();
	}

	readonly whenClosedOrLoaded: Promise<void>;

	/** The frame window this host is presented in. */
	private _frame: electron.BrowserWindow | undefined;
	get frame(): electron.BrowserWindow | undefined { return this._frame; }

	private attached = false;
	get visible(): boolean { return this.attached && !this._view.webContents.isDestroyed(); }

	/** Horizontal offset (e.g. shared sidebar width) applied when laying out this view in the frame. */
	private boundsOffsetX = 0;
	get offsetX(): number { return this.boundsOffsetX; }
	setOffsetX(value: number): void { this.boundsOffsetX = value; }

	/**
	 * Position this workbench view inside the frame's content area, leaving
	 * `offsetX` pixels at the left edge (occupied by the shared Spaces sidebar).
	 */
	setBounds(frameContentBounds: Electron.Rectangle): void {
		if (this._view.webContents.isDestroyed()) {
			return;
		}
		const width = Math.max(0, frameContentBounds.width - this.boundsOffsetX);
		this._view.setBounds({
			x: this.boundsOffsetX,
			y: 0,
			width,
			height: frameContentBounds.height
		});
	}

	constructor(
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@IProtocolMainService private readonly protocolMainService: IProtocolMainService,
		@IThemeMainService private readonly themeMainService: IThemeMainService,
		@IWorkbenchHostRegistry private readonly workbenchHostRegistry: IWorkbenchHostRegistry,
		@ILogService private readonly logService: ILogService
	) {
		super();

		const webPreferences: Electron.WebPreferences = {
			preload: FileAccess.asFileUri('vs/base/parts/sandbox/electron-browser/preload.js').fsPath,
			additionalArguments: [`--vscode-window-config=${this.configObjectUrl.resource.toString()}`],
			v8CacheOptions: this.environmentMainService.useCodeCache ? 'bypassHeatCheck' : 'none',
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			spellcheck: false
		};

		this._view = new electron.WebContentsView({ webPreferences });
		this._view.setBackgroundColor(this.themeMainService.getBackgroundColor());
		this._view.setVisible(false);

		const whenClosedOrLoaded = this._register(new Emitter<void>());
		this.whenClosedOrLoaded = Event.toPromise(whenClosedOrLoaded.event);
		this._register(this.onWillLoad(() => whenClosedOrLoaded.fire()));
		this._register(this.onDidClose(() => whenClosedOrLoaded.fire()));

		this.workbenchHostRegistry.register(this);

		this._register(Event.fromNodeEventEmitter(this._view.webContents, 'did-finish-load')(() => {
			// The renderer reports readiness separately through `notifyReady`,
			// but associate the config once the page has loaded.
			this.logService.trace(`[spaces:view] host ${this.id} did-finish-load`);
		}));

		this._register(Event.fromNodeEventEmitter(this._view.webContents, 'render-process-gone', (event, details) => details)(() => {
			this._onDidDestroy.fire();
		}));

		this._register(Event.fromNodeEventEmitter(this._view.webContents, 'destroyed')(() => {
			this._onDidDestroy.fire();
			this.workbenchHostRegistry.unregister(this);
		}));
	}

	attach(frame: electron.BrowserWindow): void {
		this._frame = frame;
		if (!frame.isDestroyed()) {
			frame.contentView.addChildView(this._view);
		}
		this.attached = true;
	}

	show(): void {
		if (this._frame && !this._frame.isDestroyed() && !this._view.webContents.isDestroyed()) {
			// Attach if not attached yet
			const children = this._frame.contentView.children;
			if (!children.includes(this._view)) {
				this._frame.contentView.addChildView(this._view);
			}
			this._view.setVisible(true);
			this.attached = true;
		}
	}

	hide(): void {
		if (this._view.webContents.isDestroyed()) {
			return;
		}
		this._view.setVisible(false);
		this.attached = false;
	}

	load(configuration: INativeWindowConfiguration, options?: { isReload?: boolean }): void {
		this.logService.trace(`[spaces:view] load host ${this.id}`);

		// The renderer uses `configuration.windowId` as its IPC identity
		// (`window:${windowId}`). Unlike a `CodeWindow` (whose id is the
		// `electron.BrowserWindow.id`), a `WebContentsView` has no window of its own, so
		// the host id (the `WebContents.id`) is the only stable identity.
		configuration.windowId = this.id;

		// Fill in window-related config the renderer relies on
		configuration.handle = this._frame && !this._frame.isDestroyed() ? VSBuffer.wrap(this._frame.getNativeWindowHandle()) : undefined;
		configuration.fullscreen = !!this._frame?.isFullScreen();
		configuration.maximized = !!this._frame?.isMaximized();
		configuration.partsSplash = this.themeMainService.getWindowSplash(configuration.workspace);
		configuration.perfMarks = getMarks();

		this.configObjectUrl.update(configuration);
		this._config = configuration;
		this.readyState = 'navigating';

		const windowUrl = FileAccess.asBrowserUri(`vs/code/electron-browser/workbench/workbench${this.environmentMainService.isBuilt ? '' : '-dev'}.html`).toString(true);
		this._view.webContents.loadURL(windowUrl);

		this._onWillLoad.fire({ workspace: configuration.workspace, reason: options?.isReload ? LoadReason.RELOAD : LoadReason.INITIAL });
	}

	send(channel: string, ...args: unknown[]): void {
		if (this._view.webContents.isDestroyed()) {
			this.logService.warn(`[spaces:view] Sending IPC message to channel '${channel}' for a destroyed host`);
			return;
		}

		try {
			this._view.webContents.send(channel, ...args);
		} catch (error) {
			this.logService.warn(`[spaces:view] Error sending IPC message to channel '${channel}' of host ${this.id}: ${toErrorMessage(error)}`);
		}
	}

	sendWhenReady(channel: string, token: CancellationToken, ...args: unknown[]): void {
		if (this.isReady) {
			this.send(channel, ...args);
		} else {
			this.ready().then(() => {
				if (!token.isCancellationRequested) {
					this.send(channel, ...args);
				}
			});
		}
	}

	private ready(): Promise<void> {
		if (this.isReady) {
			return Promise.resolve();
		}

		return new Promise<void>(resolve => {
			this.whenReadyCallbacks.push(resolve);
		});
	}

	focus(options?: { mode: FocusMode }): void {
		switch (options?.mode ?? FocusMode.Transfer) {
			case FocusMode.Transfer:
			case FocusMode.Force:
				this._onWillFocus.fire();
				this._view.webContents.focus();
				break;
			case FocusMode.Notify:
				this._onDidRequestAttention.fire();
				break;
		}
	}

	getBounds(): Electron.Rectangle {
		return this._frame && !this._frame.isDestroyed() ? this._frame.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
	}

	matches(webContents: Electron.WebContents): boolean {
		return this._view.webContents.id === webContents.id;
	}

	close(): void {
		this.dispose();
	}

	override dispose(): void {
		this.workbenchHostRegistry.unregister(this);
		this._onDidClose.fire();
		if (!this._view.webContents.isDestroyed()) {
			this._view.webContents.close({ waitForBeforeUnload: false });
		}
		super.dispose();
	}
}
