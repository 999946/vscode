/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Only `import type` is allowed in preload scripts — Electron preloads cannot
// resolve module imports at runtime.
import type { ISpacesSidebarRpcRequest, SpacesSidebarRpcMethod } from '../common/spacesSidebarRpc.js';

const { ipcRenderer, contextBridge } = require('electron') as typeof import('electron');

/**
 * Minimal preload for the shared Spaces sidebar view. It exposes exactly one
 * bridge entry point: an `invoke`-style RPC to the main process
 * `vscode:spacesSidebar` channel plus a subscription to change events pushed
 * by the main process.
 *
 * The sidebar is intentionally NOT a full workbench renderer: it only needs
 * the Space list and the operations to switch/close/rename. Keeping it a tiny
 * standalone page (plain DOM + CSS) avoids pulling in the whole workbench
 * bootstrap for what is a small chrome surface.
 */
contextBridge.exposeInMainWorld('spacesSidebar', {
	invoke(method: SpacesSidebarRpcMethod, ...args: unknown[]): Promise<unknown> {
		const request: ISpacesSidebarRpcRequest = { method, args };
		return ipcRenderer.invoke('vscode:spacesSidebar', request);
	},
	onDidChange(callback: (data: unknown) => void): void {
		ipcRenderer.on('vscode:spacesSidebarChanged', (_event, data) => callback(data));
	}
});
