/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { NativeExtensionService } from '../../extensions/electron-browser/nativeExtensionService.js';
import { IWorkspaceSessionService } from '../common/workspaceSessionService.js';
import { SessionExtensionService, WorkspaceSessionService } from '../browser/workspaceSessionService.js';

/**
 * Desktop implementation of the workspace session service. Sessions run a
 * native extension host (like the main window) instead of a web worker
 * extension host.
 */
export class NativeWorkspaceSessionService extends WorkspaceSessionService {

	override createExtensionService(scopedInstantiationService: IInstantiationService): SessionExtensionService {
		return scopedInstantiationService.createInstance(NativeExtensionService);
	}
}

registerSingleton(IWorkspaceSessionService, NativeWorkspaceSessionService, InstantiationType.Delayed);
