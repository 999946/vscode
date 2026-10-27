# Changelog

本仓库的发布说明。每个版本对应一个 section，头部标注 tag 与发布日期（发版时更新）。
GitHub Release 的备注由发布 workflow 从本文件对应版本 section 自动提取（见 `.github/workflows/release-darwin.yml`）。

发布新版本前，**必须先在顶部添加对应版本的 section**，否则 workflow 会失败。

## [1.143.7] - 2026-10-27

### 修复
- 修复应用内自动更新链路的多处边界问题，避免"下载完成点击更新后无反应 / 手动重启不生效 / 残留下载物导致升级反复失败"：
  1. 修复 `.app.old` 备份残留导致的替换失败：此前一次中断的升级会留下非空 `.old` 目录，之后每次点击更新在替换 bundle 时都因 `ENOTEMPTY` 失败。现在替换前会先清理已有的 `.old` 备份。
  2. 修复替换失败后应用卡死：此前 bundle 替换抛错后进程既不退出也不重启，用户点击"更新"后停在假死状态。现在无论替换成功与否都会退出并重新打开存在的 bundle（恢复旧版或打开新版），不再让用户卡在 `Restarting`。
  3. 修复 staging 残留导致的连环失败：更新包暂存改用唯一 `.ParaCode.app.update-<时间戳>` 目录，避免残留的 `.update` 目录让后续升级无法进行。
  4. 递归删除改用 `/bin/rm -rf` 兜底，能处理打包 app 中带符号链接的 Electron framework 树（此前偶发 `ENOTEMPTY`/`EACCES`）。

---

## [1.143.6] - 2026-10-27

### 修复
- 修复新建/打开 Space 后 frame 窗口黑屏（无内容、无侧栏）：这是两个依赖注入装配错误所致——
  1. `WebContentsViewWorkbenchHost` 的构造参数缺失 `@inject` 装饰器，主进程 DI 把 `IProtocolMainService` 等 5 个依赖全解析成 `undefined`，host 加载直接崩溃（日志：`Cannot read properties of undefined (reading 'createIPCObjectUrl')`）。已补全装饰器。
  2. `SpacesSidebarHost` 注入了主进程不存在的 `ICommandService`（该服务是 workbench 层），侧栏创建失败（日志：`[createInstance] depends on UNKNOWN service commandService`）。已移除该依赖，"Configure Spaces Root" 改为经 `vscode:spaces:openSettings` 路由到活跃 Space 的 workbench renderer 执行。
- 由此，"New Empty Space / Open Folder as New Space / Create Space" 后 frame 应显示正常侧栏与工作区内容（此前仅收编了窗口数量，frame 内容仍黑）。

---

## [1.143.5] - 2026-10-25

### 修复
- 修复在 frame 内创建/打开 Space 时出现第二个原生窗口：此前 `createEmptySpace` / `openFolderAsSpace` / `openWorkspaceAsSpace` / `createSpace` 创建 Space 后不关闭原普通窗口，导致两个窗口并存。现统一为「收编当前窗口，只留一个 frame」——创建 Space 成功后走标准 close 流程关闭原窗口（未保存更改可取消收编）。
- 修复安装版 `out/vs/platform/spaces/**` 资源缺失导致新建 Space 页面黑屏、侧栏不显示：`build/next` 补打包 `spacesSidebar.html`、`spacesSidebarPreload.ts`，新增 `compileBrowserScriptFiles()` 编译 `spacesSidebar.ts` -> `spacesSidebar.js`。
- 修复侧栏新建/关闭 tab 失败：`spaces:newTab` / `spaces:closeTab` 非法 IPC 频道改为 `vscode:` 前缀（`vscode:spaces:newTab` / `vscode:spaces:closeTab`），主进程 `sendToSpace` 与渲染层监听同步。
- 修复 frame 内扩展宿主无法启动：`WindowUtilityProcess.start` 对 WebContentsView host 的 `windowId`（= `WebContentsView.webContents.id`，非 BrowserWindow id）回退 `workbenchHostRegistry` 解析。

---

## [1.143.4] - 2026-10-22

### 修复
- 修复应用内版本号显示错误：此前发布包内的 `product.version` 始终取 `package.json` 的旧版本号（`1.143.0`），导致即使安装的是新版，关于对话框/遥测/更新检查显示的仍是旧版本。现已将源码版本同步到发布 tag，并新增发布前校验：`package.json` 版本与 release tag 不一致时构建直接失败。

---

## [1.143.3] - 2026-10-22

### 新增
- Spaces 改为默认开启（`workbench.experimental.spaces.enabled` 默认值设为 `true`）。
- Spaces 列表为空时显示空状态引导：未配置 `spaces.root` 时提供「Configure Spaces Root…」按钮直达设置；已配置时提供「Create a Space」按钮。

### 修复
- 在线更新安装后自动重新打开应用：等待旧进程完全退出再启动新版本，避免 LaunchServices 把打开请求路由到正在退出的旧实例（之前更新完成后不会自动打开）。
- 发布产物文件名带版本号：`ParaCode-darwin-<版本>-<架构>.dmg`；GitHub Release 备注不再附带安装说明，仅保留对应版本的更新日志。

---

## [1.143.2] - 2026-10-20

### 修复
- 修复 Spaces 侧栏不显示：`spacesSidebar.html` 在上一版被格式化工具污染（所有 `-`、`=`、`>` 等符号两侧被插入空格，导致 CSS 失效、HTML 结构错乱），已完整还原。

## [1.143.1] - 2026-10-19

### 新增
- Spaces 侧栏完全对齐 Terax 交互：折叠/置顶/宽度调整、Space 列表展示逻辑与设置项一致。
- 每个 Space 的标签页（编辑器/终端）持久化存储与恢复，重启后可还原。

### 修复
- 修复发布构建失败：清理 tsgo 类型错误（移除已被 WebContentsView 方案取代的 legacy 多窗口 SpacesMainService、IPC 监听改用 toDisposable 等 12 处）。

---

## [1.143.0] - 2026-10-13

### 新增
- 实现 terax 风格自动更新：启动时检查 GitHub Releases，发现新版本自动下载，重启替换 `.app` 完成更新；支持菜单 **Help → Check for Updates...** 手动检查。

---

## [0.1.1] - 2026-10-15

### 新增
- 产品重命名为 **ParaCode**（去除 vscode 品牌化）。
- 侧边多 workspace 会话编辑器：同一窗口内并排编辑不同 workspace。
- 会话级命令分发（Stage 2b）与会话存储按 workspace 隔离（Stage 2c）。
- 独立扩展宿主隔离（每个 workspace 会话独立 ext-host）。

### 修复
- 容忍共享窗口服务中重复的 ext-host 注册。
- 补充 `MainThreadGitExtensionService` 测试缺失的 `ILogService` 参数。

---

## [0.1.0] - 2026-10-12

### 新增
- 首个 macOS 双架构（x64 + arm64）发布流水线：ad-hoc 签名 + DMG 打包 + 自动附加到 GitHub Release。
