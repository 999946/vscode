# Changelog

本仓库的发布说明。每个版本对应一个 section，头部标注 tag 与发布日期（发版时更新）。
GitHub Release 的备注由发布 workflow 从本文件对应版本 section 自动提取（见 `.github/workflows/release-darwin.yml`）。

发布新版本前，**必须先在顶部添加对应版本的 section**，否则 workflow 会失败。

## 安装说明

1. M 系列 Mac 选择 **Apple Silicon** dmg，Intel Mac 选择 **Intel** dmg。
2. 双击 dmg 把 `Code - OSS.app` 拖入 Applications。
3. ad-hoc 签名会被 Gatekeeper 拦截，在系统设置里允许一次即可：

   - 右键（或按住 Control 点）`Code - OSS.app` → **打开** → 在弹窗里点 **打开**；
     或
   - 打开 **系统设置 → 隐私与安全性**，看到「已阻止 Code - OSS」时点 **仍要打开**。

   之后即可正常启动，无需每次操作。

自动更新：
- 应用启动后会自动检查 GitHub Releases，发现新版本即自动下载，并在重启时替换 `.app` 完成更新，无需重新下载 dmg。
- 也可随时通过菜单 **Help → Check for Updates...** 手动检查；有新版时菜单会变为 **Restart to Update**（适用于已下载更新后）。

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
