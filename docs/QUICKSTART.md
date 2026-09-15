# Atria CLI 快速开始

这是 `0.2.0-private.4` 的最短验证路径。完整的用户体验和安全说明见 [USER-GUIDE.md](USER-GUIDE.md)。

## 1. 解压并检查包

安装 Node.js 18+，然后在包根目录执行：

```powershell
cd atria-cli
node .\bin\atria.mjs --version
node .\bin\atria.mjs doctor --json
node .\bin\atria.mjs skills list
npm run verify
```

`verify` 扫描实际候选文件、来源摘要、禁止目录、维护者路径和疑似凭据；`doctor` 分别报告源码和本机运行时状态。源码候选不包含桌面 `node_modules` 和 `.exe`，所以桌面部分正常会显示 `runtimeReady: false`。

## 2. 浏览器能力

浏览器能力需要 Chrome 扩展和本地 MCP 服务，数据默认留在本机。

1. 打开 Chrome 的 `chrome://extensions`，开启“开发者模式”。
2. 选择“加载已解压的扩展程序”，目录指向 `packages/browser-bridge/extension`。
3. 在需要操作的页面点击扩展图标，明确把该标签页暴露给 Bridge。
4. 启动服务：

   ```powershell
   node .\bin\atria.mjs browser --standalone
   ```

5. 在 MCP 客户端中连接该本地进程，先调用 `browser_status`，再调用 `read_page` 验证页面可读。

首次测试建议使用公开的静态页面或包内 `fixtures`，不要直接在支付、管理员或含个人隐私的页面上试运行。

## 3. Windows 桌面和录制能力

这部分需要 Windows、Rust、Node 依赖以及本地 native 构建；为降低下载包风险，预览包没有携带编译产物。

1. 阅读 [record-replay-windows README](../packages/record-replay-windows/README.md)。
2. 只在准备使用桌面能力时进入该组件安装依赖。
3. 运行 `scripts/build-native.ps1` 构建本机 `actor.exe`、`recorder.exe` 和可选的 `overlay.exe`。
4. 按组件 README 运行 smoke tests。
5. 回到根目录执行 `node .\bin\atria.mjs doctor --json`，确认 `runtimeReady: true`。
6. 启动：

   ```powershell
   node .\bin\atria.mjs desktop
   ```

录制时先使用低风险的测试应用。流程通常是“开始录制 → 用户演示 → 停止 → 生成 Skill → dry-run → 确认后回放”。

希望看到 Agent 的桌面动作时：

```powershell
node .\bin\atria.mjs visual enable
node .\bin\atria.mjs visual status
node .\bin\atria.mjs automation pause
node .\bin\atria.mjs automation resume
node .\bin\atria.mjs visual disable
```

`--required` 模式会在 overlay 未就绪时阻止下一次桌面写动作；普通模式会明确报告不可见但可按策略继续。overlay 是独立 Windows helper，不等于 MCP 宿主内的录制 panel。

## 常见问题

### `doctor` 显示 `runtimeReady: false`

这是源码候选的预期结果：源码在包内，桌面依赖和 native 二进制需要你在本机安装/构建或从获准的私有二进制候选安装。浏览器能力不依赖这些文件。

### 浏览器服务启动但没有标签页

确认扩展已加载、目标标签页已点击扩展图标暴露，并先调用 `browser_status`。不要把整个 Chrome 用户目录复制给 Agent。

### 录制结果不可回放

先在低风险应用中 dry-run；检查窗口焦点、UI 控件是否变化，以及是否把验证码、密码或一次性令牌当成了固定输入。敏感值不会自动变成可安全重放的参数。

### 能否绕过 CAPTCHA 或登录？

不能。Atria 只操作你明确授权的本地会话，不提供登录绕过、验证码绕过或“自动信任”保证。
