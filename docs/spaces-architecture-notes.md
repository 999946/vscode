# Spaces: Architecture Notes

Status: MVP implemented and validated with the scripted lifecycle checks (24/24, see `docs/spaces-mvp-validation.md`), unit tests for `SpacesModel` and `SpacesMainService`, and manual dogfooding with two real Claude Code sessions (`docs/spaces-claude-validation-results.md`). These notes were written before implementation and updated with what was measured.
Branch: `feature/workspace-spaces-mvp`. Base: Code OSS `1.139.0` (`bdadf2eb338`).

All paths below are relative to `src/vs/`, and line numbers refer to the base commit.

A **Space** is a complete, independent VS Code window: its own workspace, extension host, terminals, SCM, layout, storage and lifecycle. Spaces are grouped behind one visible OS frame, and switching Spaces changes which window you see. Switching never unloads, reloads or re-opens a workspace.

---

## 1. Current window and workspace lifecycle

### 1.1 Process model (desktop)

| Process | Count | Created by | Bound to |
|---|---|---|---|
| Electron main | 1 | `code/electron-main/main.ts` → `app.ts` | app |
| Workbench renderer (`CodeWindow`) | 1 per window | `platform/windows/electron-main/windowImpl.ts:792` `new electron.BrowserWindow(options)` | its `BrowserWindow` |
| Extension host (utility process) | 1+ per window | `platform/extensions/electron-main/extensionHostStarter.ts:72` | the `BrowserWindow` of `responseWindowId` |
| Pty host (utility process) | 1 global | `platform/terminal/electron-main/electronPtyHostStarter.ts:50-82` | app; terminals grouped by **workspace id** |
| Shared process | 1 global | `code/electron-main/app.ts` | app |

Identity: `CodeWindow.id` is `BrowserWindow.id` (`windowImpl.ts:795`). The renderer receives it as `configuration.windowId` (`windowsMainService.ts:1671`) and uses it as its IPC context `window:${windowId}` (`platform/ipc/electron-browser/mainProcessService.ts:25`).

### 1.2 Window creation

1. `IWindowsMainService.open(IOpenConfiguration)` (`platform/windows/electron-main/windowsMainService.ts:335`) goes through `doOpen` (`:539`) to `openInBrowserWindow` (`:1510`).
2. `openInBrowserWindow` builds `INativeWindowConfiguration` (`:1527-1598`). Unless `forceNewWindow` is set, it reuses `lastActiveWindow` (`:1519-1524`).
3. For a new window it runs `instantiationService.createInstance(CodeWindow, { state, ... })` (`:1606`), adds the window to `this.windows` (`:1621`), fires `onDidOpenWindow`, and calls `lifecycleMainService.registerWindow` (`:1645`).
4. `doOpenInBrowserWindow` (`:1689`) registers backups and the profile, then calls `window.load(configuration)`.
5. `CodeWindow.load` (`windowImpl.ts:1242-1311`) publishes the configuration through an IPC object URL (`--vscode-window-config`, `:774`). The preload reads it (`base/parts/sandbox/electron-browser/preload.ts:40-65`). It then calls `loadURL(vs/code/electron-browser/workbench/workbench.html)` (`:1291`).
6. The renderer runs `code/electron-browser/workbench/workbench.ts`, imports `workbench/workbench.desktop.main.js`, and calls `DesktopMain.open()` (`workbench/electron-browser/desktop.main.ts:117`):
   - `initServices()` (`:174`) sets up IPC for this `windowId` (`:189`), the environment from the window config (`:197`), files, profiles, the workspace identifier (`:304`), `WorkspaceService` (`:370`) and storage (`:395`).
   - `new Workbench(...)` and `startup()` (`workbench/browser/workbench.ts:131-189`) start contributions, render the layout and restore editors.

Every singleton, `Registry` and `mainWindow` (`base/browser/window.ts:21`) is a module-level global, so there is exactly one of each per JS realm. **A second independent workbench needs a second renderer.** It cannot be a second `Workbench` object in the same page.

### 1.3 Window shutdown

- Close, quit, reload and load all go through `lifecycleMainService.unload(window, reason)` (`platform/lifecycle/electron-main/lifecycleMainService.ts:517-555`). It sends `vscode:onBeforeUnload` (`:603`), which is vetoable, and then `vscode:onWillUnload` (`:614`).
- In the renderer, `NativeLifecycleService` (`workbench/services/lifecycle/electron-browser/lifecycleService.ts:37,64`) fires `onBeforeShutdown` (vetoes such as dirty prompts and terminal confirm) and then `onWillShutdown` (joiners such as storage close and extension host stop).

## 2. Where "open folder in the current window" destroys the workspace

1. `workbench.action.files.openFolder` (`workbench/browser/actions/workspaceActions.ts:54-84`) calls `fileDialogService.pickFolderAndOpen`, which calls `nativeHostMainService.pickFolderAndOpen` (`platform/native/electron-main/nativeHostMainService.ts:607`). That calls `windowsMainService.open({ context: DIALOG, contextWindowId })`.
2. `shouldOpenNewWindow` (`windowsMainService.ts:1361-1376`) reads `window.openFoldersInNewWindow`, and `openInBrowserWindow` picks the current window (`:1520`).
3. **The teardown happens here:** `lifecycleMainService.unload(window, UnloadReason.LOAD)` (`windowsMainService.ts:1676-1681`), followed by `window.load(newConfig)`. That means a full page navigation (`windowImpl.ts:1291`), so the whole JS realm is destroyed.
4. Side effects of the `LOAD` reason:
   - Main kills the window's extension host: `WindowUtilityProcess` listens to `lifecycleMainService.onWillLoadWindow` for this `BrowserWindow` (`platform/utilityProcess/electron-main/utilityProcess.ts:500-514`), with a 6s grace (`platform/extensions/common/extensionHostStarter.ts:12`).
   - Terminals are disposed and their ptys killed (`workbench/contrib/terminal/browser/terminalService.ts:705-722`). Only `RELOAD` with persistent sessions detaches instead.
   - Storage is closed and switched to the new workspace id.

Project-manager extensions call exactly this path, which is why they kill the Claude session.

The in-window workspace transitions (`WorkspaceChangeExtHostRelauncher`, `workbench/contrib/relauncher/browser/relauncher.contribution.ts:269-307`, and `NativeWorkspaceEditingService.enterWorkspace`, `workbench/services/workspaces/electron-browser/workspaceEditingService.ts:178-210`) also restart extension hosts.

## 3. Where a new window gets independent state

A new `CodeWindow` gets all of the following:

- **A new renderer:** new JS realm, service collection, `Registry` and contributions.
- **Its own workspace identity:** a single folder uses the md5 of `fsPath` plus birthtime (`platform/workspaces/node/workspaces.ts:47-80`), and a multi-root workspace uses the md5 of the config path (`:24-32`).
- **Its own workspace storage:** `<userData>/User/workspaceStorage/<workspaceId>/state.vscdb` (`platform/storage/electron-main/storageMain.ts:413-482`). This holds layout state (`workbench/browser/layout.ts:2860-2909`, WORKSPACE-scoped keys), editor state (`editorpart.state`), view state and extension `workspaceState`.
- **Its own backups:** `backupMainService.registerWorkspaceBackup` / `registerFolderBackup` (`windowsMainService.ts:1695+`). Dirty editors are scoped per window.
- **Its own extension host(s):** started by `NativeExtensionService` (`workbench/services/extensions/electron-browser/nativeExtensionService.ts:137-140`) with `responseWindowId = windowId` (`localProcessExtensionHost.ts:248`).
- **Its own terminal backend connection:** `vscode:createPtyHostMessageChannel` is keyed by the sender `webContents` (`electronPtyHostStarter.ts:115-127`), and pty layout is keyed by workspace id (`workbench/contrib/terminal/electron-browser/localTerminalBackend.ts:313-368`).
- **Its own SCM/Git:** the git extension runs in that window's extension host.

## 4. Extension host lifecycle is bound to the BrowserWindow

- Renderer: `NativeLocalProcessExtensionHost.start()` (`workbench/services/extensions/electron-browser/localProcessExtensionHost.ts:208-449`) calls `IExtensionHostStarter.createExtensionHost()` and `start({ responseWindowId, ... })`.
- Main: `ExtensionHostStarter.start` (`platform/extensions/electron-main/extensionHostStarter.ts:105-127`) passes `windowLifecycleBound: true` into `WindowUtilityProcess.start` (`platform/utilityProcess/electron-main/utilityProcess.ts:476-514`), which:
  - resolves `windowsMainService.getWindowById(responseWindowId)` and refuses to start if the window is missing;
  - posts the MessagePort to `responseWindow.win.webContents` (`:495`), which assumes the window's single webContents;
  - kills the host on `onWillLoadWindow` for that `BrowserWindow` (reload or workspace change) and on the `BrowserWindow` `'closed'` event.
- Renderer shutdown joins `_doStopExtensionHosts()` (`workbench/services/extensions/common/abstractExtensionService.ts:210-235`).

**Nothing kills an extension host when its window is hidden, minimized, blurred or occluded.** Visibility is not part of the lifecycle. This is the key fact the MVP relies on.

## 5. Terminal lifecycle is bound to renderer shutdown

- There is one global pty host. A renderer disconnect detaches ptys, which keep running for a grace period (60s, or 6s short grace; `platform/terminal/common/terminal.ts:865-874`, `platform/terminal/node/ptyService.ts:800-841`).
- Renderer `TerminalService._onWillShutdown` (`workbench/contrib/terminal/browser/terminalService.ts:705-722`) detaches on `RELOAD` with `enablePersistentSessions`, and **kills otherwise** (`dispose(Shutdown)`).
- **Terminals only die when their renderer shuts down.** Hiding a window does not shut the renderer down, so terminal processes keep running. Output arriving while hidden goes into the xterm buffer as usual.

## 6. Options evaluated and MVP path chosen

### Option A: several workbench `WebContentsView`s inside one `BrowserWindow`

This is the target end state for rendering, but it is very invasive today. Main assumes one workbench webContents per `BrowserWindow`:

- `windowsMainService.getWindowByWebContents` uses `BrowserWindow.fromWebContents` and then `CodeWindow.matches` (`windowImpl.ts:1777`, `win.webContents.id === webContents.id`). An embedded view returns `undefined`, and callers include shell env resolution (`app.ts:661,682`) and the menubar (`menubar.ts:259,774`).
- `WindowUtilityProcess` posts extension host ports to `win.webContents` and binds its lifetime to the `BrowserWindow` (`utilityProcess.ts:476-514`).
- The lifecycle unload/veto handshake uses `CodeWindow.send` → `win.webContents.send` (`windowImpl.ts:1644-1652`, `lifecycleMainService.ts:421-461, 603, 614`).
- Focus, blur, title, represented filename, document-edited state, fullscreen, zoom, dialogs, touch bar and window state persistence are all `BrowserWindow`-level (`nativeHostMainService.ts:107-119, 475-480`, `windowsStateHandler.ts`).
- The integrated browser (`platform/browserView/electron-main/browserView.ts:158-188`) already proves `WebContentsView` children work in a `CodeWindow`, but those are guest pages, not workbenches.

Doing A means introducing a "workbench host" abstraction with its own id below `CodeWindow` and re-keying all of the above. That is not an MVP-sized change.

### Option B: a "tabbed window" model through macOS native tabs

`window.nativeTabs` (`workbench/electron-browser/desktop.contribution.ts:299-303`, `win.addTabbedWindow` in `windowImpl.ts:1236-1240`) already hosts independent `CodeWindow`s under one OS frame. It covers a lot of the need, but:

- it is macOS-only and needs a restart;
- it forces the native title bar and native fullscreen (`platform/window/common/window.ts:301-303, 361-362`);
- it offers a tab-bar UI rather than a Space picker;
- the OS owns tab state, so there is no API to query or switch programmatically beyond `sendActionToFirstResponder`.

This is a useful fallback to recommend today, but it is not the feature.

### Option C (chosen): Spaces backed by real `CodeWindow`s, one visible at a time

A **Space group** is a set of ordinary `CodeWindow`s that share one on-screen frame. Exactly one member (the active Space) is shown. The others are hidden with `BrowserWindow.hide()`, which neither closes nor unloads them. Switching copies the frame bounds and maximized state to the target, shows and focuses the target, and then hides the previous window.

Why this is the least invasive path that meets every acceptance criterion:

- **Isolation is inherited, not re-implemented.** Each Space is exactly a VS Code window, so extensions (including Claude), Git, terminals, debug, storage and backups behave as they do across OS windows today. There are no extension API changes.
- **No lifecycle path runs on switch.** `hide()` and `show()` never trigger `unload`, `onWillLoadWindow`, the `'closed'` event or renderer shutdown. From §4 and §5, extension hosts and terminals therefore stay alive.
- **The renderer-facing contract is independent of presentation.** Renderers only talk to `ISpacesService` (list, create, switch, close, rename). Moving to Option A later only replaces the main-process presentation strategy (hide/show `BrowserWindow`s becomes swapping `WebContentsView`s); commands, UI and model stay the same.

### Implementation layout

| Layer | File | Role |
|---|---|---|
| common | `platform/spaces/common/spaces.ts` | `ISpace`, `ISpacesSnapshot`, `ICommonSpacesService`, channel name, setting id |
| common | `platform/spaces/common/spacesModel.ts` | Pure state machine: add, remove, activate, rename, workspace update, MRU fallback. Unit tested. |
| electron-main | `platform/spaces/electron-main/spacesMainService.ts` | Owns the model. Opens Space windows via `IWindowsMainService.open({ forceNewWindow: true })`, hides and shows members, handles close, focus and show events. |
| electron-main | `platform/window/electron-main/window.ts`, `platform/windows/electron-main/windowImpl.ts` | New `ICodeWindow.onWillFocus` event. The dev "never showed" fallback skips windows that are ready. |
| test | `test/spaces/` | Probe extension, its installer, the launch script and the end-to-end validator |
| electron-main | `code/electron-main/app.ts` | Registers the service and exposes it with `ProxyChannel.fromService` on channel `spaces` |
| electron-browser | `workbench/services/spaces/electron-browser/spacesService.ts` | Renderer proxy with `context: windowId`, following the same pattern as `NativeHostService` |
| electron-browser | `workbench/contrib/spaces/electron-browser/spaces.contribution.ts` | Setting, commands, Space picker, status bar and title bar entry, dialog-reveal guard |
| desktop entry | `workbench/workbench.desktop.main.ts` | Imports the contribution |

Behaviour rules:

- **Adoption.** The first Spaces command run from a normal window adopts that window as a Space. Agents/sessions windows and extension development or test hosts are never adopted.
- **Create.** `openFolderAsSpace` / `openWorkspaceAsSpace` / `createEmptySpace` call `windowsMainService.open` with `forceNewWindow: true`, adopt the returned window and activate it. If the folder is already open in some window, VS Code returns that window, and it gets adopted (a folder is never opened twice).
- **Switch.** `activate(target)`:
  1. mark the target active;
  2. copy bounds, or maximize if the previous window was maximized;
  3. `target.win.show()` and `target.focus()`;
  4. `previous.win.hide()`.

  Hiding happens after showing, so the app never loses its last visible window mid-switch.
- **External activation.** If a hidden member is focused by any other route (the Switch Window picker, the Window menu, the Dock, a CLI `code <file>` into that window, or `vscode.openFolder` on a folder a Space already has open), the service treats it as a switch to that Space. See §10 for why this needed a `CodeWindow` hook.
- **Close.** `closeSpace(id)` first activates the Space, so any dirty-file prompt is visible, and then calls `win.close()`. The normal lifecycle applies, and a veto keeps it open. When a member closes by any route, it is removed from the group and the most recently active remaining Space is shown in the same frame.
- **In-Space folder change.** Using normal "Open Folder" inside a Space replaces that Space's workspace, the same way it does in a window today. The Space keeps its id and updates its name (unless renamed) on `onWillLoad`.
- **Dialogs in hidden Spaces during shutdown.** While a hidden Space is in a shutdown veto phase (for example a quit prompting for unsaved files), the renderer asks main to reveal it before a dialog is shown, so prompts are never invisible.
- **Native fullscreen.** Hiding a macOS native-fullscreen window leaves an empty desktop Space behind, so the MVP refuses to switch while the active Space is in native fullscreen and shows a message instead.

Feature flag: `workbench.experimental.spaces.enabled` (default `false`). The commands, status bar and title bar entries only appear when it is `true`. The main-process service is inert until a renderer calls it.

## 7. Risks

| Risk | Impact | Mitigation / status |
|---|---|---|
| CPU/GPU of inactive Spaces | **Measured:** on macOS with Electron 42.10.0, a window hidden with `BrowserWindow.hide()` is **not** background-throttled. While hidden, `document.visibilityState` stays `visible`, `requestAnimationFrame` runs at about 120 Hz, and 50 ms intervals fire on time. This holds with and without a DevTools session. Extension hosts and ptys are separate processes and are never throttled. | Good for the requirement: agent sessions and their webview UIs keep running exactly as if visible. The cost is renderer work whenever an inactive Space renders, for example terminal output or progress animations. Follow-up: an opt-in "suspend rendering of inactive Spaces" option. Electron exposes no `WasHidden` for on-screen `webContents`, so that option would need a Chromium or Electron patch, or a renderer-side signal. |
| Memory: each Space costs a full window (renderer about 250–500 MB plus an extension host) | Same as N windows today | Documented. There is no additional overhead versus separate windows. |
| Quit/restart: `window.restoreWindows` reopens every Space window as a separate visible window | Spaces grouping is lost on restart (the MVP is in-memory) | Documented. Next step is to persist the group (workspace URIs, names, active Space) in `IStateMainService` and re-adopt restored windows. |
| Prompts in a hidden Space are not visible | The extension waits until the user switches to that Space | Partly mitigated by the "needs attention" marker (§9, finding 6). It covers VS Code modal dialogs (custom style) and window attention requests. Prompts drawn inside an extension webview, such as Claude's in-panel approvals, are not detectable. |
| Native fullscreen switching is refused | Minor UX gap | Documented. Use maximized or `window.nativeFullScreen: false`. |
| Auxiliary windows (editors moved into a new window) are independent Electron windows, not child windows | Without handling, they would stay visible while their Space is hidden | Handled: `SpacesMainService` hides and restores them together with their Space, matched by `parentId` |
| Renderer crash followed by "Reopen" | `CodeWindow.destroyWindow` opens a replacement window and then closes the crashed one. Without handling, the Space was dropped, the next Space was revealed and two windows were visible (reproduced) | Handled: the replacement window takes over the Space (`SpacesMainService.onDidOpenWindow`, unit tested and checked by the validator) |
| Quit vetoed without a dialog in a hidden Space | In theory the app could be left with only hidden windows | Not reproduced: the dirty-editor quit flow reveals the hidden Space, and Cancel leaves it visible (dogfooded). No deterministic case without a dialog is known, so there is no change |
| Mission Control / App Exposé | Can show hidden Space windows | Architectural limitation of real windows |
| Hidden windows still appear in the Switch Window picker and the macOS Window menu | Selecting one switches Space, which is acceptable | Handled by the `CodeWindow.onWillFocus` interception (see §10) |
| Dev-only: the 10s "window never showed" fallback (`windowImpl.ts`) showed a Space that was hidden less than 10s after load and opened DevTools (reproduced) | Two visible Space windows in dev builds | Fixed: the fallback now skips windows that already signaled ready (§10) |
| Frame bounds on multi-display setups | The target moves to the frame's display | Bounds are copied verbatim |
| A Space closed by `workbench.action.closeWindow` or an extension | Handled like the user closing it | Removal and fallback activation run on `onDidClose` |
| Windows/Linux: `hide()` removes the taskbar entry of the hidden window | Desired | Presentation works cross-platform. Only the fullscreen guard is macOS-specific. |

## 8. Validation plan

Automated:

- Unit tests for `SpacesModel` (`platform/spaces/test/common/spacesModel.test.ts`): add is idempotent, activation exclusivity and MRU, removal of the active Space picks the MRU fallback, rename and reset to default name, workspace change updates non-custom names, and snapshots are immutable.
- Typecheck (`npm run typecheck-client`), eslint on changed files, and layer checks (`npm run valid-layers-check`).

Manual or scripted (see `docs/spaces-mvp-validation.md`):

1. Terminal persistence: a timestamp loop in Space A keeps running while Space B is active (the pty PID stays the same and the output has no gap).
2. Extension host persistence: the `spaces-probe` test extension records the extension host PID, activation count and a ticking counter per workspace. Switching Spaces must not change the PID or the activation count.
3. Unsaved editors stay scoped to their Space.
4. Explorer, Search and SCM show the active Space's repo.
5. Close Space: a dirty prompt appears and can be cancelled. Closing kills only that Space's extension host and terminals, and the next Space appears in the same frame.
6. Claude: two sessions in two Spaces both survive switching.

## 9. Implementation findings

Measured on macOS 26 with Electron 42.10.0 while implementing:

1. **Hiding does not touch the lifecycle.** Validated end to end:
   - the extension host PID and activation count stay the same across switches;
   - a 30s background run advances the tick counter 30 times;
   - the terminal `date` loop has at most a 2s gap and keeps the same PID;
   - dirty editors and git repositories stay scoped per Space.
2. **Closing a Space tears down only that Space.** Its extension host and pty exit, while the other Space keeps its PIDs.
3. **Programmatic `show()` or `focus()` on a hidden window emits no Electron events.** With the app in the background, `BrowserWindow` emitted no `show`, `hide`, `focus` or `blur` events for `win.show()`, `win.hide()` or `win.focus()`. `win.focus()` on a hidden window also does not show it. Listening to native events therefore misses Switch Window, CLI reuse and `vscode.openFolder` into an existing Space.
4. **Hidden windows are not throttled** (see Risks).
5. **Memory:** each Space costs the same as one window today. There is no extra overhead: it is exactly one renderer plus one extension host.
6. **Attention signals from hidden Spaces.** These were investigated for the needs-attention marker:
   - **`FocusMode.Notify`** (`CodeWindow.focus` → dock bounce / taskbar flash) is VS Code's existing "window wants attention" request. It is raised by built-in chat when a request needs input (`workbench/contrib/chat/browser/chatWindowNotifier.ts`), by long-running task completion (`workbench/contrib/tasks/browser/abstractTaskService.ts`) and by the Agents window. It is now surfaced through `ICodeWindow.onDidRequestAttention`.
   - **`IDialogService.onWillShowDialog`** (renderer) fires for every VS Code dialog, including extension `showWarningMessage({ modal: true })`. A hidden Space reports it with `ISpacesService.requestAttention()`, or reveals itself when the dialog is part of a shutdown.
   - **Native dialog style** (the macOS default): the dialog sheet makes macOS show the hidden window, which Spaces then treat as a switch. The Space is revealed automatically, so no marker is needed. This was measured.
   - **Notifications:** `INotificationService` has no public add event (only the concrete `NotificationsModel`), and notifications are noisy, so they were not used.
   - **Extension webviews** (e.g. Claude's in-panel approval UI) expose no signal to the workbench. They are not detectable without extension API changes.
   - **Electron:** there is no event for a hidden window "requesting attention" other than VS Code's own `flashFrame` / `dock.bounce` calls, which the Notify path covers.

   The marker is cleared when the Space becomes active. It lives in `SpacesModel` (`needsAttention`, unit tested) and is rendered in the picker, the title bar widget and the status bar entry.

## 10. Changes to existing code

All other code is new. These are the only edits to existing code paths:

| File | Change | Why |
|---|---|---|
| `platform/window/electron-main/window.ts` | `ICodeWindow.onWillFocus: Event<void>` and `ICodeWindow.onDidRequestAttention: Event<void>` (fires for `FocusMode.Notify`) | Lets Spaces reveal a hidden Space before any focus request (finding 3). Fires for `FocusMode.Transfer` and `Force`, but not `Notify`, so attention requests such as a dock bounce never steal the frame. |
| `platform/windows/electron-main/windowImpl.ts` | Emits `onWillFocus` and `onDidRequestAttention` in `BaseWindow.focus()`. The dev-only 10s "window never showed" fallback also requires `!isReady`. | The fallback was re-showing hidden Spaces and opening DevTools (reproduced). A window that signaled ready but is hidden was hidden on purpose. |
| `platform/windows/test/electron-main/windowsFinder.test.ts` | Mock gets `onWillFocus` and `onDidRequestAttention` | Interface change |
| `code/electron-main/app.ts` | Registers `ISpacesMainService` and the `spaces` channel | |
| `workbench/workbench.desktop.main.ts` | Imports the Spaces contribution | |
| `build/lib/i18n.resources.json` | Adds `vs/workbench/contrib/spaces` | Lint rule `code-translation-remind` |
| `eslint.config.js` | Adds a `code-import-patterns` target for `test/spaces/**` | Required by hygiene for new test files |

## 11. Next steps after the MVP (Option A migration outline)

1. Persist Space groups across restarts (`IStateMainService`, re-adopt restored windows by workspace URI, and start the non-active ones hidden).
2. Extend the needs-attention marker. Candidates: an opt-in extension API or a webview signal for in-panel prompts, filtered notifications with actions, and the terminal bell.
3. Introduce `IWorkbenchHost` in main (id, `webContents`, `send`, `load`, `focus`, `bounds`), with `CodeWindow` as the first implementation. Re-key `getWindowByWebContents`, `WindowUtilityProcess.start`, `lifecycleMainService.registerWindow` and nativeHost focus tracking on the host id instead of `BrowserWindow.id`.
4. Add `WebContentsViewWorkbenchHost`: a workbench renderer in a `WebContentsView` of a shared frame window. `SpacesMainService` then swaps views instead of hiding windows. Window-level concerns (title, traffic lights, fullscreen, menubar) move to the frame.
