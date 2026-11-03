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
import { escape } from '../../../base/common/strings.js';
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

	private errorShown = false;
	private rendererErrors: string[] = [];
	private readonly loadTimeoutScheduler: RunOnceScheduler;

	private whenReadyCallbacks: { (): void }[] = [];

	setReady(): void {
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

		this._register(Event.fromNodeEventEmitter(this._view.webContents, 'did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => ({ errorCode, errorDescription, validatedURL, isMainFrame }))(({ errorCode, errorDescription, validatedURL, isMainFrame }) => {
			// -3 (ERR_ABORTED) is the expected error when navigation is interrupted
			// (e.g. the user reloads or a new navigation supersedes the load).
			if (isMainFrame && errorCode !== -3) {
				// Allow a failed manual reload to re-render the error page.
				this.errorShown = false;
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
				this.errorShown = false;
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
		this.errorShown = false;
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
			? `<div style="color:#f48771;line-height:1.5;margin-top:12px;word-break:break-word;">${escape(lastError)}</div>`
			: '';

		const script = `(() => {
			if (document.getElementById('paracode-space-stalled')) { return; }
			const overlay = document.createElement('div');
			overlay.id = 'paracode-space-stalled';
			overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.88);color:#cccccc;font-family:-apple-system,system-ui,sans-serif;';
			overlay.innerHTML = '<div style="max-width:520px;padding:24px;text-align:center;">'
				+ '<div style="font-size:18px;font-weight:600;margin-bottom:8px;">Space is taking too long to start</div>'
				+ '<div style="color:#969696;line-height:1.5;">The workbench has not finished loading. DevTools has been opened - check the console for errors.</div>'
				+ '<div style="color:#969696;line-height:1.5;margin-top:8px;">If this keeps happening, reloading the Space or restarting ParaCode may help.</div>'
				+ ${JSON.stringify(errorBlock)}
				+ '</div>';
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
	 * Render an in-place error page for this Space instead of leaving the view
	 * blank. The page is a self-contained `data:` URL: it performs no IPC, so it
	 * works even when the renderer process is gone, preload failed or the boot
	 * JS crashed before the workbench could start. It shows the failure, the log
	 * directory, and a link back to the workbench to retry.
	 */
	private showErrorPage(title: string, message: string, errorCode?: string, openDevTools = false): void {
		if (this.errorShown || this._view.webContents.isDestroyed()) {
			return;
		}
		this.errorShown = true;
		this.loadTimeoutScheduler.cancel();
		this.logService.error(`[spaces:view] host ${this.id} ${title}: ${message}`);

		const workbenchUrl = FileAccess.asBrowserUri(`vs/code/electron-browser/workbench/workbench${this.environmentMainService.isBuilt ? '' : '-dev'}.html`).toString(true);
		const errorPageUrl = `data:text/html;charset=utf-8,${encodeURIComponent(this.buildErrorPageHtml(title, message, errorCode, workbenchUrl))}`;

		void this._view.webContents.loadURL(errorPageUrl).catch(error => {
			this.logService.error(`[spaces:view] failed to render error page for host ${this.id}: ${toErrorMessage(error)}`);
		});

		if (openDevTools) {
			this._view.webContents.openDevTools();
		}
	}

	private buildErrorPageHtml(title: string, message: string, errorCode: string | undefined, workbenchUrl: string): string {
		const logsPath = this.environmentMainService.logsHome.fsPath;
		const code = errorCode ? `<p class="code">Error code: ${escape(errorCode)}</p>` : '';

		return `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8" />
	<style>
		body { margin: 0; font-family: -apple-system, system-ui, 'Segoe UI', sans-serif; background: #1e1e1e; color: #cccccc; }
		.container { max-width: 760px; margin: 0 auto; padding: 48px 24px; }
		h1 { font-size: 24px; font-weight: 600; margin: 0 0 12px; }
		.message { margin: 12px 0; line-height: 1.5; word-break: break-word; }
		.code { color: #f48771; font-weight: 500; }
		.logs { color: #969696; font-size: 12px; }
		.logs code { background: #252526; padding: 2px 6px; border-radius: 3px; word-break: break-all; }
		.button { display: inline-block; margin-top: 16px; padding: 8px 18px; background: #0e639c; color: #ffffff; text-decoration: none; border-radius: 4px; font-size: 13px; }
		.button:hover { background: #1177bb; }
		.hint { color: #969696; font-size: 12px; margin-top: 8px; }
	</style>
</head>
<body>
	<div class="container">
		<h1>\u26a0\ufe0f ${escape(title)}</h1>
		<p class="message">${escape(message)}</p>
		${code}
		<p class="logs">Logs: <code>${escape(logsPath)}</code></p>
		<a class="button" href="${escapeAttribute(workbenchUrl)}">Reload Space</a>
		<p class="hint">If this keeps happening, open DevTools (Cmd+Alt+I) and check the console, then inspect the log directory above.</p>
	</div>
</body>
</html>`;
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
const LOAD_TIMEOUT = 20000;

/** Escape a value for use inside a double-quoted HTML attribute. */
function escapeAttribute(value: string): string {
	return escape(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
