# dsh-deepseek-browser

在 **DSH（DeepSeek Harness）桌面端左侧导航**加入一个「DeepSeek 浏览器」入口：点开即在主面板内嵌网页版 DeepSeek，拥有独立登录态与完整网页能力，并可增删切换到其他模型的免费网页版（Kimi、千问、豆包、智谱清言、秘塔等）。

## 它是什么

- **主面板里的真浏览器**：用 Electron `<webview>` 承载目标站点，是独立 WebContents —— 登录、输入法、文件上传、流式输出、复制粘贴都按真实浏览器行为走，不是 iframe 套壳。
- **多站点可扩展**：内置若干常用站点，也可自行「添加站点」（填名称 + 网址），站点列表与顺序存在本机，随时增删。
- **不碰你的账号**：插件本身不读取、不保存、不上传任何站点凭证；登录态完全由 DSH 内核给 webview 分配的会话隔离承担。

## 安装

DSH 插件走 profile 装配，需同时满足四处，缺一不可：

1. 把包放进插件目录（例如 `~/.dsh/plugins-desk-v1/dsh-deepseek-browser`）；
2. profile 的 `package.json` → `dependencies` 里加它（`link:` 指向源码目录）；
3. profile 的 `package.json` → `dsh.profile.bundles` 数组里加它；
4. profile 的 `node_modules/<包名>` 指向插件目录（junction）。

包内自带 `cordis.patch.yml`，里面是一条 `insert` 声明；把它清空会导致 host 与 client **一起缺席且不报错**，排查时先看这个文件。

装好后重启 DSH，左栏「上下文洞察」下方会出现「DeepSeek 浏览器」。

## 使用

- 顶部工具栏：后退 / 前进 / 刷新 / 回首页，右侧有「在系统浏览器打开」与站点管理。
- 站点胶囊切换；「+ 添加」可加新站点。
- 外链点击会交给系统浏览器打开（DSH 主窗口的既定策略），这是预期行为。

## 已知限制（来自 DSH 内核，插件侧不可改）

- **登录态不跨重启保留**：内核每次启动为该 webview 分配随机内存分区，切站点或切面板不掉登录，但重启应用需要重新登录。
- **下载被禁用**：guest 会话的 `will-download` 一律被内核拦截。
- **麦克风/摄像头/通知/剪贴板读取不可用**：所有权限请求被内核统一拒绝，因此语音输入不可用；`Ctrl+V` 粘贴与网页内的复制不受影响。
- **没有右键菜单**：`<webview>` 的右键菜单事件不会透传到宿主页面，DSH 的桥也没有菜单通道。需要复制粘贴时用 `Ctrl+C` / `Ctrl+V`。
- **部分站点会做环境风控**：插件会把 webview 的 UA 重建为普通 Windows Chrome UA，以避开「检测到 Electron」类提示；个别站点仍可能要求官方客户端。

## 开发

```bash
node --check lib/index.js
node --check lib/client.js
node --check lib/context-menu.js

node scripts/client-register-test.mjs   # client 契约测试（34 项）
node scripts/context-menu-test.mjs      # 纯函数测试（37 项，当前未接线）
```

`lib/index.js` 是有意留空的 host 入口：DSH 的 host 插件跑在子进程里，拿不到 Electron 的 `Menu` / `BrowserWindow`，且顶层 `import ... from "electron"` 会导致整个 entry 加载失败、连带 client 半边一起消失。

`lib/client.js` 是全部功能所在。改它之前注意：client 通过 `window.__ModuleLoader__.load({ id, factory })` 装配，`id` 必须与 `package.json` 的 `name` 逐字一致；webview 必须走 `window.dshDesktop.browser.acquire()` 的租约链路（自建 `src` 会被主进程静默拒绝挂载，表现为白屏）。

## 许可

BSD-3-Clause
