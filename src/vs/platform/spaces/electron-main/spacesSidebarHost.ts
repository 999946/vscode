/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import electron from 'electron';
import { Disposable } from '../../../base/common/lifecycle.js';
import { FileAccess } from '../../../base/common/network.js';
import { validatedIpcMain } from '../../../base/parts/ipc/electron-main/ipcMain.js';
import { basename, extname } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { IDialogMainService } from '../../dialogs/electron-main/dialogMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IThemeMainService } from '../../theme/electron-main/themeMainService.js';
import { SpaceOperationResult, ISpaceWorkspace } from '../common/spaces.js';
import { ISpacesSettings } from '../common/spacesConfig.js';
import { ISpacesSidebarData, ISpacesSidebarRpcRequest, ISpacesSidebarSpace, ISpacesSidebarTab, SpacesSidebarRpcMethod, SPACES_SIDEBAR_CHANGED_CHANNEL, SPACES_SIDEBAR_CHANNEL } from '../common/spacesSidebarRpc.js';
import type { ISerializedSpaceTab } from '../common/spacesTabs.js';
import { ICommandService } from '../../commands/common/commands.js';
import type { ISpacesViewService } from './spacesViewService.js';

/** Default width of the shared Spaces sidebar in the frame window. */
export const SPACES_SIDEBAR_WIDTH = 280;

/**
 * Hosts the shared Spaces sidebar as a `WebContentsView` attached to the frame
 * `BrowserWindow`. Unlike a Space's workbench host, this view is created once
 * per frame and lives for the frame's lifetime — it is NOT swapped when the
 * active Space changes. Switching Spaces only changes which workbench view is
 * visible to its right.
 *
 * The sidebar page is a small standalone DOM page that talks to the main
 * process over `validatedIpcMain.handle(SPACES_SIDEBAR_CHANNEL, ...)`. The
 * main process resolves labels / serializes data so the page stays dumb.
 */
export class SpacesSidebarHost extends Disposable {

	private readonly view: electron.WebContentsView;

	constructor(
		frame: electron.BrowserWindow,
		private readonly spacesViewService: ISpacesViewService,
		@IThemeMainService private readonly themeMainService: IThemeMainService,
		@IDialogMainService private readonly dialogMainService: IDialogMainService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this.view = new electron.WebContentsView({
			webPreferences: {
				preload: FileAccess.asFileUri('vs/platform/spaces/electron-browser/spacesSidebarPreload.js').fsPath,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				spellcheck: false,
				backgroundThrottling: false
			}
		});
		this.view.setBackgroundColor(this.themeMainService.getBackgroundColor());

		frame.contentView.addChildView(this.view);
		this.setBounds(frame.getContentBounds());

		this._register(validatedIpcMain.handle(SPACES_SIDEBAR_CHANNEL, async (event, request: ISpacesSidebarRpcRequest) => {
			if (event.sender.id !== this.view.webContents.id) {
				return undefined;
			}
			return this.handleRpc(request);
		}));

		this._register(this.spacesViewService.onDidChangeSpaces(() => this.pushChange()));

		void this.view.webContents.loadURL(
			FileAccess.asBrowserUri('vs/platform/spaces/electron-browser/spacesSidebar.html').toString(true)
		);
	}

	get webContents(): electron.WebContents {
		return this.view.webContents;
	}

	override dispose(): void {
		// This host owns the global `vscode:spacesSidebar` handler. Remove it so
		// a recreated frame (new sidebar) does not collide with a stale handler.
		validatedIpcMain.removeHandler(SPACES_SIDEBAR_CHANNEL);
		super.dispose();
	}

	/** Position the sidebar at the left edge of the frame's content area. */
	setBounds(frameContentBounds: Electron.Rectangle): void {
		this.view.setBounds({
			x: 0,
			y: 0,
			width: Math.min(SPACES_SIDEBAR_WIDTH, frameContentBounds.width),
			height: frameContentBounds.height
		});
	}

	private async handleRpc(request: ISpacesSidebarRpcRequest): Promise<unknown> {
		const method = request.method as SpacesSidebarRpcMethod;
		const args = request.args ?? [];
		switch (method) {
			case 'getSpaces':
				return this.toSidebarData();
			case 'createEmptySpace':
				return this.spacesViewService.createEmptySpace(undefined);
			case 'createSpace':
				return this.spacesViewService.createSpace(undefined, args[0] as string);
			case 'getSettings':
				return this.toSidebarSettings();
			case 'setSetting':
				await this.spacesViewService.setSidebarSetting(undefined, args[0] as string, args[1]);
				return this.toSidebarSettings();
			case 'getSpaceTabs': {
				const state = await this.spacesViewService.getSpaceTabs(undefined, args[0] as string);
				return { tabs: state.tabs.map((t, i) => toSidebarTab(t, i === state.activeTabIndex)) };
			}
			case 'openSettings':
				await this.commandService.executeCommand('workbench.action.openSettings', 'spaces');
				return undefined;
			case 'newTabInSpace':
				await this.spacesViewService.sendToSpace(undefined, args[0] as string, 'spaces:newTab');
				return undefined;
			case 'closeTab': {
				const [spaceId, tabId] = args as [string, string];
				await this.spacesViewService.sendToSpace(undefined, spaceId, 'spaces:closeTab', tabId);
				return undefined;
			}
			case 'openFolderAsSpace': {
				const result = await this.dialogMainService.showOpenDialog({
					title: 'Open Folder as New Space',
					properties: ['openDirectory', 'createDirectory']
				});
				const picked = result.filePaths?.[0];
				if (picked) {
					return this.spacesViewService.openFolderAsSpace(undefined, URI.file(picked));
				}
				return { result: SpaceOperationResult.Ok };
			}
			case 'switchToSpace':
				return this.spacesViewService.switchToSpace(undefined, args[0] as string);
			case 'closeSpace':
				return this.spacesViewService.closeSpace(undefined, args[0] as string);
			case 'deleteSpace':
				return this.spacesViewService.deleteSpace(undefined, args[0] as string);
			case 'renameSpace':
				return this.spacesViewService.renameSpace(undefined, args[0] as string, args[1] as string);
			default:
				this.logService.warn(`[spaces:sidebar] unknown RPC method '${method}'`);
				return undefined;
		}
	}

	private pushChange(): void {
		if (!this.view.webContents.isDestroyed()) {
			void this.toSidebarData().then(data => {
				if (!this.view.webContents.isDestroyed()) {
					this.view.webContents.send(SPACES_SIDEBAR_CHANGED_CHANNEL, data);
				}
			});
		}
	}

	private async toSidebarSettings(): Promise<ISpacesSettings> {
		return this.spacesViewService.getSidebarSettings(undefined);
	}

	private async toSidebarData(): Promise<ISpacesSidebarData> {
		const snapshot = await this.spacesViewService.getSpaces(undefined);
		const activeId = snapshot.activeSpaceId;
		const tabCounts = new Map<string, number>();
		await Promise.all(snapshot.spaces.map(async space => {
			const state = await this.spacesViewService.getSpaceTabs(undefined, space.id);
			tabCounts.set(space.id, state.tabs.length);
		}));
		const spaces: ISpacesSidebarSpace[] = snapshot.spaces.map(space => ({
			id: space.id,
			name: space.name,
			workspaceLabel: space.workspace ? toSidebarWorkspaceLabel(space.workspace) : undefined,
			workspaceUri: space.workspace?.uri,
			state: space.state,
			needsAttention: space.needsAttention,
			isCurrent: space.id === activeId,
			tabCount: tabCounts.get(space.id) ?? 0
		}));
		return { spaces };
	}
}

function toSidebarTab(tab: ISerializedSpaceTab, active: boolean): ISpacesSidebarTab {
	return {
		id: `${tab.kind}-${tab.value ?? tab.label}`,
		kind: tab.kind,
		label: tab.customTitle ?? tab.label,
		detail: tab.detail,
		active
	};
}

function toSidebarWorkspaceLabel(workspace: ISpaceWorkspace): string {
	const name = basename(workspace.uri);
	if (workspace.kind === 'workspace') {
		const ext = extname(workspace.uri);
		return ext ? name.substring(0, name.length - ext.length) : name;
	}
	return name || workspace.uri.authority || workspace.uri.toString();
}
