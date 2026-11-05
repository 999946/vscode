/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Upper bound for a single Keychain round trip. The async safeStorage APIs run
 * off the main thread, so a wedged SecurityAgent no longer freezes the UI - but
 * it does leave the returned promise pending forever, which would block
 * `SecretStorageService.initialize()` and therefore part of workbench startup.
 * Timing out turns "never answers" into an ordinary, reportable failure.
 */
export const SAFE_STORAGE_TIMEOUT_MS = 5000;

/**
 * Settles with `promise`, or rejects after `timeoutMs` so that a hung native
 * call cannot stall the caller indefinitely. The losing native operation is
 * left to finish on its own (it runs on a worker thread and holds no JS
 * resources).
 */
export function withSafeStorageTimeout<T>(promise: Promise<T>, operation: string, timeoutMs: number = SAFE_STORAGE_TIMEOUT_MS): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			reject(new Error(`${operation} timed out after ${timeoutMs}ms; the keychain did not respond`));
		}, timeoutMs);
		promise.then(value => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(value);
		}, error => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
	});
}
