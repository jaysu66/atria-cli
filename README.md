# Atria CLI

一个本地优先的统一入口，把 Atria 的浏览器、Windows 桌面和工作流录制能力接给 Agent。

当前版本是 **`0.2.0-private.4` 私有候选包**：尚未公开，也不是一键安装器。它只包含首批三类能力：

- 浏览器控制：通过本地 Browser Bridge 和 Chrome 扩展操作用户主动暴露的 Chrome。
- Windows 桌面控制：通过 UI Automation 读取和操作原生 Windows 窗口。
- 录制与回放：把用户演示转换成可复用的语义化 Skill。

PPT、通用办公助手、公司业务流程、客户数据、登录状态、Cookie、`.env`、内部记忆和私有产品代码均不在包内。

## 先看哪份文档

- [面向最终用户的完整使用指南](docs/USER-GUIDE.md)：安装、体验、三类能力、故障排查和安全边界。
- [CLI 能力说明](docs/CLI-CAPABILITIES.md)：按任务选择 Skill，并了解 Agent 如何调用它们。
- [快速开始](docs/QUICKSTART.md)：按命令启动浏览器或检查桌面运行时。
- [组件许可状态](LICENSE-STATUS.md)：发布前必须逐项确认，不能把当前预览当作许可已清理完毕。
- [组件清单](manifests/components.json)：机器可读的平台、能力和运行时要求。

## 每个 Skill 的说明

README 面向使用者，说明用途、输入输出、依赖、体验和安全边界；各目录内的 `SKILL.md` 则是给 Agent 的执行协议。

| Skill | 从这里了解 |
| --- | --- |
| `atria-cli-overview` | [能力总览与选择](skills/atria-cli-overview/README.md) |
| `atria-browser-bridge` | [真实 Chrome 操作与页面提取](skills/atria-browser-bridge/README.md) |
| `atria-desktop` | [Windows 桌面控制](skills/atria-desktop/README.md) |
| `atria-recording` | [选择正确的录制方式](skills/atria-recording/README.md) |
| `record-replay-windows` | [录制会话、语义 Skill 与回放](skills/record-replay-windows/README.md) |

## 可选：Agent 协作与工程方法

[atria-skill-library](https://github.com/jaysu66/atria-skill-library) 是独立的个人 Skill 总库，按领域整理方法、经验和可选 Pack。当前首个领域是 Agent Engineering；它回答“如何组织需求、设计和协作”，本仓库回答“Agent 能调用哪些工具完成实际操作”。私有阶段仅授权协作者可访问。

两者按受众分开，没有强制安装关系：只想使用浏览器、桌面或录制能力，不必安装工程方法；只想阅读方法论，也不需要运行 CLI。方法仓库中的 Skill 可按需选择，不应默认把整套项目规则写进使用者的环境。

## 5 分钟检查

需要 Node.js 18 或更高版本。此预览不需要在根目录安装依赖，但保留 `npm` 脚本方便统一检查：

```powershell
cd atria-cli
npm run doctor
node .\bin\atria.mjs skills list
npm test
npm run verify
```

`doctor` 返回 `incomplete` 并不一定表示包损坏：桌面录制的 `node_modules` 和 native 二进制没有随预览包分发，首次使用前需要按组件说明在本机安装和构建。

## 启动能力入口

```powershell
# 浏览器 MCP 服务（需要先加载 Chrome 扩展）
node .\bin\atria.mjs browser --standalone

# Windows 桌面/录制 MCP 服务（需要完成本地构建）
node .\bin\atria.mjs desktop
node .\bin\atria.mjs recording

# 等价的显式路由写法
node .\bin\atria.mjs mcp --capability browser

# 可选：独立桌面动作提示与执行控制
node .\bin\atria.mjs visual status
node .\bin\atria.mjs visual enable
node .\bin\atria.mjs visual enable --required
node .\bin\atria.mjs automation pause
node .\bin\atria.mjs automation resume
node .\bin\atria.mjs automation stop
```

CLI 只负责稳定路由，不会静默安装依赖、读取登录会话、导出 Cookie 或把生成的 Skill 写入用户的全局 Skill 目录。`visual` 是可选的独立 Windows overlay；它与只在部分 MCP 宿主显示的 `event_stream_panel` widget 不同。关闭 visual 不影响执行能力。

## 当前边界

浏览器组件可以优先作为独立公开项目继续推进；`record-replay-windows`、`atria-desktop` 与原生二进制仍需完成许可证、依赖和干净机器构建审查。当前候选没有自动更新器、Skill 市场、云端同步或完整安装器。更新应替换一整套固定版本并核对 SHA-256；回退时恢复上一整套，保留包外的用户录制、令牌和配置。发布前请以 [LICENSE-STATUS.md](LICENSE-STATUS.md)、候选 manifest 和实际 `doctor` 结果为准。
