/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/spaces.css';
import { $, append } from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ISpace, ISpacesService, ISpacesSnapshot, SPACES_ENABLED_SETTING } from '../../../../platform/spaces/common/spaces.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import '../../../services/spaces/electron-browser/spacesService.js';
import { AddCurrentWindowAsSpaceAction, CloseCurrentSpaceAction, ListSpacesAction, NewEmptySpaceAction, OpenFolderAsNewSpaceAction, OpenWorkspaceAsNewSpaceAction, RenameCurrentSpaceAction, SpacesCommandId, SwitchSpaceAction, TitleBarSpacesPickerAction } from './spacesActions.js';

//#region Configuration

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...workbenchConfigurationNodeBase,
	properties: {
		[SPACES_ENABLED_SETTING]: {
			type: 'boolean',
			default: false,
			tags: ['experimental'],
			markdownDescription: localize('spaces.enabled', "Enables Spaces: several fully independent windows (own workspace, extension host, terminals and state) hosted behind one window frame. Switching Spaces keeps inactive Spaces running.")
		}
	}
});

//#endregion

//#region Actions

registerAction2(NewEmptySpaceAction);
registerAction2(OpenFolderAsNewSpaceAction);
registerAction2(OpenWorkspaceAsNewSpaceAction);
registerAction2(AddCurrentWindowAsSpaceAction);
registerAction2(SwitchSpaceAction);
registerAction2(CloseCurrentSpaceAction);
registerAction2(RenameCurrentSpaceAction);
registerAction2(ListSpacesAction);
registerAction2(TitleBarSpacesPickerAction);

//#endregion

//#region Current Space tracking

function getCurrentSpace(snapshot: ISpacesSnapshot | undefined, windowId: number): ISpace | undefined {
	return snapshot?.spaces.find(space => space.windowId === windowId);
}

function getSpaceLabel(space: ISpace | undefined): string {
	return space ? localize('spaces.label', "Space: {0}", space.name) : localize('spaces.noSpace', "Spaces");
}

function getAttentionCount(snapshot: ISpacesSnapshot | undefined): number {
	return snapshot?.spaces.filter(space => space.needsAttention).length ?? 0;
}

function getAttentionLabel(count: number): string {
	return count === 1 ? localize('spaces.attentionOne', "1 Space needs attention") : localize('spaces.attentionMany', "{0} Spaces need attention", count);
}

//#endregion

//#region Title bar

class SpacesTitleBarWidget extends BaseActionViewItem {

	private labelElement: HTMLElement | undefined;
	private attentionElement: HTMLElement | undefined;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions | undefined,
		@ISpacesService private readonly spacesService: ISpacesService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IHoverService private readonly hoverService: IHoverService
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		container.classList.add('spaces-titlebar-widget');
		container.setAttribute('role', 'button');
		container.setAttribute('aria-haspopup', 'listbox');
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), container, localize('spaces.titleBarHover', "Switch Space")));

		append(container, $(`span.spaces-titlebar-widget-icon${ThemeIcon.asCSSSelector(Codicon.window)}`));
		this.labelElement = append(container, $('span.spaces-titlebar-widget-label'));
		this.attentionElement = append(container, $(`span.spaces-titlebar-widget-attention${ThemeIcon.asCSSSelector(Codicon.bellDot)}`));
		append(container, $(`span.spaces-titlebar-widget-chevron${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`));

		this.update(undefined);
		this._register(this.spacesService.onDidChangeSpaces(snapshot => this.update(snapshot)));
		this.spacesService.getSpaces().then(snapshot => this.update(snapshot));
	}

	private update(snapshot: ISpacesSnapshot | undefined): void {
		if (!this.labelElement || !this.attentionElement || !this.element) {
			return;
		}

		const label = getSpaceLabel(getCurrentSpace(snapshot, this.nativeHostService.windowId));
		const attentionCount = getAttentionCount(snapshot);
		this.labelElement.textContent = label;
		this.attentionElement.style.display = attentionCount > 0 ? '' : 'none';
		this.element.setAttribute('aria-label', attentionCount > 0 ? `${label}, ${getAttentionLabel(attentionCount)}` : label);
	}
}

class SpacesTitleBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.spaces.titleBar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();

		this._register(actionViewItemService.register(MenuId.TitleBarAdjacentCenter, SpacesCommandId.TitleBarPicker, (action, options) => {
			return instantiationService.createInstance(SpacesTitleBarWidget, action, options);
		}, undefined));
	}
}

registerWorkbenchContribution2(SpacesTitleBarContribution.ID, SpacesTitleBarContribution, WorkbenchPhase.AfterRestored);

//#endregion

//#region Status bar and dialog guard

class SpacesStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.spaces.status';

	private readonly statusEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly enablementListeners = this._register(new MutableDisposable<DisposableStore>());

	private snapshot: ISpacesSnapshot | undefined;
	private shutdownRequested = false;

	constructor(
		@ISpacesService private readonly spacesService: ISpacesService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IDialogService private readonly dialogService: IDialogService
	) {
		super();

		this.updateEnablement();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SPACES_ENABLED_SETTING)) {
				this.updateEnablement();
			}
		}));
	}

	private updateEnablement(): void {
		if (!this.configurationService.getValue<boolean>(SPACES_ENABLED_SETTING)) {
			this.enablementListeners.clear();
			this.statusEntry.clear();
			return;
		}

		if (this.enablementListeners.value) {
			return;
		}

		const store = this.enablementListeners.value = new DisposableStore();

		store.add(this.spacesService.onDidChangeSpaces(snapshot => this.updateStatus(snapshot)));
		this.spacesService.getSpaces().then(snapshot => this.updateStatus(snapshot));

		// A dialog in a hidden Space is invisible. When the Space is asked to shut
		// down (e.g. on quit, asking about unsaved changes) show it first; otherwise
		// mark it as needing attention in the Spaces UI of the visible Space.
		store.add(this.lifecycleService.onBeforeShutdown(() => this.shutdownRequested = true));
		store.add(this.lifecycleService.onShutdownVeto(() => this.shutdownRequested = false));
		store.add(this.dialogService.onWillShowDialog(() => {
			if (getCurrentSpace(this.snapshot, this.nativeHostService.windowId)?.state !== 'inactive') {
				return;
			}

			if (this.shutdownRequested) {
				this.spacesService.revealCurrentSpace();
			} else {
				this.spacesService.requestAttention();
			}
		}));
	}

	private updateStatus(snapshot: ISpacesSnapshot): void {
		if (!this.enablementListeners.value) {
			return;
		}

		this.snapshot = snapshot;

		const current = getCurrentSpace(snapshot, this.nativeHostService.windowId);
		const attentionCount = getAttentionCount(snapshot);
		const text = attentionCount > 0
			? `$(${Codicon.window.id}) ${getSpaceLabel(current)} $(${Codicon.bellDot.id}) ${attentionCount}`
			: `$(${Codicon.window.id}) ${getSpaceLabel(current)}`;
		const tooltip = [
			current
				? localize('spaces.statusTooltip', "{0} of {1} Spaces. Click to switch.", snapshot.spaces.indexOf(current) + 1, snapshot.spaces.length)
				: localize('spaces.statusTooltipNone', "Spaces: open folders as independent Spaces in this window frame."),
			...(attentionCount > 0 ? [getAttentionLabel(attentionCount)] : [])
		].join('\n');
		const entry = {
			name: localize('spaces.statusName', "Spaces"),
			text,
			ariaLabel: attentionCount > 0 ? `${getSpaceLabel(current)}, ${getAttentionLabel(attentionCount)}` : getSpaceLabel(current),
			tooltip,
			command: SpacesCommandId.SwitchSpace
		};

		if (this.statusEntry.value) {
			this.statusEntry.value.update(entry);
		} else {
			this.statusEntry.value = this.statusbarService.addEntry(entry, 'status.workbench.spaces', StatusbarAlignment.LEFT, 10000);
		}
	}
}

registerWorkbenchContribution2(SpacesStatusContribution.ID, SpacesStatusContribution, WorkbenchPhase.AfterRestored);

//#endregion
