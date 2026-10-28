# DSH 插件制作指导

> **这是什么：一份 DSH 插件制作说明书。** 它不是官方文档的翻译，而是「照着官方文档做、在本机内核上逐条撞出来」的实践记录 —— 结论都标了可信度与证据，目标是让另一个 agent 换一台机器也能直接复现一个可用的客户端插件。
>
> **适用对象：**要给 **DeepSeek Harness（DSH）** 写「带左栏入口 + 自定义面板」这类客户端插件的人。
>
> 写法约定：本文区分三种可信度 ——
>
> - **【官方】**：摘自官方文档站（`https://deepseek-harness.github.io/deepseek-harness/`），离线副本在 `docs/official/`；
> - **【实测】**：在 DSH NEXT 2.0.20-next（内核 `0.2.1-rc.3`）上跑出来的结果，附证据或日志；
> - **【踩坑】**：真实失败过、且失败姿势反直觉的地方。
>
> 版本会漂。凡是本文与你的 `app.asar` 对不上，**以你的 asar 为准**，并按第 9 节的命令重新核实。

---

## 1. 心智模型：一个插件横跨四个平面

DSH 的插件不是「一个 JS 文件」，而是四个平面协同。把这四个平面分清，90% 的「改了没反应」都能当场定位。

```text
┌─ ① 进程侧（host）────────────────────────────────────────┐
│  一个 Cordis 插件：lib/index.js，导出 name / apply(ctx)   │
│  能干：注册服务、挂 CLI、读写文件、开子进程、加 web 路由   │
│  不能干：直接画 UI                                        │
└───────────────────────────────────────────────────────────┘
              │ ② 装配（bundle patch）
              │ 插件自带的 cordis.patch.yml 把自己 insert 进 loader 树
              ▼
┌─ ③ 浏览器侧（client）─────────────────────────────────────┐
│  一个普通 JS bundle：lib/client.js，导出                  │
│  window.__ModuleLoader__.load({ id, factory })           │
│  由 host 的 ClientModuleRegistry 扫描 dsh.client 声明，     │
│  组合成 window.__DSH_BOOT__ 图，从 /plugins 路由送出       │
└───────────────────────────────────────────────────────────┘
              │ ④ 渲染（slots）
              ▼
┌─ ④ Slot ──────────────────────────────────────────────────┐
│  类型化 React 组合点。左栏导航 = sidebar.panellist        │
│  主面板     = main（keyed slot）                          │
│  注册方式：ctx.slots.inject(name, () => ctx.slots.register(...)) │
└───────────────────────────────────────────────────────────┘
```

**为什么要强调「四个平面」**：DSH 的启动链路是 —— loader 读 patch → 装配 host fiber → host 扫 `dsh.client` → 往 HTML 注入 `__DSH_BOOT__` → 浏览器加载 bundle → factory 物化 → slot 渲染。

这条链上**任何一环断掉，后面的环节会安静地消失**：patch 里没你 → host 不在 → client 不扫 → HTML 不注入 → 页面不加载 → 左栏没有入口。而 DSH 往往**不报错**。所以定位必须按链路顺序查，不能从「UI 没有」直接猜「缓存问题」。

---

## 2. 最小可运行插件：六个文件

一个能出现在左栏、能占满主面板的最小插件只需要六个文件。下面这份骨架来自本仓库的 `packages/dsh-deepseek-browser/`，可整体复制改名。

```text
my-plugin/
├─ package.json
├─ cordis.patch.yml
├─ README.md
├─ lib/index.js          ← host 面
├─ lib/client.js         ← client 面
└─ scripts/client-register-test.mjs  ← 离线契约测试（强烈建议）
```

### 2.1 `package.json`

```jsonc
{
  "name": "my-plugin",              // ★ 必须与 client.js 里 load({ id }) 逐字一致
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",  // ★ dsh.client 的 bundle 出口，缺了它 client 不加载
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // ★ 不写 = 不被当 bundle 装配
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-slots"]  // 包名级依赖边，影响 factory 到达顺序
    }
  }
}
```

两个 `dsh.*` 字段是**全部**装配声明的来源，作用完全不同：

| 字段 | 作用 | 漏写的结果 |
| --- | --- | --- |
| `dsh.bundle.patch` | 让 loader 认这个包是 bundle，并读它的 patch | 包被装上但**不进启动图**；host 与 client 一起缺席，且不报错 |
| `dsh.client.platform` | 让 host 的 ClientModuleRegistry 把它当 web client 模块 | 只有 host 半边；浏览器侧永远不加载 |

**【官方】** `dsh.client` 的三个可用键：`platform: 'web'`、可选 `inject`（包名级依赖边，用于 factory 到达顺序）、可选 `immediately`（标 stage-one 预取）。原始说明见 `docs/official/reference_subsystems_client-modules.md`。

### 2.2 `cordis.patch.yml`

```yaml
- insert:
    - id: my-plugin          # 短名，用于行寻址（改名 = 换一个实例）
      name: my-plugin        # ★ 完整包名，必须与 package.json 的 name 一致
```

**【踩坑】** 空列表 `[]` 是合法写法，含义是「本 bundle 不装配任何东西」——**不报错**。如果你的 patch 被误清成 `[]`，插件会彻底消失且日志干净。

### 2.3 `lib/index.js`（host 面，可以什么都不干）

```js
export const name = "my-plugin";

/**
 * host 侧入口。纯 UI 插件这里可以保持为空：
 * 左栏入口与面板全部由 client 半边提供。
 */
export function apply() {
  // 预留：注册服务、web 路由、子进程等
}

export const inject = [];
```

**【官方】** host 插件是标准 Cordis 插件：`export const name`、`export function apply(ctx)`、可选 `export const inject = [...]`（填 **Cordis 服务名**，不是包名）。

### 2.4 `lib/client.js`（client 面）

```js
window.__ModuleLoader__.load({
  id: "my-plugin",                       // ★ 与 package.json name 逐字一致
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    function MyPanel() {
      return h("div", { style: { padding: 16 } }, "hello from my-plugin");
    }

    function MyIcon(props) {
      const size = (props && props.size) || 18;
      return h("svg", {
        width: size, height: size, viewBox: "0 0 24 24",
        fill: "none", stroke: "currentColor", strokeWidth: 1.6,
      }, h("circle", { cx: 12, cy: 12, r: 9 }));
    }

    function apply(ctx) {
      // ① 左栏一行
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          { name: "sidebar.panellist", id: "my-plugin", order: 100, label: () => "我的插件" },
          MyIcon,
        ),
      );
      // ② 主面板（keyed，key 用同一个 id）
      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: "my-plugin" }, MyPanel),
      );
    }

    return { apply, inject: ["slots"] };
  },
});
```

这四行结构是全部要点，逐条解释见第 4 节。

### 2.5 `scripts/client-register-test.mjs`（离线契约测试）

`node --check` 只查语法，查不出「factory 物化时抛异常」这类运行期问题。**必须**有一个假 DOM + 假 `__ModuleLoader__` 的离线测试：把 `client.js` 读进来、在 `vm` 里跑、断言 `load()` 被调用、工厂返回 `{ apply, inject }`、`apply` 不抛、两个 slot 都注册了、注册项字段对得上。

本仓库的可工作版本：`packages/dsh-deepseek-browser/scripts/client-register-test.mjs`（15 项断言，改插件时复制过去改名即可）。

---

## 3. client bundle 的加载契约

### 3.1 只有这一种形态

**【官方】** client bundle 是**普通脚本**（不是 ESM），加载即执行，只做一件事：把自己挂到全局模块表上。

```js
window.__ModuleLoader__.load({
  id: "<包名>",
  factory: (require) => {
    // require 是 DS 的模块表查询函数：可 require("react") 和宿主暴露的包
    // 这里在「apply 世界」里，不能碰 DOM 之外的宿主全局
    return { apply, inject: [...] };
  },
});
```

`factory` 的返回值就是 Cordis 插件的形态：`apply(ctx)` + `inject`。**注意两个 inject 不是一个东西**：

| 位置 | 填什么 | 语义 |
| --- | --- | --- |
| `package.json` → `dsh.client.inject` | **包名**，如 `@deepseek-ai/dsh-client-ui-slots` | 依赖边：决定 factory 到达顺序 |
| `client.js` → `return { inject }` | **Cordis 服务名**，如 `"slots"` | 服务注入：`ctx.slots` 可用 |

把包名写进第二个位置，`ctx.slots` 就是 `undefined`。

### 3.2 `id` 必须逐字一致

`load({ id })` 的 `id` 会被当作浏览器模块 id 使用；与 `package.json` 的 `name` 不一致时，模块表里查不到，插件**不激活**，而且报错信息很不指向（常见为 `1 entry did not activate`）。

### 3.3 bundle 路由与 rev

**【官方】** bundle 走 `GET /plugins/??<包名>/client.js,<包名2>/client.js&rev=<rev>`，`rev` 从文件系统元数据派生；未知/被改动的资源列表、缺失 rev、**陈旧 rev 一律 404**，绝不会把 HTML 当 JS 返回。首次 `GET` 才拼接，响应长期 immutable 缓存。

**【实测】** 桌面版 DSH NEXT 的 web server 对普通 HTTP 客户端回：

```text
403 Browser access is disabled
```

因为窗口本身走 `dsh-app://app/` 内部协议，不走 `127.0.0.1:34423` 这个端口。**别拿 curl 去探测端口当成验收**（见第 6 节）。

---

## 4. Slot 体系（本文只需要会用的部分）

**【官方】** 完整文档：`docs/official/reference_subsystems_slots.md`。

### 4.1 两个维度

| 维度 | 取值 | 含义 |
| --- | --- | --- |
| cardinality | `single` | 单个 cell，priority 胜者渲染 |
| | `list` | 由必填 `id` 定址，先按 `order`、再按注册顺序排列 |
| | `keyed` | owner 传 `entryKey`，匹配 cell 以该 key 的 props 渲染 |
| | `chain` | 每项提供 `select(owner)`，第一个非 null 结果获选 |
| scope | `root` | 一个 root 作用域组件与 store |
| | `session` / `session-maybe` | 绑定到会话；`session-maybe` 允许无 binding |

`priority` 对前三种是「遮蔽优先级」，对 `chain` 是选举顺序；**数值越小越先运行或渲染**。

### 4.2 注册的唯一正确姿势

```js
ctx.slots.inject("sidebar.panellist", () =>
  ctx.slots.register({ name: "sidebar.panellist", id: "my-plugin", order: 100, label: () => "..." }, Icon),
);
```

- **必须先 `inject` 再 `register`**。`inject(key, callback)` 会在「该 slot 被声明」的每段生命周期里运行 callback：owner 折叠时你的贡献跟着移除，owner 重新挂载时再跑一次。
- 宿主**还没声明**这个 slot 时直接 `register`，贡献会被**静默丢弃**（官方原话：向未声明 slot 注册会在插件激活时失败/被丢弃）。
- **向其他包的 slot 贡献永远用 `inject`**，不要直接 `register`。

### 4.3 注册项字段

| 字段 | 用途 |
| --- | --- |
| `name` | slot 全名，如 `sidebar.panellist`、`main` |
| `id` | list 的定址键（可选但强烈建议给，便于后期替换/移除） |
| `order` | 排序权重，小的在前 |
| `label` | 左栏行的文字，**函数** `() => string`（支持本地化与延迟取值） |
| `key` | keyed slot 的定址键（`main` 用这个） |
| `children` | 声明子 slot（本文用不到） |
| `inject` | 组件私有的数据/callback 工厂（把 service 投影成 props） |
| `store` / `locale` | 共享视图状态 / 本地化命名空间 |

**【官方】** 组件**永远不会收到 `ctx`**。需要的数据要么走注册项 `inject`（闭包捕获 service，只返回数据与 callback），要么走 owner props。

---

## 5. 左栏导航与主面板：实测坐标

### 5.1 左栏每一行 = `sidebar.panellist` 的一条注册

**【实测】** 在抽取出来的内核 client bundle 里逐包比对，量出当前安装的行序：

| 行 | 拥有包 | order |
| --- | --- | --- |
| 插件 | `dsh-plugin-manager` | `0` |
| 插件市场 | `@dsh-external/dshmarket` | `1` |
| 技能管理 | `@michengai/dsh-skills-manager` | `2` |
| 归档管理器 | `@michengai/dsh-archive-manager` | `4` |
| 自动化任务 | `dsh-plugin-schedule` | `10` |
| 上下文洞察 | `dsh-plugin-context` | `20` |
| **更多** | `dsh-client-ui-entry-customization`（`sidebar.panellist.actions`） | 末尾 |

- 新入口的 `order` 取**两值之间**或大于 20（本文插件取 `100`，正好落在「更多」上方）。
- 「更多」不是一个 slot 行，而是 `sidebar.panellist.actions` 这个 list slot 的呈现：**只要有任何包往它注册，按钮就出现**；没有注册项时按钮不出现。

### 5.2 主面板 = `main` 的 keyed slot

**【实测】** `main` 是 `root` 作用域下的 keyed slot，会话面板用 `key: "conversation"`。插件用**同一个 id** 作为 key 注册自己的面板：

```js
ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "my-plugin" }, MyPanel));
```

点左栏入口时，宿主把 `main` 的 `entryKey` 切成你的 key，你的面板就占满主区。面板组件应当 `height:100%`、自己处理内部滚动。

### 5.3 图标组件的约定

`sidebar.panellist` 的组件是**纯图标元素**（不带文字，文字由 `label` 提供）。宿主会传 `size` 之类的 props，**必须容忍空 props**（`(props && props.size) || 18`），因为不同版本传的字段不同。用 `currentColor` 描边，跟随主题。

---

## 6. 内嵌网页：`<webview>` 而不是 iframe

这是本类插件最容易走错的一步。结论先给：**桌面端用 Electron `<webview>`，不要用 iframe。**

### 6.1 证据链

| 事实 | 来源 |
| --- | --- |
| `chat.deepseek.com` 回 `Content-Security-Policy: frame-ancestors 'none'` | 站点响应头（实测） |
| 主窗口 `webPreferences.webviewTag = "primary"`（`true` 的细化形式） | 【实测】内核 `main.js` L4889–4890 |
| **每个 `<webview>` 挂载都要过主进程的租约校验，否则被 `preventDefault()` 静默拒绝** | 【实测】`app.asar` → `lib/browser-guests.js` 的 `will-attach-webview` 处理器 |
| 渲染侧提供 `window.dshDesktop.browser = { acquire, release, onOpenRequested }` | 【实测】`lib/preload-app.cjs` L475–479 |
| 主窗口 `setWindowOpenHandler` 一律 `deny` 并转 `openExternal` | 【实测】`main.js` L4953 |
| `will-navigate` 只放行 `dsh-app://app/` | 【实测】`main.js` L4957 |

后果：

- **iframe 一律被拒**（`frame-ancestors 'none'`），页面上表现为「加载失败 / 空白 / 被拒绝连接」，控制台会明确报 CSP 违规；
- **`<webview>` 不受 frame-ancestors 约束**，它是独立 WebContents，等价于开了一个真实浏览器：登录态、输入法、文件上传、剪贴板、下载都按真实行为走；
- **目标站点的外链点击会跳系统浏览器**（`setWindowOpenHandler` → `openExternal`）。这是 DSH 的既定策略，不是插件 bug。

### 6.2 必须走 guest broker：裸 `<webview src="https://...">` 一定白屏

这一节是本仓库踩过的最贵一课。DSH NEXT 桌面版主进程在 primary window 上装了 `will-attach-webview`，
对**每一个** webview attach 做强制校验，逻辑等价于：

```js
// app.asar → lib/browser-guests.js（bind(window, attachInput) 内）
const id = params.src.startsWith("about:blank#") ? params.src.slice(12) : "";
const lease = this.leases.get(id);
if (lease === undefined || lease.owner !== owner || lease.attached
    || params.partition !== lease.partition) {
  event.preventDefault();   // ← 元素根本不挂载
  return;
}
lease.attached = true;
// 同时强制 webPreferences：contextIsolation=true / nodeIntegration=false / sandbox=true …
```

也就是说：

- `src` 必须是 `about:blank#<leaseId>`，`<leaseId>` 必须是主进程发过的租约；
- `partition` 必须**逐字等于**主进程随租约一起下发的那个分区名；
- 一个租约只能 attach 一次（`lease.attached` 之后不可复用）；
- 三项任一不符 → `preventDefault()` → **webview 不挂载、不报错、不抛异常**，
  页面上就是白屏 + 一直「加载中…」。这比抛错难查得多。

正确链路（三步，顺序不能换）：

```js
// 1) 申请租约。参数是「workspace 标识」，主进程按这个字符串复用同一个分区。
const { lease, partition } = await window.dshDesktop.browser.acquire("my-plugin-workspace");

// 2) 三个属性必须在 append 之前写好（校验发生在 append 那一刻）
const element = document.createElement("webview");
element.setAttribute("name", lease);
element.setAttribute("partition", partition);
element.setAttribute("allowpopups", "");
element.setAttribute("src", "about:blank#" + lease);
container.appendChild(element);

// 3) 等 dom-ready 之后再导航到真正的目标地址
element.addEventListener("dom-ready", () => element.loadURL("https://chat.deepseek.com/"));

// 4) 卸载时必须归还租约，否则主进程里留下已 attach 的死租约
await window.dshDesktop.browser.release(lease);
```

要点：

1. **`acquire` 返回的对象是 `{ lease, partition }`**，两个都要用；`partition` 不要自己编，也不要加 `persist:` 前缀（主进程发什么就用什么）。
2. **分区是按 workspace 字符串分配的进程内存储**（形如 `dsh-sidebar-browser-<uuid>`，没有 `persist:` 前缀 ⇒ 内存态）。含义是：同一进程内切站点、切面板都不丢登录态；**重启应用后要重新登录**。这是 DSH 的隔离策略，插件侧绕不开，也不该绕。
3. **切站点只 `loadURL`，不重建元素**：租约一次性，重建元素必须重新 acquire；重建还会丢滚动位置。
4. `did-fail-load` 里要忽略 `errorCode === -3 / 0`（`ERR_ABORTED`，同一 guest 连续导航的正常中止）。
5. **guest 内部的 `window.open` 不会自己开窗**：主进程对所有 guest 都装了 `setWindowOpenHandler`（一律 `deny`）。要接住外链，用 `browser.onOpenRequested(lease, (url) => window.open(url))`，主窗口会把它转 `openExternal`。
6. 面板首次渲染时租约可能还没到，**导航请求要排队**（`pendingUrl`，`dom-ready` 时再 `loadURL`），否则首屏那个 URL 会被静默丢掉。

### 6.3 纯 Web 环境的降级

`dsh web`（浏览器里打开）**没有** `window.dshDesktop.browser`，也没有可用的 `<webview>`。插件必须检测并给出说明，而不是白屏：

```js
const desktop = globalThis.dshDesktop;
const bridge = desktop && desktop.browser;
if (!bridge || typeof bridge.acquire !== "function") {
  // 渲染一段可读提示：内嵌网页版需要 DSH 桌面窗口，并给出站点 URL 与「交给系统浏览器」按钮
}
```

注意两点：

- 判断依据是**桥是否存在**，不是 `document.createElement("webview").constructor.name`（后者在有 tag 但无租约时仍会误导）；
- 降级态一旦设置，**不要在导航 effect 里被 `setBlocked(null)` 覆盖**（本仓库真踩过：创建 effect 设了降级，导航 effect 又清掉，最后只剩白屏）。只清「可恢复」的阻断态：

```js
setBlocked((current) => (current === null || current.kind === "bridge" ? current : null));
```

> 为什么不用现成的右侧栏浏览器（`@deepseek-ai/dsh-client-ui-sidebar-browser`）：它只占右侧窄栏，不满足「主面板完整网页」的需求。但它的实现是本节的权威样板——它就是走 `acquire` / `about:blank#<lease>` 这套流程的，可以直接对照。

### 6.4 guest 的右键菜单：宿主架构下做不出来

**结论：在 DSH NEXT 当前的插件架构里，第三方插件无法给 guest 加右键菜单。** 两条路都被堵死，而且是架构级的，不是配置问题：

| 路径 | 卡在哪 |
| --- | --- |
| 渲染侧（client 半边） | `<webview>` 不透传 `context-menu` 事件；`dshDesktop` 桥也没有菜单通道 |
| 宿主侧（host 半边） | 插件的 host 代码跑在**子进程**里，根本拿不到 `BrowserWindow` / `Menu` / `webContents` |

依据（都是本机实测，2026-10-28）：

1. **`WebviewTag` 不透传 `context-menu`**：给 `<webview>` 元素加监听器收不到任何东西，只有 guest 自己的 WebContents 才发这个事件，而那个对象在渲染进程里拿不到。
2. **`dshDesktop` 桥没有菜单通道**（`lib/preload-app.cjs` L475–479）：暴露的只有 `{ protocolVersion, browser: { acquire, release, onOpenRequested, onNavigation, setOffsets, setCornerRadii, setBackgroundColor }, keyboard }`。没有任何 IPC 能让插件请求主进程弹菜单。
3. **宿主只给主窗口装了编辑菜单**：`main.js` L4966 `installEditingContextMenu(window.webContents)` 只作用于 primary window；Windows 上连应用菜单都不设（L904 的 `Menu.setApplicationMenu(...)` 包在 `if (process.platform !== "win32")` 里）。
4. **插件 host 是独立子进程**。`desktop-next.log` 里能看到成对的
   ```
   main.next.js: spawned desktop-next-host { pid: 51456 }
   main.next.js: spawned desktop-next-loader { pid: 41524 }
   ```
   插件 `apply()` 里的 `process.pid` **不等于** `main.next.js` 的 pid —— 也就是说 `require("electron")` 拿到的只是 npm 那个壳（`module.exports` 是一段路径字符串），拿不到 `app` / `Menu`。本仓库实测：`electronModules()` 返回 `null`，代码静默降级，日志里没有任何报错，表现就是「右键什么都不发生」。
5. **连官方自己都是走主进程内部 hack**：`dsh-client-ui-sidebar-browser` 的 `memory.ts` 里写着 `hackContextMenu(...)` / `restoreContextMenu()`，注释大意是 —— 直接用 Electron 原生 `webview` 的 ContextMenu 会在悬停时崩溃（`SetApplicationMenu` on `null`），所以官方在主进程里**替换了 `electron-webview` 内部的 `ContextMenu` 类**。这是内核特权，插件拿不到。

**于是本仓库的处理**：`lib/index.js` 保持为空插件（不接线），`lib/context-menu.js` 里那套纯函数（`isSupportedUrl` 白名单 + `menuItemsFor`）留作将来复用 —— 它的测试 `scripts/context-menu-test.mjs` 是纯 Node 的（37 项），不依赖 Electron，随时可跑。

**替代方案**（本插件实际提供的）：

- `Ctrl+V` 粘贴（Blink 原生编辑命令，不受权限层影响）；
- 工具栏的 ↗ 按钮把当前页丢给系统浏览器，那里有完整右键菜单。

**如果宿主未来真的开出菜单通道**，接线时有两个坑必须记住：

- **`contents.paste()` 走原生通道**，直接读系统剪贴板，**不受** `setPermissionRequestHandler(() => false)` 影响 —— 这是 guest 场景唯一可靠的「粘贴」入口。
- **`attached` 用 `WeakSet`**，并且只用 `contents.getType() === "webview"` 收口：`web-contents-created` 会对同一 contents 多次触发，重复监听会弹两个菜单；不限定 type 会污染 DSH 自身窗口。
- **绝不在 host 入口顶层 `import { ... } from "electron"`**（这条是踩出来的，独立成踩坑 13）：插件由宿主的 ESM loader 按路径加载，`electron` 被解析成 node_modules 里 Electron 的 CJS 入口，于是抛
  `SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'`
  → 日志 `failed to import: file:///...lib/index.js` → `1 entry did not activate`，**连 client 半边一起消失**（左栏入口整条不见），而 DSH 本身照常启动，看起来特别像「缓存没刷」。
  正确姿势是 `createRequire(import.meta.url)` + `apply()` 内 `require("electron")` + `try/catch`，让模块加载期永不失败。

---

## 7. 安装落地：四条判据缺一不可

**【实测】** 有些安装包里 `<DSH 安装目录>/resources/runtime` 下只有 `x64\`、没有 `cli\bin\dsh.cmd`，那就走「手装等价路径」。无论用 CLI 还是手装，装好的状态必须同时满足四条：

| # | 判据 | 位置 | 漏了会怎样 |
| --- | --- | --- | --- |
| 1 | `dependencies` 有它，值形如 `link:<源码目录>` 或 `link:<副本目录>` | profile `package.json` | 启动时解析不到包 |
| 2 | `dsh.profile.bundles` 数组里有包名 | profile `package.json` | 包在但你不在启动图 |
| 3 | `node_modules\<包名>` 是指向源码目录的 **junction/symlink** | profile `node_modules` | ESM 解析失败 |
| 4 | 插件目录 `cordis.patch.yml` 里有 `insert` 条目 | 插件目录 | bundle 合法但零装配，不报错 |

路径约定（按你的环境替换）：

```text
profile               ~/.dsh/profiles/<profile 名>
profile 清单          <profile>/package.json
profile patch 层      <profile>/cordis.patch.yml   ← 约 74 KB，改前必须备份
插件运行副本目录      ~/.dsh/plugins-desk-v1/      ← ASCII、与 profile 同盘
```

### 7.1 手装命令（PowerShell 7）

```powershell
# 0) 先把插件源码拷到运行副本目录（ASCII 路径、与 profile 同盘）
$src     = '<仓库根>\packages\dsh-deepseek-browser'
$dst     = "$env:USERPROFILE\.dsh\plugins-desk-v1\dsh-deepseek-browser"
Copy-Item $src $dst -Recurse -Force

# 1) junction
$target = Join-Path "$env:USERPROFILE\.dsh\profiles\<profile 名>" 'node_modules\dsh-deepseek-browser'
if (Test-Path $target) { (Get-Item $target).Delete() }
New-Item -ItemType Junction -Path $target -Target $dst | Out-Null

# 2) profile package.json：dependencies + dsh.profile.bundles 两处都加
#    （改前备份 package.json → package.json.bak-<时间戳>）
```

**【踩坑】** 只改 `dependencies` 不加 `bundles`：装上了但不装配，左栏没有入口，且**日志干净**。只加 `bundles` 不加 junction：启动时 `ERR_MODULE_NOT_FOUND`。

**【踩坑】** 手改 `package.json` 加 dependency，pnpm 会认为 lockfile 不一致，**下次 install 把它剔掉**。手装时三样（deps / junction / bundles）必须同时补，且改完立刻重启验证。

**【踩坑】** 跨盘 + 中文路径的 junction 容易被 pnpm 拒绝。插件副本放 ASCII 路径、与 profile 同盘，源码留在工作区。

### 7.2 生效

```powershell
# 完全退出 DSH（它的每个窗口/进程）再启动，插件只在启动时装配
```

> 桌面版的进程名随安装包而定（例如 `DSH NEXT`）：先 `Get-Process` 找到它，确认路径属于你的安装目录后再 `Stop-Process`。

---

## 8. 验收方法论

### 8.1 不要用 curl 探测端口

**【实测】** `curl http://127.0.0.1:34423/` 回 `403 Browser access is disabled`。桌面窗口走 `dsh-app://app/` 内部协议，这个端口的策略与本窗口无关。**把它当故障会浪费一整天。**

同理，`/plugins/<包>/client.js?rev=` 的 `rev` 由 mtime/ctime/size 派生（不是内容哈希），手算 sha1 拼 URL 一定对不上、一定 404。**别用 URL 探测证明「插件没生效」。**

### 8.2 三态判定

插件「看起来没反应」只有三种，判据完全不同：

| 现象 | 判据 | 结论 |
| --- | --- | --- |
| 左栏**根本没有入口** | 查第 7 节四条判据 | 没进启动图（patch / bundles / junction 之一） |
| 入口在，**面板空白** | client 已加载但 slot 没渲染 | `inject` 缺失或 `register` 早于 slot 声明 |
| 面板**报错/白屏** | 开窗口开发者工具看 console | client 运行期异常（模板串断裂、API 用错） |

### 8.3 看哪里

- 窗口菜单里打开开发者工具（Electron 默认支持），console 里的报错最直接；
- 应用日志目录（`%USERPROFILE%\.dsh\logs` 同族），启动失败时会有 `web boot: N entry did not activate`；
- 启动崩溃时把包名从 `dsh.profile.bundles` **移除即可恢复**（`dependencies` / junction 留着不影响），修好再加回。

---

## 9. 踩坑清单（按出现频率排序）

**① CSS 模板字符串里出现裸反引号**

```js
const CSS = `
  .a { content: "x" }
  /* 注释里也不能有反引号，否则模板串提前终结 */
`;
```

后果：模板串被提前截断 → factory 物化抛 `ReferenceError` → DSH 弹「应用无法启动」/ `web boot: 1 entry did not activate`。**注释里也不要写反引号。**

**② `node --check` 通过 ≠ 能跑**

`a.b - c` 这类表达式语法合法、运行期炸（`undefined` 参与算术）。只有第 2.5 节的离线契约测试能拦住。

**③ 手改 profile `package.json` 只补一处**

见 7.1 三条强调。deps / junction / bundles 是三件套。

**④ 跨盘 + 中文路径的 junction**

pnpm 容易拒绝。插件副本放 `~/.dsh/plugins-desk-v1/`。

**⑤ 把「没反应」当缓存问题**

先查「有没有进启动图」，再查「slot 有没有注册」，最后才看 console。顺序反了会白改代码。

**⑥ 插件把 DSH 搞崩了**

从 `dsh.profile.bundles` 移除包名即可恢复启动。这是唯一的救援开关，记住它。

**⑦ 同一个包名被两个 Loader source 解析到**

**【官方】** 不同 active Loader source 解析到同一包名时，**组合会失败，整页起不来**。常见于「link 版与 npm 版并存」「两份 profile 都装了」。排查时先 `Get-ChildItem node_modules -Filter <包名>` 看有没有多份。

**⑧ 把包名写进 `return { inject }`**

`client.inject` 是 Cordis 服务名（`"slots"`），`package.json` 的 `dsh.client.inject` 才是包名。写反了 `ctx.slots` 是 `undefined`，报错指向 `undefined.register`，很容易误判成「slot 没声明」。

**⑨ 内嵌网页：绕过 guest broker 直接建 `<webview src="https://...">`**

**【实测·本仓库踩过】** 主进程 `will-attach-webview` 要求 `src = about:blank#<lease>`、`partition` 等于
`acquire()` 下发值、且租约未被 attach 过。任一项不符 → `preventDefault()` → **不挂载、不报错**，
表现是白屏 + 永久「加载中…」。详见 6.2。同类隐蔽坑还有两个：

- 面板首屏的 `loadURL` 早于租约到达 → 必须排队到 `dom-ready`；
- 导航 effect 无条件 `setBlocked(null)` → 把「无桌面桥」的降级提示覆盖掉 → 白屏。

**⑩ guest 里没有右键菜单 —— 而且插件的两头都补不了**

**【实测·本仓库踩过 2026-10-28】** 这是**架构限制**，不是配置问题：

- 渲染侧：`WebviewTag` 不透传 `context-menu`，`dshDesktop` 桥也没有菜单通道；
- 宿主侧：插件 host 代码跑在**子进程**（`desktop-next-host`）里，`require("electron")` 只能拿到路径字符串壳，拿不到 `Menu` / `BrowserWindow`。实测 `electronModules()` 返回 `null`，代码静默降级、日志无报错，表现就是「右键什么都不发生」。

连官方自己的右侧栏浏览器都是靠主进程内部 `hackContextMenu`（替换 `electron-webview` 的 `ContextMenu` 类）实现的，属于内核特权。所以本插件**不提供右键菜单**：粘贴用 `Ctrl+V`（Blink 原生编辑命令，不受权限层影响），完整右键菜单用工具栏 ↗ 交给系统浏览器。详见 6.4。

「页面里 Ctrl+C / Ctrl+V 能用」和「`navigator.clipboard` 不能用」并不矛盾：前者是 Blink 原生编辑命令、不过权限层；后者受 `configureSession` 里那个 `setPermissionRequestHandler(() => false)` 限制。别把「剪贴板不可用」当成整站剪贴板都坏。

**⑪ 顶层 `import { BrowserWindow } from "electron"` —— 插件入口整条消失**

**【实测·本仓库踩过 2026-10-28】** host 半边为了挂右键菜单，在 `lib/index.js` 顶层写了
`import { BrowserWindow, Menu, app, shell, webContents } from "electron"`。宿主的 ESM loader 把 `electron`
解析到 node_modules 里 Electron 的 CJS 入口（`module.exports` 是一段**路径字符串**），于是：

```text
SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'
→ failed to import: file:///C:/Users/.../dsh-deepseek-browser/lib/index.js
→ web boot: 1 entry did not activate
```

后果比报错更迷惑：**client 半边跟着一起不装配，左栏入口整条消失**，而 DSH 本身照常启动。
所以看到「入口突然没了」，第一件事是打开 `~/.dsh/logs/desktop-next.log` 搜 `failed to import`，
**不要**先去怀疑缓存、rev、bundles。

修法：顶层只留 `node:module` 与自有文件，`const require = createRequire(import.meta.url)`，
在 `apply()` 里 `require("electron")` + `try/catch`，取不到就 `return`（入口仍在，只是没有右键菜单）。
完整样例见 6.4。

---

## 10. 排障决策树

```text
左栏没有入口？
├─ 第 0 步（永远先做这个）→ 打开 <DSH_HOME>\logs\desktop-next.log，搜「failed to import」「did not activate」
│        └─ 命中 failed to import: file:///...你的插件 → 插件入口代码在**加载期**就抛了
│           （最常见：顶层 import electron，见 6.4 与 ⑪）→ 修代码，别查缓存
├─ 右键菜单不弹？（这是架构限制，别再试了）
│        └─ 看 6.4：渲染侧传不出 context-menu，host 半边在子进程里拿不到 Menu
│           → 现状：本插件不提供右键菜单，用 Ctrl+V / ↗ 系统浏览器
├─ 日志干净 → profile package.json 的 dsh.profile.bundles 有包名吗？
│        ├─ 没有 → 加上（并确认 package.json 备份过）
│        └─ 有  → dependencies 有吗？
│                 ├─ 没有 → 加上 link:，补 junction
│                 └─ 有  → node_modules\<包名> 存在且指向源码吗？
│                          ├─ 没有 → 补 junction
│                          └─ 有  → 插件 cordis.patch.yml 有 insert 吗？
│                                   ├─ 没有/为 [] → 补上
│                                   └─ 有 → 看应用日志的 entry 报错
└─ 入口在但面板空白？
         ├─ 是 → 面板里有 <webview> 吗？
         │        ├─ 有 → 它走了 dshDesktop.browser.acquire 吗？（无 → 见 6.2，白屏是必然）
         │        └─ 无 → client.js 里 main 的 register 是否包在 inject 回调里？
         │                 ├─ 否 → 改成 ctx.slots.inject("main", () => register(...))
         │                 └─ 是 → key 是否与左栏 id 一致？
         └─ 否 → 面板报错 → 开开发者工具看 console
                  ├─ ReferenceError at factory → 找裸反引号/模板串断裂
                  ├─ undefined.register → inject 用了包名
                  └─ 其它 → 全文搜索报错里的函数名
```

---

## 11. 官方文档地图（离线副本在 `docs/official/`）

| 文件 | 讲什么 | 站上路径 |
| --- | --- | --- |
| `reference_index.md` | 参考总目录（19 K） | `reference/index.md` |
| `reference_subsystems_index.md` | 子系统目录 | `reference/subsystems/index.md` |
| `reference_subsystems_slots.md` | **Slot 体系全文**：cardinality / scope / props / inject / 层级 | `reference/subsystems/slots.md` |
| `reference_subsystems_client-modules.md` | **client 模块系统**：`dsh.client` 扫描、`__DSH_BOOT__`、bundle 路由与 rev | `reference/subsystems/client-modules.md` |
| `reference_subsystems_web-client.md` | Web Client 架构、启动、Remote、数据通路 | `reference/subsystems/web-client.md` |

抓取方式（官方文档站直出 Markdown，不要抓 HTML）：

```powershell
Invoke-WebRequest -Uri 'https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots.md' -OutFile 'docs/official/reference_subsystems_slots.md'
```

---

## 12. 发布前检查表

写一个 DSH 客户端插件、准备交付之前，逐条打勾：

- [ ] `package.json` 的 `name` 与 `client.js` 里 `load({ id })` **逐字一致**
- [ ] `dsh.bundle.patch` 指向存在的 `cordis.patch.yml`，其中 `insert[].name` 等于包名
- [ ] `dsh.client.platform === "web"`，`exports["./client"]` 指向 bundle
- [ ] `cordis.patch.yml` 不是空列表，`insert` 条目在
- [ ] `lib/index.js` 与 `lib/client.js` 都过 `node --check`
- [ ] 离线契约测试通过（factory 物化 + apply 不抛 + slot 注册字段齐全）
- [ ] 左栏行 `order` 不与现有行冲突（本机参考值：0/1/2/4/10/20）
- [ ] `main` 面板的 key 与左栏 id 一致
- [ ] 所有 slot 注册都包在 `ctx.slots.inject(...)` 里
- [ ] client 返回的 `inject` 是**服务名**（`"slots"`），不是包名
- [ ] 内嵌网页走 `<webview>`（`partition: "persist:..."`），有纯 Web 环境降级提示
- [ ] `did-fail-load` 忽略 `errorCode === -3`
- [ ] 插件副本在 ASCII 路径、与 profile 同盘
- [ ] profile 三件套（deps / junction / bundles）齐备，且改前备份过 `package.json`
- [ ] 重启后左栏出现入口、面板能打开目标站点、登录态在重启后保留
- [ ] 卸载路径清楚：从 `dsh.profile.bundles` 移除即可恢复启动

---

## 13. 本仓库作为活样例

`packages/dsh-deepseek-browser/` 是把本文全部结论落地的一份可运行实现：

- 左栏入口（`sidebar.panellist`，order 100，落在「更多」上方）；
- 主面板（`main` keyed slot）内嵌 `<webview>`，默认站点 DeepSeek，可增删切换到 Kimi / 千问 / 豆包 / 智谱清言，以及 ChatGPT / Claude / Gemini / Grok / Copilot / Perplexity；
- 站点清单保存在 `localStorage`（`dsh-deepseek-browser.sites.v1`），登录态在 `persist:dsh-deepseek-browser` 分区；
- 纯 Web 环境自动降级为说明页；
- 离线契约测试 15 项。

改它之前先读本文件第 9 节，再读 `AGENTS.md` 的「踩坑」。
