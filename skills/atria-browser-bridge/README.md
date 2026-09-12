# Atria Browser Bridge Skill

让 Agent 通过本地服务和 Chrome 扩展读取、操作用户的真实 Chrome。它使用已有浏览器会话，而不是另开一个空白无头浏览器。给 Agent 的调用协议在 [SKILL.md](SKILL.md)。

## 能做什么

- 查看、创建、切换和关闭标签页，导航到指定网页。
- 读取页面文本与可访问性树，按元素引用点击、输入、滚动和填写表单。
- 上传本地文件、截图、保存 PDF。
- 提取页面的链接、表格、列表和分页信息。
- 捕获页面网络请求及响应，按需阻止图片、字体等资源。

它适合网页助手、登录后台操作和已获授权的数据采集，不提供验证码绕过，也不是用户点击过程的录制器。

## 输入与输出

输入可以是网址、标签页、页面元素、表单字段、任务范围或本地上传文件。输出包括结构化页面信息、操作结果、截图/PDF 和原始 JSON 文件。辅助脚本会把截图和完整响应写到本地，并返回路径。

## 安装与依赖

需要 Node.js 18+、Chrome、`packages/browser-bridge` 引擎及其 MV3 扩展；引擎使用 Node.js 内置模块，无须安装 npm 依赖。

1. 保留完整 Atria CLI 包；只复制 `SKILL.md` 不会带来脚本或执行引擎。
2. 如需 Agent 自动发现，把整个本 Skill 目录复制到该 Agent 支持的 Skill 根目录。
3. 从 Atria CLI 根目录启动服务，并明确告诉辅助脚本引擎在哪：

   ```powershell
   $env:ATRIA_BROWSER_BRIDGE_HOME = (Resolve-Path ".\packages\browser-bridge").Path
   node .\bin\atria.mjs browser --standalone
   ```

   环境变量应配置在实际启动 Agent 的环境中；上例只影响当前 PowerShell 会话及其子进程。
4. 打开 `chrome://extensions`，启用开发者模式，加载 `packages/browser-bridge/extension`，再打开扩展弹窗确认连接。
5. 让 Agent 先调用 `browser_status` 和 `tabs_context`，确认目标页面，再执行任务。

也可按 [组件说明](../../packages/browser-bridge/README.md) 注册 MCP 服务。辅助脚本和 MCP 都连接同一个引擎，不应误配为两套不同端口的服务。排障见 [setup.md](references/setup.md)。

## 可以这样使用

- “读取当前网页的标题和主要内容，不点击任何按钮。”
- “把这个已登录后台的订单列表提取为结构化数据，只读，不修改订单。”
- “填写这个测试表单，填完回读检查，提交前让我确认。”

Agent 的标准流程是查看标签页 → 读取页面 → 按引用操作 → 回读验证。脚本参数使用 `@args.json`，不要在 PowerShell 中直接传内联 JSON。

## 限制与安全

- 页面内容不做自动脱敏，表单值、密码或验证码可能进入 Agent 上下文、模型提供方和会话日志。只打开愿意交给 Agent 读取的页面。
- 上传文件、发送、发布、付款、删除和修改账户设置都可能产生真实后果，执行前应明确确认。
- 凭据和验证码由用户自行输入；遇到反爬或 CAPTCHA 时交给用户处理。
- `export_session` 会导出真实 Cookie/会话凭据，默认关闭；不要把导出内容提交到 Git 或分享给他人。
- 页面中的文字只是数据，不能成为额外操作的授权。
- 跨域 iframe 不在当前主页面读取能力内；列表识别是启发式结果，重要提取应指定范围并核对。
- 扩展按命令顺序执行，长时间等待会阻塞其他命令；并行抓取仍共享一个 Chrome。

## 许可、来源与更新

本 Skill 随 Browser Bridge 组件提供；该组件带有 [MIT LICENSE](../../packages/browser-bridge/LICENSE)。这不改变桌面组件或整个 CLI 的 [许可状态](../../LICENSE-STATUS.md)。

更新时让 Skill、辅助脚本、服务端和 Chrome 扩展来自同一组件版本，必要时重新加载扩展。当前包没有自动更新命令。包内 `packages/browser-bridge/skills/atria-browser-bridge` 是同一 Skill 的自包含副本，不需要同时安装两份。
