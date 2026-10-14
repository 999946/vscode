/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ExtensionService } from '../../extensions/browser/extensionService.js';
import { IWorkspaceSessionService } from '../common/workspaceSessionService.js';
import { SessionExtensionService, WorkspaceSessionService } from './workspaceSessionService.js';

/**
 * Web implementation of the workspace session service. Sessions run an
 * in-browser (web worker) extension host, matching the regular browser
 * workbench. Placed in its own module so that importing it for the desktop
 * platform never pulls in the browser extension service's module side
 * effects (which register a browser extension service eagerly).
 */
export class BrowserWorkspaceSessionService extends WorkspaceSessionService {

	override createExtensionService(scopedInstantiationService: IInstantiationService): SessionExtensionService {
		return scopedInstantiationService.createInstance(ExtensionService);
	}
}

registerSingleton(IWorkspaceSessionService, BrowserWorkspaceSessionService, InstantiationType.Delayed);