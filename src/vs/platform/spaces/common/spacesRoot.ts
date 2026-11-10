/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure helpers for the Terax-style `spaces.root` setting: the root folder
 * whose *first-level sub-folders* each become a Space.
 *
 * These are kept free of services so the path handling (trailing separators,
 * Windows vs. POSIX separators, comparison keys) and the scan rules (files,
 * hidden folders, duplicates) can be unit tested exhaustively.
 */

/** A directory entry of the Spaces root, as produced by `IFileService.readdir`. */
export interface IRootFolderEntry {
	readonly name: string;
	readonly isDirectory: boolean;
}

export interface IScannedRootFolder {
	readonly name: string;
	/** Absolute path of the folder that should become a Space. */
	readonly fsPath: string;
}

export type RootFolderSkipReason = 'notDirectory' | 'hidden' | 'duplicate' | 'invalidName';

export interface ISkippedRootEntry {
	readonly name: string;
	readonly reason: RootFolderSkipReason;
}

export interface IRootScanResult {
	/** Folders that should become Spaces, sorted by name. */
	readonly folders: readonly IScannedRootFolder[];
	/** Entries that were intentionally ignored, for logging/diagnostics. */
	readonly skipped: readonly ISkippedRootEntry[];
}

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PREFIX = /^\\\\/;

/** Whether the path looks like a Windows path (`C:\\...` or a UNC share). */
export function isWindowsStylePath(fsPath: string): boolean {
	return WINDOWS_DRIVE_PREFIX.test(fsPath) || WINDOWS_UNC_PREFIX.test(fsPath);
}

/**
 * Removes trailing separators while preserving root paths (`/`, `C:\\`).
 * Returns an empty string for blank input.
 */
export function trimRootPath(root: string): string {
	const trimmed = (root ?? '').trim();
	if (!trimmed) {
		return '';
	}

	const windows = isWindowsStylePath(trimmed);
	const withoutTrailing = trimmed.replace(windows ? /[\\/]+$/ : /\/+$/, '');
	if (!withoutTrailing) {
		// The path consisted only of separators.
		if (windows) {
			// `C:` / `C:\\` / `C:/` -> drive root `X:\\`; `\\` -> UNC root.
			const drive = trimmed.match(/^([A-Za-z]:)/);
			return drive ? `${drive[1]}\\` : '\\\\';
		}
		return '/';
	}
	let normalized = windows ? withoutTrailing.replace(/\//g, '\\') : withoutTrailing;
	if (windows && /^[A-Za-z]:$/.test(normalized)) {
		// `C:` alone is a drive-relative path; `C:\\` is the drive root.
		normalized += '\\';
	}
	return normalized;
}

/** Joins the root folder and a Space name, choosing the separator from the root. */
export function joinRootFolder(root: string, name: string): string {
	const base = trimRootPath(root);
	const trimmedName = (name ?? '').trim();
	if (!base) {
		return trimmedName;
	}
	if (!trimmedName) {
		return base;
	}
	if (/[\\/]$/.test(base)) {
		return base + trimmedName;
	}
	return base + (isWindowsStylePath(base) ? '\\' : '/') + trimmedName;
}

/**
 * Comparable form of a path: separators unified and, on case-insensitive
 * file systems, lower cased. Used to detect folders that are already open as
 * a Space.
 */
export function pathKey(fsPath: string, caseInsensitive: boolean): string {
	const unified = trimRootPath(fsPath).replace(/\\/g, '/');
	return caseInsensitive ? unified.toLowerCase() : unified;
}

/**
 * Scans the Spaces root and returns the folders that should become Spaces.
 *
 * Skips (never throws):
 * - non-folder entries (plain files, sockets, symlinks reported as files)
 * - hidden entries (leading `.`, e.g. `.git`, `.DS_Store`)
 * - names that are empty or contain separators (defensive: `readdir` names
 *   never contain separators, but the root may come from user input)
 * - folders that are already open as a Space (compared via `pathKey`)
 */
export function scanRootFolders(
	root: string,
	entries: readonly IRootFolderEntry[],
	existingFsPaths: readonly string[] = [],
	options: { readonly caseInsensitive?: boolean } = {}
): IRootScanResult {
	const caseInsensitive = options.caseInsensitive ?? false;
	const folders: IScannedRootFolder[] = [];
	const skipped: ISkippedRootEntry[] = [];

	const base = trimRootPath(root);
	if (!base) {
		return { folders, skipped };
	}

	const known = new Set(existingFsPaths.filter(p => !!p).map(p => pathKey(p, caseInsensitive)));
	const seen = new Set<string>();

	for (const entry of entries) {
		const name = (entry.name ?? '').trim();
		if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
			skipped.push({ name: entry.name, reason: 'invalidName' });
			continue;
		}
		if (name.startsWith('.')) {
			skipped.push({ name, reason: 'hidden' });
			continue;
		}
		if (!entry.isDirectory) {
			skipped.push({ name, reason: 'notDirectory' });
			continue;
		}

		const fsPath = joinRootFolder(base, name);
		const key = pathKey(fsPath, caseInsensitive);
		if (known.has(key) || seen.has(key)) {
			skipped.push({ name, reason: 'duplicate' });
			continue;
		}

		seen.add(key);
		folders.push({ name, fsPath });
	}

	folders.sort((a, b) => a.name.localeCompare(b.name));

	return { folders, skipped };
}

/**
 * Whether `childFsPath` is a *direct* child of `rootFsPath`. Used to decide if
 * a Space folder may be deleted together with the Space.
 */
export function isDirectChildOfRoot(childFsPath: string, rootFsPath: string, caseInsensitive: boolean): boolean {
	const root = trimRootPath(rootFsPath);
	const child = trimRootPath(childFsPath);
	if (!root || !child) {
		return false;
	}

	const rootKey = pathKey(root, caseInsensitive);
	const childKey = pathKey(child, caseInsensitive);
	const prefix = rootKey.endsWith('/') ? rootKey : `${rootKey}/`;
	if (!childKey.startsWith(prefix)) {
		return false;
	}

	const remainder = childKey.slice(prefix.length);
	return remainder.length > 0 && !remainder.includes('/');
}
