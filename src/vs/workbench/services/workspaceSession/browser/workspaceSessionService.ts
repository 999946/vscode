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
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IPolicyService } from '../../../../platform/policy/common/policy.js';
import { IRemoteAgentService } from '../../remote/common/remoteAgentService.js';
import { CommandService } from '../../commands/common/commandService.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';
import { WorkspaceService } from '../../configuration/browser/configurationService.js';
import { IWorkbenchConfigurationService } from '../../configuration/common/configuration.js';
import { ConfigurationCache } from '../../configuration/common/configurationCache.js';
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

/**
 * Storage service scoped to a session. Sessions need initialize() and
 * close() beyond the IStorageService interface (neither is declared
 * there): initialize() kicks off loading the underlying stores, close()
 * flushes and releases them on session disposal.
 */
export type SessionStorageService = IStorageService & { initialize(): Promise<void>; close(): void | Promise<void> };

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
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IFileService protected readonly fileService: IFileService,
		@IRemoteAgentService protected readonly remoteAgentService: IRemoteAgentService,
		@IUriIdentityService protected readonly uriIdentityService: IUriIdentityService,
		@IPolicyService protected readonly policyService: IPolicyService,
		@ILogService protected readonly logService: ILogService,
		@IRemoteAuthorityResolverService protected readonly remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@IUserDataProfileService protected readonly userDataProfileService: IUserDataProfileService,
		@IUserDataProfilesService protected readonly userDataProfilesService: IUserDataProfilesService,
		@IBrowserWorkbenchEnvironmentService protected readonly environmentService: IBrowserWorkbenchEnvironmentService,
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

		// 2. Storage service scoped to this workspace (per-workspace database)
		const storageService = this.createStorageService(workspace);
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

		// 5. Command service scoped to this session. Resolves handler
		//    dependencies through the session's services (workspace context,
		//    storage, extension host) so commands invoked from this session's UI
		//    operate on this workspace instead of the main one. Created after the
		//    extension service is registered so its injected `IExtensionService`
		//    resolves to this session's extension host.
		const commandService = scopedInstantiationService.createInstance(CommandService);
		services.set(ICommandService, commandService);

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
			commandService,
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
	 * Creates the storage service scoped to a new session. Sessions get their
	 * own storage instance addressed by the workspace id, so each workspace
	 * session keeps its state in its own database (native: per-workspace
	 * state.vscdb; browser: per-workspace IndexedDB). Implemented by
	 * platform-specific subclasses so that importing the base class never
	 * triggers platform storage module registration side effects.
	 */
	protected abstract createStorageService(workspace: IAnyWorkspaceIdentifier): SessionStorageService;

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
		storageService: SessionStorageService,
		workspaceService: WorkspaceService,
		workspaceTrustManagementService: WorkspaceTrustManagementService,
		extensionService: SessionExtensionService,
		commandService: CommandService,
		logService: ILogService,
	) {
		super();

		// Close all workspace-scoped services on session dispose
		this.disposables.add(toDisposable(() => storageService.close()));
		this.disposables.add(workspaceService);
		this.disposables.add(workspaceTrustManagementService);
		this.disposables.add(extensionService);
		this.disposables.add(commandService);
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
