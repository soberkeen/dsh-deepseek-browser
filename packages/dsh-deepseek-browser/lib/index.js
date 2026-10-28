/**
 * dsh-deepseek-browser — host（进程侧）入口。
 *
 * 现在这里**只做一件事**：保持最小合法插件形态（name / inject / apply），
 * 让本包进入 loader 树 —— client 半边（左栏入口 + 主面板）依赖这条 entry 存在。
 * 任何一行在模块加载期抛异常的代码，都会让 entry 加载失败，进而让 client 半边
 * 一起消失（左栏入口整条不见），所以这里刻意留空。
 *
 * ── 为什么这里没有「给 guest 补右键菜单」（2026-10-28 结论，别再试第二轮）──
 *
 * 原方案：在主进程用 contents.on("context-menu") + Menu.popup() 给 webview 弹原生菜单。
 * 实测不可行，两条互相独立的硬限制：
 *
 * 1. **host 侧拿不到 Electron API**。DSH NEXT 把 host 插件跑在独立子进程里，
 *    createRequire(import.meta.url)("electron") 直接失败，运行日志：
 *      [error] [dsh-deepseek-browser] 取不到 electron 模块，右键菜单不可用
 *      Error: Cannot find module 'electron'
 *      查找路径 ...\plugins-desk-v1\dsh-deepseek-browser\lib\index.js
 *    也就是说 host 进程里没有 BrowserWindow / Menu / webContents 可用，
 *    原生菜单这条路从根上走不通（不是写法问题）。
 *
 * 2. **渲染侧接不住 guest 的右键事件**。WebviewTag 不透传 context-menu，
 *    dshDesktop 桥（lib/preload-app.cjs L475-479）暴露的只有
 *    { protocolVersion, browser: { acquire, release, onOpenRequested, onNavigation,
 *      setOffsets, setCornerRadii, setBackgroundColor }, keyboard }，
 *    没有任何菜单/剪贴板通道。宿主也只给主窗口装了编辑菜单
 *    （main.js L4966 installEditingContextMenu(window.webContents)）。
 *
 * 用户决定（2026-10-28）：「先不做，用 Ctrl+V」。网页内 Ctrl+C / Ctrl+V 是 Blink
 * 原生编辑命令，不受 guest 的 setPermissionRequestHandler(() => false) 影响，本来就能用；
 * 不能用的只是网页自己调 navigator.clipboard（例如「粘贴并提问」按钮）。
 *
 * 如果将来真要菜单，唯一可行方向是「在 guest 页面里注入脚本接住 contextmenu，
 * 在宿主 UI 画 HTML 菜单，粘贴由宿主读剪贴板再注入输入框」。lib/context-menu.js
 * 与 scripts/context-menu-test.mjs 是那一刻留下的纯函数与测试（零 Electron 依赖），
 * 可以复用；但**不要**再把它们接回这里的模块顶层。
 */

export const name = "dsh-deepseek-browser"

export const inject = []

export function apply() {
	// 有意留空：本插件的能力全在 client 半边。
	//
	// 历史教训：这里曾经 import / require Electron 来挂右键菜单，
	// 结果 entry 加载失败 → 左栏入口消失。要加 host 侧能力前，
	// 先确认该 API 在 host 子进程里真的存在。
}
