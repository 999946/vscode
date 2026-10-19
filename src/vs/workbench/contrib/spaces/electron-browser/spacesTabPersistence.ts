/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { ISpacesService } from '../../../../platform/spaces/common/spaces.js';
import { ISerializedSpaceTab, ISpaceTabState } from '../../../../platform/spaces/common/spacesTabs.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { getActiveWindow } from '../../../../base/browser/dom.js';

/**
 * Reports this Space's live tabs (editors + terminals) to the main process for
 * persistence, restores persisted tabs on startup, and handles sidebar tab
 * actions (`spaces:newTab` / `spaces:closeTab`).
 *
 * Mirrors Terax `useSpacePersistence`:
 * - debounced (3 s) writes of the tab list + active tab index
 * - per-Space storage on the main-process side
 * - restore: editors re-open (VS Code restores its own workspace editors on
 *   top, so we only add a terminal if the Space persisted one); terminals are
 *   re-created in their persisted cwd.
 *
 * The calling Space is resolved on the main-process side from the window id
 * (`updateSpaceTabs(state)`), so this contribution needs no Space identity.
 */
class SpacesTabPersistenceContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.spaces.tabPersistence';

	private readonly store = this._register(new DisposableStore());
	private timer: number | null = null;

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ISpacesService private readonly spacesService: ISpacesService,
		@ILogService private readonly logService: ILogService
	) {
		super();
		this.init();
	}

	private async init(): Promise<void> {
		this.store.add(this.editorGroupsService.onDidChangeActiveGroup(() => this.scheduleReport()));
		this.store.add(this.editorGroupsService.onDidActivateGroup(() => this.scheduleReport()));
		this.store.add(this.editorGroupsService.onDidAddGroup(() => this.scheduleReport()));
		this.store.add(this.editorGroupsService.onDidRemoveGroup(() => this.scheduleReport()));
		this.store.add(this.terminalService.onDidCreateInstance(() => this.scheduleReport()));

		// Restore persisted terminals after the workbench is restored so the
		// editors the Space had open are restored first by the workbench.
		this.restore();

		// Sidebar tab actions routed to this Space's renderer by the main process.
		const newTabListener = () => { void this.newTab(); };
		ipcRenderer.on('spaces:newTab', newTabListener);
		this.store.add(toDisposable(() => ipcRenderer.removeListener('spaces:newTab', newTabListener)));

		const closeTabListener = (_event: unknown, tabId: unknown) => { void this.closeTab(String(tabId)); };
		ipcRenderer.on('spaces:closeTab', closeTabListener);
		this.store.add(toDisposable(() => ipcRenderer.removeListener('spaces:closeTab', closeTabListener)));
	}

	private scheduleReport(): void {
		const w = getActiveWindow();
		if (this.timer !== null) {
			w.clearTimeout(this.timer);
		}
		this.timer = w.setTimeout(() => {
			this.timer = null;
			void this.report();
		}, 3000);
	}

	private collectTabs(): ISerializedSpaceTab[] {
		const tabs: ISerializedSpaceTab[] = [];

		// Editors across all groups, in visual order.
		for (const group of this.editorGroupsService.groups) {
			for (const editor of group.editors) {
				const resource = editor.resource;
				if (resource && resource.scheme === 'file') {
					tabs.push({
						kind: 'editor',
						label: basename(resource),
						detail: resource.path ? dirname(resource).path : undefined,
						value: resource.path
					});
				}
			}
		}

		// Terminal instances (only non-detached, i.e. the ones in the panel/editor).
		for (const instance of this.terminalService.instances) {
			const cwd = instance.cwd;
			if (cwd) {
				tabs.push({
					kind: 'terminal',
					label: instance.title || 'terminal',
					detail: cwd,
					value: cwd,
					customTitle: instance.isTitleSetByProcess ? undefined : instance.title
				});
			}
		}

		return tabs;
	}

	private async report(): Promise<void> {
		const tabs = this.collectTabs();
		const activeEditor = this.editorGroupsService.activeGroup.activeEditor;
		const activeResource = activeEditor?.resource;
		let activeTabIndex = 0;
		if (activeResource && activeResource.scheme === 'file') {
			activeTabIndex = tabs.findIndex(t => t.kind === 'editor' && t.value === activeResource.path);
		}
		const state: ISpaceTabState = { tabs, activeTabIndex: Math.max(0, activeTabIndex) };
		await this.spacesService.updateSpaceTabs(state);
	}

	private async restore(): Promise<void> {
		try {
			// The persisted state is fetched from the main process by this Space's id.
			// We discover the Space via the snapshot (window id match) or fall back to
			// the currently active Space when this renderer has no Space yet.
			const state = await this.spacesService.getPersistedTabStateForWindow();
			if (!state || !state.tabs.length) {
				return;
			}

			// Re-create terminals in their persisted cwd. Editors are restored by
			// VS Code's own workspace session recovery.
			for (const tab of state.tabs) {
				if (tab.kind !== 'terminal' || !tab.value) {
					continue;
				}
				try {
					const cwdUri = URI.file(tab.value);
					await this.terminalService.createTerminal({
						cwd: cwdUri,
						...(tab.customTitle ? { name: tab.customTitle } : {})
					});
				} catch (error) {
					this.logService.warn(`[spaces:tabs] failed to restore terminal (${tab.value}): ${error}`);
				}
			}
		} catch (error) {
			this.logService.warn(`[spaces:tabs] failed to restore tab state: ${error}`);
		}
	}

	private async newTab(): Promise<void> {
		// Mirror Terax: a new tab in a Space starts a fresh terminal in the workspace.
		await this.terminalService.createTerminal();
	}

	private async closeTab(tabId: string): Promise<void> {
		// Persisted tab ids look like `${kind}-${value}`. Find a matching
		// editor/terminal and close it.
		const idx = tabId.indexOf('-');
		if (idx < 0) {
			return;
		}
		const kind = tabId.substring(0, idx);
		const value = tabId.substring(idx + 1);
		if (kind === 'editor') {
			for (const group of this.editorGroupsService.groups) {
				for (const editor of group.editors) {
					if (editor.resource?.path === value) {
						void group.closeEditor(editor);
						return;
					}
				}
			}
		} else if (kind === 'terminal') {
			for (const instance of this.terminalService.instances) {
				if (instance.cwd === value) {
					void instance.dispose();
					return;
				}
			}
		}
	}

	override dispose(): void {
		if (this.timer !== null) {
			getActiveWindow().clearTimeout(this.timer);
			this.timer = null;
		}
		// Flush on dispose so the last tab state is persisted.
		void this.report();
		this.store.clear();
		super.dispose();
	}
}

registerWorkbenchContribution2(SpacesTabPersistenceContribution.ID, SpacesTabPersistenceContribution, WorkbenchPhase.AfterRestored);
