/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IPolicyService } from '../../../../platform/policy/common/policy.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IAnyWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';
import { NativeExtensionService } from '../../extensions/electron-browser/nativeExtensionService.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IRemoteAgentService } from '../../remote/common/remoteAgentService.js';
import { NativeWorkbenchStorageService } from '../../storage/electron-browser/storageService.js';
import { IWorkspaceSessionService } from '../common/workspaceSessionService.js';
import { SessionExtensionService, SessionStorageService, WorkspaceSessionService } from '../browser/workspaceSessionService.js';

/**
 * Desktop implementation of the workspace session service. Sessions run a
 * native extension host (like the main window) instead of a web worker
 * extension host, and store workspace state in the main process's on-disk
 * storage (per-workspace state.vscdb) instead of IndexedDB.
 */
export class NativeWorkspaceSessionService extends WorkspaceSessionService {

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IFileService fileService: IFileService,
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@IPolicyService policyService: IPolicyService,
		@ILogService logService: ILogService,
		@IRemoteAuthorityResolverService remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@IUserDataProfileService userDataProfileService: IUserDataProfileService,
		@IUserDataProfilesService userDataProfilesService: IUserDataProfilesService,
		@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
	) {
		super(
			instantiationService, fileService, remoteAgentService, uriIdentityService,
			policyService, logService, remoteAuthorityResolverService, userDataProfileService,
			userDataProfilesService, environmentService,
		);
	}

	override createExtensionService(scopedInstantiationService: IInstantiationService): SessionExtensionService {
		return scopedInstantiationService.createInstance(NativeExtensionService);
	}

	override createStorageService(workspace: IAnyWorkspaceIdentifier): SessionStorageService {
		return new NativeWorkbenchStorageService(
			workspace,
			this.userDataProfileService,
			this.userDataProfilesService,
			this.mainProcessService,
			this.environmentService,
		);
	}
}

registerSingleton(IWorkspaceSessionService, NativeWorkspaceSessionService, InstantiationType.Delayed);
