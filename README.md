# Atria CLI

一个本地优先的统一入口，把 Atria 的浏览器、Windows 桌面和工作流录制能力接给 Agent。

当前版本是 **`0.1.0-public-preview` 私有预览包**：源码已经整理并上传到私有 GitHub 仓库，尚未公开，也不是一键安装器。它只包含首批三类能力：

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

## 5 分钟检查

需要 Node.js 18 或更高版本。此预览不需要在根目录安装依赖，但保留 `npm` 脚本方便统一检查：

```powershell
cd atria-cli
npm run doctor
node .\bin\atria.mjs skills list
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
```

CLI 只负责稳定路由，不复制底层引擎，也不会静默安装依赖、读取登录会话、导出 Cookie 或把生成的 Skill 写入用户的全局 Skill 目录。

## 当前边界

浏览器组件可以优先作为独立公开项目继续推进；`record-replay-windows` 和 `atria-desktop` 仍需完成许可证、依赖和干净机器构建审查。当前预览没有自动更新器、Skill 市场、云端同步或完整安装器。发布前请以 [LICENSE-STATUS.md](LICENSE-STATUS.md) 和实际 `doctor` 结果为准。
