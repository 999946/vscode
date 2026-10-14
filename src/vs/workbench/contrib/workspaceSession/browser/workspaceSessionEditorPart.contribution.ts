/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { toWorkspaceIdentifier, IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkspaceSessionService } from '../../../services/workspaceSession/common/workspaceSessionService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';

/**
 * Renders a dedicated editor part for every workspace session, side-by-side
 * with the main editor part. The first session is created from the current
 * workspace on startup; further sessions are created whenever the session
 * service is asked to create them.
 */
class WorkspaceSessionEditorPartContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IWorkspaceSessionService private readonly workspaceSessionService: IWorkspaceSessionService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Render a side-by-side editor part for every session that is created,
		// and dispose it again once the session is closed.
		this._register(this.workspaceSessionService.onDidCreateSession(session => {
			this.editorGroupsService.createSessionEditorPart(session);
		}));
		this._register(this.workspaceSessionService.onDidDisposeSession(session => {
			this.editorGroupsService.getSessionEditorPart(session.context.sessionId)?.dispose();
		}));

		// Create the first session from the current workspace so a side-by-side
		// editor part appears on startup. Failures are logged but never break
		// the main workbench.
		void this.createInitialSession();
	}

	private async createInitialSession(): Promise<void> {
		try {
			const workspace = toWorkspaceIdentifier(this.contextService.getWorkspace());
			await this.workspaceSessionService.createSession(workspace);
		} catch (error) {
			this.logService.error('[workspaceSession] failed to create the initial session', error);
		}
	}
}

registerWorkbenchContribution2('workspaceSession.editorPart', WorkspaceSessionEditorPartContribution, WorkbenchPhase.BlockStartup);