/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IWorkbenchHost } from './workbenchHost.js';

export const IWorkbenchHostRegistry = createDecorator<IWorkbenchHostRegistry>('workbenchHostRegistry');

/**
 * Maps every live workbench renderer to its host, independent of whether the
 * host is a full `BrowserWindow` (a `CodeWindow`) or a `WebContentsView`
 * attached to a shared frame (a `WebContentsViewWorkbenchHost`).
 *
 * The renderer's `WebContents.id` is the identity (matches the IPC routing in
 * `ipc.electron.ts`, which scopes every `vscode:hello`/`vscode:message` by
 * `sender.id`), so `getHostByWebContents` can resolve any renderer - including
 * one embedded in a `WebContentsView`, where `BrowserWindow.fromWebContents`
 * returns `undefined`.
 */
export interface IWorkbenchHostRegistry {

	readonly _serviceBrand: undefined;

	register(host: IWorkbenchHost): void;
	unregister(host: IWorkbenchHost): void;

	getHostById(hostId: number): IWorkbenchHost | undefined;
	getHostByWebContents(webContents: Electron.WebContents): IWorkbenchHost | undefined;
}

export class WorkbenchHostRegistry implements IWorkbenchHostRegistry {

	declare readonly _serviceBrand: undefined;

	private readonly hosts = new Map<number, IWorkbenchHost>();

	constructor(
		@ILogService private readonly logService: ILogService
	) { }

	register(host: IWorkbenchHost): void {
		this.hosts.set(host.id, host);
		this.logService.trace(`[hosts] registered host ${host.id}`);
	}

	unregister(host: IWorkbenchHost): void {
		if (this.hosts.get(host.id) === host) {
			this.hosts.delete(host.id);
			this.logService.trace(`[hosts] unregistered host ${host.id}`);
		}
	}

	getHostById(hostId: number): IWorkbenchHost | undefined {
		return this.hosts.get(hostId);
	}

	getHostByWebContents(webContents: Electron.WebContents): IWorkbenchHost | undefined {
		for (const host of this.hosts.values()) {
			if (host.matches(webContents)) {
				return host;
			}
		}

		return undefined;
	}
}
