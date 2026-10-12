/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IAnyWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceSession, WorkspaceSessionState } from './workspaceSession.js';

export const IWorkspaceSessionService = createDecorator<IWorkspaceSessionService>('workspaceSessionService');

/**
 * Window-level service that manages multiple workspace sessions running
 * side-by-side inside the current window. Each session owns a dedicated
 * set of workspace-scoped services and its own editor groups / tabs.
 */
export interface IWorkspaceSessionService {

	readonly _serviceBrand: undefined;

	// --- events ---

	/**
	 * Fired when a session was created.
	 */
	readonly onDidCreateSession: Event<IWorkspaceSession>;

	/**
	 * Fired when a session was disposed.
	 */
	readonly onDidDisposeSession: Event<IWorkspaceSession>;

	/**
	 * Fired when the active (focused) session changed.
	 */
	readonly onDidChangeActiveSession: Event<IWorkspaceSession | undefined>;

	// --- query ---

	/**
	 * Whether there is a session with the given id.
	 */
	hasSession(sessionId: string): boolean;

	/**
	 * Get a session by id.
	 */
	getSession(sessionId: string): IWorkspaceSession | undefined;

	/**
	 * All sessions, in creation order.
	 */
	readonly sessions: readonly IWorkspaceSession[];

	/**
	 * The active (focused) session, if any.
	 */
	readonly activeSession: IWorkspaceSession | undefined;

	/**
	 * Find the session that owns the given resource, e.g. because the
	 * resource lives inside one of the session's workspace folders.
	 */
	getSessionByResource(resource: URI): IWorkspaceSession | undefined;

	// --- lifecycle ---

	/**
	 * Create and start a new session for the given workspace. Returns
	 * the created session (once it is ready to be used).
	 */
	createSession(workspace: IAnyWorkspaceIdentifier): Promise<IWorkspaceSession>;

	/**
	 * Close and dispose the given session. Throws if the session does
	 * not exist.
	 */
	closeSession(sessionId: string): Promise<void>;

	/**
	 * Set the active (focused) session. Pass `undefined` to clear.
	 */
	setActiveSession(session: IWorkspaceSession | undefined): void;

	/**
	 * The current state of a session (mostly useful for UI).
	 */
	getSessionState(sessionId: string): WorkspaceSessionState | undefined;
}
