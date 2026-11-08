/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import electron from 'electron';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { FileAccess } from '../../../base/common/network.js';
import { getMarks } from '../../../base/common/performance.js';
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
import { SpacesErrorPageFallback } from './spacesErrorPage.js';

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

	/**
	 * Mirrors `ICodeWindow.lastFocusTime` so host-agnostic code can pick the
	 * "last focused" workbench without knowing if it is window- or view-backed.
	 * Updated when the renderer gains focus, when it is explicitly focused and
	 * when it is shown (a newly shown Space is the one the user is looking at).
	 */
	private _lastFocusTime = Date.now();
	get lastFocusTime(): number { return this._lastFocusTime; }

	private readyState: 'none' | 'navigating' | 'ready' = 'none';
	get isReady(): boolean { return this.readyState === 'ready'; }

	private readonly errorPage: SpacesErrorPageFallback;
	private rendererErrors: string[] = [];
	private readonly loadTimeoutScheduler: RunOnceScheduler;

	private whenReadyCallbacks: { (): void }[] = [];

	setReady(): void {
		this.logService.trace(`[spaces:view] host ${this.id} reported ready`);
		this.loadTimeoutScheduler.cancel();
		this.removeStartupStalledOverlay();
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

		// A Space that fails to load, crashes or loses its preload used to leave
		// the view permanently black. The fallback renders a self-contained page
		// (no IPC needed) and owns the retry path back to the workbench.
		this.errorPage = this._register(new SpacesErrorPageFallback(this._view.webContents, this.logService, {
			label: `host ${this.id}`,
			retryUrl: FileAccess.asBrowserUri(`vs/code/electron-browser/workbench/workbench${this.environmentMainService.isBuilt ? '' : '-dev'}.html`).toString(true),
			logsPath: this.environmentMainService.logsHome.fsPath
		}));

		// If the workbench renderer never reports readiness, assume startup is
		// stuck - most often a silent JS error during boot that leaves the page
		// on the splash / black screen. Keep the workbench page intact and
		// overlay a hint, then open DevTools so the console error is visible.
		this.loadTimeoutScheduler = this._register(new RunOnceScheduler(() => {
			if (!this.isReady) {
				this.showStartupStalledOverlay();
			}
		}, LOAD_TIMEOUT));

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

		// Track focus so main-process code can pick the last focused workbench
		// (e.g. to surface an update dialog) even though a view host has no
		// `BrowserWindow` whose focus events would otherwise be observed.
		this._register(Event.fromNodeEventEmitter(this._view.webContents, 'focus')(() => {
			this._lastFocusTime = Date.now();
		}));

		this._register(Event.fromNodeEventEmitter(this._view.webContents, 'did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => ({ errorCode, errorDescription, validatedURL, isMainFrame }))(({ errorCode, errorDescription, validatedURL, isMainFrame }) => {
			// -3 (ERR_ABORTED) is the expected error when navigation is interrupted
			// (e.g. the user reloads or a new navigation supersedes the load).
			if (isMainFrame && errorCode !== -3) {
				// Allow a failed manual reload to re-render the error page.
				this.errorPage.reset();
				this.showErrorPage('Space failed to load', `${errorDescription}${validatedURL ? ` (${validatedURL})` : ''}`, String(errorCode));
			}
		}));

		this._register(Event.fromNodeEventEmitter(this._view.webContents, 'render-process-gone', (event, details) => details)(details => {
			this._onDidDestroy.fire();
			this.showErrorPage('Space renderer crashed', `Reason: ${details?.reason ?? 'unknown'}, exit code: ${details?.exitCode ?? 'unknown'}`);
		}));

		this._register(Event.fromNodeEventEmitter(this._view.webContents, 'preload-error', (event, preloadPath, error) => ({ preloadPath, error }))(({ preloadPath, error }) => {
			this.showErrorPage('Space preload script failed', `${preloadPath}: ${toErrorMessage(error)}`, undefined, true);
		}));

		this._register(Event.fromNodeEventEmitter(this._view.webContents, 'console-message', (details: Electron.WebContentsConsoleMessageEventParams) => details)((details: Electron.WebContentsConsoleMessageEventParams) => {
			if (details.level === 'error') {
				// Keep the most recent errors so a stalled startup can show what the
				// renderer actually complained about instead of just a blank screen.
				this.rendererErrors.push(details.message);
				if (this.rendererErrors.length > 20) {
					this.rendererErrors.shift();
				}
				this.logService.error(`[spaces:view] host ${this.id} renderer: ${details.message}`);
			}
		}));

		this._register(Event.fromNodeEventEmitter(this._view.webContents, 'did-navigate', (event, url) => url)(url => {
			// Re-arm the startup timeout when the workbench page is (re)navigated
			// to, e.g. through the "Reload Space" link on the error page, but not
			// when the error page itself is loaded (a `data:` URL).
			if (!this.isReady && !url.startsWith('data:')) {
				this.errorPage.reset();
				this.loadTimeoutScheduler.schedule(LOAD_TIMEOUT);
			}
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
			this._lastFocusTime = Date.now();
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
		this.errorPage.reset();
		this.rendererErrors = [];

		const windowUrl = FileAccess.asBrowserUri(`vs/code/electron-browser/workbench/workbench${this.environmentMainService.isBuilt ? '' : '-dev'}.html`).toString(true);
		this._view.webContents.loadURL(windowUrl);
		this.loadTimeoutScheduler.schedule(LOAD_TIMEOUT);

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
				this._lastFocusTime = Date.now();
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

	/**
	 * The renderer never reported ready but did not fail either. Keep the
	 * workbench page as-is (a slow start must not be replaced) and overlay a
	 * hint on top of it, then open DevTools where the console shows the actual
	 * startup error. The overlay is removed again if the workbench becomes ready.
	 */
	private showStartupStalledOverlay(): void {
		if (this._view.webContents.isDestroyed()) {
			return;
		}

		this.logService.error(`[spaces:view] host ${this.id} did not report ready within ${LOAD_TIMEOUT}ms; showing startup overlay`);

		const lastError = this.rendererErrors.length ? this.rendererErrors[this.rendererErrors.length - 1] : undefined;
		const errorBlock = lastError
			? `(() => { const d = document.createElement('div'); d.style.cssText = 'color:#f48771;line-height:1.5;margin-top:12px;word-break:break-word;'; d.textContent = ${JSON.stringify(lastError)}; return d; })()`
			: 'null';

		// Build the overlay with DOM APIs (no `innerHTML`): the workbench document
		// enforces Trusted Types, so assigning HTML strings here throws.
		const script = `(() => {
			if (document.getElementById('paracode-space-stalled')) { return; }
			const overlay = document.createElement('div');
			overlay.id = 'paracode-space-stalled';
			overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.88);color:#cccccc;font-family:-apple-system,system-ui,sans-serif;';
			const box = document.createElement('div');
			box.style.cssText = 'max-width:520px;padding:24px;text-align:center;';
			const title = document.createElement('div');
			title.style.cssText = 'font-size:18px;font-weight:600;margin-bottom:8px;';
			title.textContent = 'Space is taking too long to start';
			const hint = document.createElement('div');
			hint.style.cssText = 'color:#969696;line-height:1.5;';
			hint.textContent = 'The workbench has not finished loading. DevTools has been opened - check the console for errors.';
			box.appendChild(title);
			box.appendChild(hint);
			const lastError = ${errorBlock};
			if (lastError) { box.appendChild(lastError); }
			overlay.appendChild(box);
			document.body.appendChild(overlay);
		})();`;

		void this._view.webContents.executeJavaScript(script).catch(error => {
			this.logService.error(`[spaces:view] failed to inject startup overlay for host ${this.id}: ${toErrorMessage(error)}`);
		});

		this._view.webContents.openDevTools();
	}

	private removeStartupStalledOverlay(): void {
		if (this._view.webContents.isDestroyed()) {
			return;
		}

		void this._view.webContents.executeJavaScript(`document.getElementById('paracode-space-stalled')?.remove();`).catch(() => {
			// The page may have navigated or the renderer may be gone; nothing to clean up.
		});
	}

	/**
	 * Surface a failure inside this Space instead of leaving the view blank.
	 *
	 * See `SpacesErrorPageFallback`: the page needs no IPC, so it shows up even
	 * when the renderer is gone, preload failed or boot JS crashed, and retrying
	 * is driven from the main process.
	 */
	private showErrorPage(title: string, message: string, errorCode?: string, openDevTools = false): void {
		this.loadTimeoutScheduler.cancel();
		this.errorPage.show(title, message, errorCode);

		if (openDevTools) {
			this._view.webContents.openDevTools();
		}
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

/** How long to wait for the workbench renderer to report ready before showing a startup hint. */
// Dev-mode cold starts (extension host + agent host + remote calls) can easily
// exceed 20s on slower machines, and a false "stalled" overlay is worse than
// waiting a bit longer. The overlay still surfaces a genuinely stuck boot.
const LOAD_TIMEOUT = 45000;
