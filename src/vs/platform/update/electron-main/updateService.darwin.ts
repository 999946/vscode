/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, spawnSync } from 'child_process';
import * as electron from 'electron';
import * as fs from 'fs';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { getErrorMessage } from '../../../base/common/errors.js';
import * as path from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { IFileService } from '../../files/common/files.js';
import { IRelaunchHandler, IRelaunchOptions, ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IMeteredConnectionService } from '../../meteredConnection/common/meteredConnection.js';
import { IProductService } from '../../product/common/productService.js';
import { asJson, IRequestService } from '../../request/common/request.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { AvailableForDownload, IUpdate, State, StateType, UpdateType } from '../common/update.js';
import { AbstractUpdateService, IUpdateURLOptions } from './abstractUpdateService.js';

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/999946/vscode/releases/latest';
const UPDATE_DMG_ASSET_PREFIX = 'ParaCode-darwin-';
/** Regex for a release DMG asset name: `ParaCode-darwin-<version>-<arch>.dmg` (version in the middle, since the arch is always the last segment before `.dmg`). */
const UPDATE_DMG_ASSET_REGEX = /^ParaCode-darwin-.*-([^.]+)\.dmg$/;
/** Sibling of the running app that holds the pre-swap bundle until the new version proves it can launch. */
const BACKUP_APP_SUFFIX = '.old';
/** How long a backup bundle must be left untouched before it is considered stale and removable. */
const STALE_BACKUP_THRESHOLD_MS = 60 * 1000;

interface IGitHubRelease {
	readonly tag_name: string;
	readonly assets: readonly { readonly name: string; readonly browser_download_url: string }[];
}

function parseVersion(version: string): number[] {
	return version.replace(/^release-v/, '').replace(/^v/, '').split('-')[0].split('.').map(part => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(remote: string, current: string): boolean {
	const remoteParts = parseVersion(remote);
	const currentParts = parseVersion(current);
	const length = Math.max(remoteParts.length, currentParts.length);
	for (let index = 0; index < length; index++) {
		if ((remoteParts[index] ?? 0) !== (currentParts[index] ?? 0)) {
			return (remoteParts[index] ?? 0) > (currentParts[index] ?? 0);
		}
	}
	return false;
}

/** Runs a command to completion, resolving with its stdout and rejecting on a non-zero exit. */
function runCommand(executable: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', data => { stdout += data.toString(); });
		child.stderr?.on('data', data => { stderr += data.toString(); });
		child.on('error', err => reject(err));
		child.on('exit', code => {
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(`${executable} exited with code ${code}: ${stderr.trim()}`));
			}
		});
	});
}

/**
 * Spawns a short-lived command fully detached from the current process so it
 * survives the parent's immediate exit (e.g. launching the replaced app while
 * this process is quitting).
 */
function spawnDetached(executable: string, args: string[]): void {
	const child = spawn(executable, args, { detached: true, stdio: 'ignore' });
	child.unref();
}

function removeRecursively(target: string): Promise<void> {
	return (async () => {
		try {
			await fs.promises.rm(target, { recursive: true, force: true });
			return;
		} catch (error) {
			// Fall through to the system rm for stubborn framework trees.
		}
		try {
			await runCommand('/bin/rm', ['-rf', target]);
		} catch (error) {
			// The caller decides how to handle cleanup failure.
		}
	})();
}

function removeSyncRecursively(target: string): void {
	try {
		// eslint-disable-next-line local/code-no-sync-fs -- This hook must finish before app.exit().
		fs.rmSync(target, { recursive: true, force: true });
		return;
	} catch (error) {
		// Fall through to the system rm.
	}
	try {
		const result = spawnSync('/bin/rm', ['-rf', target]);
		if (result.error) {
			throw result.error;
		}
	} catch (error) {
		// The caller decides how to handle cleanup failure.
	}
}

export class DarwinUpdateService extends AbstractUpdateService implements IRelaunchHandler {

	private downloadedAppPath: string | undefined;
	private downloadCancellation: CancellationTokenSource | undefined;

	constructor(
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@IConfigurationService configurationService: IConfigurationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IRequestService requestService: IRequestService,
		@ILogService logService: ILogService,
		@IProductService productService: IProductService,
		@IApplicationStorageMainService applicationStorageMainService: IApplicationStorageMainService,
		@IMeteredConnectionService meteredConnectionService: IMeteredConnectionService,
		@IFileService private readonly fileService: IFileService,
	) {
		super(lifecycleMainService, configurationService, environmentMainService, requestService, logService, productService, telemetryService, applicationStorageMainService, meteredConnectionService, true);
		lifecycleMainService.setRelaunchHandler(this);
	}

	protected override async initialize(): Promise<void> {
		await super.initialize();
		await this.cleanupStaleBackup();
	}

	handleRelaunch(options?: IRelaunchOptions): boolean {
		if (options?.addArgs || options?.removeArgs || this.state.type !== StateType.Ready) {
			return false;
		}
		this.doQuitAndInstall();
		return true;
	}

	protected override buildUpdateFeedUrl(_quality: string, _commit: string, _options?: IUpdateURLOptions): string | undefined {
		return GITHUB_RELEASES_URL;
	}

	protected override doCheckForUpdates(explicit: boolean): void {
		this.setState(State.CheckingForUpdates(explicit));
		void this.checkGitHubRelease(explicit);
	}

	private async checkGitHubRelease(explicit: boolean): Promise<void> {
		let release: IGitHubRelease | null = null;
		try {
			const context = await this.requestService.request({
				url: GITHUB_RELEASES_URL,
				headers: { Accept: 'application/vnd.github+json' },
				callSite: 'updateService.darwin.githubRelease'
			}, CancellationToken.None);
			release = await asJson<IGitHubRelease>(context);
		} catch (error) {
			this.logService.error('update#checkGitHubRelease - failed to check for updates', error);
			if (this.state.type === StateType.CheckingForUpdates) {
				// Surface the failure only on explicit checks; automatic checks stay quiet.
				this.setState(State.Idle(UpdateType.Archive, getErrorMessage(error)));
			}
			return;
		}

		const remoteVersion = release?.tag_name;
		const archName = process.arch === 'x64' ? 'x64' : 'arm64';
		const asset = release?.assets.find(candidate => candidate.name.startsWith(UPDATE_DMG_ASSET_PREFIX) && UPDATE_DMG_ASSET_REGEX.test(candidate.name) && candidate.name.endsWith(`-${archName}.dmg`));
		if (!remoteVersion || !asset || !isNewerVersion(remoteVersion, this.productService.version)) {
			this.setState(State.Idle(UpdateType.Archive, undefined, explicit || undefined));
			return;
		}

		const version = remoteVersion.replace(/^release-v/, '').replace(/^v/, '');
		const update: IUpdate = { version, productVersion: version, url: asset.browser_download_url };
		this.setState(State.AvailableForDownload(update, true));
		void this.downloadUpdate(explicit);
	}

	protected override doDownloadUpdate(state: AvailableForDownload): Promise<void> {
		return this.downloadAndStage(state.update, true);
	}

	private async downloadAndStage(update: IUpdate, explicit: boolean): Promise<void> {
		if (!update.url) {
			return;
		}
		this.downloadCancellation?.dispose();
		const cancellation = this.downloadCancellation = new CancellationTokenSource();
		const updateDirectory = await fs.promises.mkdtemp(path.join(this.environmentMainService.tmpDir.path, 'vscode-fork-update-'));
		const updateDmgPath = path.join(updateDirectory, 'update.dmg');
		try {
			this.setState(State.Downloading(update, explicit, false));
			const context = await this.requestService.request({ url: update.url, callSite: 'updateService.darwin.downloadUpdate' }, cancellation.token);
			await this.fileService.writeFile(URI.file(updateDmgPath), context.stream);
			this.downloadedAppPath = await this.stageAppFromDmg(updateDmgPath);
			this.setState(State.Downloaded(update, explicit, false));
			this.setState(State.Ready(update, explicit, false));
		} catch (error) {
			if (!cancellation.token.isCancellationRequested) {
				this.logService.error('update#downloadAndStage - failed to download or stage the update', error);
				this.setState(State.Idle(UpdateType.Archive, getErrorMessage(error)));
			}
		} finally {
			await fs.promises.rm(updateDirectory, { recursive: true, force: true });
			this.downloadCancellation = undefined;
			cancellation.dispose();
		}
	}

	/**
	 * Mounts the downloaded DMG read-only and copies the contained `.app` into
	 * the running application's installation folder under a unique `.update-*`
	 * sibling name. Staging on the same volume means the swap at restart is a
	 * plain rename — no root privileges, no Gatekeeper prompt (the file was
	 * fetched by the app itself, so it carries no quarantine attribute), and
	 * the running bundle is never mutated while in use. The unique suffix
	 * avoids collisions with stale staging directories left by interrupted
	 * updates.
	 */
	private async stageAppFromDmg(updateDmgPath: string): Promise<string> {
		const mountPoint = await this.attachDmg(updateDmgPath);
		if (!mountPoint) {
			throw new Error('Could not locate the mounted update volume');
		}
		try {
			const appName = `${this.productService.nameLong}.app`;
			const sourceApp = path.join(mountPoint, appName);
			const currentApp = this.getCurrentAppPath();
			// Use a unique sibling so a stale partial stage cannot block a later update.
			const stagedApp = path.join(path.dirname(currentApp), `.${appName}.update-${Date.now()}`);
			await removeRecursively(stagedApp);
			await runCommand('ditto', [sourceApp, stagedApp]);
			return stagedApp;
		} finally {
			await this.detachDmg(mountPoint);
		}
	}

	private async attachDmg(updateDmgPath: string): Promise<string | undefined> {
		const stdout = await runCommand('hdiutil', ['attach', '-nobrowse', '-readonly', updateDmgPath]);
		for (const line of stdout.split('\n')) {
			const match = /\t(\/Volumes\/.*)$/.exec(line);
			if (match) {
				return match[1];
			}
		}
		return undefined;
	}

	private async detachDmg(mountPoint: string): Promise<void> {
		try {
			await runCommand('hdiutil', ['detach', mountPoint]);
		} catch (error) {
			this.logService.warn('update#detachDmg - failed to detach the update volume', error);
		}
	}

	private getCurrentAppPath(): string {
		return path.resolve(process.execPath, '../../..');
	}

	protected override doQuitAndInstall(): void {
		if (!this.downloadedAppPath) {
			return;
		}
		const currentApp = this.getCurrentAppPath();
		const backupApp = `${currentApp}${BACKUP_APP_SUFFIX}`;
		const waitAndOpen = (appToOpen: string) => spawnDetached('/bin/sh', ['-c', `i=0; while kill -0 ${process.pid} 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; open ${JSON.stringify(appToOpen)}`]);
		try {
			// A stale non-empty backup makes renameSync fail with ENOTEMPTY.
			// eslint-disable-next-line local/code-no-sync-fs -- This hook must inspect the sibling before app.exit().
			if (fs.existsSync(backupApp)) {
				removeSyncRecursively(backupApp);
			}

			// Swap the running bundle for the staged one.
			// eslint-disable-next-line local/code-no-sync-fs -- This hook must complete the swap before app.exit().
			fs.renameSync(currentApp, backupApp);
			// eslint-disable-next-line local/code-no-sync-fs -- This hook must complete the swap before app.exit().
			fs.renameSync(this.downloadedAppPath, currentApp);

			// Launch only after this process has exited; otherwise LaunchServices
			// may route the request back to the old instance.
			waitAndOpen(currentApp);
			electron.app.exit(0);
		} catch (error) {
			this.logService.error('update#quitAndInstall - failed to replace the application bundle', error);
			try {
				// Restore the old bundle if the first rename succeeded but the
				// second rename failed.
				// eslint-disable-next-line local/code-no-sync-fs -- This hook must restore the bundle before app.exit().
				if (fs.existsSync(backupApp) && !fs.existsSync(currentApp)) {
					// eslint-disable-next-line local/code-no-sync-fs -- This hook must restore the bundle before app.exit().
					fs.renameSync(backupApp, currentApp);
				}
				// eslint-disable-next-line local/code-no-sync-fs -- This hook must inspect the staged bundle before app.exit().
				const stagedExists = fs.existsSync(this.downloadedAppPath) && !fs.existsSync(currentApp);
				if (stagedExists) {
					// eslint-disable-next-line local/code-no-sync-fs -- This hook must restore the bundle before app.exit().
					fs.renameSync(this.downloadedAppPath, currentApp);
				}
			} catch (restoreError) {
				this.logService.error('update#quitAndInstall - failed to restore the application bundle', restoreError);
			}

			// Always exit the stuck Restarting process and reopen whichever
			// bundle still exists, rather than leaving the user stranded.
			// eslint-disable-next-line local/code-no-sync-fs -- This hook must choose a recovery bundle before app.exit().
			const recoverApp = fs.existsSync(currentApp) ? currentApp : (fs.existsSync(backupApp) ? backupApp : undefined);
			if (recoverApp) {
				waitAndOpen(recoverApp);
			}
			electron.app.exit(0);
		}
	}
	/**
	 * Removes the previous version's bundle once the new app has been running
	 * long enough that a crash-loop is unlikely. Kept as the `.old` sibling in
	 * the meantime so a broken release can be rolled back by hand.
	 */
	private async cleanupStaleBackup(): Promise<void> {
		try {
			const backupApp = `${this.getCurrentAppPath()}${BACKUP_APP_SUFFIX}`;
			try {
				const stats = await fs.promises.stat(backupApp);
				if (Date.now() - stats.mtimeMs < STALE_BACKUP_THRESHOLD_MS) {
					return;
				}
			} catch (error) {
				const code = (error as { code?: string }).code;
				if (code !== 'ENOENT') {
					throw error;
				}
				return;
			}
			await removeRecursively(backupApp);
			this.logService.info('update#cleanupStaleBackup - removed the previous application version backup');
		} catch (error) {
			this.logService.warn('update#cleanupStaleBackup - failed to remove the previous application version backup', error);
		}
	}

	protected override async doIsLatestVersion(commit?: string, token: CancellationToken = CancellationToken.None): Promise<boolean | undefined> {
		try {
			const context = await this.requestService.request({ url: GITHUB_RELEASES_URL, headers: { Accept: 'application/vnd.github+json' }, callSite: 'updateService.darwin.isLatestVersion' }, token);
			const release = await asJson<IGitHubRelease>(context);
			return release?.tag_name ? !isNewerVersion(release.tag_name, commit ?? this.productService.version) : undefined;
		} catch (error) {
			this.logService.warn('update#doIsLatestVersion - failed to check GitHub releases', error);
			return undefined;
		}
	}

	protected override async cancelPendingUpdate(): Promise<void> {
		this.downloadCancellation?.cancel();
		this.downloadCancellation?.dispose();
		this.downloadCancellation = undefined;
		if (this.downloadedAppPath) {
			await removeRecursively(this.downloadedAppPath);
		}
		this.downloadedAppPath = undefined;
	}
}
