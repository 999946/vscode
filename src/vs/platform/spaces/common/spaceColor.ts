/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Decorative per-space accent hues, mirroring Terax's `SPACE_COLORS` palette.
 * Kept in `oklch()` so the standalone sidebar can use them directly in
 * `color-mix(in oklch, ...)`. The palette is tuned to read on both light and
 * dark surfaces.
 */

export const SPACE_COLORS = [
	'oklch(0.62 0.17 254)',  // blue
	'oklch(0.60 0.18 296)',  // violet
	'oklch(0.65 0.16 162)',  // emerald
	'oklch(0.74 0.16 78)',   // amber
	'oklch(0.64 0.20 18)',   // rose
	'oklch(0.68 0.13 212)',  // cyan
	'oklch(0.68 0.18 44)',   // orange
	'oklch(0.66 0.19 350)',  // pink
] as const;

const SPACE_COLORS_LENGTH = SPACE_COLORS.length;

/** A cheap, stable hash of a Space id so a Space keeps the same accent across restarts. */
export function spaceAccentIndex(spaceId: string): number {
	let h = 0;
	for (let i = 0; i < spaceId.length; i++) {
		h = (h * 31 + spaceId.charCodeAt(i)) | 0;
	}
	return Math.abs(h) % SPACE_COLORS_LENGTH;
}

/** The accent color for a Space id, or the raw fallback when the index is out of range. */
export function spaceAccentFor(spaceId: string): string {
	return SPACE_COLORS[spaceAccentIndex(spaceId)];
}

/** The first letter of a Space name, uppercased (Terax `spaceInitial`). */
export function spaceInitial(name: string): string {
	const ch = name.trim()[0];
	return ch ? ch.toUpperCase() : '?';
}
