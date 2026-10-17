/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileDialogService, IOpenDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { ISpacesService } from '../../../../../platform/spaces/common/spaces.js';
import { OpenFolderAsNewSpaceAction, OpenWorkspaceAsNewSpaceAction } from '../../electron-browser/spacesActions.js';

suite('Spaces actions', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function openLabelsOf(options: IOpenDialogOptions | undefined): string[] {
		const openLabel = options?.openLabel;
		if (typeof openLabel === 'string') {
			return [openLabel];
		}

		return openLabel ? [openLabel.withMnemonic, openLabel.withoutMnemonic] : [];
	}

	async function runAndCaptureDialog(action: OpenFolderAsNewSpaceAction | OpenWorkspaceAsNewSpaceAction): Promise<IOpenDialogOptions | undefined> {
		const instantiationService = store.add(new TestInstantiationService());
		let captured: IOpenDialogOptions | undefined;

		instantiationService.stub(IFileDialogService, {
			defaultFolderPath: async () => URI.file('/work'),
			defaultWorkspacePath: async () => URI.file('/work'),
			showOpenDialog: async (options: IOpenDialogOptions) => {
				captured = options;
				return undefined; // cancelled
			}
		});
		instantiationService.stub(ISpacesService, {});
		instantiationService.stub(INotificationService, new TestNotificationService());

		await instantiationService.invokeFunction(accessor => action.run(accessor));

		return captured;
	}

	test('folder dialog button label has no raw mnemonic markers', async () => {
		const labels = openLabelsOf(await runAndCaptureDialog(new OpenFolderAsNewSpaceAction()));

		assert.ok(labels.length > 0);
		for (const label of labels) {
			assert.ok(!label.includes('&&'), `unexpected '&&' in '${label}'`);
			assert.ok(label.replace(/[&_]/g, '').includes('Open as Space'), label);
		}
	});

	test('workspace dialog button label has no raw mnemonic markers', async () => {
		const labels = openLabelsOf(await runAndCaptureDialog(new OpenWorkspaceAsNewSpaceAction()));

		assert.ok(labels.length > 0);
		for (const label of labels) {
			assert.ok(!label.includes('&&'), `unexpected '&&' in '${label}'`);
		}
	});
});
