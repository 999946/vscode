/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IPolicyService, NullPolicyService } from '../../../../../platform/policy/common/policy.js';
import { RemoteAuthorityResolverService } from '../../../../../platform/remote/browser/remoteAuthorityResolverService.js';
import { IRemoteAuthorityResolverService } from '../../../../../platform/remote/common/remoteAuthorityResolver.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IAnyWorkspaceIdentifier } from '../../../../../platform/workspace/common/workspace.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../../services/environment/browser/environmentService.js';
import { BrowserWorkspaceSessionService } from '../../browser/browserWorkspaceSessionService.js';
import { SessionStorageService } from '../../browser/workspaceSessionService.js';
import { TestUserDataProfileService, TestProductService } from '../../../../test/common/workbenchTestServices.js';
import { workbenchInstantiationService, TestEnvironmentService } from '../../../../test/browser/workbenchTestServices.js';

// Exposes the protected createStorageService factory so the tests can drive
// the production browser session service's storage creation directly (the
// factory is the seam Stage 2c introduces; the rest of createSession is
// unchanged from before).
class TestBrowserWorkspaceSessionService extends BrowserWorkspaceSessionService {
	public createStorageServicePublic(workspace: IAnyWorkspaceIdentifier): SessionStorageService {
		return this.createStorageService(workspace);
	}
}

suite('WorkspaceSession - Storage Isolation', () => {

	const disposables = new DisposableStore();

	// Teardown must be defined before the leak-suite check: mocha runs
	// suite teardowns in definition order, so clearing the stores the
	// workbench test container registered into must happen before the
	// leak check, otherwise every service it created counts as leaked.
	teardown(() => {
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	function createBrowserSessionService(): { service: TestBrowserWorkspaceSessionService; instantiationService: IInstantiationService } {
		const instantiationService = workbenchInstantiationService(undefined, disposables);

		// Services the workbench test container does not register by default
		instantiationService.stub(IPolicyService, new NullPolicyService());
		instantiationService.stub(IBrowserWorkbenchEnvironmentService, TestEnvironmentService);
		instantiationService.stub(IRemoteAuthorityResolverService, disposables.add(new RemoteAuthorityResolverService(false, undefined, undefined, undefined, TestProductService, new NullLogService())));

		const service = disposables.add(instantiationService.createInstance(TestBrowserWorkspaceSessionService));
		return { service, instantiationService };
	}

	test('the session storage factory creates one BrowserStorageService per workspace', () => {
		const { service } = createBrowserSessionService();

		const storageA = service.createStorageServicePublic({ id: 'ws-session-storage-a', uri: URI.file('/a') });
		disposables.add(toDisposable(() => storageA.close()));
		const storageB = service.createStorageServicePublic({ id: 'ws-session-storage-b', uri: URI.file('/b') });
		disposables.add(toDisposable(() => storageB.close()));

		// Browser sessions keep using the IndexedDB storage service
		assert.ok(storageA instanceof BrowserStorageService);
		assert.ok(storageB instanceof BrowserStorageService);

		// Each session owns a distinct storage instance addressed by its workspace id
		assert.notStrictEqual(storageA, storageB);
	});

	test('two browser storage services isolate their WORKSPACE scope by workspace id', async () => {
		const logService = new NullLogService();
		const profileService = new TestUserDataProfileService();

		const storageA = new BrowserStorageService({ id: 'ws-session-storage-a', uri: URI.file('/a') }, profileService, logService);
		const storageB = new BrowserStorageService({ id: 'ws-session-storage-b', uri: URI.file('/b') }, profileService, logService);

		disposables.add(toDisposable(() => storageA.close()));
		disposables.add(toDisposable(() => storageB.close()));

		await storageA.initialize();
		await storageB.initialize();

		storageA.store('key', 'a-value', StorageScope.WORKSPACE, StorageTarget.MACHINE);

		// Flush before the teardown closes the storages: store() schedules an
		// async IndexedDB write that broadcasts over a BroadcastChannel; if the
		// channel is closed (close()) while that write is still in flight, the
		// broadcast throws an InvalidStateError that fails the suite teardown.
		await storageA.flush();

		// The same key written to workspace A is not visible in workspace B
		assert.strictEqual(storageB.get('key', StorageScope.WORKSPACE), undefined);
		assert.strictEqual(storageA.get('key', StorageScope.WORKSPACE), 'a-value');
	});

	test('the storage factory result is usable as a session storage service (initialize/close present)', () => {
		const { service } = createBrowserSessionService();

		const storage = service.createStorageServicePublic({ id: 'ws-session-storage-c', uri: URI.file('/c') });
		disposables.add(toDisposable(() => storage.close()));
		const sessionStorage: SessionStorageService = storage;

		assert.strictEqual(typeof sessionStorage.initialize, 'function');
		assert.strictEqual(typeof sessionStorage.close, 'function');
	});
});
