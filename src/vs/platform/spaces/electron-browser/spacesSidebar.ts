/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable no-restricted-syntax */

import type { ISpacesSidebarData, ISpacesSidebarSpace, ISpacesSidebarTab, ISpacesSidebarSettings } from '../common/spacesSidebarRpc.js';

/**
 * Renderer entry point for the shared Spaces sidebar view.
 *
 * Implements the Terax spaces panel interactions inside a standalone DOM page
 * hosted in a `WebContentsView` attached to the frame `BrowserWindow`:
 * - collapsible (folded trigger shows the active Space's initial)
 * - pinnable (pinned panels never auto-collapse)
 * - hover to expand, 180 ms delayed auto-collapse on pointer leave
 * - draggable width (180..560 px, default 260)
 * - per-Space rows with expand arrow, initial avatar, name and tab-count badge
 * - right-click context menu (rename / new tab / delete with confirmation)
 * - expanded rows list the Space's persisted tabs
 *
 * Panel chrome state (collapsed/pinned/width) lives in this view's own
 * `localStorage`, exactly like Terax. All Space data comes from the main
 * process over the `window.spacesSidebar` bridge.
 */

interface ISpacesSidebarBridge {
	invoke(method: string, ...args: unknown[]): Promise<unknown>;
	onDidChange(callback: (data: unknown) => void): void;
}

declare const window: Window & { spacesSidebar: ISpacesSidebarBridge };

const PANEL_WIDTH = 260;
const PANEL_MIN_WIDTH = 180;
const PANEL_MAX_WIDTH = 560;
const COLLAPSE_DELAY_MS = 180;

const STORAGE_COLLAPSED = 'paracode.spaces.sidebar.collapsed';
const STORAGE_PINNED = 'paracode.spaces.sidebar.pinned';
const STORAGE_WIDTH = 'paracode.spaces.sidebar.width';

function readBool(key: string, fallback: boolean): boolean {
	try {
		const v = localStorage.getItem(key);
		return v === null ? fallback : v === 'true';
	} catch {
		return fallback;
	}
}

function readWidth(): number {
	try {
		const n = Number(localStorage.getItem(STORAGE_WIDTH));
		if (!Number.isFinite(n) || n <= 0) { return PANEL_WIDTH; }
		return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(n)));
	} catch {
		return PANEL_WIDTH;
	}
}

const body = document.body;
const list = document.getElementById('list') as HTMLDivElement;
const countEl = document.getElementById('count') as HTMLSpanElement;
const panel = document.getElementById('panel') as HTMLDivElement;
const trigger = document.getElementById('trigger') as HTMLDivElement;
const triggerAvatar = document.getElementById('triggerAvatar') as HTMLSpanElement;
const pinBtn = document.getElementById('pinBtn') as HTMLButtonElement;
const collapseBtn = document.getElementById('collapseBtn') as HTMLButtonElement;
const newBtn = document.getElementById('newBtn') as HTMLButtonElement;
const resizeHandle = document.getElementById('resizeHandle') as HTMLDivElement;

let collapsed = readBool(STORAGE_COLLAPSED, false);
let pinned = readBool(STORAGE_PINNED, false);
let width = readWidth();
let collapseTimer: number | null = null;

let data: ISpacesSidebarData = { spaces: [] };
let settings: ISpacesSidebarSettings = { spacesRoot: null, showSpaceTabs: false, showSpaceInitials: false };
const expanded = new Set<string>();

// ---- state persistence ----

function persistCollapsed(value: boolean): void {
	collapsed = value;
	try { localStorage.setItem(STORAGE_COLLAPSED, String(value)); } catch { /* noop */ }
	renderChrome();
}

function persistPinned(value: boolean): void {
	pinned = value;
	try { localStorage.setItem(STORAGE_PINNED, String(value)); } catch { /* noop */ }
	renderChrome();
}

function persistWidth(value: number): void {
	width = value;
	try { localStorage.setItem(STORAGE_WIDTH, String(value)); } catch { /* noop */ }
	renderChrome();
}

// ---- chrome ----

function renderChrome(): void {
	body.classList.toggle('collapsed', collapsed);
	pinBtn.classList.toggle('active', pinned);
	pinBtn.textContent = pinned ? 'P' : 'P';
	pinBtn.title = pinned ? 'Unpin spaces' : 'Pin spaces open';
	collapseBtn.style.display = pinned ? '' : 'none';

	const active = data.spaces.find(s => s.isCurrent);
	if (settings.showSpaceInitials && active) {
		triggerAvatar.textContent = spaceInitial(active.name);
	} else {
		triggerAvatar.textContent = 'S';
	}

	if (collapsed) {
		panel.style.width = '';
	} else {
		panel.style.width = `${width}px`;
	}
}

function spaceInitial(name: string): string {
	const ch = name.trim()[0];
	return ch ? ch.toUpperCase() : '?';
}

function expand(): void {
	if (collapseTimer !== null) {
		window.clearTimeout(collapseTimer);
		collapseTimer = null;
	}
	persistCollapsed(false);
}

function collapse(): void {
	persistCollapsed(true);
}

function scheduleCollapse(): void {
	if (pinned) {
		if (collapseTimer !== null) {
			window.clearTimeout(collapseTimer);
			collapseTimer = null;
		}
		return;
	}
	if (collapseTimer !== null) {
		window.clearTimeout(collapseTimer);
	}
	collapseTimer = window.setTimeout(() => {
		collapseTimer = null;
		collapse();
	}, COLLAPSE_DELAY_MS);
}

// ---- rendering ----

function createRow(space: ISpacesSidebarSpace): HTMLDivElement {
	const row = document.createElement('div');
	row.className = 'row' + (space.isCurrent ? ' active' : '');
	row.setAttribute('role', 'button');
	row.tabIndex = 0;
	row.dataset.spaceId = space.id;

	if (settings.showSpaceTabs) {
		const caret = document.createElement('span');
		caret.className = 'caret';
		caret.textContent = expanded.has(space.id) ? 'v' : '>';
		row.appendChild(caret);
	}

	if (settings.showSpaceInitials) {
		const avatar = document.createElement('span');
		avatar.className = 'avatar';
		avatar.textContent = spaceInitial(space.name);
		row.appendChild(avatar);
	}

	const main = document.createElement('div');
	main.className = 'main';
	const name = document.createElement('div');
	name.className = 'name';
	name.textContent = space.name;
	main.appendChild(name);
	if (space.workspaceLabel) {
		const ws = document.createElement('div');
		ws.className = 'workspace';
		ws.textContent = space.workspaceLabel;
		main.appendChild(ws);
	}
	row.appendChild(main);

	const badge = document.createElement('span');
	badge.className = 'badge';
	badge.textContent = String(space.tabCount);
	row.appendChild(badge);

	row.addEventListener('click', () => {
		if (!space.isCurrent) {
			void window.spacesSidebar.invoke('switchToSpace', space.id);
		}
	});
	row.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !space.isCurrent) {
			void window.spacesSidebar.invoke('switchToSpace', space.id);
		}
	});
	row.addEventListener('contextmenu', (e) => {
		e.preventDefault();
		showContextMenu(e.clientX, e.clientY, space);
	});

	return row;
}

function createTabRow(tab: ISpacesSidebarTab, spaceId: string): HTMLDivElement {
	const el = document.createElement('div');
	el.className = 'tab' + (tab.active ? ' active' : '');
	el.setAttribute('role', 'button');
	el.tabIndex = 0;

	const icon = document.createElement('span');
	icon.className = 't-icon';
	icon.textContent = tab.kind === 'terminal' ? '>' : tab.kind === 'preview' ? '#' : '{';
	el.appendChild(icon);

	const main = document.createElement('span');
	main.className = 't-main';
	const label = document.createElement('span');
	label.className = 't-label';
	label.textContent = tab.label;
	main.appendChild(label);
	if (tab.detail) {
		const detail = document.createElement('span');
		detail.className = 't-detail';
		detail.textContent = tab.detail;
		main.appendChild(detail);
	}
	el.appendChild(main);

	const close = document.createElement('button');
	close.className = 't-close';
	close.textContent = 'x';
	close.title = 'Close tab';
	close.addEventListener('click', (e) => {
		e.stopPropagation();
		void window.spacesSidebar.invoke('closeTab', spaceId, tab.id);
	});
	el.appendChild(close);

	return el;
}

function render(): void {
	countEl.textContent = `${data.spaces.length} Space${data.spaces.length === 1 ? '' : 's'}`;
	list.textContent = '';

	if (data.spaces.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'empty';

		if (settings.spacesRoot) {
			empty.textContent = 'No Spaces yet. Create one to get started.';
			appendButton(empty, 'Create a Space', () => showNewSpaceDialog());
		} else {
			empty.textContent = 'No Spaces yet. Set your Spaces root folder to get started.';
			appendButton(empty, 'Configure Spaces Root…', () => {
				void window.spacesSidebar.invoke('openSettings');
			});
		}
		list.appendChild(empty);
		return;
	}

	for (const space of data.spaces) {
		list.appendChild(createRow(space));

		if (settings.showSpaceTabs && expanded.has(space.id)) {
			const spaceId = space.id;
			void window.spacesSidebar.invoke('getSpaceTabs', spaceId).then((res) => {
				const { tabs } = res as { tabs: ISpacesSidebarTab[] };
				if (tabs.length > 0) {
					const tabContainer = document.createElement('div');
					tabContainer.className = 'tabs';
					for (const tab of tabs) { tabContainer.appendChild(createTabRow(tab, spaceId)); }
					insertTabsAfterRow(spaceId, tabContainer);
				}
			});
		}
	}

	renderChrome();
}

function appendButton(container: HTMLElement, label: string, onClick: () => void): void {
	const btn = document.createElement('button');
	btn.className = 'empty-action';
	btn.textContent = label;
	btn.addEventListener('click', onClick);
	container.appendChild(btn);
}

function insertTabsAfterRow(spaceId: string, container: HTMLElement): void {
	const rows = Array.from(list.children);
	const idx = rows.findIndex((el) => (el as HTMLElement).dataset.spaceId === spaceId);
	if (idx >= 0) {
		const insertBefore = rows[idx + 1] ?? null;
		list.insertBefore(container, insertBefore);
	}
}

function showContextMenu(x: number, y: number, space: ISpacesSidebarSpace): void {
	closeContextMenu();
	const menu = document.createElement('div');
	menu.className = 'menu';
	menu.style.left = `${x}px`;
	menu.style.top = `${y}px`;

	const renameItem = document.createElement('div');
	renameItem.className = 'menu-item';
	renameItem.textContent = 'Rename';
	renameItem.addEventListener('click', () => {
		closeContextMenu();
		showRenameDialog(space);
	});
	menu.appendChild(renameItem);

	const newTabItem = document.createElement('div');
	newTabItem.className = 'menu-item';
	newTabItem.textContent = 'New Tab';
	newTabItem.addEventListener('click', () => {
		closeContextMenu();
		void window.spacesSidebar.invoke('newTabInSpace', space.id);
	});
	menu.appendChild(newTabItem);

	const sep = document.createElement('div');
	sep.className = 'menu-sep';
	menu.appendChild(sep);

	const deleteItem = document.createElement('div');
	deleteItem.className = 'menu-item danger';
	deleteItem.textContent = 'Delete';
	deleteItem.addEventListener('click', () => {
		closeContextMenu();
		showDeleteDialog(space);
	});
	menu.appendChild(deleteItem);

	document.body.appendChild(menu);
	const close = () => closeContextMenu();
	window.setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
}

function closeContextMenu(): void {
	const menus = document.querySelectorAll('.menu');
	menus.forEach((m) => m.remove());
}

function showRenameDialog(space: ISpacesSidebarSpace): void {
	const backdrop = document.createElement('div');
	backdrop.className = 'modal-backdrop';

	const modal = document.createElement('div');
	modal.className = 'modal';
	const h3 = document.createElement('h3');
	h3.textContent = 'Rename Space';
	const input = document.createElement('input');
	input.value = space.name;
	input.autofocus = true;
	const actions = document.createElement('div');
	actions.className = 'actions';
	const cancelBtn = document.createElement('button');
	cancelBtn.textContent = 'Cancel';
	const okBtn = document.createElement('button');
	okBtn.className = 'primary';
	okBtn.textContent = 'Rename';

	actions.appendChild(cancelBtn);
	actions.appendChild(okBtn);
	modal.appendChild(h3);
	modal.appendChild(input);
	modal.appendChild(actions);
	backdrop.appendChild(modal);
	document.body.appendChild(backdrop);

	const close = () => backdrop.remove();
	cancelBtn.addEventListener('click', close);
	backdrop.addEventListener('click', (e) => {
		if (e.target === backdrop) { close(); }
	});
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { okBtn.click(); }
		if (e.key === 'Escape') { close(); }
	});
	okBtn.addEventListener('click', () => {
		const v = input.value.trim();
		if (v) {
			void window.spacesSidebar.invoke('renameSpace', space.id, v);
		}
		close();
	});
	input.focus();
}

function showDeleteDialog(space: ISpacesSidebarSpace): void {
	const backdrop = document.createElement('div');
	backdrop.className = 'modal-backdrop';

	const modal = document.createElement('div');
	modal.className = 'modal';
	const h3 = document.createElement('h3');
	h3.textContent = `Delete "${space.name}"?`;
	const p = document.createElement('p');
	p.textContent = 'The Space and its tab state will be removed.';
	const actions = document.createElement('div');
	actions.className = 'actions';
	const cancelBtn = document.createElement('button');
	cancelBtn.textContent = 'Cancel';
	const delBtn = document.createElement('button');
	delBtn.className = 'danger';
	delBtn.textContent = 'Delete';

	actions.appendChild(cancelBtn);
	actions.appendChild(delBtn);
	modal.appendChild(h3);
	modal.appendChild(p);
	modal.appendChild(actions);
	backdrop.appendChild(modal);
	document.body.appendChild(backdrop);

	const close = () => backdrop.remove();
	cancelBtn.addEventListener('click', close);
	backdrop.addEventListener('click', (e) => {
		if (e.target === backdrop) { close(); }
	});
	delBtn.addEventListener('click', () => {
		void window.spacesSidebar.invoke('deleteSpace', space.id);
		close();
	});
}

function showNewSpaceDialog(): void {
	const backdrop = document.createElement('div');
	backdrop.className = 'modal-backdrop';

	const modal = document.createElement('div');
	modal.className = 'modal';
	const h3 = document.createElement('h3');
	h3.textContent = 'New Space';
	const p = document.createElement('p');
	p.textContent = 'Enter a name for the new Space. It will be created as a folder under your Spaces root.';
	const input = document.createElement('input');
	input.placeholder = 'Space name';
	input.autofocus = true;
	const actions = document.createElement('div');
	actions.className = 'actions';
	const cancelBtn = document.createElement('button');
	cancelBtn.textContent = 'Cancel';
	const createBtn = document.createElement('button');
	createBtn.className = 'primary';
	createBtn.textContent = 'Create';

	actions.appendChild(cancelBtn);
	actions.appendChild(createBtn);
	modal.appendChild(h3);
	modal.appendChild(p);
	modal.appendChild(input);
	modal.appendChild(actions);
	backdrop.appendChild(modal);
	document.body.appendChild(backdrop);

	const close = () => backdrop.remove();
	cancelBtn.addEventListener('click', close);
	backdrop.addEventListener('click', (e) => {
		if (e.target === backdrop) { close(); }
	});
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { createBtn.click(); }
		if (e.key === 'Escape') { close(); }
	});
	createBtn.addEventListener('click', () => {
		const v = input.value.trim();
		if (v) {
			void window.spacesSidebar.invoke('createSpace', v);
		}
		close();
	});
	input.focus();
}

// ---- events ----

panel.addEventListener('pointerenter', expand);
panel.addEventListener('pointerleave', scheduleCollapse);
trigger.addEventListener('pointerenter', expand);
trigger.addEventListener('pointerleave', scheduleCollapse);

// Clicking the collapsed trigger expands; clicking an expanded (pinned) header
// collapses. Matches Terax's trigger toggle.
trigger.addEventListener('click', () => {
	if (collapsed) { expand(); }
});
collapseBtn.addEventListener('click', () => collapse());

pinBtn.addEventListener('click', () => persistPinned(!pinned));

newBtn.addEventListener('click', () => {
	// No spaces root configured -> guide to settings first (Terax behavior).
	if (!settings.spacesRoot) {
		void window.spacesSidebar.invoke('openSettings');
		return;
	}
	showNewSpaceDialog();
});

// Width drag
resizeHandle.addEventListener('pointerdown', (e) => {
	e.preventDefault();
	resizeHandle.classList.add('dragging');
	const startX = e.clientX;
	const startWidth = width;
	const onMove = (ev: PointerEvent) => {
		const next = startWidth + (ev.clientX - startX);
		persistWidth(Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(next))));
	};
	const onUp = () => {
		resizeHandle.classList.remove('dragging');
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
	};
	window.addEventListener('pointermove', onMove);
	window.addEventListener('pointerup', onUp);
});

// ---- boot ----

async function refresh(): Promise<void> {
	const [spacesData, settingsData] = await Promise.all([
		window.spacesSidebar.invoke('getSpaces'),
		window.spacesSidebar.invoke('getSettings')
	]);
	data = spacesData as ISpacesSidebarData;
	settings = settingsData as ISpacesSidebarSettings;
	render();
}

window.spacesSidebar.onDidChange(() => void refresh());
void refresh();
