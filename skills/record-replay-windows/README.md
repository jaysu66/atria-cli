# Record & Replay Windows Skill

这是 Windows 录制引擎的操作 Skill：管理录制会话，把用户演示整理成语义化 Skill，再由 Agent 或回放工具执行。它比 [atria-recording](../atria-recording/README.md) 更贴近具体录制工具；后者先负责选择正确引擎。执行协议见 [SKILL.md](SKILL.md)。

## 能做什么

- 开始录制、查看状态、显示带计时和停止按钮的本地面板。
- 停止录制并保存事件流。
- 用用户语言为工作流命名，把原始事件整理成可理解的步骤。
- 草稿不足时补充语义说明，生成最终 Skill。
- 为后续执行保留执行计划、清洗后的事件证据与复用说明。

回放由同一 Windows 引擎提供的 `replay_run` 等工具完成，操作规范可参考 [Atria Desktop 录制说明](../atria-desktop/references/recording.md)。

## 输入与输出

输入是用户演示、工作流名称/摘要、会话 ID，以及回放范围。输出包括：

- `%LOCALAPPDATA%\Codex\EventStream\sessions\<sessionID>\` 中的本地会话文件和 `events.jsonl`。
- 安装到配置 Skill 根目录的 `record-replay-<workflow-slug>-<timestamp>` 目录。
- 用户可读的动作标题、技术 ID、语义步骤、执行计划和事件证据。

用户可读标题可以是中文，技术目录名使用 ASCII。停止录制并不总等于完成：若返回 `requiresCodexRefinement: true`，还需 Agent 复核并生成语义版。

## 安装与依赖

需要 Windows、Node.js 18+、MCP 客户端、Record/Replay Windows 的 npm 依赖和本机构建的 `actor.exe` / `recorder.exe`。只安装这个 Skill 不会安装执行引擎。

先看 [组件说明](../../packages/record-replay-windows/README.md) 与 [许可状态](../../LICENSE-STATUS.md)，在组件目录运行：

```powershell
npm install
npm run build:native
npm run smoke:mcp
```

再把 `node <Atria CLI 绝对路径>/bin/atria.mjs recording` 注册为所用客户端的 MCP 服务，或通过 [Atria Desktop](../atria-desktop/README.md) 辅助脚本访问。将完整 Skill 目录安装到 Agent 支持的 Skill 根目录。当前预览需要手工配置，不能把“文件存在”视为桌面权限和运行时已经验收。

## 首次体验

用无隐私数据的记事本或测试应用，明确输出目录后再开始：

1. 对 Agent 说：“录制我输入一段测试文字的操作，先告诉我何时开始和如何结束。”
2. 等待面板或 Agent 确认录制已开始，再演示。
3. 说“演示结束，请命名为‘填写测试备注’，并告诉我生成了哪些文件。”
4. 检查生成 Skill 的语义步骤；重新加载 Agent 后要求先 dry-run，再决定是否实际回放。

如果客户端不支持 MCP sampling，可由 Agent 给停止/生成工具明确传入工作流名称和摘要。面板通道不可用时，需 Agent 调用工具，不能宣称按钮必定可用。

## 限制与安全

- 仅支持 Windows；应用 UIA 支持、权限和界面变化会影响录制与回放可靠性。
- 记录可能覆盖整个桌面，关闭私人应用；不要把原始事件、截图和生成的私人 Skill 上传 Git。
- 默认会把生成 Skill 写入用户配置的 Skill 根目录，常见默认值为 `~/.codex/skills`，可用 `CODEX_SKILLS_ROOT` 指向测试目录。
- 生成最终语义 Skill 时，引擎会清理指向同一录制会话的早期草稿目录；不要把这些草稿当成长期备份。
- 先 dry-run；涉及发布、支付、删除、发送或权限变更时重新确认。凭据由用户自行输入。
- 语义步骤优先，原始坐标只是备用证据；不能保证任意应用或改版后的页面都能确定性回放。

## 许可、来源与更新

本 Skill 随 Record/Replay Windows 组件提供，当前组件仍是私有源码候选，没有最终再分发许可证，见 [LICENSE-STATUS.md](../../LICENSE-STATUS.md)。

随组件版本更新，更新前保留自己的录制和生成 Skill。包内 `packages/record-replay-windows/skills/record-replay-windows` 是同一 Skill 的自包含副本，不需要重复安装。
