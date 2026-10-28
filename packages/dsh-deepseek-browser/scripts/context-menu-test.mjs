/**
 * 【当前未启用 · 2026-10-28】host 侧右键菜单逻辑的离线测试（不依赖 electron，可在纯 Node 里跑）。
 *
 *   node scripts/context-menu-test.mjs
 *
 * 它测的 lib/context-menu.js 目前没有被 lib/index.js 引用：宿主 host 子进程里
 * 没有 Electron API，原生菜单做不出来（详见 lib/context-menu.js 顶部结论）。
 * 测试保留，是因为白名单匹配与菜单项生成逻辑将来「注入式自绘菜单」也能直接复用。
 *
 * 覆盖两件事：
 *   1. 白名单匹配：子域命中、近似域名不误命中、非 http(s) 一律不命中；
 *   2. 菜单项生成：可编辑 / 只读有选中 / 空白 / 链接 / editFlags 关闭 五种形态。
 *
 * 之所以把逻辑抽到 lib/context-menu.js（纯函数），就是为了让这里能在没有
 * Electron 运行时的环境里直接跑 —— Menu/popup/webContents 那些在 index.js 里，
 * 只能靠重启后目视验收。
 */

import { ALLOWLIST, isSupportedUrl, menuItemsFor } from "../lib/context-menu.js"

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail) {
	if (condition) {
		passed += 1
		console.log("PASS  " + name)
		return
	}
	failed += 1
	const note = detail === undefined ? "" : "  — " + detail
	failures.push(name + note)
	console.log("FAIL  " + name + note)
}

function eq(name, actual, expected) {
	check(name, Object.is(actual, expected), "期望 " + String(expected) + "，实际 " + String(actual))
}

/** 收集 actions 的调用记录。 */
function recorder() {
	const calls = []
	const make = (key) => () => calls.push(key)
	return {
		calls,
		actions: {
			undo: make("undo"),
			redo: make("redo"),
			cut: make("cut"),
			copy: make("copy"),
			paste: make("paste"),
			selectAll: make("selectAll"),
			reload: make("reload"),
			openExternal: (url) => calls.push("openExternal:" + url)
		}
	}
}

const labelsOf = (items) => items.filter((item) => item.type !== "separator").map((item) => item.label)
const itemNamed = (items, label) => items.find((item) => item.type !== "separator" && item.label === label)

console.log("=== 白名单匹配 ===")

eq("ALLOWLIST 含 deepseek.com", ALLOWLIST.includes("deepseek.com"), true)
eq("chat.deepseek.com 命中", isSupportedUrl("https://chat.deepseek.com/"), true)
eq("platform.deepseek.com 命中", isSupportedUrl("https://platform.deepseek.com/usage"), true)
eq("带路径与查询串命中", isSupportedUrl("https://www.kimi.com/chat/abc?from=x#top"), true)
eq("裸 http 命中", isSupportedUrl("http://metaso.cn/"), true)
eq("大小写混写命中", isSupportedUrl("https://CHAT.DeepSeek.COM/"), true)
eq("近似域名 evil-deepseek.com 不命中", isSupportedUrl("https://evil-deepseek.com/"), false)
eq("后缀拼接 deepseek.com.evil.com 不命中", isSupportedUrl("https://deepseek.com.evil.com/"), false)
eq("about:blank 不命中", isSupportedUrl("about:blank"), false)
eq("租约占位页不命中", isSupportedUrl("about:blank#abc-123"), false)
eq("ftp 协议不命中", isSupportedUrl("ftp://deepseek.com/x"), false)
eq("dsh-app 协议不命中", isSupportedUrl("dsh-app://app/index.html"), false)
eq("空串不命中", isSupportedUrl(""), false)
eq("null 不命中", isSupportedUrl(null), false)
eq("数字不命中", isSupportedUrl(12345), false)
eq("乱码不命中", isSupportedUrl("not a url"), false)
eq("自定义白名单生效", isSupportedUrl("https://example.org/x", ["example.org"]), true)
eq("自定义白名单不误伤", isSupportedUrl("https://chat.deepseek.com/", ["example.org"]), false)

console.log("\n=== 菜单项：可编辑输入框 ===")

{
	const { calls, actions } = recorder()
	const items = menuItemsFor({
		isEditable: true,
		selectionText: "",
		linkURL: "",
		editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
	}, actions)

	eq("项数（7 个命令 + 3 个分隔符）", items.length, 10)
	eq("标签顺序", labelsOf(items).join("|"), "撤销|重做|剪切|复制|粘贴|全选|重新加载")
	eq("第一项是撤销", items[0].label, "撤销")
	eq("可编辑时没有「在系统浏览器打开链接」", itemNamed(items, "在系统浏览器打开链接"), undefined)
	eq("canRedo=false → 重做禁用", itemNamed(items, "重做").enabled, false)
	eq("canPaste=true → 粘贴可用", itemNamed(items, "粘贴").enabled, true)

	for (const label of ["撤销", "剪切", "复制", "粘贴", "全选", "重新加载"]) itemNamed(items, label).run()
	eq("点击各命令后的调用", calls.join(","), "undo,cut,copy,paste,selectAll,reload")
}

console.log("\n=== 菜单项：只读页面有选中 ===")

{
	const { calls, actions } = recorder()
	const items = menuItemsFor({
		isEditable: false,
		selectionText: "被选中的一段回答",
		linkURL: "",
		editFlags: { canCopy: true }
	}, actions)

	eq("标签顺序", labelsOf(items).join("|"), "复制|重新加载")
	eq("没有粘贴项", itemNamed(items, "粘贴"), undefined)
	eq("没有剪切项", itemNamed(items, "剪切"), undefined)

	itemNamed(items, "复制").run()
	eq("复制只调 copy", calls.join(","), "copy")
}

console.log("\n=== 菜单项：右键空白处 ===")

{
	const { actions } = recorder()
	const items = menuItemsFor({ isEditable: false, selectionText: "   ", linkURL: "", editFlags: {} }, actions)
	eq("只有重新加载", labelsOf(items).join("|"), "重新加载")
}

console.log("\n=== 菜单项：链接上 ===")

{
	const { calls, actions } = recorder()
	const items = menuItemsFor({
		isEditable: false,
		selectionText: "",
		linkURL: "https://platform.deepseek.com/top_up",
		editFlags: { canCopy: true }
	}, actions)

	eq("链接项在最前", items[0].label, "在系统浏览器打开链接")
	items[0].run()
	eq("点击后交给系统浏览器", calls.join(","), "openExternal:https://platform.deepseek.com/top_up")
}

console.log("\n=== 菜单项：非 http 链接不出现 ===")

{
	const { actions } = recorder()
	const items = menuItemsFor({ isEditable: false, selectionText: "", linkURL: "javascript:alert(1)", editFlags: {} }, actions)
	eq("javascript: 链接被过滤", itemNamed(items, "在系统浏览器打开链接"), undefined)
}

console.log("\n=== 菜单项：editFlags 缺失时的兜底 ===")

{
	const { actions } = recorder()
	const items = menuItemsFor({ isEditable: true, selectionText: "", linkURL: "" }, actions)
	eq("缺 editFlags 时命令默认可用", items.filter((item) => item.type !== "separator").every((item) => item.enabled !== false), true)
}

console.log("\n=== 菜单项：形状合法 ===")

{
	const { actions } = recorder()
	for (const params of [
		{ isEditable: true, selectionText: "", linkURL: "" },
		{ isEditable: false, selectionText: "x", linkURL: "" },
		{ isEditable: false, selectionText: "", linkURL: "https://a.b/" }
	]) {
		const items = menuItemsFor(params, actions)
		const shapesOk = items.every((item) => item.type === "separator" || (typeof item.label === "string" && item.label !== "" && typeof item.run === "function"))
		check("每一项要么是分隔符，要么有 label + run", shapesOk)
	}
}

console.log("\n=== 汇总 ===")
console.log("通过 " + passed + "，失败 " + failed + "，共 " + (passed + failed) + " 项")

if (failed > 0) {
	for (const failure of failures) console.log("  × " + failure)
	process.exitCode = 1
} else {
	console.log("=== 全部通过 ===")
}
