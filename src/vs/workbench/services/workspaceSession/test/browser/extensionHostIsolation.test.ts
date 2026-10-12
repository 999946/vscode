/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { ExtensionKind, IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { ExtensionIdentifier, IExtension, IExtensionDescription } from '../../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { TestInstantiationService, createServices } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import product from '../../../../../platform/product/common/product.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { RemoteAuthorityResolverService } from '../../../../../platform/remote/browser/remoteAuthorityResolverService.js';
import { IRemoteAuthorityResolverService, ResolverResult } from '../../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IRemoteExtensionsScannerService } from '../../../../../platform/remote/common/remoteExtensionsScanner.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IUserDataProfilesService, UserDataProfilesService } from '../../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkspaceContextService, toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustEnablementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IWorkbenchEnvironmentService } from '../../../environment/common/environmentService.js';
import { IWebExtensionsScannerService, IWorkbenchExtensionEnablementService, IWorkbenchExtensionManagementService } from '../../../extensionManagement/common/extensionManagement.js';
import { AbstractExtensionService, IExtensionHostFactory, ResolvedExtensions } from '../../../extensions/common/abstractExtensionService.js';
import { ExtensionHostKind, ExtensionRunningPreference } from '../../../extensions/common/extensionHostKind.js';
import { IExtensionHostManager } from '../../../extensions/common/extensionHostManagers.js';
import { ExtensionManifestPropertiesService, IExtensionManifestPropertiesService } from '../../../extensions/common/extensionManifestPropertiesService.js';
import { ExtensionRunningLocation } from '../../../extensions/common/extensionRunningLocation.js';
import { ExtensionRunningLocationTracker } from '../../../extensions/common/extensionRunningLocationTracker.js';
import { ActivationKind, IExtensionHost, IExtensionService } from '../../../extensions/common/extensions.js';
import { ExtensionsProposedApi } from '../../../extensions/common/extensionsProposedApi.js';
import { ILifecycleService } from '../../../lifecycle/common/lifecycle.js';
import { IRemoteAgentService } from '../../../remote/common/remoteAgentService.js';
import { IUserDataProfileService } from '../../../userDataProfile/common/userDataProfile.js';
import { WorkspaceTrustEnablementService } from '../../../workspaces/common/workspaceTrust.js';
import { TestEnvironmentService, TestLifecycleService, TestRemoteAgentService, TestRemoteExtensionsScannerService, TestWebExtensionsScannerService, TestWorkbenchExtensionEnablementService, TestWorkbenchExtensionManagementService } from '../../../../test/browser/workbenchTestServices.js';
import { TestContextService, TestFileService, TestUserDataProfileService } from '../../../../test/common/workbenchTestServices.js';

suite('WorkspaceSession - Extension Host Isolation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// A minimal AbstractExtensionService that tracks extension host creation per
	// instance. Mirrors the pattern in extensions/test/browser/extensionService.test.ts,
	// but each instance is created from a scoped child instantiation service bound to
	// its own workspace context - this is exactly how a workspace session wires its
	// extension host in WorkspaceSessionService.createSession.
	class MySessionExtensionService extends AbstractExtensionService {

		private _extHostId = 0;
		public readonly order: string[] = [];
		public remoteExtHostIsReady = true;
		public localExtHostIsReady = true;

		/**
		 * The async initialization kicked off in the constructor. Tests must
		 * await this before disposing the session, otherwise resources created
		 * after the last await point (locks, extension description registries,
		 * extension host managers) are tracked after the leak check runs.
		 */
		public readonly initializePromise: Promise<void> | null;

		constructor(
			@IInstantiationService instantiationService: IInstantiationService,
			@INotificationService notificationService: INotificationService,
			@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
			@ITelemetryService telemetryService: ITelemetryService,
			@IWorkbenchExtensionEnablementService extensionEnablementService: IWorkbenchExtensionEnablementService,
			@IFileService fileService: IFileService,
			@IProductService productService: IProductService,
			@IWorkbenchExtensionManagementService extensionManagementService: IWorkbenchExtensionManagementService,
			@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
			@IConfigurationService configurationService: IConfigurationService,
			@IExtensionManifestPropertiesService extensionManifestPropertiesService: IExtensionManifestPropertiesService,
			@ILogService logService: ILogService,
			@IRemoteAgentService remoteAgentService: IRemoteAgentService,
			@IRemoteExtensionsScannerService remoteExtensionsScannerService: IRemoteExtensionsScannerService,
			@ILifecycleService lifecycleService: ILifecycleService,
			@IRemoteAuthorityResolverService remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		) {
			const extensionsProposedApi = instantiationService.createInstance(ExtensionsProposedApi);
			const extensionHostFactory = new class implements IExtensionHostFactory {
				createExtensionHost(runningLocations: ExtensionRunningLocationTracker, runningLocation: ExtensionRunningLocation, isInitialStart: boolean): IExtensionHost | null {
					return new class extends mock<IExtensionHost>() {
						override runningLocation = runningLocation;
					};
				}
			};
			super(
				{ allowRemoteExtensionsInLocalWebWorker: false, hasLocalProcess: true },
				extensionsProposedApi,
				extensionHostFactory,
				null!,
				instantiationService,
				notificationService,
				environmentService,
				telemetryService,
				extensionEnablementService,
				fileService,
				productService,
				extensionManagementService,
				contextService,
				configurationService,
				extensionManifestPropertiesService,
				logService,
				remoteAgentService,
				remoteExtensionsScannerService,
				lifecycleService,
				remoteAuthorityResolverService,
				new TestDialogService()
			);

			this.initializePromise = this._initializeIfNeeded();
		}

		get workspaceId(): string {
			return this.contextService.getWorkspace().id;
		}

		protected _pickExtensionHostKind(extensionId: ExtensionIdentifier, extensionKinds: ExtensionKind[], isInstalledLocally: boolean, isInstalledRemotely: boolean, preference: ExtensionRunningPreference): ExtensionHostKind | null {
			throw new Error('Method not implemented.');
		}

		protected override _doCreateExtensionHostManager(extensionHost: IExtensionHost, initialActivationEvents: string[]): IExtensionHostManager {
			const order = this.order;
			const extService = this;
			const extensionHostId = ++this._extHostId;
			const extHostKind = extensionHost.runningLocation.kind;
			order.push(`create ${extensionHostId}`);
			return new class extends mock<IExtensionHostManager>() {
				override onDidExit = Event.None;
				override onDidChangeResponsiveState = Event.None;
				override kind = extHostKind;
				override get isReady() { return extHostKind === ExtensionHostKind.Remote ? extService.remoteExtHostIsReady : extService.localExtHostIsReady; }
				override disconnect() {
					return Promise.resolve();
				}
				override start(): Promise<void> {
					return Promise.resolve();
				}
				override dispose(): void {
					order.push(`dispose ${extensionHostId}`);
				}
				override representsRunningLocation(runningLocation: ExtensionRunningLocation): boolean {
					return extensionHost.runningLocation.equals(runningLocation);
				}
				override activateByEvent(event: string, activationKind: ActivationKind): Promise<void> {
					return Promise.resolve();
				}
				override ready(): Promise<void> {
					return Promise.resolve();
				}
			};
		}

		protected async *_resolveExtensions(): AsyncIterable<ResolvedExtensions> {
			// No extensions to resolve in tests
		}

		protected _scanSingleExtension(extension: IExtension): Promise<IExtensionDescription | null> {
			throw new Error('Method not implemented.');
		}

		protected _onExtensionHostExit(code: number): Promise<void> {
			throw new Error('Method not implemented.');
		}

		protected _resolveAuthority(remoteAuthority: string): Promise<ResolverResult> {
			throw new Error('Method not implemented.');
		}
	}

	let disposables: DisposableStore;
	let instantiationService: TestInstantiationService;

	setup(() => {
		disposables = new DisposableStore();
		const testProductService = { _serviceBrand: undefined, ...product };
		instantiationService = createServices(disposables, [
			// Window-level shared services. Workspace-scoped services
			// (IWorkspaceContextService, IConfigurationService, IExtensionService)
			// are provided per session via child service collections below.
			[ILifecycleService, TestLifecycleService],
			[IWorkbenchExtensionManagementService, TestWorkbenchExtensionManagementService],
			[INotificationService, TestNotificationService],
			[IRemoteAgentService, TestRemoteAgentService],
			[ILogService, NullLogService],
			[IWebExtensionsScannerService, TestWebExtensionsScannerService],
			[IExtensionManifestPropertiesService, ExtensionManifestPropertiesService],
			[IConfigurationService, TestConfigurationService],
			[IProductService, testProductService],
			[IFileService, TestFileService],
			[IWorkbenchExtensionEnablementService, TestWorkbenchExtensionEnablementService],
			[ITelemetryService, NullTelemetryService],
			[IEnvironmentService, TestEnvironmentService],
			[IWorkspaceTrustEnablementService, WorkspaceTrustEnablementService],
			[IUserDataProfilesService, UserDataProfilesService],
			[IUserDataProfileService, TestUserDataProfileService],
			[IUriIdentityService, UriIdentityService],
			[IRemoteExtensionsScannerService, TestRemoteExtensionsScannerService],
			[IRemoteAuthorityResolverService, new RemoteAuthorityResolverService(false, undefined, undefined, undefined, testProductService, new NullLogService())]
		]);
	});

	teardown(() => {
		disposables.dispose();
	});

	test('two sessions get independent extension hosts bound to their own workspace', async () => {
		// Session A: workspace 'ws-session-a'
		const servicesA = new ServiceCollection();
		servicesA.set(IWorkspaceContextService, new TestContextService(new Workspace('ws-session-a', [toWorkspaceFolder(URI.file('/path/a'))])));
		servicesA.set(IConfigurationService, new TestConfigurationService());
		servicesA.set(IExtensionService, new SyncDescriptor(MySessionExtensionService));
		const sessionA = instantiationService.createChild(servicesA);
		const extA = <MySessionExtensionService>sessionA.get(IExtensionService);

		// Session B: workspace 'ws-session-b'
		const servicesB = new ServiceCollection();
		servicesB.set(IWorkspaceContextService, new TestContextService(new Workspace('ws-session-b', [toWorkspaceFolder(URI.file('/path/b'))])));
		servicesB.set(IConfigurationService, new TestConfigurationService());
		servicesB.set(IExtensionService, new SyncDescriptor(MySessionExtensionService));
		const sessionB = instantiationService.createChild(servicesB);
		const extB = <MySessionExtensionService>sessionB.get(IExtensionService);

		// Distinct extension service instances per session
		assert.notStrictEqual(extA, extB);

		// Each session's extension service is bound to its own workspace context
		assert.strictEqual(extA.workspaceId, 'ws-session-a');
		assert.strictEqual(extB.workspaceId, 'ws-session-b');
		assert.notStrictEqual(extA.workspaceId, extB.workspaceId);

		// Let both sessions finish initializing (creating extension host managers,
		// extension description registries, ...) so nothing is created after
		// the leak check.
		await extA.initializePromise;
		await extB.initializePromise;

		// Both sessions created their own set of extension host managers
		assert.ok(extA.order.length > 0);
		assert.ok(extB.order.length > 0);

		// Disposing session A does not affect session B
		extA.dispose();
		assert.ok(extA.order.some(entry => entry.startsWith('dispose')));
		await extB.activateByEvent('onTest', ActivationKind.Immediate);
		assert.ok(extB.order.some(entry => entry.startsWith('create')));

		extB.dispose();
		sessionA.dispose();
		sessionB.dispose();

		// Dispose the parent instantiation service (and with it any lazily
		// created services) before the leak check runs in teardown.
		disposables.dispose();
	});
});
