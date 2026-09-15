# Atria CLI 用户指南

## 这是什么

Atria CLI 是一个本地优先的“能力入口”。它让 Agent 能够发现并启动三类执行引擎：浏览器、Windows 桌面，以及录制/回放。CLI 本身不替代这些引擎，而是提供稳定命令、能力清单和健康检查。

```text
Agent 读取 SKILL.md
       ↓
atria CLI 路由
       ↓
本地 MCP 服务
       ↓
Chrome 扩展 / Windows UI Automation / native recorder
       ↓
结构化结果、截图、事件文件或生成的 Skill
```

当前是 `0.2.0-private.3` 私有候选源代码包，尚未公开；不包含云端模型、登录状态、Cookie、公司数据或用户生成的 Skill。原生二进制候选与源码候选分开保管。

## 能力地图

### 浏览器：`atria-browser-bridge`

适合“操作我已经打开并授权的网页”。可读取页面结构和文本，点击、输入、滚动、上传、截图、保存 PDF，提取结构化数据，并按需捕获网络请求。

运行：

```powershell
node .\bin\atria.mjs browser --standalone
```

用户体验是可见的：Chrome 扩展会显示连接和操作状态，Agent 收到结构化结果，而不是只能看截图。Bridge 只操作你在扩展中明确暴露的标签页。

### 桌面：`atria-desktop`

适合 Excel、ERP、桌面客户端等浏览器之外的 Windows 应用。它优先通过 UI Automation 读取控件，再按控件执行点击和输入，支持窗口聚焦、键盘、拖拽、滚动和截图。

运行：

```powershell
node .\bin\atria.mjs desktop
```

首次运行必须先构建 `record-replay-windows` 的 native actor/recorder；预览包刻意没有分发 `.exe`。

可选择 `atria visual enable` 启动独立、点击穿透且不抢焦点的 Windows 动作提示；`atria visual enable --required` 会在提示层未就绪时阻止下一次写动作。`event_stream_panel` 是另一种宿主内录制 widget，只有支持 MCP resources 的宿主才显示。

### 录制与复用：`atria-recording` + `record-replay-windows`

当你说“我做一遍，以后照做”时，录制 Skill 会选择合适引擎：桌面/浏览器点击走事件流录制，API 数据走浏览器网络捕获。停止后生成语义化 Skill，再先 dry-run，最后在用户确认后正式回放。

录制建议：

1. 关闭不相关的聊天、邮箱和密码管理器。
2. 使用专门的低风险测试应用。
3. 不要在录制中输入真实密码、验证码、银行卡号或 API key。
4. 先 dry-run，确认窗口、控件和目标数据正确，再执行有副作用的动作。

## 从下载到第一次使用

1. 解压包并安装 Node.js 18+。
2. 执行 `node .\bin\atria.mjs doctor --json`，保存输出作为安装基线。
3. 执行 `node .\bin\atria.mjs skills list`，确认 5 个 Skill 可见（其中 `atria-cli-overview` 是能力说明与路由 Skill）。
4. 浏览器用户先加载 Chrome 扩展；桌面用户按组件 README 安装依赖并构建 native。
5. 让 Agent 读取对应 `SKILL.md`，再启动相应 MCP 服务。
6. 先执行读取类动作（`browser_status`、`read_page`、桌面 snapshot），确认目标正确后再写入、发送、删除或提交。

## 命令参考

```text
atria --version
atria doctor [--json]
atria skills list
atria browser [组件参数]
atria desktop [组件参数]
atria recording [组件参数]
atria mcp --capability browser|desktop|recording
atria visual status|enable [--required]|disable
atria automation status [operationId]|pause|resume|stop
```

CLI 参数会透传给对应组件；未知命令会返回退出码 2。`doctor --json` 中：

- `sourceReady`：包内源码、适配器和 Skill 是否齐全。
- `runtimeReady`：桌面依赖与 native 二进制是否已在本机就绪。
- `ok`：未选组件时表示源码包结构可用；使用 `--component` 时只表示所选组件就绪。不要用它替代真实浏览器/桌面验收。

## 安全与隐私

- 本地优先不等于绝对安全：Agent 仍可能看到页面文本、表单值和桌面内容。
- Browser Bridge 的会话导出能力默认关闭；不要在共享终端或日志中输出 Cookie。
- 不要把 `.env`、浏览器用户目录、事件流原件或真实凭据提交到仓库。
- 付款、删除、发送消息、提交订单、导出会话等高影响动作必须由用户确认。
- Atria 不绕过 CAPTCHA、登录保护或访问控制。

## 故障排查

### 服务无法启动

先运行 `doctor --json`，再确认 Node.js 版本、路径和对应组件文件。浏览器服务缺少标签页时，检查扩展是否加载以及目标页是否由用户点击扩展图标暴露。

### 桌面服务提示缺少依赖

这是预览包的正常提示。进入 `packages/record-replay-windows`，按其 README 安装依赖、构建 native，再重跑 `doctor`。不要把他人的 `node_modules` 或 `.exe` 直接复制进仓库。

### 回放失败或点击错目标

停止回放，保存事件和截图，重新获取 UI snapshot；检查窗口焦点、控件层级和目标数据是否变化。先修正生成的 Skill，再重新 dry-run。

## 更新和回滚（当前候选）

候选没有 `atria update`。更新时下载新 ZIP 或拉取受控 Git 分支，核对版本、来源提交和 SHA-256，执行 `npm test`、`npm run verify`、逐组件 `doctor`，确认后再替换 CLI、Skill、server 和对应二进制这一整套。把用户生成的 Skill、录制、配对令牌和配置放在包外；不要覆盖它们。升级失败时恢复上一份完整目录并回读版本/摘要即可回滚。

## 当前未提供的功能

- 一键安装器和自动更新
- 在线 Skill Registry 或云端同步
- 自动安装 Rust、Node 依赖和 Chrome 扩展
- 获得公开再分发许可的 Windows native 二进制
- 已完成许可清理的正式公共发行版

这些是后续发布工作，不应从当前预览的命令行为中推断已经实现。
