/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { URI } from '../../../../base/common/uri.js';
import { IPersistedSpace, IPersistedSpacesState, buildSpacesState, fromPersistedWorkspace, parseSpacesState, serializeSpacesState } from '../../common/spacesState.js';

const state: IPersistedSpacesState = {
	version: 1,
	spaces: [
		{ id: 'space-a', workspace: { kind: 'folder', uri: URI.file('/work/project-a').toJSON() } },
		{ id: 'space-b' }
	],
	activeSpaceId: 'space-b'
};

suite('spacesState', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseSpacesState', () => {

		test('round-trips a persisted state', () => {
			const parsed = parseSpacesState(serializeSpacesState(state))!;
			assert.ok(parsed);
			assert.strictEqual(parsed.version, 1);
			assert.strictEqual(parsed.spaces.length, 2);
			assert.strictEqual(parsed.spaces[0].id, 'space-a');
			assert.strictEqual(parsed.activeSpaceId, 'space-b');
		});

		test('returns undefined for corrupt input', () => {
			assert.strictEqual(parseSpacesState('not json'), undefined);
			assert.strictEqual(parseSpacesState('{oops'), undefined);
			assert.strictEqual(parseSpacesState('42'), undefined);
			assert.strictEqual(parseSpacesState(null), undefined);
			assert.strictEqual(parseSpacesState(undefined), undefined);
		});

		test('rejects a future or unknown version', () => {
			assert.strictEqual(parseSpacesState({ version: 99, spaces: [] }), undefined);
		});

		test('rejects a missing spaces array', () => {
			assert.strictEqual(parseSpacesState({ version: 1 }), undefined);
		});

		test('skips invalid entries instead of failing', () => {
			const parsed = parseSpacesState({
				version: 1,
				spaces: [
					{ id: 'a', workspace: { kind: 'folder', uri: URI.file('/work/a').toJSON() } },
					{ id: '' },                                  // empty id
					{ id: 'b', workspace: null },                // unknown workspace kind
					{ id: 'a' },                                 // duplicate id
					{ workspace: { kind: 'folder', uri: URI.file('/work/c').toJSON() } }, // missing id
				],
				activeSpaceId: 'b'
			})!;
			assert.strictEqual(parsed.spaces.length, 1);
			assert.strictEqual(parsed.spaces[0].id, 'a');
			assert.strictEqual(parsed.activeSpaceId, undefined, 'active id must reference a kept space');
		});

		test('drops a duplicate folder path', () => {
			const parsed = parseSpacesState({
				version: 1,
				spaces: [
					{ id: 'a', workspace: { kind: 'folder', uri: URI.file('/work/a').toJSON() } },
					{ id: 'b', workspace: { kind: 'folder', uri: URI.file('/work/a').toJSON() } },
				]
			})!;
			assert.strictEqual(parsed.spaces.length, 1);
			assert.strictEqual(parsed.spaces[0].id, 'a');
		});

		test('keeps empty Spaces (no workspace) when the id is valid', () => {
			const parsed = parseSpacesState({ version: 1, spaces: [{ id: 'empty-1' }], activeSpaceId: 'empty-1' })!;
			assert.strictEqual(parsed.spaces.length, 1);
			assert.strictEqual(parsed.spaces[0].workspace, undefined);
			assert.strictEqual(parsed.activeSpaceId, 'empty-1');
		});

		test('does not restore a partially mounted workspace uri as valid', () => {
			const parsed = parseSpacesState({
				version: 1,
				spaces: [{ id: 'x', workspace: { kind: 'folder', uri: { scheme: 'file' } } }] // missing path
			});
			assert.strictEqual(parsed, undefined);
		});
	});

	suite('buildSpacesState', () => {

		test('builds state from live Spaces keeping ids and order', () => {
			const built = buildSpacesState([
				{ id: 'a', workspace: { kind: 'folder', uri: URI.file('/work/a') } },
				{ id: 'b', workspace: undefined as never }
			], 'a');
			assert.deepStrictEqual(built.spaces.map(s => (s as IPersistedSpace).id), ['a', 'b']);
			assert.strictEqual(built.activeSpaceId, 'a');
			assert.deepStrictEqual(built.spaces[0].workspace!.uri, URI.file('/work/a').toJSON());
		});

		test('empty state has no active space', () => {
			const built = buildSpacesState([], undefined);
			assert.deepStrictEqual(built.spaces, []);
			assert.strictEqual(built.activeSpaceId, undefined);
		});
	});

	suite('fromPersistedWorkspace', () => {

		test('revives a persisted workspace uri', () => {
			const ws = fromPersistedWorkspace({ kind: 'folder', uri: URI.file('/work/project-a').toJSON() })!;
			assert.deepStrictEqual(ws.kind, 'folder');
			assert.strictEqual(ws.uri.fsPath, '/work/project-a');
		});

		test('undefined becomes undefined', () => {
			assert.strictEqual(fromPersistedWorkspace(undefined), undefined);
		});
	});
});
