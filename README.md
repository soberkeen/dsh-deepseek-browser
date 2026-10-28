# dsh-deepseek-browser

给 **DeepSeek Harness（DSH）** 桌面版加一个「DeepSeek 浏览器」入口：左栏一行，点开就是主面板里的网页版 DeepSeek，登录态、输入法、文件上传、剪贴板、下载都按真实浏览器行为走；并且可以增删、切换到其他模型的免费网页版。

```text
左栏                          主面板
┌──────────────┐             ┌───────────────────────────────────────┐
│ 插件          │             │ DeepSeek  Kimi  千问  豆包  …    ＋  ⟳  │
│ 插件市场      │             ├───────────────────────────────────────┤
│ 技能管理      │             │                                       │
│ 归档管理器    │             │        chat.deepseek.com              │
│ 自动化任务    │             │        （真实网页，非截图非代理）      │
│ 上下文洞察    │             │                                       │
│ DeepSeek 浏览器 ← 新增       │                                       │
│ 更多          │             │                                       │
└──────────────┘             └───────────────────────────────────────┘
```

## 它解决什么问题

DSH 里和模型对话很方便，但「切到网页版用完整功能」一直要另开浏览器。这个插件把网页版搬进主面板，并且不牺牲任何网页能力：

- **完整网页**：不是镜像、不是 API 代理、不是 iframe，是真实的 `chat.deepseek.com`；
- **登录态独立**：跑在 DSH 主进程分配的专用分区里，与 DSH 自身会话隔离；同一进程内切站点/切面板不掉登录，重启应用需登录一次（分区是进程内存储，没有 `persist:` 前缀，插件侧改不了）；
- **可扩展**：内置 DeepSeek / Kimi / 千问 / 豆包 / 智谱清言 / 秘塔，任一可删；还能自己加任意网址（比如其他模型的免费网页版）；
- **不装额外依赖**：只是给 DSH 补一个入口和一块 `<webview>`，不代理、不改请求、不注入页面脚本。

## 使用

1. 左栏点「DeepSeek 浏览器」（在「更多」正上方）；
2. 顶部胶囊切换站点，`＋` 添加新站点，`⟳` 刷新，齿轮图标打开站点管理（增删 / 恢复默认）；
3. 站点清单只保存在本机 `localStorage`（键 `dsh-deepseek-browser.sites.v1`），不随插件同步。

## 已知限制

这些限制来自 DSH 主进程的固定策略（`lib/browser-guests.js` 的 `configureSession`），插件侧绕不开：

| 能力 | 状态 | 原因 |
| --- | --- | --- |
| Ctrl+C / Ctrl+V | 可用 | Blink 原生编辑命令，不过权限层 |
| **右键菜单** | **不提供** | 见下方说明 |
| 网页调 `navigator.clipboard.readText()`（如「粘贴并提问」） | 被拒 | 所有权限请求一律 `callback(false)` |
| 语音输入 / 麦克风 / 摄像头 / 通知 | 不可用 | 同上 |
| 文件下载 | 被禁 | `will-download` 一律 `preventDefault()` |
| 站点内的外链 | 跳系统浏览器 | 主窗口 `setWindowOpenHandler` 一律 `deny` + `openExternal` |
| 重启 DSH 后登录态 | 需重新登录 | 分区是每次启动随机生成的内存分区，见下方「兼容性」 |

**为什么没有右键菜单**：DSH NEXT 的插件 host 半边跑在子进程里（日志 `spawned`），拿不到 `BrowserWindow/Menu`；渲染侧 `<webview>` 又不把 `context-menu` 事件交给宿主页面，`dshDesktop` 桥也没有菜单通道。两头都够不着，所以这一版不提供右键菜单 —— 需要时用 `Ctrl+V`，或点顶部 ↗ 用系统浏览器打开。`lib/context-menu.js` 里留了一套纯函数实现，等宿主未来开出菜单通道可直接复用。

## 安装

机器上若没有官方 `dsh` CLI，走手装等价路径。四个判据缺一不可，详见 [`docs/DSH插件制作指导.md`](docs/DSH插件制作指导.md) 的安装一节。

```powershell
# 0) 按你的环境改这三行
$src     = '<仓库根>\packages\dsh-deepseek-browser'
$dst     = "$env:USERPROFILE\.dsh\plugins-desk-v1\dsh-deepseek-browser"
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"        # 换成你的 profile 目录

# 1) 源码 → 运行副本目录（ASCII 路径、与 profile 同盘）
Copy-Item $src $dst -Recurse -Force

# 2) junction：profile/node_modules/<包名> → 运行副本
$target = Join-Path $profile 'node_modules\dsh-deepseek-browser'
if (Test-Path $target) { (Get-Item $target).Delete() }
New-Item -ItemType Junction -Path $target -Target $dst | Out-Null

# 3) 改 profile/package.json：dependencies 加 "dsh-deepseek-browser": "link:<$dst>"
#    并把包名加进 dsh.profile.bundles（改前备份）
# 4) 完全退出 DSH 再启动（插件只在启动时装配）
```

**卸载 / 救火**：把 `dsh-deepseek-browser` 从 profile `package.json` 的 `dsh.profile.bundles` 移除即可恢复启动（`dependencies` 与 junction 留着不影响）。

## 兼容性

| 环境 | 表现 |
| --- | --- |
| DSH 桌面版（Electron） | 完整功能，`<webview>` 承载网页 |
| `dsh web`（纯浏览器打开） | 自动降级为说明页：内嵌网页版需要 Electron 窗口，且目标站点 `frame-ancestors` 不允许 iframe |
| 内核版本 | 在 `0.2.1-rc.3` / DSH NEXT `2.0.20-next` 上实测 |

**登录态**：DSH 桌面版把 webview 的分区交给主进程按「工作区标识」分配，属于**进程内**存储（形如 `dsh-sidebar-browser-<uuid>`，没有 `persist:` 前缀）。因此：

- 同一进程内切站点、切面板、关掉再打开面板，登录态都在；
- **重启 DSH 后需要重新登录一次**。这是 DSH 的隔离策略，插件侧改不了。

## 为什么是 `<webview>` 而不是 iframe

`chat.deepseek.com` 等站点回 `Content-Security-Policy: frame-ancestors 'none'`，iframe 一律被拒。桌面主窗口 `webPreferences.webviewTag = "primary"`（内核 `main.js` L4889–4890），`<webview>` 是独立 WebContents，不受 frame-ancestors 约束。

**但不能裸建 `<webview src="https://...">`**：DSH NEXT 主进程的 `lib/browser-guests.js` 会在 `will-attach-webview` 里校验租约（`src` 必须是 `about:blank#<lease>`、`partition` 必须与 `acquire()` 下发的一致），不符就 `preventDefault()` —— 元素静默不挂载，表现为白屏 + 永久「加载中…」。所以本插件先 `window.dshDesktop.browser.acquire()` 拿租约，再按租约属性建元素，`dom-ready` 后 `loadURL`，卸载时 `release()`。细节见 [`docs/DSH插件制作指导.md`](docs/DSH插件制作指导.md) 第 6.2 节。

由此带来一个**预期行为**：面板里点目标站点的外链，会跳系统浏览器 —— 主窗口 `setWindowOpenHandler` 一律 `deny` 并转 `openExternal`（`main.js` L4953），`will-navigate` 只放行 `dsh-app://app/`（L4957）。这是 DSH 的安全策略，不是插件缺陷。

## 开发

```powershell
node --check lib/index.js
node --check lib/client.js
node scripts/client-register-test.mjs      # client 离线契约测试，34 项
node scripts/context-menu-test.mjs         # 右键菜单纯函数测试，37 项（当前未被引用）
```

改 `lib/client.js` 前必读 [`AGENTS.md`](AGENTS.md) 的「踩坑」一节：CSS 模板串里的裸反引号会让 factory 物化崩溃，`node --check` 查不出来；webview 绕过租约则静默白屏，契约测试第 14–25 项锁的正是这条链路。

> 注意运行副本是**拷贝**不是 junction（`~/.dsh/plugins-desk-v1/dsh-deepseek-browser` 是实体目录），改完源码要重新覆盖并核对 sha1。
>
> 也不要给 host 入口（`lib/index.js`）加顶层 `import ... from "electron"`：宿主用 ESM loader 加载它，`electron` 解析不到命名导出会抛 `SyntaxError`，整个 entry 失败、**连左栏入口一起消失**。详见 AGENTS.md 踩坑 13。

## 文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | `dsh.bundle.patch` + `dsh.client` 两处装配声明 |
| `cordis.patch.yml` | `insert` 块，把自己挂进 loader 树 |
| `lib/index.js` | host 侧入口，**有意留空**（host 是子进程，拿不到 Electron API） |
| `lib/context-menu.js` | 右键菜单纯函数（白名单 + 菜单项），当前未启用，备将来复用 |
| `lib/client.js` | client 侧全部功能：左栏行 + 主面板 + 站点管理 + webview 租约/UA |
| `scripts/client-register-test.mjs` | client 离线契约测试（假 DOM + 假 loader + 假桥），34 项 |
| `scripts/context-menu-test.mjs` | 纯函数测试（白名单与菜单形态），37 项 |

## 许可

BSD-3-Clause
