# Spaces MVP: Validation Guide

This guide shows how to prove that Spaces keep every workspace session alive while you switch between them. It has three parts:

- **A.** A scripted check that needs no Claude and runs in about 2 minutes.
- **B.** Manual checks, including unsaved-changes prompts and the UI.
- **C.** The Claude extension check.

Architecture background is in `docs/spaces-architecture-notes.md`.

---

## 0. Setup

### Prerequisites (macOS)

- Node version from `.nvmrc`, currently `24.18.0` (`nvm install 24.18.0 && nvm use 24.18.0`)
- Xcode command line tools and Python 3, as required by native modules
- `git-lfs` is only needed for `extensions/copilot` test fixtures. Without it, add `*.sqlite -filter -diff -merge` to `.git/info/attributes` so `git status` and checkout work.

### Build

```bash
git switch feature/workspace-spaces-mvp
npm i
npm run compile-client      # full compile: client + built-in extensions (first time)
# incremental while developing:
npm run watch               # or: npm run transpile-client (fast, no typecheck)
```

### Launch the fork

```bash
./scripts/code.sh                      # normal dev launch (uses ~/.vscode-oss-dev)
```

If you launch from a terminal that runs inside an extension host, `ELECTRON_RUN_AS_NODE=1` may leak into the environment. In that case Electron starts as plain Node and fails with `The requested module 'electron' does not provide an export named 'Menu'`. Use `env -u ELECTRON_RUN_AS_NODE ./scripts/code.sh`.

### Enable Spaces

Add this to your user `settings.json`:

```jsonc
"workbench.experimental.spaces.enabled": true
```

The title bar then shows a `Space: …` dropdown, and the status bar shows a `Space: …` entry. Both open the Space picker. The commands live under the **Spaces** category in the Command Palette:

| Command | Id |
|---|---|
| Spaces: New Empty Space | `workbench.action.spaces.newEmptySpace` |
| Spaces: Open Folder as New Space... | `workbench.action.spaces.openFolderAsNewSpace` |
| Spaces: Open Workspace as New Space... | `workbench.action.spaces.openWorkspaceAsNewSpace` |
| Spaces: Add Current Window as Space | `workbench.action.spaces.addCurrentWindowAsSpace` |
| Spaces: Switch Space... | `workbench.action.spaces.switchSpace` (optional arg: Space id or name) |
| Spaces: Close Current Space | `workbench.action.spaces.closeCurrentSpace` |
| Spaces: Rename Current Space... | `workbench.action.spaces.renameCurrentSpace` (optional arg: name) |
| Spaces: List Spaces | `workbench.action.spaces.listSpaces` (manage view with rename and close buttons) |

`openFolderAsNewSpace` and `openWorkspaceAsNewSpace` also accept a URI or path argument, so you can bind them to keys with fixed paths:

```jsonc
// keybindings.json
{ "key": "ctrl+alt+1", "command": "workbench.action.spaces.switchSpace", "args": "project-b" }
```

---

## A. Scripted lifecycle validation (no Claude)

This uses a throwaway profile with two small git repositories and the **Spaces probe** extension (`test/spaces/spaces-probe`). Once per second, the probe writes `<probeDir>/<workspace>.json` containing:

- the extension host `pid`
- an `activationCount`, persisted in `workspaceState`, which increments whenever the extension host starts again for that workspace
- `ticks`, an in-memory counter that resets if the extension host restarts
- terminal PIDs, dirty editors, and git repositories as seen by that Space's git extension

Terminal 1 (launches the fork and blocks):

```bash
test/spaces/launch-validation.sh /tmp/vscode-spaces-validation
```

Terminal 2:

```bash
node test/spaces/validateSpaces.ts /tmp/vscode-spaces-validation/probe 9334 \
  /tmp/vscode-spaces-validation/projects/project-a \
  /tmp/vscode-spaces-validation/projects/project-b 30
```

The validator drives the fork through the probe's localhost control endpoint. That endpoint is enabled only when `SPACES_PROBE_CONTROL=1`, which the launch script sets. The validator reads window visibility from the main process over `--inspect=9334`. It performs these steps:

1. In Space A, it starts a terminal loop (`date +%s >> terminal-a.log` every second) and opens an unsaved untitled editor.
2. It runs `Spaces: Open Folder as New Space` for project-b, then starts a terminal loop and an unsaved editor there.
3. It leaves A in the background for 30 seconds, then switches back to A.
4. It opens a modal dialog in hidden Space A and checks that B shows the attention marker. It then re-opens A's folder from B, which switches to A and clears the marker, and finally closes B.

The launch script sets `window.dialogStyle: "custom"`. With native dialogs, macOS shows the hidden window for the dialog sheet, and Spaces then switch to it instead of showing a marker.

Expected output, recorded on 2026-09-14 on macOS with Electron 42.10.0 (fresh run directory):

```
PASS  separate extension hosts per Space
PASS  only Space B visible after creating it
PASS  Spaces share one frame
PASS  inactive Space extension host kept same PID
PASS  inactive Space extension not re-activated
PASS  inactive Space extension kept ticking               {"ticksDuringBackground":30,"expected":30}
PASS  inactive Space terminal process alive
PASS  inactive Space terminal output continuous           {"lines":30,"maxGap":1}
PASS  only Space A visible after switching back
PASS  Space A extension host unchanged after switch back
PASS  Space B extension host unchanged while inactive
PASS  Space B terminal process alive while inactive
PASS  unsaved editors scoped per Space                    {"project-a":["unsaved in A"],"project-b":["unsaved in B"]}
PASS  git repositories scoped per Space
PASS  picker initially selects the current Space
PASS  open picker updates correctly on Spaces change
PASS  auxiliary window of hidden Space is hidden
PASS  modal in hidden Space marks it as needing attention  {"titleBar":"Space: project-b, 1 Space needs attention"}
PASS  opening an existing Space folder switches to that Space
PASS  auxiliary window shown again with its Space
PASS  attention marker cleared when the Space becomes active
PASS  closing Space B stops its extension host and terminal
PASS  Space A shown and untouched after closing B
PASS  crash and Reopen keep the Space and its single visible frame
24/24 checks passed
```

Unit tests:

```bash
npm run test-node -- --run src/vs/platform/spaces/test/common/spacesModel.test.ts
./scripts/test.sh --run src/vs/platform/windows/test/electron-main/windowsFinder.test.ts
```

---

## B. Manual checks

Use your own repositories, or the ones created by `launch-validation.sh`.

> Status: B1–B6 were exercised through the scripted run and a manual dogfooding run with two real repositories (`docs/spaces-claude-validation-results.md`). The dogfooding run also covered closing one Space, the quit prompt for a hidden dirty Space (Cancel and Don't Save), and native fullscreen (unsupported). Still not run: B5.4 (close a hidden dirty Space from the picker) and maximized frames.

### B1. Create Space A and Space B

1. Launch the fork with Spaces enabled and any window open.
2. Run **Spaces: Open Folder as New Space...** and pick `/private/example/path/project-a`.
   - The window you ran the command from becomes a Space itself. It is listed in the picker and can be closed.
   - A new Space opens in the same frame (same position and size), and the previous window disappears.
3. Run the command again and pick `/private/example/path/project-b`.
4. Open the title bar dropdown `Space: project-b ▾`. All Spaces are listed, and the current one has a check mark.

### B2. Switch

- Pick `project-a` in the dropdown. The frame now shows that workspace, with its Explorer, editors and panel layout unchanged.
- <kbd>Cmd</kbd>+<kbd>`</kbd> cycles only visible windows. **Mission Control / App Exposé can still show the hidden Space windows**, because each Space is a real window. This is an architectural limitation of the MVP.
- **Window › Switch Window...** (`workbench.action.switchWindow`) lists every Space window. Picking one switches to that Space.

### B3. Terminal persistence

1. In Space A, open a terminal and run `while true; do date; sleep 1; done`.
2. Switch to Space B and wait at least 60 seconds. That is longer than the 60s pty reconnect grace, so a detach would show up.
3. Switch back to A. The loop is still printing, the timestamps have no gap, and the terminal still has the same process: `ps -p <pid>` from **Terminal: Show Terminal Info** or `echo $$`.

### B4. Extension host persistence

- **Developer: Show Running Extensions** in Space A shows the same extension host PID before and after switching.
- **Developer: Open Process Explorer** shows one `extension-host` per Space. All of them keep running while their Space is hidden.
- With the probe installed (`node test/spaces/installSpacesProbe.ts ~/.vscode-oss-dev/extensions`), the status bar item `probe pid … · act #N · Ns` keeps counting across switches, and `act #N` does not change.

### B5. Unsaved editors

1. Type into an untitled file in Space A without saving, and do the same in Space B.
2. Switch back and forth. Each Space shows only its own dirty editor, and the dirty dot in the title stays correct.
3. **Close with a prompt:** in Space B, run **Spaces: Close Current Space**. The "Do you want to save…" dialog appears. Press **Cancel**: B stays open and active. Run the command again and press **Don't Save**: B closes, and A appears in the same frame.
4. **Close a hidden Space from the picker:** open **Spaces: List Spaces** and click the **×** on an inactive Space that has unsaved changes. The Space is shown first, so its save prompt is visible.

### B6. Source Control and search scoping

- In Space A, the Source Control view shows only repository A's changes and branch.
- In Space B, it shows only B's. The status bar branch (`main*`) belongs to the visible Space.
- **Search** (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>) searches only the visible Space's folder.

### B7. Title bar and window behaviors

- **Rename:** `Spaces: Rename Current Space...` with `Frontend` changes the title bar to `Space: Frontend`. An empty name restores the folder name.
- **Red close button:** closes the visible Space (with the normal unsaved prompt), then shows the most recently used remaining Space.
- **Maximized frame:** switching keeps the target maximized.
- **Native fullscreen (macOS):** switching or creating is refused with *"Exit full screen before switching or creating Spaces."* This is a known MVP limitation.
- **Quit (<kbd>Cmd</kbd>+<kbd>Q</kbd>):** all Spaces close. With the default `files.hotExit: onExit`, no prompts appear. With hot exit off, a hidden Space with unsaved changes is revealed before its prompt.

---

## C. Claude extension validation

The step-by-step manual test, including exact prompts, pass and fail criteria, and limitations, is in `docs/spaces-claude-validation.md`. Record results with `docs/spaces-claude-validation-results-template.md`.

It has **not** been run yet, because it requires your Claude account inside the fork. The scripted checks in section A cover the same mechanism for any extension: extension host PID, activation count, timers and terminals.

---

## Known behaviors to keep in mind while validating

- **Inactive Spaces run at full speed.** On macOS with Electron 42, a hidden Space window's renderer is not background-throttled (measured: `requestAnimationFrame` about 120 Hz and 50 ms timers unthrottled while hidden, with `document.visibilityState` still `visible`). This is good for agent sessions. The cost is CPU and GPU whenever an inactive Space renders, for example a busy terminal.
- **Mission Control / App Exposé** can show the real windows of hidden Spaces.
- **Needs attention marker.** When a hidden Space shows a VS Code modal dialog (with custom dialog style) or requests window attention (dock bounce), the picker shows `<name> — needs attention`, and a bell dot appears in the title bar and status bar. Prompts rendered inside an extension's own webview panel are not detected.
- **Spaces are not restored on restart** (the MVP keeps them in memory). With `window.restoreWindows` enabled, every Space reopens as a separate window.
- **Dev builds only:** DevTools may open on a Space window if that window never finished loading within 10 seconds, which is the existing error fallback.
