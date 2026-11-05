/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { withSafeStorageTimeout } from '../../common/safeStorageTimeout.js';

suite('withSafeStorageTimeout', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('passes through a resolved value', async () => {
		assert.strictEqual(await withSafeStorageTimeout(Promise.resolve(42), 'op', 1000), 42);
	});

	test('propagates a rejection from the underlying promise', async () => {
		const failure = new Error('keychain refused');
		await assert.rejects(() => withSafeStorageTimeout(Promise.reject(failure), 'op', 1000), (error: Error) => error === failure);
	});

	test('rejects instead of hanging when the keychain never answers', async () => {
		// Models a wedged SecurityAgent: the native call never settles. Without
		// the timeout this promise (and `SecretStorageService.initialize()`,
		// which awaits it) would stay pending forever.
		const never = new Promise<boolean>(() => { /* never settles */ });

		await assert.rejects(
			() => withSafeStorageTimeout(never, 'safeStorage.isAsyncEncryptionAvailable', 20),
			(error: Error) => /timed out after 20ms; the keychain did not respond/.test(error.message)
		);
	});

	test('a late native result is ignored after the timeout fired', async () => {
		let release!: (value: string) => void;
		const late = new Promise<string>(resolve => release = resolve);

		await assert.rejects(() => withSafeStorageTimeout(late, 'late-op', 20), /timed out/);

		// Resolving afterwards must not throw or settle anything unexpectedly.
		release('too late');
		await new Promise(resolve => setTimeout(resolve, 10));
	});
});
