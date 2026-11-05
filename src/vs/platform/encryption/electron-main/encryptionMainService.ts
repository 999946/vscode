/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { safeStorage as safeStorageElectron, app } from 'electron';
import { isMacintosh, isWindows } from '../../../base/common/platform.js';
import { KnownStorageProvider, IEncryptionMainService, PasswordStoreCLIOption } from '../common/encryptionService.js';
import { ILogService } from '../../log/common/log.js';
import { withSafeStorageTimeout } from '../common/safeStorageTimeout.js';

// These APIs are currently only supported in our custom build of electron so
// we need to guard against them not being available.
interface ISafeStorageAdditionalAPIs {
	setUsePlainTextEncryption(usePlainText: boolean): void;
	getSelectedStorageBackend(): string;

	// Async variants only exist in our custom Electron build.
	isAsyncEncryptionAvailable?(): Promise<boolean>;
	encryptStringAsync?(plainText: string): Promise<Buffer>;
	decryptStringAsync?(encrypted: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>;
}

const safeStorage: typeof import('electron').safeStorage & Partial<ISafeStorageAdditionalAPIs> = safeStorageElectron;

/**
 * Every Keychain call on macOS is synchronous and, when `securityd` /
 * SecurityAgent is wedged, it blocks the main thread forever. That used to
 * freeze the entire application during startup (encryption availability is
 * probed before any workbench loads), so every window - including a freshly
 * created Space - stayed black with no way to report an error.
 *
 * Our custom Electron build exposes async safeStorage APIs which perform the
 * Keychain access off the main thread, keeping the main process responsive
 * even if the keychain never answers. Prefer them when present.
 */
const supportsAsyncSafeStorage = typeof safeStorage.isAsyncEncryptionAvailable === 'function'
	&& typeof safeStorage.encryptStringAsync === 'function'
	&& typeof safeStorage.decryptStringAsync === 'function';

export class EncryptionMainService implements IEncryptionMainService {
	_serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService
	) {
		// if this commandLine switch is set, the user has opted in to using basic text encryption
		if (app.commandLine.getSwitchValue('password-store') === PasswordStoreCLIOption.basic) {
			this.logService.trace('[EncryptionMainService] setting usePlainTextEncryption to true...');
			safeStorage.setUsePlainTextEncryption?.(true);
			this.logService.trace('[EncryptionMainService] set usePlainTextEncryption to true');
		}

		this.logService.trace(`[EncryptionMainService] async safeStorage: ${supportsAsyncSafeStorage}`);
	}

	async encrypt(value: string): Promise<string> {
		this.logService.trace('[EncryptionMainService] Encrypting value...');
		try {
			const result = JSON.stringify(await this.doEncrypt(value));
			this.logService.trace('[EncryptionMainService] Encrypted value.');
			return result;
		} catch (e) {
			this.logService.error(e);
			throw e;
		}
	}

	async decrypt(value: string): Promise<string> {
		let parsedValue: { data: string };
		try {
			parsedValue = JSON.parse(value);
			if (!parsedValue.data) {
				throw new Error(`[EncryptionMainService] Invalid encrypted value: ${value}`);
			}
			const bufferToDecrypt = Buffer.from(parsedValue.data);

			this.logService.trace('[EncryptionMainService] Decrypting value...');
			const result = await this.doDecrypt(bufferToDecrypt);
			this.logService.trace('[EncryptionMainService] Decrypted value.');
			return result;
		} catch (e) {
			this.logService.error(e);
			throw e;
		}
	}

	async isEncryptionAvailable(): Promise<boolean> {
		this.logService.trace('[EncryptionMainService] Checking if encryption is available...');
		try {
			const result = supportsAsyncSafeStorage
				? await withSafeStorageTimeout(safeStorage.isAsyncEncryptionAvailable!(), 'safeStorage.isAsyncEncryptionAvailable')
				: safeStorage.isEncryptionAvailable();
			this.logService.trace('[EncryptionMainService] Encryption is available: ', result);
			return result;
		} catch (e) {
			// Never leave the caller waiting on a wedged keychain: treat the
			// failure as "not available" so secret storage degrades to memory
			// instead of blocking workbench startup.
			this.logService.error('[EncryptionMainService] Failed to check encryption availability', e);
			return false;
		}
	}

	getKeyStorageProvider(): Promise<KnownStorageProvider> {
		if (isWindows) {
			return Promise.resolve(KnownStorageProvider.dplib);
		}
		if (isMacintosh) {
			return Promise.resolve(KnownStorageProvider.keychainAccess);
		}
		if (safeStorage.getSelectedStorageBackend) {
			try {
				this.logService.trace('[EncryptionMainService] Getting selected storage backend...');
				const result = safeStorage.getSelectedStorageBackend() as KnownStorageProvider;
				this.logService.trace('[EncryptionMainService] Selected storage backend: ', result);
				return Promise.resolve(result);
			} catch (e) {
				this.logService.error(e);
			}
		}
		return Promise.resolve(KnownStorageProvider.unknown);
	}

	async setUsePlainTextEncryption(): Promise<void> {
		if (isWindows) {
			throw new Error('Setting plain text encryption is not supported on Windows.');
		}

		if (isMacintosh) {
			throw new Error('Setting plain text encryption is not supported on macOS.');
		}

		if (!safeStorage.setUsePlainTextEncryption) {
			throw new Error('Setting plain text encryption is not supported.');
		}

		this.logService.trace('[EncryptionMainService] Setting usePlainTextEncryption to true...');
		safeStorage.setUsePlainTextEncryption(true);
		this.logService.trace('[EncryptionMainService] Set usePlainTextEncryption to true');
	}

	private async doEncrypt(value: string): Promise<Buffer> {
		if (supportsAsyncSafeStorage) {
			return withSafeStorageTimeout(safeStorage.encryptStringAsync!(value), 'safeStorage.encryptStringAsync');
		}
		return safeStorage.encryptString(value);
	}

	private async doDecrypt(encrypted: Buffer): Promise<string> {
		if (!supportsAsyncSafeStorage) {
			return safeStorage.decryptString(encrypted);
		}

		const first = await withSafeStorageTimeout(safeStorage.decryptStringAsync!(encrypted), 'safeStorage.decryptStringAsync');
		if (!first.shouldReEncrypt) {
			return first.result;
		}

		// The key was rotated or a stronger one became available: ask once more
		// so the caller gets the value decrypted with the new key.
		this.logService.trace('[EncryptionMainService] Decrypted value should be re-encrypted, retrying');
		const second = await withSafeStorageTimeout(safeStorage.decryptStringAsync!(encrypted), 'safeStorage.decryptStringAsync');
		return second.result ?? first.result;
	}
}
