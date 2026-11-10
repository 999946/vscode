# Changelog

本仓库的发布说明。每个版本对应一个 section，头部标注 tag 与发布日期（发版时更新）。
GitHub Release 的备注由发布 workflow 从本文件对应版本 section 自动提取（见 `.github/workflows/release-darwin.yml`）。

发布新版本前，**必须先在顶部添加对应版本的 section**，否则 workflow 会失败。

## [1.143.15] - 2026-11-10

### 新功能
- **Spaces root（对齐 Terax）**：新增 `spaces.root` 设置，root 文件夹下**第一层子文件夹**会各自成为一个 Space。
  - 启动时扫描 root 自动补齐 Space；root 设置变化时自动重新同步。
  - 侧栏新增「⚙ Set Spaces Root…」按钮，可直接选择 root 目录，选中后立即扫描。
  - 新建 Space 时会在 root 下创建对应文件夹；删除 root 下的 Space 会同时删除其文件夹。
  - 扫描规则（均有单测覆盖）：跳过普通文件、隐藏项（`.` 开头，如 `.git` / `.DS_Store`）、重复目录（按路径归一化 + 大小写不敏感比较）、以及会逃逸 root 的非法名称；Windows/POSIX 分隔符、末尾斜杠、UNC 路径、盘符根目录均正确处理。
- **Spaces 模式持久化**：切换到 Spaces 模式后，下次启动会**恢复 Spaces 模式**（共享 frame + 所有 Space + 上次的 active Space），而不是打开普通窗口。
  - 状态保存在用户数据目录的 `spaces-state.json`（原子写入），因为启动早期就需读取，而应用存储数据库此时尚未初始化。
  - 恢复时沿用原 Space id，使已持久化的 tab 状态（编辑器/终端）继续匹配。
  - 边缘场景（均有单测覆盖）：无状态文件、0 个 Space、active id 丢失、JSON 损坏、未知版本、重复 id/重复路径、文件夹已从磁盘删除、恢复失败时回退到普通窗口并清理残留 frame。

### 修复
- 修复**新建 2 个 Space 后左侧 Spaces 列表完全空白**（280px 黑条）的问题。根因有三处：
  1. 侧栏 CSS 的 collapsed 触发按钮规则写错：`body.collapsed.trigger` 应为 `body.collapsed .trigger`，且 `.trigger { display: none; }` 被放在 collapsed 规则**之后**，导致折叠状态下面板和触发按钮同时不可见 → 整条空白。已修正顺序与选择器。
  2. 鼠标移出侧栏会自动折叠，并把 `collapsed=true` 写入 `localStorage`；下次启动直接恢复为折叠 → 空白。现在折叠状态**不再持久化**（仅内存中的悬停状态），启动时还会清理旧版本留下的该键。
  3. 空 Space 列表分支提前 `return`，未调用 `renderChrome()`，导致折叠 class 状态未应用。已修复。
- 侧栏样式系统性修复：`.row.caret`、`.row.avatar`、`.tab.t-icon`、`.modal.actions` 等 20+ 处误写的复合选择器改为真正的后代选择器，Space 行/标签页/弹窗样式恢复正常。
- **错误现在一定可见**：侧栏新增内联错误横幅，RPC 失败、root 不可读/不是目录等情况会在侧栏直接显示标题与详情，而不是留下空白黑条；成功刷新后自动清除。

### 测试
- 新增 `spacesRoot` 单测 19 项（路径归一化、UNC/盘符、扫描规则、root 边界）。
- 新增 `spacesState` 单测 13 项（序列化往返、损坏/版本/无效条目/重复路径容错）。
- `spacesModel` 增补持久化 id 恢复测试。
- `SpacesViewService` 增补 6 项（持久化状态探测、模式恢复、空状态回退、root 扫描、已存在去重、root 不可读不抛错）；该文件共 23 项全部通过。

---

## [1.143.14] - 2026-11-08

### 修复
- 修复 Spaces 模式下「检查更新」（Check for Updates…）点击后完全没有反应、既不提示「当前已是最新版本」也不提示检查失败的问题。
  - 根因：Spaces 的每个工作台都运行在共享 frame 窗口的 `WebContentsView` 里，没有独立的 `BrowserWindow`。主进程的窗口查询（`getActiveWindowId()`、`getWindowCount()`、对话框父窗口解析）只认识 `CodeWindow`，于是：
    - `hadLastFocus()` 永远返回 false，工作台侧的主题化提示被静默丢弃；
    - 原生兜底弹窗要么被误判跳过，要么挂到用户根本没在看的另一个窗口上。
  - 修复：主进程新增 `workbenchFocus.ts`，统一按「活跃的 webContents」识别工作台（同时覆盖 `CodeWindow` 与 Spaces 视图），并据此：
    - `getActiveWindowId()` / `getActiveWindowPosition()` 返回真正聚焦的工作台 id；
    - `getWindowCount()` 统计所有工作台（Spaces 模式不再误报 0 个窗口）；
    - 对话框解析到 Spaces 所在的 frame 窗口，提示会出现在用户正看着的地方；
    - 无法确定焦点时回退到最近聚焦的工作台，而不是丢弃提示。
  - 新增 25 个单元测试覆盖：Spaces 视图工作台、`CodeWindow` id 与 webContents id 不一致、多 Space 共享一个 frame、无焦点回退、无工作台时不重复弹原生框等边缘场景。

---

## [1.143.13] - 2026-11-06

### 修复
- 加密可用性探测与加解密调用增加 5 秒超时兜底：即使异步 `safeStorage` 的 Promise 因 Keychain 永不响应而一直不完成，`isEncryptionAvailable()` 也会按「不可用」返回（密钥存储降级为内存），不再让 `SecretStorageService` 初始化无限期挂起。
- 超时的错误会写入主进程日志，便于定位 Keychain / SecurityAgent 问题。

---

## [1.143.12] - 2026-11-05

### 修复
- 修复 macOS Keychain 卡死导致整个应用冻结、新建 Space 后只剩黑屏且无法显示任何错误的问题。
  - 根因：macOS 上 `safeStorage` 全是同步调用，当 `securityd` / SecurityAgent 无响应时，启动阶段的加密可用性探测会永久阻塞主线程，窗口不再绘制、日志不再落盘，因此任何错误都没机会显示。
  - 改用本构建 Electron 提供的异步 `safeStorage` API（`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`），把 Keychain 访问移出主线程；不可用时自动回退到同步实现。加密可用性探测失败按「不可用」处理，不再让调用方永久等待。
- 修复新建 Space 时主进程或配置解析长时间阻塞导致旧窗口被关闭、界面只剩黑屏的问题。
  - 新 Space Host 创建成功并显示后才关闭调用窗口；创建失败会保留旧窗口。
  - Host 创建增加超时与落盘日志，超时或异常会在 Spaces 界面显示错误详情。
  - 延迟完成的 Host 会自动销毁，避免超时后遗留不可见渲染进程。

---

## [1.143.11] - 2026-11-05

### 修复
- 更新检查不再因 GitHub API 匿名限流（每出口 IP 每小时 60 次，NAT/共享网络常见 403）而失效。
  - 先用 GitHub API 查询最新发布版本；失败时自动回退到不受限流影响的 `releases.atom` 发布流，并直接按 tag 拼接出 DMG 资产的下载地址。
  - 显式的「检查更新」失败会弹出错误对话框提示网络或代理问题，自动检查失败保持静默，不再每小时无端干扰。
  - 更新下载/暂存失败仅在显式触发时弹出错误提示。

---

## [1.143.10] - 2026-11-05

### 修复
- Space 视图与左侧 Spaces 列表加载失败时不再是一片黑色，改为在对应区域内直接显示错误详情。
  - 新增共享的 `SpacesErrorPageFallback`，在出错的 `WebContents` 中渲染一张自包含的错误页（`data:` URL，不依赖 IPC 与 preload），因此即使渲染进程崩溃、preload 失败或启动脚本报错也能显示。
  - 错误页展示失败原因、Electron 错误码与日志目录，并提供「Reload Space」按钮。
  - 重试由主进程驱动：`will-navigate` 拦截错误页的 `paracode-retry:` 链接并重新加载原地址，`before-input-event` 将 ⌘R / Ctrl+R、F5、Enter 映射到同一路径。
- 左侧 sidebar 现在也会上报加载失败、渲染进程崩溃、preload 失败与渲染进程 console 错误，并支持就地重试，不再静默留白。
- 主区 Space 视图的错误兜底统一改用上述共享实现，并补充 `did-navigate` 时重置错误状态，避免一次失败后无法再次展示。

---

## [1.143.9] - 2026-11-05

### 修复
- 修复新建 Space 后窗口一片漆黑、主区与左侧列表都不显示的问题。根因是主进程对 `vscode-file://` 请求的白名单只认真正的 `BrowserWindow` 主框架，而 Space 的 workbench 与 sidebar 都运行在 `WebContentsView` 里，导致 `workbench.html` 与 `spacesSidebar.html` 的请求全部被取消（`ERR_BLOCKED_BY_CLIENT`）。
  - 现在会遍历每个真实窗口的 `contentView` 子视图树，识别其中的 `WebContentsView` 并放行其请求；子资源（图片、字体等）通过渲染进程 id 一并匹配。
  - 来自 Space 视图的 SVG 请求同样被视为安全来源，图标不再丢失。
- 修复启动超时提示层无法显示的问题：workbench 文档启用了 Trusted Types，原先用 `innerHTML` 注入会抛异常，现在改用 DOM API 构建。
- 启动超时判定从 20 秒放宽到 45 秒。开发模式冷启动（扩展宿主、Agent 宿主、远程调用叠加）常常超过 20 秒，会对健康启动的 Space 误报「启动过慢」。

---

## [1.143.8] - 2026-11-04

### 修复
- 修复 Space 加载失败时界面一片黑、没有任何提示的问题：此前 Space 的 workbench 渲染层加载失败、渲染进程崩溃、preload 脚本报错或启动期 JS 静默抛错时，用户只会看到一个黑色的空白视图。
  - 加载失败（`did-fail-load`，忽略主动中止的 `ERR_ABORTED`）：显示错误页，包含错误码、错误描述、加载地址和日志目录，并提供「Reload Space」重试链接。
  - 渲染进程崩溃（`render-process-gone`）：显示错误页，包含崩溃原因与退出码。
  - preload 脚本报错（`preload-error`）：显示错误页并自动打开 DevTools。
  - 启动超时（20 秒内未完成加载，最常见的黑屏场景）：**不破坏原页面**，在原页面上叠加提示层并自动打开 DevTools，同时显示渲染层最后一条 `console.error`；若随后加载完成，提示层会自动移除。
  - 以上错误同时写入主进程日志，便于排查。

---

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
