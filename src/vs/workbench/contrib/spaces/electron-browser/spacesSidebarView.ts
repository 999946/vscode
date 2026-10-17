/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService, ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import {
	Extensions as ViewContainerExtensions,
	IViewContainersRegistry,
	IViewDescriptor,
	IViewDescriptorService,
	IViewsRegistry,
	ViewContainerLocation
} from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ISpace, ISpacesService, ISpacesSnapshot, SPACES_ENABLED_SETTING } from '../../../../platform/spaces/common/spaces.js';
import { SpacesCommandId } from './spacesActions.js';

export const SPACES_SIDEBAR_VIEW_ID = 'workbench.view.spacesSidebar';
export const SPACES_SIDEBAR_CONTAINER_ID = 'workbench.view.spacesSidebarContainer';
export const SPACES_SIDEBAR_FOCUS_COMMAND_ID = 'workbench.action.spaces.focusSidebar';

const spacesSidebarIcon = registerIcon(
	'spaces-sidebar-view-icon',
	Codicon.window,
	localize('spacesSidebarIcon', "View icon of the Spaces sidebar view.")
);

function getCurrentSpace(snapshot: ISpacesSnapshot | undefined, windowId: number): ISpace | undefined {
	return snapshot?.spaces.find(space => space.windowId === windowId);
}

/**
 * Sidebar view that lists every Space and lets you switch to it. One Space is
 * one workbench renderer hosted in a `WebContentsView` inside the shared frame
 * window, so switching here swaps the visible workbench.
 */
export class SpacesSidebarViewPane extends ViewPane {

	static readonly ID = SPACES_SIDEBAR_VIEW_ID;

	private listContainer: HTMLElement | undefined;
	private snapshot: ISpacesSnapshot | undefined;
	private readonly spacesDisposables = this._register(new DisposableStore());

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ISpacesService private readonly spacesService: ISpacesService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@ILabelService private readonly labelService: ILabelService,
		@ICommandService private readonly commandService: ICommandService,
		@IQuickInputService private readonly quickInputService: IQuickInputService
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService
		);

		this.spacesDisposables.add(this.spacesService.onDidChangeSpaces(snapshot => this.render(snapshot)));
	}

	override dispose(): void {
		super.dispose();
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('spaces-sidebar-view');
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.height = '100%';

		this.listContainer = DOM.append(container, DOM.$('.spaces-sidebar-list'));
		this.listContainer.style.flex = '1';
		this.listContainer.style.overflowY = 'auto';
		this.listContainer.style.padding = '4px';

		void this.spacesService.getSpaces().then(snapshot => {
			if (this.listContainer) {
				this.render(snapshot);
			}
		});
	}

	private render(snapshot: ISpacesSnapshot): void {
		this.snapshot = snapshot;
		if (!this.listContainer) {
			return;
		}

		DOM.reset(this.listContainer);

		const current = getCurrentSpace(snapshot, this.nativeHostService.windowId);
		const spaces = snapshot.spaces;

		const header = DOM.append(this.listContainer, DOM.$('.spaces-sidebar-header'));
		const headerText = DOM.append(header, DOM.$('span'));
		headerText.textContent = localize('spaces.sidebar.count', "{0} Space{1}", spaces.length, spaces.length === 1 ? '' : 's');

		const newButton = DOM.append(header, DOM.$('button.spaces-sidebar-header-action'));
		newButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		newButton.title = localize('spaces.newEmptySpace', "New Empty Space");
		newButton.addEventListener('click', () => this.commandService.executeCommand(SpacesCommandId.NewEmptySpace));

		const openButton = DOM.append(header, DOM.$('button.spaces-sidebar-header-action'));
		openButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.folderOpened));
		openButton.title = localize('spaces.openFolderAsNewSpace', "Open Folder as New Space");
		openButton.addEventListener('click', () => this.commandService.executeCommand(SpacesCommandId.OpenFolderAsNewSpace));

		if (spaces.length === 0) {
			const empty = DOM.append(this.listContainer, DOM.$('.spaces-sidebar-empty'));
			empty.textContent = localize('spaces.sidebar.empty', "No Spaces yet. Create one to get started.");
			return;
		}

		for (const space of spaces) {
			this.listContainer.appendChild(this.renderSpaceRow(space, current?.id === space.id));
		}
	}

	private renderSpaceRow(space: ISpace, isActive: boolean): HTMLElement {
		const row = DOM.$('.spaces-sidebar-row' + (isActive ? '.active' : ''));
		row.tabIndex = 0;
		row.setAttribute('role', 'button');

		const icon = DOM.append(row, DOM.$('.spaces-sidebar-row-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(space.needsAttention ? Codicon.bellDot : Codicon.window));

		const main = DOM.append(row, DOM.$('.spaces-sidebar-row-main'));
		const name = DOM.append(main, DOM.$('.spaces-sidebar-row-name'));
		name.textContent = space.name;

		if (space.workspace) {
			const workspace = DOM.append(main, DOM.$('.spaces-sidebar-row-workspace'));
			workspace.textContent = this.labelService.getUriLabel(space.workspace.uri);
		}

		const meta = DOM.append(row, DOM.$('.spaces-sidebar-row-meta'));
		if (space.needsAttention) {
			const badge = DOM.append(meta, DOM.$('.spaces-sidebar-row-badge'));
			badge.textContent = localize('spaces.sidebar.attention', "attention");
		}
		const actions = DOM.append(meta, DOM.$('.spaces-sidebar-row-actions'));

		const renameButton = DOM.append(actions, DOM.$('button.spaces-sidebar-row-action'));
		renameButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.edit));
		renameButton.title = localize('spaces.sidebar.rename', "Rename Space");
		renameButton.addEventListener('click', e => {
			e.stopPropagation();
			this.renameSpace(space);
		});

		const closeButton = DOM.append(actions, DOM.$('button.spaces-sidebar-row-action'));
		closeButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		closeButton.title = localize('spaces.sidebar.close', "Close Space");
		closeButton.addEventListener('click', e => {
			e.stopPropagation();
			this.closeSpace(space);
		});

		row.addEventListener('click', () => this.switchToSpace(space));
		row.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				this.switchToSpace(space);
			}
		});

		return row;
	}

	private async switchToSpace(space: ISpace): Promise<void> {
		if (this.snapshot && getCurrentSpace(this.snapshot, this.nativeHostService.windowId)?.id === space.id) {
			return;
		}

		await this.spacesService.switchToSpace(space.id);
	}

	private async closeSpace(space: ISpace): Promise<void> {
		await this.spacesService.closeSpace(space.id);
	}

	private async renameSpace(space: ISpace): Promise<void> {
		const name = await this.quickInputService.input({
			title: localize('spaces.renameTitle', "Rename Space"),
			value: space.name,
			prompt: localize('spaces.renamePrompt', "Enter a new name. Leave empty to use the folder or workspace name.")
		});

		if (typeof name === 'string') {
			await this.spacesService.renameSpace(space.id, name);
		}
	}
}

//#region View title actions

const VIEW_TITLE_WHEN = ContextKeyExpr.equals('view', SpacesSidebarViewPane.ID);

class NewSpaceSidebarAction extends Action2 {
	constructor() {
		super({
			id: 'spaces.sidebar.newSpace',
			title: localize2('spaces.newEmptySpaceShort', "New Space"),
			icon: Codicon.add,
			menu: [{ id: MenuId.ViewTitle, when: VIEW_TITLE_WHEN, group: 'navigation', order: 1 }]
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand(SpacesCommandId.NewEmptySpace);
	}
}

class FocusSpacesSidebarAction extends Action2 {
	constructor() {
		super({
			id: SPACES_SIDEBAR_FOCUS_COMMAND_ID,
			title: localize2('spaces.sidebar.focus', "Focus Spaces Sidebar"),
			f1: true,
			category: localize2('spaces', "Spaces"),
			precondition: ContextKeyExpr.equals(`config.${SPACES_ENABLED_SETTING}`, true)
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		await viewsService.openView(SpacesSidebarViewPane.ID, true);
	}
}

class OpenFolderSidebarAction extends Action2 {
	constructor() {
		super({
			id: 'spaces.sidebar.openFolder',
			title: localize2('spaces.openFolderShort', "Open Folder as Space"),
			icon: Codicon.folderOpened,
			menu: [{ id: MenuId.ViewTitle, when: VIEW_TITLE_WHEN, group: 'navigation', order: 2 }]
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand(SpacesCommandId.OpenFolderAsNewSpace);
	}
}

//#endregion

//#region Registration

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

const container = viewContainersRegistry.registerViewContainer(
	{
		id: SPACES_SIDEBAR_CONTAINER_ID,
		title: localize2('spaces.sidebar.container', "Spaces"),
		icon: spacesSidebarIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SPACES_SIDEBAR_CONTAINER_ID, {}]),
		storageId: SPACES_SIDEBAR_CONTAINER_ID,
		hideIfEmpty: true,
		order: 5,
	},
	ViewContainerLocation.Sidebar,
);

const viewDescriptor: IViewDescriptor = {
	id: SpacesSidebarViewPane.ID,
	name: localize2('spaces.sidebar.view', "Spaces"),
	containerIcon: spacesSidebarIcon,
	ctorDescriptor: new SyncDescriptor(SpacesSidebarViewPane),
	canToggleVisibility: true,
	canMoveView: true,
	when: ContextKeyExpr.equals(`config.${SPACES_ENABLED_SETTING}`, true),
	openCommandActionDescriptor: {
		id: SPACES_SIDEBAR_FOCUS_COMMAND_ID,
		title: localize2('spaces.sidebar.focus', "Focus Spaces Sidebar"),
	},
};

viewsRegistry.registerViews([viewDescriptor], container);

registerAction2(NewSpaceSidebarAction);
registerAction2(OpenFolderSidebarAction);
registerAction2(FocusSpacesSidebarAction);

//#endregion
