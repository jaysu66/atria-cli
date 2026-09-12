# Atria CLI 能力说明

这份文档回答一个问题：**我应该把什么任务交给 Atria CLI？**

## 一句话理解

把“需要 Agent 真实操作浏览器或 Windows 软件”的重复工作，变成可观察、可验证、可复用的本地能力。

## 选择哪项能力

| 你的任务 | 使用 | 结果 |
|---|---|---|
| 已登录网页中查找、填写、提交或抓取 | `atria-browser-bridge` | 页面状态、结构化数据、截图或网络详情 |
| Excel、ERP、桌面客户端中的点击和输入 | `atria-desktop` | Windows 控件操作结果和截图 |
| “我做一遍，以后照做” | `atria-recording` | 选择录制引擎并生成可复用 Skill |
| 录制、生成、dry-run、回放已有工作流 | `record-replay-windows` | 事件流、执行计划和回放结果 |

## 能力边界

Atria CLI 能做的是“在本地执行你明确授权的动作”。它不能做的是：

- 自动获得你没有授权的账号或页面访问权
- 绕过 CAPTCHA、登录保护或访问控制
- 替用户决定付款、删除、发送或提交等高影响动作
- 保证第三方网站、桌面软件或模型永远不出错
- 替你保存或托管 Cookie、密码和 API key

## 典型任务示例

### 浏览器：整理后台列表

```text
打开已授权的后台标签页 → 读取表格 → 翻页 → 提取订单编号和状态 → 输出 JSON
```

先启动：

```powershell
node .\bin\atria.mjs browser --standalone
```

Agent 应先调用 `browser_status`、`read_page`，确认页面和账号正确，再执行翻页或导出。

### 桌面：重复填写本地软件

```text
聚焦订单窗口 → 读取 UI snapshot → 填写客户编号 → 回读输入值 → 等待保存完成
```

启动前必须完成 Record/Replay 的本地依赖和 native 构建：

```powershell
node .\bin\atria.mjs doctor --json
node .\bin\atria.mjs desktop
```

### 录制：把一次演示变成 Skill

```text
开始录制 → 用户演示 → 停止 → 生成语义化 Skill → dry-run → 用户确认 → 正式回放
```

生成的 Skill 应保存在 CLI 包外的用户 Skill 目录，升级 CLI 时不会被覆盖。

## Agent 如何使用

Agent 先读取对应目录中的 `SKILL.md`。Skill 文件告诉 Agent：

1. 什么时候使用该能力；
2. 启动哪个本地服务；
3. 参数如何通过 `@args.json` 传递；
4. 哪些动作需要回读验证或用户确认；
5. 失败时如何停止、保存证据并重试。

因此，CLI 命令是稳定入口，Skill 是行为协议，组件 MCP 服务才是实际执行者。三者分层后，新增 Skill 不需要复制一套新的浏览器或桌面引擎。

## 当前预览的现实体验

- 浏览器能力可以在安装扩展后直接验证。
- 桌面能力需要 Windows、Rust、Node 依赖和本地 native 构建。
- 当前没有自动安装器、自动更新器或在线 Skill 市场。
- 当前包是私有预览源代码，不代表所有组件已经完成公共发布许可审查。
