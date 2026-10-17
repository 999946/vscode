/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { mnemonicButtonLabel } from '../../../../base/common/labels.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputButton, IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { ISpace, ISpaceOperationResult, ISpacesService, SPACES_ENABLED_SETTING, SpaceOperationResult } from '../../../../platform/spaces/common/spaces.js';
import { WORKSPACE_FILTER } from '../../../../platform/workspace/common/workspace.js';

export const SPACES_CATEGORY = localize2('spaces', "Spaces");

export const SpacesEnabledContext = ContextKeyExpr.equals(`config.${SPACES_ENABLED_SETTING}`, true);

export const enum SpacesCommandId {
	NewEmptySpace = 'workbench.action.spaces.newEmptySpace',
	OpenFolderAsNewSpace = 'workbench.action.spaces.openFolderAsNewSpace',
	OpenWorkspaceAsNewSpace = 'workbench.action.spaces.openWorkspaceAsNewSpace',
	AddCurrentWindowAsSpace = 'workbench.action.spaces.addCurrentWindowAsSpace',
	SwitchSpace = 'workbench.action.spaces.switchSpace',
	CloseCurrentSpace = 'workbench.action.spaces.closeCurrentSpace',
	RenameCurrentSpace = 'workbench.action.spaces.renameCurrentSpace',
	ListSpaces = 'workbench.action.spaces.listSpaces',
	TitleBarPicker = 'workbench.action.spaces.titleBarPicker'
}

function reportResult(notificationService: INotificationService, operation: ISpaceOperationResult): boolean {
	switch (operation.result) {
		case SpaceOperationResult.Ok:
			return true;
		case SpaceOperationResult.NativeFullScreen:
			notificationService.info(localize('spaces.nativeFullScreen', "Exit full screen before switching or creating Spaces."));
			return false;
		case SpaceOperationResult.UnsupportedWindow:
			notificationService.info(localize('spaces.unsupportedWindow', "Spaces are not supported in this window."));
			return false;
		case SpaceOperationResult.UnknownSpace:
			notificationService.warn(localize('spaces.unknownSpace', "The Space no longer exists."));
			return false;
		case SpaceOperationResult.OpenFailed:
			notificationService.error(localize('spaces.openFailed', "Unable to open the Space."));
			return false;
	}
}

function getCurrentSpace(spaces: readonly ISpace[], windowId: number): ISpace | undefined {
	return spaces.find(space => space.windowId === windowId);
}

export class NewEmptySpaceAction extends Action2 {
	constructor() {
		super({
			id: SpacesCommandId.NewEmptySpace,
			title: localize2('spaces.newEmptySpace', "New Empty Space"),
			category: SPACES_CATEGORY,
			precondition: SpacesEnabledContext,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const spacesService = accessor.get(ISpacesService);
		const notificationService = accessor.get(INotificationService);

		reportResult(notificationService, await spacesService.createEmptySpace());
	}
}

export class OpenFolderAsNewSpaceAction extends Action2 {
	constructor() {
		super({
			id: SpacesCommandId.OpenFolderAsNewSpace,
			title: localize2('spaces.openFolderAsNewSpace', "Open Folder as New Space..."),
			category: SPACES_CATEGORY,
			precondition: SpacesEnabledContext,
			f1: true
		});
	}

	/**
	 * @param folder optional folder to open without showing a dialog (for automation)
	 */
	async run(accessor: ServicesAccessor, folder?: URI | string): Promise<void> {
		const spacesService = accessor.get(ISpacesService);
		const fileDialogService = accessor.get(IFileDialogService);
		const notificationService = accessor.get(INotificationService);

		let folderUri = typeof folder === 'string' ? URI.file(folder) : URI.isUri(folder) ? folder : undefined;
		if (!folderUri) {
			const picked = await fileDialogService.showOpenDialog({
				title: localize('spaces.pickFolder', "Open Folder as New Space"),
				openLabel: mnemonicButtonLabel(localize({ key: 'spaces.openSpace', comment: ['&& denotes a mnemonic'] }, "&&Open as Space")),
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				defaultUri: await fileDialogService.defaultFolderPath()
			});
			folderUri = picked?.[0];
		}

		if (folderUri) {
			reportResult(notificationService, await spacesService.openFolderAsSpace(folderUri));
		}
	}
}

export class OpenWorkspaceAsNewSpaceAction extends Action2 {
	constructor() {
		super({
			id: SpacesCommandId.OpenWorkspaceAsNewSpace,
			title: localize2('spaces.openWorkspaceAsNewSpace', "Open Workspace as New Space..."),
			category: SPACES_CATEGORY,
			precondition: SpacesEnabledContext,
			f1: true
		});
	}

	/**
	 * @param workspace optional `.code-workspace` file to open without showing a dialog (for automation)
	 */
	async run(accessor: ServicesAccessor, workspace?: URI | string): Promise<void> {
		const spacesService = accessor.get(ISpacesService);
		const fileDialogService = accessor.get(IFileDialogService);
		const notificationService = accessor.get(INotificationService);

		let workspaceUri = typeof workspace === 'string' ? URI.file(workspace) : URI.isUri(workspace) ? workspace : undefined;
		if (!workspaceUri) {
			const picked = await fileDialogService.showOpenDialog({
				title: localize('spaces.pickWorkspace', "Open Workspace as New Space"),
				openLabel: mnemonicButtonLabel(localize({ key: 'spaces.openSpace', comment: ['&& denotes a mnemonic'] }, "&&Open as Space")),
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				filters: WORKSPACE_FILTER,
				defaultUri: await fileDialogService.defaultWorkspacePath()
			});
			workspaceUri = picked?.[0];
		}

		if (workspaceUri) {
			reportResult(notificationService, await spacesService.openWorkspaceAsSpace(workspaceUri));
		}
	}
}

export class AddCurrentWindowAsSpaceAction extends Action2 {
	constructor() {
		super({
			id: SpacesCommandId.AddCurrentWindowAsSpace,
			title: localize2('spaces.addCurrentWindowAsSpace', "Add Current Window as Space"),
			category: SPACES_CATEGORY,
			precondition: SpacesEnabledContext,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const spacesService = accessor.get(ISpacesService);
		const notificationService = accessor.get(INotificationService);

		reportResult(notificationService, await spacesService.addCurrentWindowAsSpace());
	}
}

export class SwitchSpaceAction extends Action2 {
	constructor() {
		super({
			id: SpacesCommandId.SwitchSpace,
			title: localize2('spaces.switchSpace', "Switch Space..."),
			category: SPACES_CATEGORY,
			precondition: SpacesEnabledContext,
			f1: true
		});
	}

	/**
	 * @param target optional Space id or name to switch to without showing the picker (for automation)
	 */
	async run(accessor: ServicesAccessor, target?: string): Promise<void> {
		if (typeof target === 'string') {
			const spacesService = accessor.get(ISpacesService);
			const notificationService = accessor.get(INotificationService);

			const { spaces } = await spacesService.getSpaces();
			const space = spaces.find(space => space.id === target) ?? spaces.find(space => space.name === target);
			reportResult(notificationService, space ? await spacesService.switchToSpace(space.id) : { result: SpaceOperationResult.UnknownSpace });
			return;
		}

		return showSpacesPicker(accessor, 'switch');
	}
}

export class TitleBarSpacesPickerAction extends Action2 {
	constructor() {
		super({
			id: SpacesCommandId.TitleBarPicker,
			title: localize2('spaces.titleBarPicker', "Spaces"),
			f1: false,
			precondition: SpacesEnabledContext,
			menu: {
				id: MenuId.TitleBarAdjacentCenter,
				order: -2000,
				when: SpacesEnabledContext
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		return showSpacesPicker(accessor, 'switch');
	}
}

export class CloseCurrentSpaceAction extends Action2 {
	constructor() {
		super({
			id: SpacesCommandId.CloseCurrentSpace,
			title: localize2('spaces.closeCurrentSpace', "Close Current Space"),
			category: SPACES_CATEGORY,
			precondition: SpacesEnabledContext,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const spacesService = accessor.get(ISpacesService);
		const nativeHostService = accessor.get(INativeHostService);
		const notificationService = accessor.get(INotificationService);

		const { spaces } = await spacesService.getSpaces();
		const current = getCurrentSpace(spaces, nativeHostService.windowId);
		if (!current) {
			notificationService.info(localize('spaces.notASpace', "This window is not a Space."));
			return;
		}

		reportResult(notificationService, await spacesService.closeSpace(current.id));
	}
}

export class RenameCurrentSpaceAction extends Action2 {
	constructor() {
		super({
			id: SpacesCommandId.RenameCurrentSpace,
			title: localize2('spaces.renameCurrentSpace', "Rename Current Space..."),
			category: SPACES_CATEGORY,
			precondition: SpacesEnabledContext,
			f1: true
		});
	}

	/**
	 * @param newName optional name to apply without showing an input box (for automation)
	 */
	async run(accessor: ServicesAccessor, newName?: string): Promise<void> {
		const spacesService = accessor.get(ISpacesService);
		const nativeHostService = accessor.get(INativeHostService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		const { spaces } = await spacesService.getSpaces();
		const current = getCurrentSpace(spaces, nativeHostService.windowId);
		if (!current) {
			notificationService.info(localize('spaces.notASpace', "This window is not a Space."));
			return;
		}

		await renameSpace(spacesService, quickInputService, notificationService, current, newName);
	}
}

export class ListSpacesAction extends Action2 {
	constructor() {
		super({
			id: SpacesCommandId.ListSpaces,
			title: localize2('spaces.listSpaces', "List Spaces"),
			category: SPACES_CATEGORY,
			precondition: SpacesEnabledContext,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		return showSpacesPicker(accessor, 'manage');
	}
}

async function renameSpace(spacesService: ISpacesService, quickInputService: IQuickInputService, notificationService: INotificationService, space: ISpace, newName?: string): Promise<void> {
	const name = newName ?? await quickInputService.input({
		title: localize('spaces.renameTitle', "Rename Space"),
		value: space.name,
		prompt: localize('spaces.renamePrompt', "Enter a new name. Leave empty to use the folder or workspace name.")
	});

	if (typeof name === 'string') {
		reportResult(notificationService, await spacesService.renameSpace(space.id, name));
	}
}

interface ISpacePickItem extends IQuickPickItem {
	readonly space?: ISpace;
	readonly commandId?: SpacesCommandId;
}

/**
 * The Spaces dropdown: all Spaces followed by Space management actions.
 * `manage` mode adds details and inline rename/close buttons.
 */
async function showSpacesPicker(accessor: ServicesAccessor, mode: 'switch' | 'manage'): Promise<void> {
	const spacesService = accessor.get(ISpacesService);
	const quickInputService = accessor.get(IQuickInputService);
	const labelService = accessor.get(ILabelService);
	const commandService = accessor.get(ICommandService);
	const nativeHostService = accessor.get(INativeHostService);
	const notificationService = accessor.get(INotificationService);

	const renameButton: IQuickInputButton = { iconClass: ThemeIcon.asClassName(Codicon.edit), tooltip: localize('spaces.renameButton', "Rename Space") };
	const closeButton: IQuickInputButton = { iconClass: ThemeIcon.asClassName(Codicon.close), tooltip: localize('spaces.closeButton', "Close Space") };

	const toItems = (spaces: readonly ISpace[]): Array<ISpacePickItem | IQuickPickSeparator> => {
		const current = getCurrentSpace(spaces, nativeHostService.windowId);
		const items: Array<ISpacePickItem | IQuickPickSeparator> = [];

		if (spaces.length > 0) {
			items.push({ type: 'separator', label: localize('spaces.separator', "Spaces") });
		}

		for (const space of spaces) {
			const isCurrent = space.id === current?.id;
			items.push({
				space,
				label: space.needsAttention
					? `$(${Codicon.bellDot.id}) ${localize('spaces.needsAttention', "{0} — needs attention", space.name)}`
					: `$(${isCurrent ? Codicon.check.id : Codicon.blank.id}) ${space.name}`,
				description: space.workspace ? labelService.getUriLabel(space.workspace.uri) : localize('spaces.empty', "No folder"),
				detail: mode === 'manage'
					? localize('spaces.detailState', "{0} · last active {1}", space.state === 'active' ? localize('spaces.stateActive', "Active") : localize('spaces.stateInactive', "Running in background"), space.lastActiveAt ? new Date(space.lastActiveAt).toLocaleTimeString() : localize('spaces.never', "never"))
					: undefined,
				buttons: mode === 'manage' ? [renameButton, closeButton] : [closeButton]
			});
		}

		items.push({ type: 'separator' });
		items.push({ commandId: SpacesCommandId.NewEmptySpace, label: `$(${Codicon.add.id}) ${localize('spaces.pick.new', "New Empty Space")}` });
		items.push({ commandId: SpacesCommandId.OpenFolderAsNewSpace, label: `$(${Codicon.folderOpened.id}) ${localize('spaces.pick.openFolder', "Open Folder as New Space...")}` });
		items.push({ commandId: SpacesCommandId.OpenWorkspaceAsNewSpace, label: `$(${Codicon.fileCode.id}) ${localize('spaces.pick.openWorkspace', "Open Workspace as New Space...")}` });
		if (current) {
			items.push({ commandId: SpacesCommandId.RenameCurrentSpace, label: `$(${Codicon.edit.id}) ${localize('spaces.pick.rename', "Rename Current Space...")}` });
			items.push({ commandId: SpacesCommandId.CloseCurrentSpace, label: `$(${Codicon.close.id}) ${localize('spaces.pick.close', "Close Current Space")}` });
		} else {
			items.push({ commandId: SpacesCommandId.AddCurrentWindowAsSpace, label: `$(${Codicon.window.id}) ${localize('spaces.pick.addCurrent', "Add Current Window as Space")}` });
		}
		if (mode === 'switch') {
			items.push({ commandId: SpacesCommandId.ListSpaces, label: `$(${Codicon.listUnordered.id}) ${localize('spaces.pick.manage', "Manage Spaces...")}` });
		}

		return items;
	};

	const disposables = new DisposableStore();
	const picker = disposables.add(quickInputService.createQuickPick<ISpacePickItem>({ useSeparators: true }));
	picker.title = mode === 'manage' ? localize('spaces.manageTitle', "Manage Spaces") : localize('spaces.switchTitle', "Switch Space");
	picker.placeholder = localize('spaces.placeholder', "Select a Space to switch to");
	picker.matchOnDescription = true;

	const snapshot = await spacesService.getSpaces();
	picker.items = toItems(snapshot.spaces);
	picker.activeItems = picker.items.filter((item): item is ISpacePickItem => item.type !== 'separator' && item.space?.windowId === nativeHostService.windowId);

	disposables.add(spacesService.onDidChangeSpaces(snapshot => {
		picker.keepScrollPosition = true;
		picker.items = toItems(snapshot.spaces);
	}));

	disposables.add(picker.onDidTriggerItemButton(async ({ item, button }) => {
		if (!item.space) {
			return;
		}

		if (button === closeButton) {
			reportResult(notificationService, await spacesService.closeSpace(item.space.id));
		} else if (button === renameButton) {
			picker.hide();
			await renameSpace(spacesService, quickInputService, notificationService, item.space);
		}
	}));

	disposables.add(picker.onDidAccept(async () => {
		const [item] = picker.selectedItems;
		picker.hide();

		if (item?.space) {
			reportResult(notificationService, await spacesService.switchToSpace(item.space.id));
		} else if (item?.commandId) {
			await commandService.executeCommand(item.commandId);
		}
	}));

	disposables.add(picker.onDidHide(() => disposables.dispose()));
	picker.show();
}
