/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable no-restricted-syntax */

import type { ISpacesSidebarData, ISpacesSidebarSpace } from '../common/spacesSidebarRpc.js';

/**
 * Renderer entry point for the shared Spaces sidebar view.
 *
 * The sidebar is a tiny standalone page (see `spacesSidebar.html`) hosted in a
 * `WebContentsView` attached to the frame `BrowserWindow`. It renders the Space
 * list, lets you switch/rename/close Spaces and create/open Spaces — all via
 * the `window.spacesSidebar` bridge exposed by `spacesSidebarPreload.js`.
 *
 * Because the sidebar is a plain DOM page (not a full workbench renderer), all
 * strings are inline; there is no nls/localization layer here.
 */

interface ISpacesSidebarBridge {
	invoke(method: string, ...args: unknown[]): Promise<unknown>;
	onDidChange(callback: (data: unknown) => void): void;
}

declare const window: Window & { spacesSidebar: ISpacesSidebarBridge };

const list = document.getElementById('list') as HTMLDivElement;
const countEl = document.getElementById('count') as HTMLSpanElement;

function createRow(space: ISpacesSidebarSpace): HTMLDivElement {
	const row = document.createElement('div');
	row.className = 'row' + (space.isCurrent ? ' active' : '');
	row.setAttribute('role', 'button');
	row.tabIndex = 0;

	const icon = document.createElement('span');
	icon.className = 'icon';
	icon.textContent = space.needsAttention ? '*' : '#';

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

	row.appendChild(icon);
	row.appendChild(main);

	if (space.needsAttention) {
		const badge = document.createElement('span');
		badge.className = 'badge';
		badge.textContent = 'attention';
		row.appendChild(badge);
	}

	const actions = document.createElement('div');
	actions.className = 'actions';

	const renameBtn = document.createElement('button');
	renameBtn.textContent = 'R';
	renameBtn.title = 'Rename Space';
	renameBtn.addEventListener('click', async (e) => {
		e.stopPropagation();
		const newName = prompt('Rename Space', space.name);
		if (typeof newName === 'string') {
			await window.spacesSidebar.invoke('renameSpace', space.id, newName);
		}
	});
	actions.appendChild(renameBtn);

	const closeBtn = document.createElement('button');
	closeBtn.textContent = 'X';
	closeBtn.title = 'Close Space';
	closeBtn.addEventListener('click', async (e) => {
		e.stopPropagation();
		await window.spacesSidebar.invoke('closeSpace', space.id);
	});
	actions.appendChild(closeBtn);

	row.appendChild(actions);

	row.addEventListener('click', () => {
		if (!space.isCurrent) {
			void window.spacesSidebar.invoke('switchToSpace', space.id);
		}
	});
	row.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			if (!space.isCurrent) {
				void window.spacesSidebar.invoke('switchToSpace', space.id);
			}
		}
	});

	return row;
}

function render(data: ISpacesSidebarData): void {
	list.textContent = '';
	countEl.textContent = `${data.spaces.length} Space${data.spaces.length === 1 ? '' : 's'}`;

	if (data.spaces.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'empty';
		empty.textContent = 'No Spaces yet. Create one to get started.';
		list.appendChild(empty);
		return;
	}

	for (const space of data.spaces) {
		list.appendChild(createRow(space));
	}
}

async function refresh(): Promise<void> {
	const data = await window.spacesSidebar.invoke('getSpaces');
	render(data as ISpacesSidebarData);
}

document.getElementById('newBtn')!.addEventListener('click', () => {
	void window.spacesSidebar.invoke('createEmptySpace');
});
document.getElementById('openFolderBtn')!.addEventListener('click', () => {
	void window.spacesSidebar.invoke('openFolderAsSpace');
});

window.spacesSidebar.onDidChange(() => void refresh());
void refresh();
