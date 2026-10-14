/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAnyWorkspaceIdentifier, IWorkspaceContextService, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IPolicyService } from '../../../../platform/policy/common/policy.js';
import { IRemoteAgentService } from '../../remote/common/remoteAgentService.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';
import { WorkspaceService } from '../../configuration/browser/configurationService.js';
import { IWorkbenchConfigurationService } from '../../configuration/common/configuration.js';
import { ConfigurationCache } from '../../configuration/common/configurationCache.js';
import { BrowserStorageService } from '../../storage/browser/storageService.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { WorkspaceTrustEnablementService, WorkspaceTrustManagementService } from '../../workspaces/common/workspaceTrust.js';
import { IWorkspaceSession, IWorkspaceContext, WorkspaceSessionState } from '../common/workspaceSession.js';
import { IWorkspaceSessionService } from '../common/workspaceSessionService.js';
import { IExtensionService } from '../../extensions/common/extensions.js';

/**
 * Extension service scoped to a session. Both implementations
 * (ExtensionService and NativeExtensionService) extend Disposable, but the
 * IExtensionService interface does not declare dispose.
 */
export type SessionExtensionService = IExtensionService & IDisposable;

export abstract class WorkspaceSessionService extends Disposable implements IWorkspaceSessionService {

	declare readonly _serviceBrand: undefined;

	private static readonly EMPTY_SESSION_ID_PREFIX = 'empty';

	private readonly _onDidCreateSession = this._register(new Emitter<IWorkspaceSession>());
	readonly onDidCreateSession: Event<IWorkspaceSession> = this._onDidCreateSession.event;

	private readonly _onDidDisposeSession = this._register(new Emitter<IWorkspaceSession>());
	readonly onDidDisposeSession: Event<IWorkspaceSession> = this._onDidDisposeSession.event;

	private readonly _onDidChangeActiveSession = this._register(new Emitter<IWorkspaceSession | undefined>());
	readonly onDidChangeActiveSession: Event<IWorkspaceSession | undefined> = this._onDidChangeActiveSession.event;

	private readonly sessionsStore: IWorkspaceSession[] = [];
	private _activeSession: IWorkspaceSession | undefined;

	private sessionCount = 0;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IPolicyService private readonly policyService: IPolicyService,
		@ILogService private readonly logService: ILogService,
		@IRemoteAuthorityResolverService private readonly remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@IBrowserWorkbenchEnvironmentService private readonly environmentService: IBrowserWorkbenchEnvironmentService,
	) {
		super();
	}

	get sessions(): readonly IWorkspaceSession[] {
		return this.sessionsStore;
	}

	get activeSession(): IWorkspaceSession | undefined {
		return this._activeSession;
	}

	hasSession(sessionId: string): boolean {
		return this.sessionsStore.some(session => session.context.sessionId === sessionId);
	}

	getSession(sessionId: string): IWorkspaceSession | undefined {
		return this.sessionsStore.find(session => session.context.sessionId === sessionId);
	}

	getSessionByResource(resource: URI): IWorkspaceSession | undefined {
		return this.sessionsStore.find(session => session.context.rootUris.some(root => this.uriIdentityService.extUri.isEqualOrParent(root, resource)));
	}

	getSessionState(sessionId: string): WorkspaceSessionState | undefined {
		return this.getSession(sessionId)?.state;
	}

	setActiveSession(session: IWorkspaceSession | undefined): void {
		if (this._activeSession === session) {
			return;
		}

		this._activeSession = session;
		this._onDidChangeActiveSession.fire(session);
	}

	async createSession(workspace: IAnyWorkspaceIdentifier): Promise<IWorkspaceSession> {

		// Unique id within this window
		const sessionId = this.generateSessionId(workspace);

		// Child service collection: shared root services resolve from the
		// parent, workspace-scoped services are provided below.
		const services = new ServiceCollection();
		const scopedInstantiationService = this.instantiationService.createChild(services);

		// 1. Configuration / Workspace context service
		const configurationCache = new ConfigurationCache([Schemas.file, Schemas.vscodeUserData, Schemas.tmp], this.environmentService, this.fileService);
		const workspaceService = new WorkspaceService(
			{ remoteAuthority: this.environmentService.remoteAuthority, configurationCache },
			this.environmentService,
			this.userDataProfileService,
			this.userDataProfilesService,
			this.fileService,
			this.remoteAgentService,
			this.uriIdentityService,
			this.logService,
			this.policyService,
		);
		await workspaceService.initialize(workspace);
		services.set(IWorkspaceContextService, workspaceService);
		services.set(IWorkbenchConfigurationService, workspaceService);

		// 2. Storage service scoped to this workspace (IndexedDB per workspace id)
		const storageService = new BrowserStorageService(workspace, this.userDataProfileService, this.logService);
		await storageService.initialize();
		services.set(IStorageService, storageService);

		// 3. Workspace trust services
		const workspaceTrustEnablementService = new WorkspaceTrustEnablementService(workspaceService, this.environmentService);
		services.set(IWorkspaceTrustEnablementService, workspaceTrustEnablementService);

		const workspaceTrustManagementService = new WorkspaceTrustManagementService(
			workspaceService,
			this.remoteAuthorityResolverService,
			storageService,
			this.uriIdentityService,
			this.environmentService,
			workspaceService,
			workspaceTrustEnablementService,
			this.fileService,
		);
		services.set(IWorkspaceTrustManagementService, workspaceTrustManagementService);

		// 4. Extension service scoped to this session. Each session gets its own
		//    extension host instance, bound to this session's workspace context
		//    service and storage. Resolved from the child service collection, so
		//    the extension host sees this session's workspace in its init data.
		const extensionService = this.createExtensionService(scopedInstantiationService);
		services.set(IExtensionService, extensionService);

		// Build the session
		const context: IWorkspaceContext = {
			sessionId,
			workspace,
			rootUris: this.toRootUris(workspace),
		};

		const session = new WorkspaceSession(
			context,
			scopedInstantiationService,
			storageService,
			workspaceService,
			workspaceTrustManagementService,
			extensionService,
			this.logService,
		);

		this.sessionsStore.push(session);
		this._onDidCreateSession.fire(session);

		// If this is the first session, make it active
		if (!this._activeSession) {
			this.setActiveSession(session);
		}

		return session;
	}

	async closeSession(sessionId: string): Promise<void> {
		const index = this.sessionsStore.findIndex(session => session.context.sessionId === sessionId);
		if (index === -1) {
			return;
		}

		const session = this.sessionsStore[index];
		this.sessionsStore.splice(index, 1);

		if (this._activeSession === session) {
			this.setActiveSession(this.sessionsStore[Math.min(index, this.sessionsStore.length - 1)]);
		}

		this._onDidDisposeSession.fire(session);
		session.dispose();
	}

	private toRootUris(workspace: IAnyWorkspaceIdentifier): URI[] {
		if (isWorkspaceIdentifier(workspace)) {
			// Multi-root: root URIs live in the workspace file; for the
			// session context we track the config path itself as the
			// routing anchor.
			return [workspace.configPath];
		}

		if (isSingleFolderWorkspaceIdentifier(workspace)) {
			return [workspace.uri];
		}

		// Empty workspace
		return [];
	}

	/**
	 * Creates the extension service scoped to a new session. Implemented by
	 * platform-specific subclasses (browser vs. native) so that importing the
	 * base class never triggers the extension service module's registration
	 * side effects.
	 */
	protected abstract createExtensionService(scopedInstantiationService: IInstantiationService): SessionExtensionService;

	private generateSessionId(workspace: IAnyWorkspaceIdentifier): string {
		// Stable, readable session ids derived from the workspace identity
		// plus a running counter to guarantee uniqueness inside the window.
		this.sessionCount++;

		if (isWorkspaceIdentifier(workspace)) {
			return `ws-${workspace.id}-${this.sessionCount}`;
		}

		if (isSingleFolderWorkspaceIdentifier(workspace)) {
			return `folder-${workspace.id}-${this.sessionCount}`;
		}

		return `${WorkspaceSessionService.EMPTY_SESSION_ID_PREFIX}-${this.sessionCount}`;
	}
}

class WorkspaceSession extends Disposable implements IWorkspaceSession {

	private readonly disposables = this._register(new DisposableStore());
	private _state: WorkspaceSessionState = WorkspaceSessionState.Running;

	constructor(
		readonly context: IWorkspaceContext,
		readonly scopedInstantiationService: IInstantiationService,
		storageService: BrowserStorageService,
		workspaceService: WorkspaceService,
		workspaceTrustManagementService: WorkspaceTrustManagementService,
		extensionService: SessionExtensionService,
		logService: ILogService,
	) {
		super();

		// Close all workspace-scoped services on session dispose
		this.disposables.add(toDisposable(() => storageService.close()));
		this.disposables.add(workspaceService);
		this.disposables.add(workspaceTrustManagementService);
		this.disposables.add(extensionService);
		this.disposables.add(scopedInstantiationService);

		void logService.trace(`[workspaceSession] created session ${context.sessionId}`);
	}

	get state(): WorkspaceSessionState {
		return this._state;
	}

	get ready(): Promise<void> {
		return Promise.resolve();
	}

	override dispose(): void {
		this._state = WorkspaceSessionState.Closed;
		this.disposables.dispose();
		super.dispose();
	}
}
