# AGENTS.md — 本仓库索引（给 agent 与后来人）

> **📍 仓库定位：插件 + 说明书二合一。**
>
> - `packages/dsh-deepseek-browser/` —— 一个能直接装的 DSH 插件；
> - 本文件 + [`docs/DSH插件制作指导.md`](docs/DSH插件制作指导.md) —— **DSH 插件制作说明书**：做这个插件时逐条核实出来的机制、内核契约、踩坑与验收方式，供其他 agent 在别的机器上照着做。
>
> 为「写 DSH 插件」而来 → 直接看第 4 节「契约速查」；为「装插件」而来 → 看 [`README.md`](README.md)。

> 一句话：这里放 **`dsh-deepseek-browser`** 插件（DSH 左栏「DeepSeek 浏览器」入口 + 主面板内嵌网页版 DeepSeek，可扩展到其他模型的免费网页版），以及做这个插件时逐条核实出来的 DSH 插件制作知识。
>
> 新会话接手时按顺序读：本文件 → [`docs/DSH插件制作指导.md`](docs/DSH插件制作指导.md) → `packages/dsh-deepseek-browser/lib/client.js`。**动手改 client 之前先读最后一节「踩坑」。**

---

## 1. 目录结构

```
<仓库根>\
├─ AGENTS.md                              本文件（索引 + 契约速查 + 待办）
├─ docs\
│  ├─ DSH插件制作指导.md                    主指导文档（官方文档 + 本机实测 + 验收清单）
│  └─ official\                           官方文档站抓下来的原始 .md（离线可查）
├─ packages\
│  └─ dsh-deepseek-browser\                插件源码（可 link 进 profile）
│     ├─ package.json                       dsh.bundle.patch + dsh.client 两处声明
│     ├─ cordis.patch.yml                   insert 块：把自己挂进 loader 树
│     ├─ lib\index.js                       host 入口（**有意留空**：host 是子进程，见踩坑 12/13）
│     ├─ lib\context-menu.js                【未启用】右键菜单纯函数，备将来注入式方案复用
│     ├─ lib\client.js                      client（浏览器侧）全部功能
│     ├─ scripts\client-register-test.mjs   离线契约测试（34 项，含 webview 租约与 UA 伪装）
│     └─ scripts\context-menu-test.mjs      【未接线】纯函数测试（37 项），仍可单独跑
├─ tools\
│  └─ asar.mjs                              asar 读取工具（list / cat / extract）
└─ README.md                               使用者视角说明
```

## 2. 路径约定（按你的环境替换占位符）

| 用途 | 位置 |
| --- | --- |
| 内核 asar | `<DSH 安装目录>/resources/app.asar`（本机实测约 192 MB，`dsh*` 包为 `0.2.1-rc.3`） |
| 桌面 profile | `~/.dsh/profiles/<profile 名>`（Windows 即 `%USERPROFILE%\.dsh\profiles\<名字>`） |
| profile 清单 | 同目录 `package.json`（`dependencies` + `dsh.profile.bundles`） |
| profile patch 层 | 同目录 `cordis.patch.yml`（约 74 KB，**改动前必须备份**） |
| 插件运行副本目录 | `~/.dsh/plugins-desk-v1/`（ASCII 路径、与 profile 同盘） |
| 自建 skills | `~/.dsh/skills/`（`dsh-plugin-dev-guard`、`dsh-plugin-troubleshoot` 必读） |
| asar 抽取工具 | 本仓库 `tools/asar.mjs` |
| 内核抽取结果 | 任意临时目录，例如 `<临时目录>/asar-out` |

> 关于「官方 CLI」：有的 DSH 安装包 `<DSH 安装目录>/resources/runtime` 下只有 `x64\`、没有 `cli\bin\dsh.cmd`，那就走本仓库的「手装等价路径」（见指导文档第 4 节）。若机器上同时装了两套 DSH，别把 A 的 CLI 用到 B 的 profile 上。

## 3. 常用命令

```powershell
# 语法（只查语法，不查运行期）
node --check packages\dsh-deepseek-browser\lib\index.js
node --check packages\dsh-deepseek-browser\lib\context-menu.js
node --check packages\dsh-deepseek-browser\lib\client.js

# 离线契约测试（必跑，34 项；能拦住 factory 物化崩溃、webview 白屏与 UA 回归）
node packages\dsh-deepseek-browser\scripts\client-register-test.mjs

# 右键菜单纯函数测试（37 项；对应 lib/context-menu.js，当前未被 index.js 引用）
node packages\dsh-deepseek-browser\scripts\context-menu-test.mjs
```

> **不要用 curl 探测 `http://127.0.0.1:34423/`**：DSH NEXT 桌面版的 web server 对普通 HTTP 客户端回
> `403 Browser access is disabled`（窗口走 `dsh-app://app/` 内部协议，不走这个端口）。验收只能看 UI 与应用日志。
> 客户端的 bundle 路由本身是 `GET /plugins/??<包名>/client.js&rev=<rev>`，其中 `rev` 由 entry 的
> **mtime/ctime/size** 派生（不是内容哈希），陈旧 rev 一律 404 —— 手算 hash 去拼 URL 必然对不上。


## 4. 契约速查（写新插件时照抄）

**① 插件自带 `package.json`**

```jsonc
{
  "name": "dsh-deepseek-browser",     // 必须与 client.js 里 __ModuleLoader__.load({ id }) 逐字一致
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // 不写 → 不被当 bundle 装配
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-slots"] }
  }
}
```

**② 插件自带 `cordis.patch.yml`**

```yaml
- insert:
    - id: deepseek-browser          # 短名，用于行寻址
      name: dsh-deepseek-browser    # 完整包名
```
空列表 `[]` = 不装配 = host 与 client 一起缺席，**且不报错**。

**③ 装好的四个判据（缺一不可）**

1. profile `package.json` → `dependencies` 有它（`link:` 指向源码目录）；
2. profile `package.json` → `dsh.profile.bundles` 数组有它；
3. profile `node_modules\<包名>` 是指向源码目录的 **junction**；
4. 插件目录 `cordis.patch.yml` 里有 `insert` 条目。

**④ client 半边**

```js
window.__ModuleLoader__.load({
  id: "dsh-deepseek-browser",
  factory: (require) => {
    const React = require("react")
    function apply(ctx) {
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register({ name: "sidebar.panellist", id: "deepseek-browser", order: 100,
                             label: () => "DeepSeek 浏览器" }, (props) => icon))
      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: "deepseek-browser" }, () => panel))
    }
    return { apply, inject: ["slots"] }
  }
})
```

- 左栏行 = `sidebar.panellist`（list slot，`id`/`order`/`label`）。
- 主面板 = root 作用域 `main` 的 **keyed** slot，`key` 用同一个 id。
- 两处都必须 **`ctx.slots.inject(slot, …)` 再 `register`**；宿主还没声明 slot 时直接 register 会被静默丢弃。
- client 农场返回的 `inject` 是 **cordis 服务名**（如 `slots`、`locale`）；`package.json` 里的 `dsh.client.inject` 是 **包名**，两者语义不同。

**⑤ 左栏行序（实测值）**：plugin-manager `0` / 插件市场 `1` / 技能管理 `2` / 归档管理器 `4` / 自动化任务 `10` / 上下文洞察 `20` / 「更多」按钮在末尾。本插件取 `100`，落在「更多」正上方。

**⑥ 扩展点 `window.__DSB_HOOKS__`（给第三方模块用）**

主插件在 guest 就绪与每次导航完成后，把 `{ id, element, url, phase, userAgent }` 广播出去：

```js
window.__DSB_HOOKS__.onGuestReady((guest) => {
  // guest.element 是 <webview> 元素；guest.phase 为 "ready" | "navigate"
  // 订阅时会先重放当前已存在的 guest，所以晚加载也不会漏
})
```

本插件自身**不读不写任何站点凭证**；若你要在自己的插件里操作 guest 页面，`element.executeJavaScript(code)` 是正规入口（租约与 UA 都已由本插件处理好）。注意这等同于在用户浏览器里执行任意脚本，属于高权限能力，是否使用应由使用者自行判断。

## 5. 为什么是 `<webview>`，以及为什么必须走 guest broker

- `chat.deepseek.com` 等站点回 `Content-Security-Policy: frame-ancestors 'none'` → iframe 一律被拒。
- 桌面主窗口 `webPreferences.webviewTag = "primary"`（`main.js` L4889-4890）→ `<webview>` 可用，且它是独立 WebContents：**不受 frame-ancestors 约束**，登录态、输入法、文件上传、剪贴板、下载都按真实浏览器行为走。
- **但裸建 `<webview src="https://...">` 在 DSH NEXT 里一定白屏**：主进程 `lib/browser-guests.js` 的 `will-attach-webview` 会校验 `src === "about:blank#" + lease`、`partition === lease.partition`、租约未 attach 过，否则 `event.preventDefault()` —— 元素不挂载、不报错、不抛异常。必须先用 `window.dshDesktop.browser.acquire(workspace)` 拿 `{ lease, partition }`，按上面的三个属性建元素，`appendChild` 之后等 `dom-ready` 再 `loadURL`，卸载时 `release(lease)`。细节见 `docs/DSH插件制作指导.md` 6.2。
- 分区是主进程按 workspace 字符串分配的**进程内**存储（形如 `dsh-sidebar-browser-<uuid>`，无 `persist:` 前缀）：切站点/切面板不丢登录态，**重启应用需重新登录**。这是固定隔离策略，插件侧绕不开。
- **guest 的 UA 必须伪装**：Electron 默认 UA 形如 `Mozilla/5.0 (...) AppleWebKit/537.36 (KHTML, like Gecko) DSH NEXT/2.0.20-next Chrome/140.0.0.0 Electron/44.7.0 Safari/537.36`。`chat.deepseek.com` 一看到 `Electron` 就弹「使用环境异常…建议您使用我们的官方产品」。插件在 append 之前写 `useragent` 属性、append 之后 `setUserAgent()` 兜底，重建为普通 Windows Chrome UA（保留平台段与原 Chrome 主版本号）。
- **guest 会话被主进程硬限制**（`browser-guests.js` 的 `configureSession`，插件侧无解）：所有权限请求一律 `callback(false)`（麦克风/摄像头/通知/剪贴板读 → **语音输入不可用**）；`will-download` 一律 `preventDefault()`（**下载被禁**）；HTTP Basic 认证被拒（`login` 事件直接 `callback()`）；禁止再嵌套 webview。
- 主窗口 `setWindowOpenHandler` 一律 `deny` 并转 `openExternal`（`main.js` L4953），`will-navigate` 只放行 `dsh-app://app/`（L4957）→ 外链点击会进系统浏览器，这是预期行为，不是 bug。guest 内的 `window.open` 要用 `browser.onOpenRequested(lease, cb)` 接住。
- 右侧栏内置浏览器（`dsh-client-ui-sidebar-browser`）只占右侧窄栏，不满足「主面板完整网页」的需求，故未采用；但它的实现就是这套租约流程的权威样板。

## 6. 踩坑（改 client 前必读）

1. **CSS 模板字符串里出现裸反引号** → 模板串提前终结 → factory 物化抛 `ReferenceError` → DSH 弹「应用无法启动」/`web boot: 1 entry did not activate`。注释里也不要写反引号。
2. **`node --check` 通过 ≠ 能跑**：`a.b - c` 这类语法合法、运行期炸的写法只有契约测试能拦。
3. **手改 profile `package.json` 加 dependency** → pnpm 认为 lockfile 不一致，下次 install 会剔掉；手装时三样（deps / junction / bundles）必须同时补。
4. **跨盘 + 中文路径的 junction 容易被 pnpm 拒绝** → 插件副本放 ASCII 路径、与 profile 同盘。
5. **改完 client「没反应」** → 先分清三种情况：①左栏根本没有入口 = 没进启动图（查四处判据），不是缓存问题；②入口在但面板空 = client 里的 slot 注册被静默丢弃；③面板报错 = 看窗口开发者工具 console。`rev` 由 mtime/ctime/size 派生、陈旧 rev 一律 404，手算 hash 拼 URL 一定对不上。
6. **webview 白屏三连**（本仓库真实踩过，2026-10-28）：①绕过租约裸建元素 → 主进程静默拒绝挂载；②首屏 `loadURL` 早于 `dom-ready` → URL 被丢掉；③导航 effect 无条件 `setBlocked(null)` → 把「无桌面桥」降级提示覆盖成白屏。契约测试 14–25 号断言就是锁这三件事的。
7. **运行副本是拷贝不是 junction**（`~/.dsh/plugins-desk-v1/dsh-deepseek-browser` 是实体目录）→ 改完源码必须重新 `Copy-Item` 覆盖，并核对两边 sha1 一致，否则重启后跑的还是旧代码。
8. **插件把 DSH 搞崩时的救援**：把包名从 `dsh.profile.bundles` 移除即可恢复启动（`dependencies` / junction 留着不影响），修好再加回。
9. **同一个包名被两个 Loader source 解析到**（重复安装、link 与 npm 版并存）→ 组合直接失败，整页起不来。
10. **页面能打开但站点弹「使用环境异常」**（2026-10-28 实测 DeepSeek）：不是插件 bug，是 Electron 默认 UA 里的 `Electron/<ver>` 与应用名被风控命中。修法见 §5 的 UA 伪装条目；UA 只在**建元素前**写才可靠，改完必须重启（client bundle 启动时装配）。
11. **guest 没有右键菜单，且渲染侧拿不到 context-menu 事件**（2026-10-28 实测）：`WebviewTag` 不透传 `context-menu` 到宿主页面，`dshDesktop` 桥也没有菜单通道。宿主只给主窗口装了编辑菜单（`main.js` L4966 `installEditingContextMenu(window.webContents)`），Windows 下甚至不设应用菜单（L904 只在非 win32 才 `Menu.setApplicationMenu`）。给 guest 加右键菜单两条路都被架构堵死：渲染侧传不出事件，host 侧跑在**子进程**（`desktop-next-host`）里、`require("electron")` 只有路径壳，拿不到 `Menu`/`BrowserWindow`（本仓库实测：静默 `null`、右键无反应、日志无报错）。**结论：插件做不出右键菜单**，用 `Ctrl+V` 或工具栏 ↗ 交系统浏览器；纯函数实现留在 `lib/context-menu.js` 未启用。
12. **host 侧任何需要 Electron API 的逻辑，先怀疑它能不能跑**：host 插件在子进程（`desktop-next-host`）里执行，`require("electron")` 只有 npm 壳（`Cannot find module 'electron'` / 路径字符串），`BrowserWindow`、`Menu`、`webContents` 一律不存在。所以「把判断逻辑抽成纯函数 → `node` 直跑测试 → `index.js` 只做容错接线」这个分层是对的，但接线那一层在本机永远是降级分支（取不到就 `return`）。**别把它写成「留给重启后目视验收」—— 没有可验收的东西。**
13. **顶层 `import { BrowserWindow } from "electron"` 会让整个 entry 加载失败，并连带 client 半边一起消失**（2026-10-28 真实事故）：插件由宿主的 **ESM loader** 加载（日志里是 `failed to import: file:///...lib/index.js`），`electron` 按 node_modules 解析到 Electron 的 CJS 入口（`module.exports` 是一段路径字符串），于是抛
    `SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'`
    → `1 entry did not activate` → **左栏入口整条消失**（DSH 本身还能正常启动，极易误判成缓存/装配问题）。
    修法（本仓库现状）：host 入口干脆不碰 electron —— `lib/index.js` 只有 `name` / `inject` / `apply` 三个导出，`apply()` 为空。如果将来非要碰，顶层只留 `node:module` 与自有文件，`const require = createRequire(import.meta.url)`，在 `apply()` 里 `require("electron")` 并 try/catch，取不到就 `return`。
    排查入口消失时，**第一步就看 `~/.dsh/logs/desktop-next.log` 里有没有 `failed to import`**，别先猜缓存。

## 7. 当前状态与待办

- [x] 官方文档站抓取 + 本机内核契约核实（slots / client-modules / webview 策略 / 左栏行序 / guest broker）
- [x] 插件源码：`package.json`、`cordis.patch.yml`、`lib/index.js`、`lib/context-menu.js`、`lib/client.js`、离线契约测试（client **34/34**、host **37/37**）
- [x] 指导文档（`docs/DSH插件制作指导.md`，13 节）+ 索引文档 + 插件 README
- [x] 落地到 profile（deps + junction + bundles），左栏入口已显示
- [x] 白屏归因并修复：client.js 改为 guest broker 租约链路，已同步到运行副本并核对 sha1
- [—] guest 右键菜单：**已评估为不可行**（host 子进程无 Electron API + 渲染侧接不住 context-menu），用户定「先不做，用 Ctrl+V」；代码留在 `lib/context-menu.js` 未启用
- [x] 重启验证：主面板能加载 `chat.deepseek.com`（登录页正常、UA 伪装后不再弹「使用环境异常」）
- [—] 登录态跨重启：内核每次启动用 `dsh-sidebar-browser-${randomUUID()}` 随机内存分区，**插件侧无法持久化**（官方右侧栏浏览器同样如此）；本插件选择在 UI 里如实告知「重启后需重新登录」，不读取、不保存任何凭证
- [ ] 可选：把本仓库知识固化成自建 skill
