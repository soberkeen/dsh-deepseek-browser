/**
 * 【当前未启用 · 2026-10-28】guest 右键菜单的纯逻辑（不 import electron，可在 Node 里直接单测）。
 *
 * 为什么不启用：DSH NEXT 的 host 插件跑在独立子进程里，那里 `require("electron")`
 * 直接失败（Cannot find module 'electron'），拿不到 Menu / webContents；
 * 渲染侧又接不住 guest 的 context-menu 事件。两条路都堵死，所以用户决定
 * 「先不做，用 Ctrl+V」，lib/index.js 也不再引用本文件。
 *
 * 保留原因：逻辑本身是对的（白名单匹配 + 菜单项生成），将来若改走「guest 内注入
 * 自绘菜单」的路线，可以直接复用这里的判断；测试 scripts/context-menu-test.mjs 仍可跑。
 * **不要**把它接回 lib/index.js 的模块顶层 —— 那会让 entry 加载失败、左栏入口消失。
 *
 * 下面是原始设计说明（历史）：
 *
 * 背景：DSH 内核只给主窗口的 webContents 装了编辑菜单（main.js 的
 * installEditingContextMenu），guest（webview）没有；WebviewTag 也不透传
 * context-menu 事件，所以渲染侧拿不到。host 侧插件跑在主进程，可以给 guest
 * 挂 'context-menu' 并弹原生菜单 —— 这也是唯一能做出「粘贴」的路径：
 * webContents.paste() 走原生通道直接读系统剪贴板，不经过 guest 的权限 handler。
 * （注：上面这段「host 侧插件跑在主进程」的前提已被证伪，见顶部结论。）
 *
 * 本文件只负责两件事：
 *   1. 判断某个 URL 是否属于允许弹菜单的站点（白名单）；
 *   2. 根据 Chromium 给的 params 生成菜单项描述。
 * 真正的 Menu / popup / webContents 调用在 index.js。
 */

/**
 * 允许弹右键菜单的站点（按**注册域**写，子域自动命中）。
 *
 * 增删规则：
 *   - 写注册域，不要写 `chat.deepseek.com` 这种完整主机名，否则登录跳转到
 *     `platform.deepseek.com`、分享页 `chat.deepseek.com/share/...` 之外的域就会漏；
 *   - 不带协议、不带路径、不带端口；
 *   - 在面板里「+ 添加」了新站点，需要把它的注册域补到这里，然后重启 DSH。
 */
export const ALLOWLIST = [
	"deepseek.com",
	"kimi.com",
	"moonshot.cn",
	"qianwen.com",
	"tongyi.com",
	"doubao.com",
	"chatglm.cn",
	"zhipuai.cn",
	"metaso.cn"
]

/**
 * URL 是否命中白名单。
 *
 * 只接受 http/https；`about:blank`（租约占位页）与 `dsh-app:` 一律不命中。
 * 匹配用「等于注册域」或「以 .注册域 结尾」，因此 `evil-deepseek.com`
 * 与 `deepseek.com.example.com` 都不会误命中。
 *
 * @param {unknown} rawUrl 待判断的 URL
 * @param {readonly string[]} [allowlist] 注册域列表，默认 ALLOWLIST
 * @returns {boolean}
 */
export function isSupportedUrl(rawUrl, allowlist = ALLOWLIST) {
	if (typeof rawUrl !== "string" || rawUrl === "") return false
	let parsed
	try {
		parsed = new URL(rawUrl)
	} catch {
		return false
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false
	const hostname = parsed.hostname.toLowerCase()
	if (hostname === "") return false
	for (const candidate of allowlist) {
		const domain = String(candidate).trim().toLowerCase()
		if (domain === "") continue
		if (hostname === domain) return true
		if (hostname.endsWith("." + domain)) return true
	}
	return false
}

/** @typedef {{ type: "separator" } | { label: string, enabled?: boolean, run: () => void }} MenuItem */

/**
 * 按 Chromium 的 params 生成菜单项。
 *
 * 分组：
 *   链接（若有）→ 撤销/重做 → 剪切/复制/粘贴 → 全选 → 重新加载
 * 只读页面且没有选中、也不是链接时，只给「重新加载」——右键空白处仍然有反馈。
 *
 * @param {{ isEditable?: boolean, selectionText?: string, linkURL?: string, editFlags?: Record<string, unknown> } | null | undefined} params
 * @param {{
 *   undo: () => void, redo: () => void, cut: () => void, copy: () => void,
 *   paste: () => void, selectAll: () => void, reload: () => void,
 *   openExternal: (url: string) => void
 * }} actions
 * @returns {MenuItem[]}
 */
export function menuItemsFor(params, actions) {
	const flags = params !== null && typeof params === "object" && params.editFlags !== null && typeof params.editFlags === "object" ? params.editFlags : {}
	const isEditable = params !== null && typeof params === "object" && params.isEditable === true
	const selectionText = params !== null && typeof params === "object" && typeof params.selectionText === "string" ? params.selectionText : ""
	const linkURL = params !== null && typeof params === "object" && typeof params.linkURL === "string" ? params.linkURL : ""

	/** editFlags 缺字段时按可用处理：菜单项可点但点了无效果，比整项灰掉更好。 */
	const can = (key) => flags[key] !== false

	/** @type {MenuItem[]} */
	const items = []

	if (linkURL !== "" && /^https?:\/\//i.test(linkURL)) {
		items.push({ label: "在系统浏览器打开链接", run: () => actions.openExternal(linkURL) })
		items.push({ type: "separator" })
	}

	if (isEditable) {
		items.push({ label: "撤销", enabled: can("canUndo"), run: () => actions.undo() })
		items.push({ label: "重做", enabled: can("canRedo"), run: () => actions.redo() })
		items.push({ type: "separator" })
		items.push({ label: "剪切", enabled: can("canCut"), run: () => actions.cut() })
		items.push({ label: "复制", enabled: can("canCopy"), run: () => actions.copy() })
		items.push({ label: "粘贴", enabled: can("canPaste"), run: () => actions.paste() })
		items.push({ type: "separator" })
		items.push({ label: "全选", enabled: can("canSelectAll"), run: () => actions.selectAll() })
	} else if (selectionText.trim() !== "") {
		items.push({ label: "复制", enabled: can("canCopy"), run: () => actions.copy() })
	}

	items.push({ type: "separator" })
	items.push({ label: "重新加载", run: () => actions.reload() })

	return items
}
