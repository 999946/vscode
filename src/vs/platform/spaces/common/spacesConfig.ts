/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Spaces user-facing configuration, mirroring Terax:
 * - `spaces.root`      — folder whose first-level sub-folders each become a Space
 * - `spaces.showTabs`  — show each Space's tab list in the panel/switcher
 * - `spaces.showInitials` — use the Space name's first letter as its avatar
 *
 * The sidebar reads/writes these through the main process; the Settings UI
 * exposes them natively because they are registered as normal settings.
 */

export const SPACES_ROOT_SETTING = 'spaces.root';
export const SPACES_SHOW_TABS_SETTING = 'spaces.showTabs';
export const SPACES_SHOW_INITIALS_SETTING = 'spaces.showInitials';

export const SIDEBAR_SETTING_KEYS = [
	SPACES_ROOT_SETTING,
	SPACES_SHOW_TABS_SETTING,
	SPACES_SHOW_INITIALS_SETTING
] as const;

export interface ISpacesSettings {
	spacesRoot: string | null;
	showSpaceTabs: boolean;
	showSpaceInitials: boolean;
}

export function defaultSpacesSettings(): ISpacesSettings {
	return {
		spacesRoot: null,
		showSpaceTabs: true,
		showSpaceInitials: false
	};
}
