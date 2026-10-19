/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { revive } from '../../../../base/common/marshalling.js';
import { UriComponents } from '../../../../base/common/uri.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { ISpaceOperationResult, ISpacesService, ISpacesSnapshot, SPACES_CHANNEL_NAME } from '../../../../platform/spaces/common/spaces.js';
import { ISpacesSettings } from '../../../../platform/spaces/common/spacesConfig.js';
import { ISpaceTabState } from '../../../../platform/spaces/common/spacesTabs.js';

export class SpacesService implements ISpacesService {

	declare readonly _serviceBrand: undefined;

	private readonly proxy: ISpacesService;

	/**
	 * `ProxyChannel` revives the results of calls but not event payloads, so
	 * the Space workspace URIs are revived here.
	 */
	readonly onDidChangeSpaces: Event<ISpacesSnapshot>;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@INativeHostService nativeHostService: INativeHostService
	) {
		this.proxy = ProxyChannel.toService<ISpacesService>(mainProcessService.getChannel(SPACES_CHANNEL_NAME), {
			context: nativeHostService.windowId
		});

		this.onDidChangeSpaces = (listener, thisArgs, disposables) => this.proxy.onDidChangeSpaces(snapshot => listener.call(thisArgs, revive<ISpacesSnapshot>(snapshot)), undefined, disposables);
	}

	getSpaces(): Promise<ISpacesSnapshot> { return this.proxy.getSpaces(); }
	createEmptySpace(): Promise<ISpaceOperationResult> { return this.proxy.createEmptySpace(); }
	openFolderAsSpace(folderUri: UriComponents): Promise<ISpaceOperationResult> { return this.proxy.openFolderAsSpace(folderUri); }
	openWorkspaceAsSpace(workspaceUri: UriComponents): Promise<ISpaceOperationResult> { return this.proxy.openWorkspaceAsSpace(workspaceUri); }
	addCurrentWindowAsSpace(): Promise<ISpaceOperationResult> { return this.proxy.addCurrentWindowAsSpace(); }
	switchToSpace(spaceId: string): Promise<ISpaceOperationResult> { return this.proxy.switchToSpace(spaceId); }
	closeSpace(spaceId: string): Promise<ISpaceOperationResult> { return this.proxy.closeSpace(spaceId); }
	renameSpace(spaceId: string, name: string): Promise<ISpaceOperationResult> { return this.proxy.renameSpace(spaceId, name); }
	revealCurrentSpace(): Promise<void> { return this.proxy.revealCurrentSpace(); }
	requestAttention(): Promise<void> { return this.proxy.requestAttention(); }
	getSidebarSettings(): Promise<ISpacesSettings> { return this.proxy.getSidebarSettings(); }
	setSidebarSetting(key: string, value: unknown): Promise<void> { return this.proxy.setSidebarSetting(key, value); }
	getSpaceTabs(spaceId: string): Promise<ISpaceTabState> { return this.proxy.getSpaceTabs(spaceId); }
	updateSpaceTabs(state: ISpaceTabState): Promise<void> { return this.proxy.updateSpaceTabs(state); }
	getPersistedTabStateForWindow(): Promise<ISpaceTabState> { return this.proxy.getPersistedTabStateForWindow(); }
	createSpace(name: string): Promise<ISpaceOperationResult> { return this.proxy.createSpace(name); }
	deleteSpace(spaceId: string): Promise<ISpaceOperationResult> { return this.proxy.deleteSpace(spaceId); }
	sendToSpace(spaceId: string, channel: string, ...args: unknown[]): Promise<void> { return this.proxy.sendToSpace(spaceId, channel, ...args); }
}

registerSingleton(ISpacesService, SpacesService, InstantiationType.Delayed);
