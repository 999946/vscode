/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import electron from 'electron';
import { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { escape } from '../../../base/common/strings.js';
import { ILogService } from '../../log/common/log.js';

export interface ISpacesErrorPageOptions {
	/** Heading shown in large type, e.g. "Space failed to load". */
	readonly title: string;
	/** Detail line describing the failure. */
	readonly message: string;
	/** Optional Electron/net error code, rendered in red. */
	readonly errorCode?: string;
	/** Log directory, rendered so the user can find the full trace. */
	readonly logsPath: string;
	/** Extra hint appended below the retry button. */
	readonly hint?: string;
}

/**
 * Builds a self-contained error page (a `data:` URL) for a Spaces view.
 *
 * The page deliberately performs no IPC and loads no scripts: it must render
 * even when the preload script failed, the renderer crashed or the workbench
 * JS threw before boot. Retrying is driven by the main process (see
 * `SpacesErrorPageFallback`), because a `data:` document cannot navigate to a
 * `vscode-file://` URL on its own.
 */
export function buildSpacesErrorPageHtml(options: ISpacesErrorPageOptions): string {
	const code = options.errorCode ? `<p class="code">Error code: ${escape(options.errorCode)}</p>` : '';
	const hint = options.hint ?? 'If this keeps happening, inspect the log directory above.';

	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8" />
	<style>
		body { margin: 0; font-family: -apple-system, system-ui, 'Segoe UI', sans-serif; background: #1e1e1e; color: #cccccc; }
		.container { max-width: 760px; margin: 0 auto; padding: clamp(16px, 5vh, 48px) 24px; }
		h1 { font-size: clamp(16px, 3vh, 22px); font-weight: 600; margin: 0 0 12px; }
		.message { margin: 12px 0; line-height: 1.5; word-break: break-word; }
		.code { color: #f48771; font-weight: 500; }
		.logs { color: #969696; font-size: 12px; }
		.logs code { background: #252526; padding: 2px 6px; border-radius: 3px; word-break: break-all; }
		.button { display: inline-block; margin-top: 16px; padding: 8px 18px; background: #0e639c; color: #ffffff; text-decoration: none; border-radius: 4px; font-size: 13px; border: none; cursor: pointer; }
		.button:hover { background: #1177bb; }
		.hint { color: #969696; font-size: 12px; margin-top: 8px; }
	</style>
</head>
<body>
	<div class="container">
		<h1>\u26a0\ufe0f ${escape(options.title)}</h1>
		<p class="message">${escape(options.message)}</p>
		${code}
		<p class="logs">Logs: <code>${escape(options.logsPath)}</code></p>
		<a class="button" href="${SPACES_ERROR_PAGE_RETRY_SCHEME}retry">Reload Space</a>
		<p class="hint">${escape(hint)}</p>
		<p class="hint">You can also press \u2318R (Ctrl+R on Windows/Linux) while this view has focus.</p>
	</div>
</body>
</html>`;
}

/** Prefix of the synthetic URL the error page's retry link points at. */
export const SPACES_ERROR_PAGE_RETRY_SCHEME = 'paracode-retry:';

export interface ISpacesErrorPageFallbackOptions {
	/** Short label used in log messages, e.g. "host 4" or "sidebar". */
	readonly label: string;
	/** The workbench/sidebar target to navigate to when the user retries. */
	readonly retryUrl: string;
	readonly logsPath: string;
}

/**
 * Renders an error page inside a Spaces `WebContents` when loading fails, and
 * wires up retry so the user is never stuck on an error page that cannot be
 * dismissed.
 */
export class SpacesErrorPageFallback extends Disposable {

	private _shown = false;
	get isShown(): boolean {
		return this._shown;
	}

	constructor(
		private readonly webContents: electron.WebContents,
		private readonly logService: ILogService,
		private readonly options: ISpacesErrorPageFallbackOptions
	) {
		super();

		// Retrying through the error page's link, or by reloading the view
		// (Cmd/Ctrl+R, F5), must navigate back to the real page. Both paths are
		// handled here in the main process, since a `data:` document has no way
		// to reach `vscode-file://` on its own.
		this._register(Event.fromNodeEventEmitter(this.webContents, 'will-navigate', (event: Electron.Event, url: string) => ({ event, url }))(({ event, url }) => {
			if (this._shown || url.startsWith(SPACES_ERROR_PAGE_RETRY_SCHEME)) {
				event.preventDefault();
				this.retry();
			}
		}));

		this._register(Event.fromNodeEventEmitter(this.webContents, 'before-input-event', (event: Electron.Event, input: Electron.Input) => ({ event, input }))(({ event, input }) => {
			if (!this._shown || input.type !== 'keyDown') {
				return;
			}
			const isReload = (input.control || input.meta) && input.key.toLowerCase() === 'r';
			if (isReload || input.key === 'F5' || input.key === 'Enter') {
				event.preventDefault();
				this.retry();
			}
		}));
	}

	/** Show the error page, replacing whatever the view is currently rendering. */
	show(title: string, message: string, errorCode?: string): void {
		if (this._shown || this.webContents.isDestroyed()) {
			return;
		}
		this._shown = true;
		this.logService.error(`[spaces:view] ${this.options.label} ${title}: ${message}`);

		// Drop any navigation still in flight (e.g. a reload that superseded a
		// failing load) so the error page is the last word.
		this.webContents.stop();

		const html = buildSpacesErrorPageHtml({
			title,
			message,
			errorCode,
			logsPath: this.options.logsPath,
			hint: `Retry loads ${this.options.retryUrl.replace(/^.*\//, '')} again.`
		});
		const errorPageUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

		void this.webContents.loadURL(errorPageUrl).catch(error => {
			this.logService.error(`[spaces:view] failed to render error page for ${this.options.label}: ${error}`);
		});
	}

	/** Clear the shown state, e.g. when a new load is starting. */
	reset(): void {
		this._shown = false;
	}

	/** Leave the error page and load the real target again. */
	retry(): void {
		if (this.webContents.isDestroyed()) {
			return;
		}
		this._shown = false;
		this.logService.trace(`[spaces:view] ${this.options.label} retrying ${this.options.retryUrl}`);
		void this.webContents.loadURL(this.options.retryUrl).catch(error => {
			this.logService.error(`[spaces:view] ${this.options.label} retry failed: ${error}`);
		});
	}
}
