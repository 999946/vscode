/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	IRootFolderEntry, isDirectChildOfRoot, joinRootFolder, pathKey, scanRootFolders, trimRootPath
} from '../../common/spacesRoot.js';

function entries(list: Array<[string, boolean]>): IRootFolderEntry[] {
	return list.map(([name, isDirectory]) => ({ name, isDirectory }));
}

suite('spacesRoot', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('trimRootPath', () => {

		test('trims trailing separators', () => {
			assert.strictEqual(trimRootPath('/work/spaces/'), '/work/spaces');
			assert.strictEqual(trimRootPath('/work/spaces//'), '/work/spaces');
			assert.strictEqual(trimRootPath('C:\\work\\spaces\\'), 'C:\\work\\spaces');
			assert.strictEqual(trimRootPath('C:/work/spaces/'), 'C:\\work\\spaces');
		});

		test('preserves filesystem roots', () => {
			assert.strictEqual(trimRootPath('/'), '/');
			assert.strictEqual(trimRootPath('///'), '/');
			assert.strictEqual(trimRootPath('C:\\'), 'C:\\');
			assert.strictEqual(trimRootPath('C:/'), 'C:\\');
		});

		test('handles blank input', () => {
			assert.strictEqual(trimRootPath(''), '');
			assert.strictEqual(trimRootPath('   '), '');
			assert.strictEqual(trimRootPath(undefined as unknown as string), '');
			assert.strictEqual(trimRootPath(null as unknown as string), '');
		});
	});

	suite('joinRootFolder', () => {

		test('joins with the separator hinted by the root', () => {
			assert.strictEqual(joinRootFolder('/work/spaces', 'proj a'), '/work/spaces/proj a');
			assert.strictEqual(joinRootFolder('C:\\work\\spaces', 'proj a'), 'C:\\work\\spaces\\proj a');
			// Real UNC path: two leading backslashes, single separators inside.
			assert.strictEqual(joinRootFolder('\\\\server\\share', 'proj'), '\\\\server\\share\\proj');
		});

		test('tolerates trailing and missing separators', () => {
			assert.strictEqual(joinRootFolder('/work/spaces/', 'proj'), '/work/spaces/proj');
			assert.strictEqual(joinRootFolder('', 'proj'), 'proj');
			assert.strictEqual(joinRootFolder('/', 'proj'), '/proj');
			assert.strictEqual(joinRootFolder('C:\\', 'proj'), 'C:\\proj');
		});

		test('trims the Space name', () => {
			assert.strictEqual(joinRootFolder('/work', '  proj  '), '/work/proj');
			assert.strictEqual(joinRootFolder('/work', '   '), '/work');
			assert.strictEqual(joinRootFolder('/', '   '), '/');
		});
	});

	suite('pathKey', () => {

		test('unifies separators so the same folder compares equal', () => {
			assert.strictEqual(pathKey('C:\\work\\spaces\\proj', false), 'C:/work/spaces/proj');
			assert.strictEqual(pathKey('C:\\work\\spaces\\proj', true), 'c:/work/spaces/proj');
			assert.strictEqual(pathKey('c:/work/spaces/proj', true), 'c:/work/spaces/proj');
		});

		test('case-sensitive filesystems keep the original case', () => {
			assert.notStrictEqual(pathKey('/Work/Proj', false), pathKey('/work/proj', false));
			assert.strictEqual(pathKey('/Work/Proj', true), pathKey('/work/proj', true));
		});
	});

	suite('scanRootFolders', () => {

		test('every first-level sub-folder becomes a Space, files are skipped', () => {
			const result = scanRootFolders('/work/spaces', entries([
				['alpha', true], ['beta', true], ['notes.md', false]
			]));
			assert.deepStrictEqual(result.folders.map(f => f.name), ['alpha', 'beta']);
			assert.deepStrictEqual(result.skipped.map(s => s.name), ['notes.md']);
			assert.strictEqual(result.folders[0].fsPath, '/work/spaces/alpha');
		});

		test('folders sort by name regardless of scan order', () => {
			const result = scanRootFolders('/work/spaces', entries([
				['zebra', true], ['apple', true], ['mango', true]
			]));
			assert.deepStrictEqual(result.folders.map(f => f.name), ['apple', 'mango', 'zebra']);
		});

		test('hidden entries are skipped', () => {
			const result = scanRootFolders('/work/spaces', entries([
				['.git', true], ['.DS_Store', false], ['visible', true]
			]));
			assert.deepStrictEqual(result.folders.map(f => f.name), ['visible']);
			assert.deepStrictEqual(result.skipped.map(s => [s.name, s.reason]), [['.git', 'hidden'], ['.DS_Store', 'hidden']]);
		});

		test('entries already open as a Space are not duplicated', () => {
			const result = scanRootFolders('/work/spaces', entries([
				['alpha', true], ['beta', true]
			]), ['/work/spaces/alpha']);
			assert.deepStrictEqual(result.folders.map(f => f.name), ['beta']);
		});

		test('Windows and slash-vs-backslash duplicates are detected on case-insensitive systems', () => {
			const result = scanRootFolders('C:\\work\\spaces', entries([
				['Proj', true]
			]), ['c:/work/spaces/proj'], { caseInsensitive: true });
			assert.deepStrictEqual(result.folders, []);
			assert.deepStrictEqual(result.skipped.map(s => s.reason), ['duplicate']);
		});

		test('a missing root yields no folders', () => {
			const result = scanRootFolders('', entries([['alpha', true]]));
			assert.deepStrictEqual(result.folders, []);
		});

		test('defensive: names that would escape the root are skipped', () => {
			const result = scanRootFolders('/work/spaces', entries([
				['..', true], ['a/b', true], ['.', true]
			]));
			assert.deepStrictEqual(result.folders, []);
		});

		test('duplicate names within one scan are only added once', () => {
			const result = scanRootFolders('/work/spaces', entries([
				['alpha', true], ['alpha', true]
			]));
			assert.deepStrictEqual(result.folders.map(f => f.name), ['alpha']);
		});
	});

	suite('isDirectChildOfRoot', () => {

		test('true only for direct children', () => {
			assert.strictEqual(isDirectChildOfRoot('/work/spaces/proj', '/work/spaces', false), true);
			assert.strictEqual(isDirectChildOfRoot('/work/spaces/proj/sub', '/work/spaces', false), false);
			assert.strictEqual(isDirectChildOfRoot('/work/spaces-evil', '/work/spaces', false), false);
			assert.strictEqual(isDirectChildOfRoot('/work/spaces', '/work/spaces', false), false);
			assert.strictEqual(isDirectChildOfRoot('', '/work/spaces', false), false);
		});

		test('survives trailing root separators and Windows paths', () => {
			assert.strictEqual(isDirectChildOfRoot('C:\\work\\spaces\\proj', 'C:\\work\\spaces\\', true), true);
			assert.strictEqual(isDirectChildOfRoot('C:\\work\\spaces\\proj\\sub', 'C:\\work\\spaces', true), false);
		});
	});
});
