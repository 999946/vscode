/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { ISpacesSnapshot } from '../../../../../platform/spaces/common/spaces.js';
import { SpacesService } from '../../electron-browser/spacesService.js';

suite('SpacesService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createSnapshot(): ISpacesSnapshot {
		return {
			spaces: [{
				id: 'space-1',
				name: 'project-a',
				windowId: 7,
				workspace: { kind: 'folder', uri: URI.file('/work/project-a') },
				createdAt: 1,
				lastActiveAt: 2,
				state: 'active',
				needsAttention: false
			}],
			activeSpaceId: 'space-1'
		};
	}

	/** What arrives over IPC: plain JSON objects instead of `URI` instances. */
	function serialize<T>(value: T): T {
		return JSON.parse(JSON.stringify(value));
	}

	function createService(onDidChangeSpaces: Event<unknown>, calls: Array<{ command: string; args: unknown }>): SpacesService {
		const channel: IChannel = {
			call<T>(command: string, args?: unknown): Promise<T> {
				calls.push({ command, args });
				return Promise.resolve(serialize(createSnapshot()) as T);
			},
			listen<T>(event: string): Event<T> {
				assert.strictEqual(event, 'onDidChangeSpaces');
				return onDidChangeSpaces as Event<T>;
			}
		};

		return new SpacesService(
			{ getChannel: () => channel } as unknown as IMainProcessService,
			{ windowId: 7 } as unknown as INativeHostService
		);
	}

	test('revives workspace URIs of change events', () => {
		const emitter = store.add(new Emitter<unknown>());
		const service = createService(emitter.event, []);

		const received: ISpacesSnapshot[] = [];
		store.add(service.onDidChangeSpaces(snapshot => received.push(snapshot)));
		emitter.fire(serialize(createSnapshot()));

		assert.strictEqual(received.length, 1);
		const uri = received[0].spaces[0].workspace?.uri;
		assert.ok(URI.isUri(uri));
		assert.strictEqual(uri.fsPath, URI.file('/work/project-a').fsPath);
	});

	test('passes the window id as context and revives call results', async () => {
		const emitter = store.add(new Emitter<unknown>());
		const calls: Array<{ command: string; args: unknown }> = [];
		const service = createService(emitter.event, calls);

		const snapshot = await service.getSpaces();

		assert.deepStrictEqual(calls, [{ command: 'getSpaces', args: [7] }]);
		assert.ok(URI.isUri(snapshot.spaces[0].workspace?.uri));
	});
});
