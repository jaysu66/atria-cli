# Atria Desktop Skill

让 Agent 读取和操作真实 Windows 桌面，并调用录制与回放能力。它是 Record/Replay Windows 引擎的使用入口，不是单靠 Markdown 就能运行的桌面程序。执行协议见 [SKILL.md](SKILL.md)。

## 能做什么

- 列出和聚焦窗口，读取 UI Automation 控件树。
- 按控件索引或名称点击、设置字段值、输入文字和快捷键。
- 移动鼠标、拖拽、滚动、截图与批量执行确定的动作。
- 开始和停止工作流录制，生成语义化 Skill，dry-run 后回放。

输入是目标窗口、控件、待填内容或待演示的工作流；输出是当前 UI 状态、动作结果、截图、原始 JSON、录制会话和生成的 Skill 路径。

## 安装与依赖

需要 Windows、Node.js 18+、`packages/record-replay-windows`、该组件的 npm 依赖，以及 Rust/native 构建所需环境。预览包没有携带 `node_modules`、`actor.exe` 或 `recorder.exe`。

先审阅 [组件说明](../../packages/record-replay-windows/README.md) 与 [许可状态](../../LICENSE-STATUS.md)，在组件目录安装依赖并构建：

```powershell
cd packages\record-replay-windows
npm install
npm run build:native
npm run smoke:mcp
```

回到 Atria CLI 根目录后，配置实际 Agent 进程能继承的环境：

```powershell
$env:ATRIA_DESKTOP_SUITE_DIR = (Resolve-Path ".\packages\record-replay-windows").Path
node .\bin\atria.mjs doctor --json
node .\skills\atria-desktop\scripts\desktop.js --health
```

如需自动发现，将完整 Skill 目录放进 Agent 的 Skill 根目录；引擎仍需单独保留。辅助脚本首个调用会启动持久桌面 daemon，默认绑定 `127.0.0.1:47653`。配置细节见 [setup.md](references/setup.md)。

## 首次体验与例子

先打开不含隐私内容的测试应用，再对 Agent 说：

- “列出可见窗口，先不要点击。”
- “读取记事本窗口的控件，输入‘自动化测试’，不要保存或关闭窗口。”
- “我会演示一次导出测试文件的过程，请录制；回放前先展示计划。”

正常交互是先获取 `ui_snapshot`，核实目标和焦点，再操作并检查返回状态。`ui_set_value` 支持回读验证；普通 `computer_type` 不能单独证明目标字段已写入。

## 限制与安全

- 仅支持 Windows，不提供 macOS/Linux 桌面执行。
- 自绘界面可能没有 UIA 控件树，需截图辅助；截图坐标需要按返回缩放比例换算。
- UI 变化会让控件索引过期，不能把旧索引反复用于新页面。
- 输入发往当前焦点窗口；必须先确认窗口聚焦成功。
- 关闭未保存窗口、删除、发送、支付或提交都需要确认；这是用户真实电脑，动作立即可见。
- 截图、UI 文本和录制文件可能包含敏感信息，也可能进入 Agent 上下文和日志。
- 录制范围是整个桌面，开始前关闭私人应用并设置排除项。录制中不能停止 daemon。
- 生成的工作流会写入本地 Skill 根目录，默认通常为 `~/.codex/skills`；可通过 `CODEX_SKILLS_ROOT` 配置。先在隔离的测试目录体验。
- 回放先 `dryRun: true`；被脱敏的凭据需要用户自行输入，界面变化也可能要求 Agent 接手。

## 许可、来源与更新

这是 dsh 封装层的 Skill，依赖 Record/Replay Windows；两者的来源与再分发许可仍需确认，见 [LICENSE-STATUS.md](../../LICENSE-STATUS.md)。当前不宣称已具备正式开源授权或干净机器完整验收。

更新时同步 Skill 和引擎，保留用户录制与自行修改的 Skill。没有活动录制时才重启旧 daemon。完整录制流程见 [recording.md](references/recording.md)。
