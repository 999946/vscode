/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { IDialogMainService } from '../../dialogs/electron-main/dialogMainService.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import { IWorkbenchHostRegistry } from '../../window/electron-main/workbenchHostRegistry.js';
import { shouldShowNativeNoUpdateDialog } from '../../window/electron-main/workbenchFocus.js';
import { IUpdateService, StateType } from '../common/update.js';

/**
 * Shows a native "no updates available" dialog after an explicit update check, but only on macOS with no workbench
 * open at all (e.g. "Check for Updates" from the menu bar/dock with every window closed). Otherwise the workbench shows
 * its own themed dialog from the last focused window (see `UpdateContribution`).
 *
 * The check keys off live workbench hosts instead of `BrowserWindow`s because Spaces renders each workbench in a
 * `WebContentsView` attached to a shared frame: there may be no `CodeWindow` (window count 0) while the user is
 * actively looking at a workbench, in which case a native dialog would duplicate the themed one.
 */
export class NotAvailableUpdateDialog extends Disposable {

	constructor(
		updateService: IUpdateService,
		dialogMainService: IDialogMainService,
		windowsMainService: IWindowsMainService,
		workbenchHostRegistry: IWorkbenchHostRegistry,
	) {
		super();

		this._register(updateService.onStateChange(state => {
			if (state.type !== StateType.Idle || !state.notAvailable || state.error) {
				return;
			}

			const workbenchHostCount = workbenchHostRegistry.getHosts().length;
			if (!shouldShowNativeNoUpdateDialog({ isMacintosh, workbenchHostCount })) {
				return;
			}

			// Anchor the dialog to the last active window when there is one, so it is
			// presented as a sheet instead of a free-floating window.
			const window = windowsMainService.getFocusedWindow() ?? windowsMainService.getLastActiveWindow();

			dialogMainService.showMessageBox({
				type: 'info',
				message: localize('noUpdatesAvailable', "There are currently no updates available."),
			}, window?.win ?? undefined);
		}));
	}
}
