/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ISpace, ISpacesSnapshot } from '../../common/spaces.js';
import {
	applyScriptResults, DEFAULT_SPACE_INFO_SCRIPT, makeSpaceScriptEvent, resolveNodeBinary,
	scanScriptDirectory, scriptStderrTail, spacesPayload,
	versionManagerCandidates
} from '../../common/spacesScripts.js';
import { ISpaceInfo } from '../../common/spacesLifecycle.js';

suite('spacesScripts', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('makeSpaceScriptEvent', () => {

		test('builds a Terax-style envelope', () => {
			const ev = makeSpaceScriptEvent('spaces.loaded', { spaces: [] });
			assert.strictEqual(ev.version, 1);
			assert.strictEqual(ev.type, 'spaces.loaded');
			assert.strictEqual(ev.context.eventType, 'spaces.loaded');
			assert.strictEqual(ev.context.eventVersion, 1);
			assert.ok(ev.context.eventId.startsWith('spaces.loaded-'));
			assert.ok(!isNaN(Date.parse(ev.context.emittedAt)));
			assert.deepStrictEqual(ev.payload, { spaces: [] });
		});

		test('increments the event sequence', () => {
			const a = makeSpaceScriptEvent('app.started', {});
			const b = makeSpaceScriptEvent('app.started', {});
			assert.notStrictEqual(a.context.eventId, b.context.eventId);
		});
	});

	suite('payload builders', () => {

		function snapshot(): ISpacesSnapshot {
			const spaces: ISpace[] = [
				{
					id: 's1', name: 'Alpha', windowId: 1, state: 'active',
					workspace: { kind: 'folder', uri: { scheme: 'file', fsPath: '/work/a' } as unknown as import('../../../../base/common/uri.js').URI },
					createdAt: 1, lastActiveAt: 2, needsAttention: false
				},
				{
					id: 's2', name: 'Empty', windowId: 2, state: 'inactive',
					workspace: undefined,
					createdAt: 3, lastActiveAt: 0, needsAttention: false
				}
			];
			return { spaces, activeSpaceId: 's1' };
		}

		test('spacesPayload only includes root-backed spaces', () => {
			const snap = snapshot();
			const payload = spacesPayload(snap);
			assert.strictEqual(payload.spaces.length, 1);
			assert.deepStrictEqual(payload.spaces[0], { id: 's1', name: 'Alpha', root: '/work/a' });
		});
	});

	suite('applyScriptResults', () => {

		test('merges space.info.updated', () => {
			const base = new Map<string, ISpaceInfo>();
			const info: ISpaceInfo = { summary: 'Local', status: 'online', onlineAt: null, lastTestedAt: null };
			const { info: next, errors } = applyScriptResults(base, [
				{ pluginId: 'a', result: { type: 'space.info.updated', spaceId: 's1', info }, error: undefined }
			]);
			assert.strictEqual(errors.length, 0);
			assert.deepStrictEqual(next.get('s1'), info);
		});

		test('merges spaces.info.updated', () => {
			const a: ISpaceInfo = { summary: 'A', status: 'online', onlineAt: null, lastTestedAt: null };
			const b: ISpaceInfo = { summary: 'B', status: 'offline', onlineAt: null, lastTestedAt: null };
			const { info } = applyScriptResults(new Map(), [
				{ pluginId: 'x', result: { type: 'spaces.info.updated', spaces: { s1: a, s2: b } }, error: undefined }
			]);
			assert.deepStrictEqual(info.get('s1'), a);
			assert.deepStrictEqual(info.get('s2'), b);
		});

		test('surfaces errors and skips their info', () => {
			const { info, errors } = applyScriptResults(new Map(), [
				{ pluginId: 'bad', result: undefined, error: 'boom' }
			]);
			assert.deepStrictEqual(errors, ['bad: boom']);
			assert.strictEqual(info.size, 0);
		});

		test('handled results do nothing', () => {
			const { info, errors } = applyScriptResults(new Map(), [
				{ pluginId: 'n', result: { type: 'handled' }, error: undefined }
			]);
			assert.strictEqual(errors.length, 0);
			assert.strictEqual(info.size, 0);
		});
	});

	suite('scanScriptDirectory', () => {

		test('finds mjs/cjs/js, ignores other files and directories', () => {
			const files = scanScriptDirectory([
				{ name: 'space-info.mjs', isDirectory: false },
				{ name: 'helper.cjs', isDirectory: false },
				{ name: 'notes.txt', isDirectory: false },
				{ name: 'subdir', isDirectory: true },
				{ name: 'app.js', isDirectory: false },
				{ name: '.hidden.js', isDirectory: false }
			]);
			assert.deepStrictEqual(files.map(f => f.id), ['app', 'helper', 'space-info']);
			assert.deepStrictEqual(files.map(f => f.name), ['app.js', 'helper.cjs', 'space-info.mjs']);
		});

		test('orders deterministically by id', () => {
			const files = scanScriptDirectory([
				{ name: 'z.mjs', isDirectory: false },
				{ name: 'a.mjs', isDirectory: false }
			]);
			assert.deepStrictEqual(files.map(f => f.id), ['a', 'z']);
		});
	});

	suite('resolveNodeBinary', () => {

		function isExecutable(p: string): boolean {
			// Simulate a filesystem where /good and /custom exist.
			return p === 'node' || p.startsWith('/good/') || p.startsWith('/custom/');
		}

		test('uses PARACODE_NODE override', () => {
			const result = resolveNodeBinary({ PARACODE_NODE: '/custom/node', PATH: '', HOME: '/home' }, isExecutable);
			assert.strictEqual(result, '/custom/node');
		});

		test('falls back to PATH node', () => {
			const result = resolveNodeBinary({ PARACODE_NODE: '', PATH: '/bad:/good/bin:/also', HOME: '/home' }, isExecutable);
			assert.strictEqual(result, '/good/bin/node');
		});

		test('falls back to version manager roots', () => {
			// fnm root under home is "exists"
			const result = resolveNodeBinary({
				PARACODE_NODE: '', PATH: '/bad', HOME: '/home'
			}, () => false);
			// With an isExecutable that rejects everything, no binary is found.
			assert.strictEqual(result, undefined);
		});

		test('nvm newest version is preferred within its root', () => {
			const candidates = versionManagerCandidates(
				'/home',
				() => ['v18.0.0', 'v22.1.0', 'v20.3.0'],
				p => p.includes('v22.1.0')
			);
			assert.ok(candidates.some(c => c.endsWith('/.nvm/versions/node/v22.1.0/bin/node')));
			assert.ok(!candidates.some(c => c.endsWith('/v18.0.0')));
		});
	});

	suite('scriptStderrTail', () => {

		test('keeps the tail of a long stderr', () => {
			const lines = [];
			for (let i = 0; i < 40; i++) { lines.push(`line ${i}`); }
			const tail = scriptStderrTail(lines.join('\n'));
			assert.ok(tail.includes('line 39'), 'has last line');
			assert.ok(!tail.includes('line 0'), 'oldest line trimmed');
		});

		test('empty stderr produces no detail', () => {
			assert.strictEqual(scriptStderrTail(''), '');
			assert.strictEqual(scriptStderrTail('   \n  '), '');
		});
	});

	suite('DEFAULT_SPACE_INFO_SCRIPT', () => {

		test('is a module exporting a handler map', () => {
			assert.ok(DEFAULT_SPACE_INFO_SCRIPT.includes('export default'));
			assert.ok(DEFAULT_SPACE_INFO_SCRIPT.includes('"spaces.loaded"'));
			assert.ok(DEFAULT_SPACE_INFO_SCRIPT.includes('"space.activated"'));
			assert.ok(DEFAULT_SPACE_INFO_SCRIPT.includes('toSpaceInfo'));
		});
	});
});
