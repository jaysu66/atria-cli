# Atria CLI 总览 Skill

这是给 Agent 的能力导航，不是新的浏览器或桌面引擎。它帮助使用者了解 Atria CLI 能做什么、该选择哪个 Skill，以及开始前还缺哪些配置。具体执行规则见 [SKILL.md](SKILL.md)。

## 适合什么需求

- “这个 CLI 能帮我做什么？”
- “我想操作网页，应该启用哪项能力？”
- “浏览器控制、桌面控制和录制有什么区别？”
- “为什么下载完仍然不能录制？”

## 输入与输出

输入是任务描述和本机环境；输出是能力选择、前置条件、启动方式与检查结果。它本身不操作电脑，也不自动安装底层组件。

| 需求 | 转交给 |
| --- | --- |
| 读取或操作网页、抓页面接口 | [atria-browser-bridge](../atria-browser-bridge/README.md) |
| 操作 Windows 软件、窗口与控件 | [atria-desktop](../atria-desktop/README.md) |
| 演示一次并生成工作流，或选择录制方式 | [atria-recording](../atria-recording/README.md) |
| 直接管理录制会话、生成 Skill 和回放 | [record-replay-windows](../record-replay-windows/README.md) |

## 安装与首次体验

可以只阅读本说明，不安装任何 Skill。希望 Agent 自动识别时，把整个 `atria-cli-overview` 目录放入其支持的 Skill 根目录；具体发现方式以所用 Agent 为准。这个导航 Skill 无额外运行时，但实际能力需要各自的引擎。

在 Atria CLI 仓库根目录执行：

```powershell
node .\bin\atria.mjs doctor --json
node .\bin\atria.mjs skills list
```

再对 Agent 说：“用 Atria CLI 总览解释我的任务适合哪项能力，先检查环境，不操作页面。”

`doctor` 目前检查组件、依赖目录和 native 文件是否存在，不能代替 Chrome 连接或真实桌面操作验收；`skills list` 只列出包内 Skill，不代表它们已安装进当前 Agent。

## 能力限制与安全

- 当前是私有源码预览，不是云服务或一键安装器，也没有自动更新器。
- 浏览器需要手动加载 Chrome 扩展；桌面和录制需要 Windows、本机依赖及 native 构建。
- 导航只负责推荐能力，不能替用户授权发布、付款、删除或发送消息。
- 本地工具的返回内容仍可能进入 Agent 的模型上下文与日志；“本地运行”不等于所有内容永不离开电脑。
- 源码就绪、运行时就绪和许可就绪必须分别判断。

## 许可、来源与更新

此 Skill 是 Atria CLI 的总览文档，当前尚无单独确认的开源许可证；参见 [许可状态](../../LICENSE-STATUS.md)。不要据此推定底层组件都可以再分发。

随 Atria CLI 版本更新；更新前保留自己修改过的文件。可继续阅读 [用户指南](../../docs/USER-GUIDE.md) 和 [CLI 能力说明](../../docs/CLI-CAPABILITIES.md)。
