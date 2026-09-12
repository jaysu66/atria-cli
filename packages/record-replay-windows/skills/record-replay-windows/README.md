# Record & Replay Windows Skill（组件自包含版）

此目录是 Record/Replay Windows 自带的录制操作 Skill，与 Atria CLI 顶层同名 Skill 是同一能力。它让 Agent 使用组件的 MCP 工具管理录制、保存事件并生成语义化 Skill。执行协议见 [SKILL.md](SKILL.md)。

## 用途与输入输出

输入是用户演示的 Windows 操作、工作流名称/摘要和会话 ID。输出是本地录制会话、`events.jsonl`、用户可读的动作标题、语义步骤、执行计划和可复用 Skill。

它可以开始/查询/停止录制、显示本地面板、复核草稿并生成最终 Skill；回放由同一引擎的 `replay_run` 等工具完成。若还不确定是录桌面动作还是抓页面接口，先使用 Atria CLI 的 [录制路由 Skill](../../../../skills/atria-recording/README.md)。

## 安装与依赖

需要 Windows、Node.js 18+、MCP 客户端、组件 npm 依赖与 Rust/native 构建环境。预览不附带依赖目录和 `actor.exe` / `recorder.exe`。

审阅 [组件 README](../../README.md) 和许可状态后，在组件根目录执行：

```powershell
npm install
npm run build:native
npm run smoke:mcp
```

把 `node <组件绝对路径>/mcp/server.mjs` 注册为 MCP 服务，将完整 `skills/record-replay-windows` 目录放入 Agent 的 Skill 根目录。安装说明与工具发现因客户端而异；只复制 Skill 不会安装引擎。

## 首次体验

1. 打开没有隐私内容的测试应用，并关闭私人窗口。
2. 说：“录下我填写测试备注的过程；先告诉我何时开始、怎样结束。”
3. Agent 确认开始后再演示，明确说“结束”，给工作流一个动作名称。
4. 要求 Agent 检查草稿是否完成语义整理，报告生成目录和步骤。
5. 重新加载 Agent 后先 dry-run，确认计划再执行真实回放。

客户端不支持 MCP sampling 时，Agent 可传入明确的名称和摘要。若停止结果仍要求语义精炼，必须调用生成工具完成，不能把原始草稿当作最终可复用 Skill。

## 文件、副作用与安全

- 会话保存在 `%LOCALAPPDATA%\Codex\EventStream\sessions\<sessionID>\`。
- 生成 Skill 安装到配置的根目录，常见默认值为 `~/.codex/skills`；可用 `CODEX_SKILLS_ROOT` 设独立测试目录。
- 最终生成可能清理同一会话对应的早期草稿目录，不要把草稿当作唯一备份。
- 录制可能覆盖整个桌面；事件、截图和生成 Skill 可能包含业务与隐私内容，不要上传到 Git。
- UIA 不完整、应用权限或 UI 变化都可能影响可靠性；不能保证任意软件的操作都能自动回放。
- 使用语义步骤而不是盲用原始坐标；先 dry-run，敏感动作重新确认，凭据由用户输入。
- 面板依赖本地控制通道，客户端不兼容时需由 Agent 直接调用工具。录制期间不要杀掉服务器或 recorder。

## 许可与更新

当前组件没有最终再分发许可证，是私有源码候选。详见 [总体许可状态](../../../../LICENSE-STATUS.md)，不要宣称已经完成正式开源授权。

Skill 与引擎应使用相同组件版本；升级前保留自己的录制和 Skill。不要同时安装顶层与组件内的同名 Skill。更完整说明见 [顶层 Skill README](../../../../skills/record-replay-windows/README.md)。
