/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IFileService } from '../../../files/common/files.js';
import { ISpaceInfo } from '../../common/spacesLifecycle.js';
import { SpacesScriptHost } from '../../electron-main/spacesScriptHost.js';
import { ISpaceScriptEvent } from '../../common/spacesScripts.js';

/**
 * A scriptable fake directory: `resolve` returns the configured children for
 * the scripts directory, `createFolder` and `createFile` are no-ops that mark
 * themselves called.
 */
function makeFileService(children: Array<{ name: string; isDirectory: boolean }> = []) {
	let dirChildren = children;
	const svc = {
		_serviceBrand: undefined,
		__setChildren: (c: Array<{ name: string; isDirectory: boolean }>) => { dirChildren = c; },
		__createdFolder: [] as string[],
		__createdFile: [] as { path: string; content: string }[],
		resolve: async (r: URI) => {
			if (r.fsPath === '/scripts') {
				return {
					isDirectory: true,
					children: dirChildren.map(c => ({ name: c.name, isDirectory: c.isDirectory, isSymbolicLink: false, resource: URI.file(`/scripts/${c.name}`) }))
				};
			}
			return { isDirectory: true, children: [] };
		},
		createFolder: async (r: URI) => { svc.__createdFolder.push(r.fsPath); return {} as never; },
		createFile: async (r: URI, content?: unknown) => {
			svc.__createdFile.push({ path: r.fsPath, content: String((content as { toString(): string })?.toString() ?? '') });
			return {} as never;
		}
	};
	return svc;
}

suite('SpacesScriptHost', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let fileService: ReturnType<typeof makeFileService>;
	let infoEvents: number;
	let dispatchErrors: string[];
	let host: SpacesScriptHost | undefined;

	function makeHost(overrides: { explicit?: boolean; resolveDir?: () => string | undefined; spawn?: (node: string, path: string, event: ISpaceScriptEvent) => Promise<{ result?: unknown; error?: string }> } = {}): SpacesScriptHost {
		const h = store.add(new SpacesScriptHost({
			logService: new NullLogService(),
			fileService: fileService as unknown as IFileService,
			resolveScriptsDir: overrides.resolveDir ?? (() => '/scripts'),
			isExplicitScriptsDir: () => overrides.explicit ?? true,
			spawnScript: overrides.spawn ? async (node, p, ev) => {
				const r = await overrides.spawn!(node, p, ev);
				return { pluginId: p, result: r.result as never, error: r.error };
			} : undefined
		}));
		store.add(h.onDidChangeInfo(() => infoEvents++));
		store.add(h.onDidDispatchError(e => dispatchErrors.push(e)));
		host = h;
		return h;
	}

	setup(() => {
		fileService = makeFileService([
			{ name: 'space-info.mjs', isDirectory: false },
			{ name: 'helper.cjs', isDirectory: false },
			{ name: 'readme.txt', isDirectory: false },
			{ name: 'sub', isDirectory: true }
		]);
		infoEvents = 0;
		dispatchErrors = [];
		host = undefined;
	});

	teardown(() => {
		host?.dispose();
		host = undefined;
	});

	test('dispatch runs every script and merges info results', async () => {
		const info: ISpaceInfo = { summary: 'Local', status: 'online', onlineAt: null, lastTestedAt: null };
		makeHost({
			spawn: async (_node, path) => {
				if (path.endsWith('space-info.mjs')) {
					return { result: { type: 'spaces.info.updated', spaces: { s1: info } } };
				}
				return { result: { type: 'handled' } };
			}
		});

		await host!.dispatch('spaces.loaded', () => ({ spaces: [{ id: 's1', name: 'A', root: '/work/a' }] }));

		assert.strictEqual(infoEvents, 1);
		assert.deepStrictEqual(host!.getInfoBySpace().get('s1'), info);
		assert.deepStrictEqual(dispatchErrors, []);
	});

	test('dispatch surfaces a failing script error without stopping others', async () => {
		const info: ISpaceInfo = { summary: 'Local', status: 'online', onlineAt: null, lastTestedAt: null };
		makeHost({
			spawn: async (_node, path) => {
				if (path.endsWith('space-info.mjs')) {
					return { result: undefined, error: 'boom' };
				}
				return { result: { type: 'spaces.info.updated', spaces: { s1: info } } };
			}
		});

		await host!.dispatch('spaces.loaded', () => ({ spaces: [{ id: 's1', name: 'A', root: '/work/a' }] }));

		assert.deepStrictEqual(dispatchErrors, ['space-info: boom']);
		assert.deepStrictEqual(host!.getInfoBySpace().get('s1'), info, 'good script still contributed');
	});

	test('no scripts directory yields silent skip, not an error', async () => {
		makeHost({ resolveDir: () => undefined });
		assert.strictEqual(host!.isAvailable(), false);
		await host!.dispatch('spaces.loaded', () => ({ spaces: [{ id: 's1', name: 'A', root: '/work/a' }] }));
		assert.strictEqual(dispatchErrors.length, 0, 'missing scripts dir is silent, not an error');
	});
});
