/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IAnyWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Pure data and routing context for a single workspace session.
 *
 * A workspace session represents one workspace that runs inside the
 * current window, side-by-side with other sessions. Each session owns a
 * dedicated set of services (configuration, storage, editor groups,
 * extension host, ...) and its own set of tabs / editor groups.
 */
export interface IWorkspaceContext {
	/**
	 * Unique id of the session within this window.
	 */
	readonly sessionId: string;

	/**
	 * The workspace identifier this session was created for.
	 */
	readonly workspace: IAnyWorkspaceIdentifier;

	/**
	 * Root URIs belonging to this workspace (derived from the workspace identifier).
	 */
	readonly rootUris: readonly URI[];
}

/**
 * Lifecycle states of a workspace session.
 */
export const enum WorkspaceSessionState {
	/** Session was created but not yet opened. */
	Idle = 'idle',
	/** Session is open and running. */
	Running = 'running',
	/** Session is closing down. */
	Closing = 'closing',
	/** Session closed. */
	Closed = 'closed'
}

/**
 * A workspace session: a workspace plus the set of services that are
 * scoped to it. The whole instance is created through a child
 * instantiation service so that shared root services (file service,
 * log service, theme, ...) resolve from the parent container while
 * workspace-scoped services are provided by the session itself.
 */
export interface IWorkspaceSession {

	/**
	 * The context (pure data) of this session.
	 */
	readonly context: IWorkspaceContext;

	/**
	 * Current state of this session.
	 */
	readonly state: WorkspaceSessionState;

	/**
	 * The instantiation service scoped to this session.
	 */
	readonly scopedInstantiationService: IInstantiationService;

	/**
	 * Promise that resolves once the session is fully initialized and
	 * can be used to open editors.
	 */
	readonly ready: Promise<void>;

	/**
	 * Dispose the session and all services owned by it.
	 */
	dispose(): void;
}
