// scripts/client-register-test.mjs
// 离线验证 lib/client.js：在没有 DSH 的前提下，用最小 mock 物化 factory、执行 apply、
// 并用一个 mini hooks 运行时真正「挂载」面板组件，断言：
//   A. 左栏入口 + 主面板两处注册真的发生、描述符字段正确、组件可渲染；
//   B. webview 走的是 DSH 桌面版的 guest broker 租约（这是白屏事故的根因所在）：
//      必须先 dshDesktop.browser.acquire(workspace) 拿 { lease, partition }，
//      再写 name=lease / partition=partition / src="about:blank#"+lease 三个属性，
//      挂进 DOM，等 dom-ready 后 loadURL 目标地址；卸载时 release(lease)。
//
// 为什么必须有这一关：node --check 只查语法。
//   · CSS 模板字符串里一个裸反引号 → 模板串提前终结 → factory 物化抛 ReferenceError；
//   · 属性写错 / 没走租约 → 主进程 will-attach-webview 直接 preventDefault，
//     现象是白屏 + 永久「加载中…」+ 零报错，真机上几乎无法归因。
//
// 用法：node scripts/client-register-test.mjs

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const CLIENT = resolve(ROOT, 'lib/client.js')
const PKG = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))

const EXPECT_ID = PKG.name
const EXPECT_PANEL_ID = 'deepseek-browser'
const EXPECT_ORDER = 100
const EXPECT_WORKSPACE = 'dsh-deepseek-browser'
const EXPECT_URL = 'https://chat.deepseek.com/'
/** 本机实测的 Electron 默认 UA：带应用名与 Electron 版本号，会被站点风控识别。 */
const EXPECT_HOST_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DSH NEXT/2.0.20-next Chrome/140.0.0.0 Electron/44.7.0 Safari/537.36'

let pass = 0
let fail = 0
const failures = []

function check(name, ok, detail = '') {
	if (ok) {
		pass++
		console.log(`PASS  ${name}  — ${detail}`)
	} else {
		fail++
		failures.push(`${name} — ${detail}`)
		console.log(`FAIL  ${name}  — ${detail}`)
	}
}

/* ── 断言 0：CSS 模板字符串内不得出现裸反引号 ─────────────────────────────── */
{
	const lines = readFileSync(CLIENT, 'utf8').split('\n')
	const start = lines.findIndex((line) => line.includes('const PANEL_CSS = `'))
	let stray = null
	if (start >= 0) {
		for (let i = start + 1; i < lines.length; i++) {
			if (/^`;\s*$/.test(lines[i])) break
			if (lines[i].includes('`')) {
				stray = { line: i + 1, text: lines[i].trim().slice(0, 90) }
				break
			}
		}
	}
	check(
		'0 CSS 模板字符串内无裸反引号',
		start >= 0 && stray === null,
		stray === null ? (start >= 0 ? '未发现裸反引号' : '未找到 PANEL_CSS 模板串') : `L${stray.line}: ${stray.text}`
	)
}

/* ── 基础设施：React mock（含 mini hooks 运行时） ──────────────────────────── */
const ELEMENT = Symbol('react.element')

let hookRecord = null

const ReactMock = {
	createElement: (type, props, ...children) => ({ $$typeof: ELEMENT, type, props: props || {}, children }),
	Fragment: Symbol('react.fragment'),
	useState: (init) => {
		const rec = hookRecord
		if (rec === null) return [typeof init === 'function' ? init() : init, () => {}]
		const index = rec.stateIndex++
		if (!(index in rec.states)) rec.states[index] = typeof init === 'function' ? init() : init
		// setter 必须绑到这一轮的 rec：effect 在 render 之后才跑，那时 hookRecord 已置空。
		const setter = (next) => {
			rec.states[index] = typeof next === 'function' ? next(rec.states[index]) : next
		}
		return [rec.states[index], setter]
	},
	useEffect: (fn) => {
		const rec = hookRecord
		if (rec === null) return
		rec.effects.push(fn)
	},
	useRef: (value) => {
		const rec = hookRecord
		const ref = { current: value }
		if (rec !== null) rec.refs.push(ref)
		return ref
	},
	useMemo: (fn) => fn(),
	useCallback: (fn) => fn
}

/** 遍历 React 元素树，对带 ref 的节点回调。 */
function visitRefs(node, callback) {
	if (node === null || typeof node !== 'object') return
	const props = node.props
	if (props && props.ref && typeof props.ref === 'object') callback(node, props.ref)
	for (const child of node.children || []) visitRefs(child, callback)
}

/**
 * 挂载一个组件：执行组件函数 → 提交 ref → 按顺序跑 effect，收集 cleanup。
 * 只渲染一次（本插件 effect 都不依赖重渲染后的状态，够用）。
 */
function mount(component, refTargets) {
	const rec = { states: [], stateIndex: 0, effects: [], refs: [], cleanups: [] }
	hookRecord = rec
	let tree = null
	try {
		tree = component()
	} finally {
		hookRecord = null
	}
	visitRefs(tree, (node, ref) => {
		const target = refTargets.get(node)
		if (target !== undefined) ref.current = target
	})
	for (const effect of rec.effects) {
		const cleanup = effect()
		rec.cleanups.push(typeof cleanup === 'function' ? cleanup : () => {})
	}
	return { tree, rec }
}

/**
 * 展开函数组件元素，直到得到真正渲染出来的宿主元素树。
 * 注册进 slot 的组件是 `() => h(BrowserPanel)` 这样的包装函数，必须再调用一层
 * 才能触发面板内部的 hooks（useEffect 就在这里注册）。
 */
function renderDeep(node) {
	let current = node
	let guard = 0
	while (current !== null && typeof current === 'object' && current.$$typeof === ELEMENT && typeof current.type === 'function' && guard < 20) {
		current = current.type(current.props || {})
		guard++
	}
	return current
}

/* ── 场景工厂 ────────────────────────────────────────────────────────────── */
function makeHarness(options = {}) {
	const created = { webviews: [], styles: 0 }
	const hostMock = {
		children: [],
		appendChild(node) {
			this.children.push(node)
		}
	}
	const listeners = {}

	const webview = {
		tagName: 'WEBVIEW',
		attrs: {},
		appendedTo: null,
		removed: false,
		loads: [],
		userAgents: [],
		setAttribute(name, value) {
			this.attrs[name] = String(value)
		},
		setUserAgent(ua) {
			this.userAgents.push(String(ua))
		},
		getAttribute(name) {
			return name in this.attrs ? this.attrs[name] : null
		},
		addEventListener(name, fn) {
			;(listeners[name] ||= []).push(fn)
		},
		removeEventListener() {},
		appendChild() {},
		remove() {
			this.removed = true
		},
		loadURL(url) {
			this.loads.push(url)
			return Promise.resolve()
		},
		getTitle() {
			return 'DeepSeek'
		},
		canGoBack() {
			return false
		},
		canGoForward() {
			return false
		},
		fire(name, payload) {
			for (const fn of listeners[name] || []) fn(payload)
		},
		listenerNames() {
			return Object.keys(listeners)
		}
	}

	const documentMock = {
		createElement: (tag) => {
			if (tag === 'webview') {
				created.webviews.push(webview)
				return webview
			}
			created.styles++
			return {
				style: {},
				appendChild() {},
				append() {},
				addEventListener() {},
				removeEventListener() {},
				setAttribute() {},
				remove() {},
				parentNode: null,
				className: '',
				classList: { add() {}, remove() {} }
			}
		},
		createTextNode: (text) => ({ nodeValue: text }),
		getElementById: () => null,
		head: { appendChild() {}, append() {} },
		body: { appendChild() {}, append() {} },
		documentElement: { appendChild() {} },
		querySelector: () => null
	}

	const storage = new Map()
	const localStorageMock = {
		getItem: (key) => (storage.has(key) ? storage.get(key) : null),
		setItem: (key, value) => storage.set(key, String(value)),
		removeItem: (key) => storage.delete(key)
	}

	const openCalls = []
	const windowMock = {
		__ModuleLoader__: { load: () => {} },
		localStorage: localStorageMock,
		open: (url) => {
			openCalls.push(url)
		},
		location: { origin: 'dsh-app://app' }
	}

	const bridgeCalls = { acquire: [], release: [], onOpenRequested: [] }
	const reservation = options.reservation || { lease: 'lease-abc-123', partition: 'dsh-sidebar-browser-test-uuid' }
	const bridge = {
		acquire: async (workspace) => {
			bridgeCalls.acquire.push(workspace)
			if (options.acquireError) throw options.acquireError
			return reservation
		},
		release: async (lease) => {
			bridgeCalls.release.push(lease)
		},
		onOpenRequested: (lease, callback) => {
			bridgeCalls.onOpenRequested.push({ lease, callback })
			return () => {}
		}
	}

	const globalMock = {}
	if (options.withBridge !== false) globalMock.dshDesktop = { protocolVersion: 1, browser: bridge }

	return { created, hostMock, webview, documentMock, windowMock, localStorageMock, globalMock, bridgeCalls, reservation, openCalls, listeners }
}

/** 加载 client.js，返回 loaderEntry。 */
function loadClient(harness) {
	let loaderEntry = null
	harness.windowMock.__ModuleLoader__ = { load: (entry) => { loaderEntry = entry } }
	const src = readFileSync(CLIENT, 'utf8')
	const fn = new Function('window', 'document', 'console', 'globalThis', 'navigator', 'localStorage', src)
	fn(harness.windowMock, harness.documentMock, console, harness.globalMock, { userAgent: EXPECT_HOST_UA }, harness.localStorageMock)
	return loaderEntry
}

const requireMock = (name) => {
	if (name === 'react') return ReactMock
	if (name === 'react/jsx-runtime') return { jsx: ReactMock.createElement, jsxs: ReactMock.createElement, Fragment: ReactMock.Fragment }
	if (name === 'react-dom') return { createRoot: () => ({ render() {}, unmount() {} }) }
	throw new Error(`unexpected require: ${name}`)
}

/* ── 场景 1：正常桌面环境（有 broker） ───────────────────────────────────── */
const harness = makeHarness()
const loaderEntry = loadClient(harness)
check('1 client.js 能在 __ModuleLoader__ 协议下加载', loaderEntry !== null, loaderEntry ? `id=${loaderEntry.id}` : '未调用 load()')
check('2 模块 id 与包名逐字一致', loaderEntry !== null && loaderEntry.id === EXPECT_ID, loaderEntry ? String(loaderEntry.id) : 'n/a')

let exported = null
try {
	exported = loaderEntry.factory(requireMock)
	check('3 factory 物化成功（顶层代码不抛错）', exported !== null && exported !== undefined, exported ? 'ok' : 'null')
} catch (error) {
	check('3 factory 物化成功（顶层代码不抛错）', false, String((error && error.message) || error))
}

const registered = { slots: [] }
const ctxMock = {
	effect: (fn) => {
		const disposer = typeof fn === 'function' ? fn() : undefined
		return typeof disposer === 'function' ? disposer : () => {}
	},
	slots: {
		register: (options, component) => {
			registered.slots.push({ options, component })
			return () => {}
		},
		inject: (deps, cb) => {
			const run = typeof cb === 'function' ? cb : deps && typeof deps === 'object' && typeof deps.callback === 'function' ? deps.callback : null
			if (run !== null) {
				try {
					run(ctxMock)
				} catch {
					/* 真实宿主会在后续帧重试，这里不致命。 */
				}
			}
			return () => {}
		}
	},
	logger: { info() {}, warn() {}, error() {}, debug() {} }
}

if (exported && typeof exported.apply === 'function') {
	let applied = true
	try {
		exported.apply(ctxMock)
	} catch (error) {
		applied = false
		check('4 apply 执行不抛错', false, String((error && error.message) || error))
	}
	if (applied) {
		check('4 apply 执行不抛错', true, `注册数=${registered.slots.length}`)

		const row = registered.slots.find((entry) => entry.options && entry.options.name === 'sidebar.panellist')
		check('5 注册了左栏入口 sidebar.panellist', Boolean(row), row ? `id=${row.options.id} order=${row.options.order}` : '未注册')

		if (row) {
			const options = row.options
			const label = typeof options.label === 'function' ? options.label() : null
			check(
				'6 入口描述符字段正确（id / order / label 是函数）',
				options.id === EXPECT_PANEL_ID && options.order === EXPECT_ORDER && typeof options.label === 'function',
				JSON.stringify({ id: options.id, order: options.order, label: typeof options.label })
			)
			check('7 入口 label() 返回非空字符串', typeof label === 'string' && label.length > 0, JSON.stringify(label))
			check('8 入口第 2 参是 React 组件函数', typeof row.component === 'function', `类型=${typeof row.component}`)
			if (typeof row.component === 'function') {
				try {
					const rendered = row.component({ size: 16 })
					check('9 入口组件渲染返回 React 元素', Boolean(rendered) && rendered.$$typeof === ELEMENT, `type=${rendered && rendered.type && rendered.type.name}`)
				} catch (error) {
					check('9 入口组件渲染返回 React 元素', false, String((error && error.message) || error))
				}
			}
		}

		const main = registered.slots.find((entry) => entry.options && entry.options.name === 'main')
		check('10 注册了主面板 main keyed slot', Boolean(main), main ? `key=${main.options.key}` : '未注册')
		if (main) {
			check('11 主面板 key 与左栏 id 一致', main.options.key === EXPECT_PANEL_ID, JSON.stringify(main.options.key))
			check('12 主面板第 2 参是 React 组件函数', typeof main.component === 'function', `类型=${typeof main.component}`)
		}

		/* ── 面板实挂：验证 guest broker 租约链路 ─────────────────────────── */
		if (main && typeof main.component === 'function') {
			// 渲染一次 → 把带 ref 的宿主节点接到 mock 容器 → 按顺序跑 effect。
			const probeRec = { states: [], stateIndex: 0, effects: [], refs: [], cleanups: [] }
			hookRecord = probeRec
			const tree = renderDeep(main.component())
			hookRecord = null
			const refNodes = []
			visitRefs(tree, (node, ref) => refNodes.push({ node, ref }))
			check('13 面板渲染出带 ref 的 webview 宿主节点', refNodes.length === 1, `ref 节点数=${refNodes.length}`)
			for (const entry of refNodes) entry.ref.current = harness.hostMock
			for (const effect of probeRec.effects) {
				const cleanup = effect()
				probeRec.cleanups.push(typeof cleanup === 'function' ? cleanup : () => {})
			}

			// 等 acquire 的 microtask 链跑完
			for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done))

			check('14 通过 dshDesktop.browser.acquire 申请租约', harness.bridgeCalls.acquire.length === 1 && harness.bridgeCalls.acquire[0] === EXPECT_WORKSPACE, JSON.stringify(harness.bridgeCalls.acquire))
			check('15 创建了 webview 元素', harness.created.webviews.length === 1, `数量=${harness.created.webviews.length}`)

			const node = harness.webview
			const reservation = harness.reservation
			check('16 name 属性 = lease', node.attrs.name === reservation.lease, `name=${node.attrs.name} lease=${reservation.lease}`)
			check('17 partition 属性 = 主进程发放的 partition', node.attrs.partition === reservation.partition, `partition=${node.attrs.partition}`)
			check('18 src 属性 = about:blank#<lease>', node.attrs.src === 'about:blank#' + reservation.lease, `src=${node.attrs.src}`)
			check('19 allowpopups 已设置', 'allowpopups' in node.attrs || node.attrs.allowpopups === '', JSON.stringify(node.attrs))
			check('20 webview 已挂进宿主容器', harness.hostMock.children.includes(node), `宿主子节点数=${harness.hostMock.children.length}`)
			check('21 onOpenRequested 已按 lease 订阅', harness.bridgeCalls.onOpenRequested.length === 1 && harness.bridgeCalls.onOpenRequested[0].lease === reservation.lease, JSON.stringify(harness.bridgeCalls.onOpenRequested.map((item) => item.lease)))
			check('22 监听了 dom-ready 与加载进度事件', node.listenerNames().includes('dom-ready') && node.listenerNames().includes('did-start-loading'), node.listenerNames().join(','))

			// dom-ready 之后才允许 loadURL
			node.fire('dom-ready')
			for (let i = 0; i < 3; i++) await new Promise((done) => setImmediate(done))
			check('23 dom-ready 后 loadURL 到当前站点', node.loads.length >= 1 && node.loads[node.loads.length - 1] === EXPECT_URL, JSON.stringify(node.loads))

			/* ── UA 伪装：站点风控靠它区分「Electron 壳」与「真浏览器」 ───────── */
			const fakeUa = node.attrs.useragent || ''
			check('24 webview 的 useragent 属性已设置', fakeUa.length > 0, fakeUa)
			check('25 useragent 不含 Electron 与应用标识', !/Electron|DSH NEXT|2\.0\.20-next/.test(fakeUa), fakeUa)
			check('26 useragent 保留 Chrome 主版本号', /Chrome\/140\.0\.0\.0/.test(fakeUa), fakeUa)
			check('27 useragent 保留 Windows 平台段', /\(Windows NT 10\.0; Win64; x64\)/.test(fakeUa), fakeUa)
			check('28 兜底调用 setUserAgent 且与属性一致', node.userAgents.length === 1 && node.userAgents[0] === fakeUa, JSON.stringify(node.userAgents))

			// 卸载必须释放租约，否则主进程里会残留已 attach 的死租约
			for (const cleanup of probeRec.cleanups) cleanup()
			for (let i = 0; i < 3; i++) await new Promise((done) => setImmediate(done))
			check('29 卸载时释放租约', harness.bridgeCalls.release.length === 1 && harness.bridgeCalls.release[0] === reservation.lease, JSON.stringify(harness.bridgeCalls.release))
			check('30 卸载时移除 webview 元素', node.removed === true, `removed=${node.removed}`)
		}
	}
}

/* ── 场景 2：没有桌面桥（纯浏览器 / 非主窗口）必须优雅降级 ───────────────── */
{
	const plain = makeHarness({ withBridge: false })
	const entry = loadClient(plain)
	let degraded = null
	try {
		const mod = entry.factory(requireMock)
		const registeredSlots = []
		const slots = {
			register(options, component) {
				registeredSlots.push({ options, component })
				return () => {}
			},
			inject(_deps, cb) {
				if (typeof cb === 'function') cb(ctxPlain)
			}
		}
		const ctxPlain = { effect: (fn) => fn(), slots, logger: { info() {}, warn() {}, error() {}, debug() {} } }
		mod.apply(ctxPlain)
		const mainPanel = registeredSlots.find((item) => item.options && item.options.name === 'main')
		const rec = { states: [], stateIndex: 0, effects: [], refs: [], cleanups: [] }
		hookRecord = rec
		const tree = renderDeep(mainPanel.component())
		hookRecord = null
		visitRefs(tree, (node, ref) => { ref.current = plain.hostMock })
		for (const effect of rec.effects) effect()
		const blocked = rec.states.find((value) => value && typeof value === 'object' && typeof value.kind === 'string')
		degraded = blocked || null
		check('31 无桌面桥时进入降级态', degraded !== null && degraded.kind === 'bridge', degraded ? degraded.kind : '未降级')
		check('32 降级态不创建 webview', plain.created.webviews.length === 0, `webview 数=${plain.created.webviews.length}`)
		check('33 降级提示提到需要桌面版', degraded !== null && /桌面版/.test(degraded.detail), degraded ? degraded.detail.slice(0, 60) : 'n/a')
	} catch (error) {
		check('31 无桌面桥时进入降级态', false, String((error && error.message) || error))
	}
}

/* ── 汇总 ───────────────────────────────────────────────────────────────── */
console.log(`\n=== ${pass}/${pass + fail} 通过 ===`)
if (failures.length > 0) {
	console.log('  失败清单：')
	for (const item of failures) console.log('   · ' + item)
}
process.exitCode = fail === 0 ? 0 : 1
