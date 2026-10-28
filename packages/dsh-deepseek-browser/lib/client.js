/**
 * dsh-deepseek-browser —— client 半边。
 *
 * 注册两处：
 *   1. sidebar.panellist  左栏一行「DeepSeek 浏览器」
 *   2. main               keyed slot 面板，承载网页
 *
 * ── 关键：为什么不能直接 new webview 建一个 src="https://..." ──
 *
 * DSH NEXT 桌面版主进程（app.asar / lib/browser-guests.js）在 primary window 上
 * 装了 will-attach-webview 强制校验：
 *
 *   const id = params.src.startsWith("about:blank#") ? params.src.slice(12) : ""
 *   const lease = this.leases.get(id)
 *   if (lease === undefined || lease.owner !== owner || lease.attached
 *       || params.partition !== lease.partition) { event.preventDefault(); return }
 *
 * 也就是说每个 webview 必须先向主进程「租」一个 lease：
 *
 *   const { lease, partition } = await window.dshDesktop.browser.acquire(workspace)
 *
 * 然后元素必须写成 name=lease / partition=partition / src="about:blank#"+lease，
 * 挂载后由我们自己去 loadURL 目标地址。任何一项对不上，或者未走租约，webview
 * 会被静默拒绝挂载 —— 现象就是面板白屏 + 永久「加载中…」，没有任何报错。
 *
 * 租约是一次性的（lease.attached 置 true 后不能复用同一个元素重新挂载），
 * 所以：一个元素一个 lease；组件卸载时释放 lease；切站点只 loadURL 不换元素。
 *
 * 分区是主进程按 workspace 字符串分配的进程内存储（dsh-sidebar-browser-<uuid>，
 * 没有 persist: 前缀 = 内存会话），所以：同一进程内切站点/切面板登录态保留，
 * 重启应用后需要重新登录。这是 DSH 的固定隔离策略，插件侧无法绕开。
 */

window.__ModuleLoader__.load({
	id: "dsh-deepseek-browser",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;

		const PANEL_ID = "deepseek-browser";
		const PANEL_ORDER = 100;

		const STYLE_ID = "dsh-deepseek-browser-style";
		const SITES_KEY = "dsh-deepseek-browser.sites.v1";
		const ACTIVE_KEY = "dsh-deepseek-browser.active.v1";

		/**
		 * 租约用的 workspace 标识。主进程按这个字符串复用同一个分区，
		 * 因此本插件所有站点共享一份浏览器存储（登录一次，各站点各自 Cookie）。
		 */
		const WORKSPACE = "dsh-deepseek-browser";

		/**
		 * 扩展点（不涉及任何凭证）：把「guest 就绪 / guest 导航」这一事实广播到同页面，
		 * 让不随发布版分发的私有模块挂上来做自己的事。
		 *
		 * 本模块只知道 webview 元素和它的 URL，**不读不写登录态**；读写凭证的逻辑
		 * 全部在私有模块里（见 AGENTS.md「私有模块」一节，发布前删除该包）。
		 */
		const HOOKS_KEY = "__DSB_HOOKS__";

		function ensureHookHub() {
			const scope = typeof window === "object" && window !== null ? window : null;
			if (scope === null) return null;
			const existing = scope[HOOKS_KEY];
			if (existing && typeof existing.onGuestReady === "function") return existing;

			const listeners = new Set();
			let seq = 0;
			const hub = {
				version: 1,
				/** 当前存活的 guest：[{ id, element, url, phase, userAgent }]，最多留 6 条。 */
				guests: [],
				/**
				 * 订阅 guest 事件。注册时会把当前已存在的 guest 重放一遍，
				 * 所以私有模块比 webview 晚加载也不会漏掉。
				 * @returns {() => void} 取消订阅
				 */
				onGuestReady(listener) {
					if (typeof listener !== "function") return () => {};
					listeners.add(listener);
					for (const guest of hub.guests) {
						const node = guest.element;
						if (node && typeof node.isConnected === "boolean" && !node.isConnected) continue;
						try {
							listener(guest);
						} catch {
							/* 私有模块自己的异常不能影响浏览器。 */
						}
					}
					return () => {
						listeners.delete(listener);
					};
				},
				/** 仅供本模块调用。phase: "ready" | "navigate"。 */
				publish(node, phase, userAgent) {
					if (!node || typeof node !== "object") return;
					let url = "";
					try {
						url = typeof node.getURL === "function" ? node.getURL() : "";
					} catch {
						url = "";
					}
					const guest = { id: ++seq, element: node, url: url, phase: phase, userAgent: userAgent };
					hub.guests = hub.guests.filter((item) => item.element !== node);
					hub.guests.push(guest);
					if (hub.guests.length > 6) hub.guests = hub.guests.slice(-6);
					for (const listener of Array.from(listeners)) {
						try {
							listener(guest);
						} catch {
							/* 同上。 */
						}
					}
				},
				/** 仅供本模块调用。 */
				retire(node) {
					hub.guests = hub.guests.filter((item) => item.element !== node);
				},
			};
			scope[HOOKS_KEY] = hub;
			return hub;
		}

		/** 默认站点：国内可直连优先，全部可增删改。 */
		const DEFAULT_SITES = [
			{ id: "deepseek", label: "DeepSeek", url: "https://chat.deepseek.com/" },
			{ id: "kimi", label: "Kimi", url: "https://www.kimi.com/" },
			{ id: "qwen", label: "千问", url: "https://www.qianwen.com/" },
			{ id: "doubao", label: "豆包", url: "https://www.doubao.com/chat/" },
			{ id: "chatglm", label: "智谱清言", url: "https://chatglm.cn/" },
			{ id: "metaso", label: "秘塔", url: "https://metaso.cn/" }
		];

		const PANEL_CSS = `
.dsdb_root{box-sizing:border-box;height:100%;min-height:0;width:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-l1,#191919);color:var(--dsw-alias-label-primary,#e8e8e8);font:var(--dsw-font-s-14,14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif)}
.dsdb_bar{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));flex:none;min-height:0}
.dsdb_pills{display:flex;align-items:center;gap:4px;overflow-x:auto;scrollbar-width:none;min-width:0;flex:0 1 auto}
.dsdb_pills::-webkit-scrollbar{display:none}
.dsdb_pill{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#a8a8a8);font:inherit;font-size:13px;line-height:20px;padding:3px 10px;border-radius:999px;cursor:pointer;white-space:nowrap;flex:none;transition:background .12s ease,color .12s ease}
.dsdb_pill:hover{background:var(--dsw-alias-bg-l2,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e8e8e8)}
.dsdb_pillActive{background:var(--dsw-alias-bg-l3,rgba(255,255,255,.12));color:var(--dsw-alias-label-primary,#e8e8e8)}
.dsdb_pillAdd{color:var(--dsw-alias-label-tertiary,#8a8a8a);border:1px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.18))}
.dsdb_spacer{flex:1 1 auto;min-width:8px}
.dsdb_btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#a8a8a8);cursor:pointer;padding:0}
.dsdb_btn:hover:not(:disabled){background:var(--dsw-alias-bg-l2,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e8e8e8)}
.dsdb_btn:disabled{opacity:.35;cursor:default}
.dsdb_title{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a);max-width:38vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}
.dsdb_body{position:relative;flex:1 1 auto;min-height:0;display:flex;background:#fff}
.dsdb_view{flex:1 1 auto;width:100%;height:100%;min-height:0;min-width:0;border:0;display:flex;background:#fff}
.dsdb_progressBar{position:absolute;left:0;top:0;height:2px;background:var(--dsw-alias-brand,#4d6bfe);animation:dsdb-slide 1.1s ease-in-out infinite;z-index:3;border-radius:0 2px 2px 0}
@keyframes dsdb-slide{0%{width:8%;margin-left:0}50%{width:46%;margin-left:27%}100%{width:8%;margin-left:92%}}
.dsdb_overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-l1,#191919);z-index:4}
.dsdb_overlayInner{max-width:560px;display:flex;flex-direction:column;gap:12px;align-items:flex-start;text-align:left}
.dsdb_overlayTitle{font-size:15px;font-weight:600;line-height:22px}
.dsdb_overlayText{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#a8a8a8);word-break:break-word}
.dsdb_overlayCode{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a);background:var(--dsw-alias-bg-l2,rgba(255,255,255,.05));border-radius:6px;padding:8px 10px;max-width:100%;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.dsdb_primary{border:0;border-radius:8px;padding:7px 14px;font:inherit;font-size:13px;cursor:pointer;background:var(--dsw-alias-brand,#4d6bfe);color:#fff}
.dsdb_ghost{border:0.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.18));border-radius:8px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-primary,#e8e8e8)}
.dsdb_ghost:hover{background:var(--dsw-alias-bg-l2,rgba(255,255,255,.06))}
.dsdb_card{position:absolute;inset:0;z-index:5;background:var(--dsw-alias-bg-l1,#191919);padding:20px clamp(16px,4vw,40px);overflow-y:auto}
.dsdb_cardInner{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.dsdb_cardTitle{font-size:15px;font-weight:600;line-height:22px;margin:0}
.dsdb_cardHint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin:0}
.dsdb_list{display:flex;flex-direction:column;border-top:0.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}
.dsdb_row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}
.dsdb_rowMain{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto;text-align:left}
.dsdb_rowLabel{font-size:13px;line-height:20px;font-weight:500}
.dsdb_rowUrl{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsdb_form{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dsdb_input{box-sizing:border-box;background:var(--dsw-alias-bg-l2,rgba(255,255,255,.05));border:0.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.18));border-radius:8px;color:var(--dsw-alias-label-primary,#e8e8e8);font:inherit;font-size:13px;line-height:20px;padding:6px 10px;min-width:120px}
.dsdb_input:focus{outline:none;border-color:var(--dsw-alias-brand,#4d6bfe)}
.dsdb_inputName{flex:0 0 150px}
.dsdb_inputUrl{flex:1 1 280px;min-width:200px}
.dsdb_error{font-size:12px;line-height:18px;color:#ff6b6b}
.dsdb_footer{display:flex;gap:8px;align-items:center;justify-content:flex-end}
`;

		/** 只注入一次样式；重复注入会产生多条同名规则。 */
		function ensureStyle() {
			if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = PANEL_CSS;
			(document.head || document.documentElement).appendChild(style);
		}

		/* ────────────────────────────── 站点数据 ────────────────────────────── */

		function normalizeUrl(input) {
			const raw = String(input == null ? "" : input).trim();
			if (raw === "") return null;
			const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : "https://" + raw;
			let parsed;
			try {
				parsed = new URL(withScheme);
			} catch {
				return null;
			}
			if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
			if (parsed.hostname === "") return null;
			return parsed.href;
		}

		function makeId(label) {
			const base = String(label || "site").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "");
			const stamp = Date.now().toString(36).slice(-5);
			return (base === "" ? "site" : base).slice(0, 24) + "-" + stamp;
		}

		function sanitizeSite(candidate) {
			if (candidate === null || typeof candidate !== "object") return null;
			const url = normalizeUrl(candidate.url);
			if (url === null) return null;
			const label = String(candidate.label == null ? "" : candidate.label).trim().slice(0, 24) || new URL(url).hostname;
			const id = String(candidate.id == null ? "" : candidate.id).trim().slice(0, 40) || makeId(label);
			return { id: id, label: label, url: url };
		}

		function readSites() {
			try {
				const raw = window.localStorage.getItem(SITES_KEY);
				if (raw === null || raw === "") return DEFAULT_SITES.slice();
				const parsed = JSON.parse(raw);
				if (!Array.isArray(parsed)) return DEFAULT_SITES.slice();
				const list = [];
				const seen = new Set();
				for (const item of parsed) {
					const site = sanitizeSite(item);
					if (site === null || seen.has(site.id)) continue;
					seen.add(site.id);
					list.push(site);
				}
				return list.length === 0 ? DEFAULT_SITES.slice() : list;
			} catch {
				return DEFAULT_SITES.slice();
			}
		}

		function writeSites(list) {
			try {
				window.localStorage.setItem(SITES_KEY, JSON.stringify(list));
			} catch {
				/* 隐私模式或配额满：本次会话内仍然可用，只是不持久化。 */
			}
		}

		function readActiveId() {
			try {
				const raw = window.localStorage.getItem(ACTIVE_KEY);
				return raw === null || raw === "" ? null : raw;
			} catch {
				return null;
			}
		}

		function writeActiveId(id) {
			try {
				window.localStorage.setItem(ACTIVE_KEY, String(id));
			} catch {
				/* 同上。 */
			}
		}

		/* ────────────────────────────── UA 伪装 ────────────────────────────── */

		/**
		 * Electron 默认 UA 里带 `Electron/44.7.0` 和 `<应用名>/<版本>`
		 * （本机形如 `... DSH NEXT/2.0.20-next Chrome/140.0.0.0 Electron/44.7.0 Safari/537.36`）。
		 * chat.deepseek.com 会拿它做环境风控，命中就弹「使用环境异常…建议您使用我们的官方产品」。
		 *
		 * 这里重建一条普通 Windows Chrome 的 UA：保留平台段与原 Chrome 主版本号，
		 * 抹掉 Electron 与应用标识。UA 变了，服务端风控与页面侧判断都会跟着变。
		 */

		const FALLBACK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

		/**
		 * @param {string} raw 原 userAgent
		 * @returns {string} 去掉 Electron 痕迹的 UA
		 */
		function cleanUserAgent(raw) {
			const ua = typeof raw === "string" ? raw : "";
			const chrome = /Chrome\/([\d.]+)/.exec(ua);
			if (chrome === null) return FALLBACK_UA;
			const platform = /^(Mozilla\/5\.0 \([^)]*\))/.exec(ua);
			const head = platform === null ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" : platform[1];
			return head + " AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + chrome[1] + " Safari/537.36";
		}

		/** 取宿主渲染进程的 navigator.userAgent（就是 Electron 默认 UA）。 */
		function currentUserAgent() {
			try {
				if (typeof navigator === "undefined" || navigator === null) return FALLBACK_UA;
				return cleanUserAgent(navigator.userAgent);
			} catch {
				return FALLBACK_UA;
			}
		}

		/* ────────────────────────────── 桌面桥 ────────────────────────────── */

		/**
		 * 取主进程的浏览器租约桥。只在 DSH 桌面版存在（preload 注入
		 * window.dshDesktop.browser = { acquire, release, onOpenRequested }）。
		 *
		 * @returns {null | { acquire: Function, release: Function, onOpenRequested: Function }}
		 */
		function desktopBridge() {
			const desktop = typeof globalThis === "undefined" ? null : globalThis.dshDesktop;
			if (desktop === null || typeof desktop !== "object") return null;
			const browser = desktop.browser;
			if (browser === null || typeof browser !== "object") return null;
			if (typeof browser.acquire !== "function") return null;
			if (typeof browser.release !== "function") return null;
			return browser;
		}

		/** 在系统浏览器打开：主窗口 setWindowOpenHandler 会 deny 并转 openExternal。 */
		function openExternal(url) {
			if (typeof url !== "string" || url === "") return;
			try {
				window.open(url, "_blank", "noopener,noreferrer");
			} catch {
				/* 忽略：没有 window 环境（理论上不会到这里）。 */
			}
		}

		/* ────────────────────────────── 小图标 ────────────────────────────── */

		function svg(path, size, extra) {
			const props = {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: extra && extra.strokeWidth ? extra.strokeWidth : 1.3,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true"
			};
			return h("svg", props, path.map((d, index) => h("path", { key: index, d: d })));
		}

		const ICON = {
			globe: ["M8 14.2A6.2 6.2 0 1 0 8 1.8a6.2 6.2 0 0 0 0 12.4Z", "M1.8 8h12.4", "M8 1.8c1.7 1.7 2.6 3.9 2.6 6.2S9.7 12.5 8 14.2C6.3 12.5 5.4 10.3 5.4 8S6.3 3.5 8 1.8Z"],
			back: ["M10 3.5 5.5 8l4.5 4.5"],
			forward: ["M6 3.5 10.5 8 6 12.5"],
			reload: ["M13 8a5 5 0 1 1-1.6-3.7", "M13.4 2.4v2.9h-2.9"],
			home: ["M2.5 7.2 8 2.6l5.5 4.6", "M4 6.6v6.2c0 .3.2.5.5.5h7c.3 0 .5-.2.5-.5V6.6"],
			external: ["M9.5 2.5h4v4", "M13.5 2.5 7.8 8.2", "M6.5 3.5H3.2c-.4 0-.7.3-.7.7v8.6c0 .4.3.7.7.7h8.6c.4 0 .7-.3.7-.7V9.5"],
			plus: ["M8 3.2v9.6", "M3.2 8h9.6"],
			settings: ["M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z", "M12.6 9.6a1.1 1.1 0 0 0 .2 1.2l.1.1a1.3 1.3 0 1 1-1.9 1.9l-.1-.1a1.1 1.1 0 0 0-1.2-.2 1.1 1.1 0 0 0-.7 1v.2a1.3 1.3 0 1 1-2.6 0v-.1a1.1 1.1 0 0 0-.7-1 1.1 1.1 0 0 0-1.2.2l-.1.1a1.3 1.3 0 1 1-1.9-1.9l.1-.1a1.1 1.1 0 0 0 .2-1.2 1.1 1.1 0 0 0-1-.7h-.2a1.3 1.3 0 1 1 0-2.6h.1a1.1 1.1 0 0 0 1-.7 1.1 1.1 0 0 0-.2-1.2l-.1-.1a1.3 1.3 0 1 1 1.9-1.9l.1.1a1.1 1.1 0 0 0 1.2.2h.1a1.1 1.1 0 0 0 .7-1v-.2a1.3 1.3 0 1 1 2.6 0v.1a1.1 1.1 0 0 0 .7 1 1.1 1.1 0 0 0 1.2-.2l.1-.1a1.3 1.3 0 1 1 1.9 1.9l-.1.1a1.1 1.1 0 0 0-.2 1.2v.1a1.1 1.1 0 0 0 1 .7h.2a1.3 1.3 0 1 1 0 2.6h-.1a1.1 1.1 0 0 0-1 .7Z"],
			close: ["M4 4l8 8", "M12 4l-8 8"],
			trash: ["M2.8 4.5h10.4", "M6.2 4.5V3.1c0-.3.2-.6.6-.6h2.4c.4 0 .6.3.6.6v1.4", "M4.2 4.5v8.1c0 .5.4.9.9.9h5.8c.5 0 .9-.4.9-.9V4.5"]
		};

		/** 左侧导航行图标：宿主会把 size 传进来。 */
		function BrowserRowIcon(props) {
			const size = props && typeof props.size === "number" ? props.size : 16;
			return svg(ICON.globe, size);
		}

		function IconButton(props) {
			return h(
				"button",
				{
					type: "button",
					className: "dsdb_btn",
					title: props.title,
					"aria-label": props.title,
					disabled: props.disabled === true,
					onClick: props.onClick
				},
				svg(props.path, 16)
			);
		}

		/* ────────────────────────────── 面板组件 ────────────────────────────── */

		function describeFailure(event) {
			const code = event && typeof event.errorCode === "number" ? event.errorCode : 0;
			const detail = event && typeof event.errorDescription === "string" ? event.errorDescription : "";
			const url = event && typeof event.validatedURL === "string" ? event.validatedURL : "";
			const head = code === -106 ? "网络不可达" : code === -105 ? "域名解析失败" : code === -102 ? "连接被拒绝" : code === -118 ? "加载超时" : "网页加载失败";
			return head + (detail ? "（" + detail + "）" : "") + (url ? "：" + url : "");
		}

		/** ERR_ABORTED：同一个 guest 连续导航时的正常中止，不是失败。 */
		function isAbort(error) {
			if (error === null || typeof error !== "object") return false;
			if (error.code === "ERR_ABORTED") return true;
			return typeof error.message === "string" && error.message.indexOf("ERR_ABORTED") >= 0;
		}

		function messageOf(error) {
			if (error === null || error === undefined) return "未知错误";
			if (typeof error === "string") return error;
			if (typeof error.message === "string" && error.message !== "") return error.message;
			return String(error);
		}

		function BrowserPanel() {
			ensureStyle();

			const [sites, setSites] = React.useState(readSites);
			const [activeId, setActiveId] = React.useState(() => {
				const stored = readActiveId();
				const list = readSites();
				if (stored !== null && list.some((site) => site.id === stored)) return stored;
				return list.length > 0 ? list[0].id : "";
			});
			const [status, setStatus] = React.useState({ loading: false, title: "", canBack: false, canForward: false, error: null });
			/** null | { kind: "bridge" | "acquire" | "crash", detail: string } */
			const [blocked, setBlocked] = React.useState(null);
			const [managing, setManaging] = React.useState(false);
			const [draft, setDraft] = React.useState({ label: "", url: "" });
			const [draftError, setDraftError] = React.useState(null);

			const hostRef = React.useRef(null);
			/** { load(url), back(), forward(), reload(), home(), canBack(), canForward() } */
			const apiRef = React.useRef(null);

			const active = sites.find((site) => site.id === activeId) || sites[0] || null;
			const activeUrl = active === null ? null : active.url;

			/* 1) 申请租约 → 建 webview → 挂载。整个生命周期只做一次。 */
			React.useEffect(() => {
				const host = hostRef.current;
				if (host === null) return undefined;

				const bridge = desktopBridge();
				if (bridge === null) {
					setBlocked({
						kind: "bridge",
						detail: "没有找到 window.dshDesktop.browser。这个入口需要 DSH 桌面版（Electron 窗口）：纯浏览器环境没有 <webview>，而目标站点的 frame-ancestors 又禁止被 iframe 嵌入。",
					});
					return undefined;
				}

				let disposed = false;
				let element = null;
				let ready = false;
				let lease = "";
				let pendingUrl = null;
				let unsubscribeOpen = null;

				const reportError = (error) => {
					if (disposed || isAbort(error)) return;
					setStatus((prev) => ({ ...prev, loading: false, error: messageOf(error) }));
				};

				const syncNav = () => {
					if (element === null) return;
					let canBack = false;
					let canForward = false;
					try {
						canBack = typeof element.canGoBack === "function" ? element.canGoBack() === true : false;
						canForward = typeof element.canGoForward === "function" ? element.canGoForward() === true : false;
					} catch {
						canBack = false;
						canForward = false;
					}
					setStatus((prev) => (prev.canBack === canBack && prev.canForward === canForward ? prev : { ...prev, canBack: canBack, canForward: canForward }));
				};

				const load = (url) => {
					if (typeof url !== "string" || url === "") return;
					if (element === null || !ready) {
						pendingUrl = url;
						return;
					}
					pendingUrl = null;
					try {
						const task = element.loadURL(url);
						if (task && typeof task.catch === "function") task.catch(reportError);
					} catch (error) {
						reportError(error);
					}
				};

				/* 先把 api 暴露出去：面板的导航 effect 可能比租约先到。 */
				apiRef.current = {
					load: load,
					back: () => {
						try {
							if (element !== null && typeof element.canGoBack === "function" && element.canGoBack()) element.goBack();
						} catch {
							/* 忽略：尚未 ready。 */
						}
					},
					forward: () => {
						try {
							if (element !== null && typeof element.canGoForward === "function" && element.canGoForward()) element.goForward();
						} catch {
							/* 忽略。 */
						}
					},
					reload: () => {
						try {
							if (element !== null && typeof element.reload === "function") element.reload();
						} catch {
							/* 忽略。 */
						}
					},
					ready: () => ready && element !== null,
				};

				const attach = async () => {
					let reservation;
					try {
						reservation = await bridge.acquire(WORKSPACE);
					} catch (error) {
						if (disposed) return;
						setBlocked({ kind: "acquire", detail: messageOf(error) });
						return;
					}
					if (disposed) {
						/* 已经卸载：把租约还回去，别留在主进程里。 */
						if (reservation && typeof reservation.lease === "string") {
							Promise.resolve(bridge.release(reservation.lease)).catch(() => {});
						}
						return;
					}
					if (reservation === null || typeof reservation !== "object" || typeof reservation.lease !== "string" || typeof reservation.partition !== "string") {
						setBlocked({ kind: "acquire", detail: "主进程返回的租约格式不对（需要 { lease, partition }）。" });
						return;
					}
					lease = reservation.lease;

					const userAgent = currentUserAgent();

					const publishGuest = (target, phase) => {
						const hub = ensureHookHub();
						if (hub === null) return;
						try {
							hub.publish(target, phase, userAgent);
						} catch {
							/* 私有扩展点自身的异常不能影响浏览器。 */
						}
					};

					const node = document.createElement("webview");
					node.className = "dsdb_view";
					/* 这三项必须在 append 之前设置：will-attach-webview 就在 append 时校验。 */
					node.setAttribute("name", lease);
					node.setAttribute("partition", reservation.partition);
					node.setAttribute("allowpopups", "");
					node.setAttribute("src", "about:blank#" + lease);
					/* UA 也必须在 append 之前写好：webview 自定义元素在挂载时取它。 */
					node.setAttribute("useragent", userAgent);

					const onStart = () => setStatus((prev) => (prev.loading && prev.error === null ? prev : { ...prev, loading: true, error: null }));
					const onReady = () => {
						syncNav();
						publishGuest(node, "navigate");
						try {
							const title = typeof node.getTitle === "function" ? node.getTitle() : "";
							if (typeof title === "string" && title !== "") setStatus((prev) => (prev.title === title ? prev : { ...prev, title: title }));
						} catch {
							/* 未 dom-ready 时 getTitle 会抛错，忽略。 */
						}
					};
					const onStop = () => {
						syncNav();
						setStatus((prev) => (prev.loading === false ? prev : { ...prev, loading: false }));
					};
					const onTitle = (event) => {
						const title = event && typeof event.title === "string" ? event.title : "";
						if (title !== "") setStatus((prev) => (prev.title === title ? prev : { ...prev, title: title }));
					};
					const onFail = (event) => {
						const code = event && typeof event.errorCode === "number" ? event.errorCode : 0;
						if (code === 0 || code === -3) return;
						setStatus((prev) => ({ ...prev, loading: false, error: describeFailure(event) }));
					};
					const onDomReady = () => {
						ready = true;
						syncNav();
						publishGuest(node, "ready");
						if (pendingUrl !== null) load(pendingUrl);
					};
					const onGone = () => {
						ready = false;
						if (disposed) return;
						setBlocked({ kind: "crash", detail: "网页进程已退出（render-process-gone / destroyed）。点「重新加载」重建。" });
					};

					node.addEventListener("did-start-loading", onStart);
					node.addEventListener("did-stop-loading", onStop);
					node.addEventListener("dom-ready", onDomReady);
					node.addEventListener("did-navigate", onReady);
					node.addEventListener("did-navigate-in-page", onReady);
					node.addEventListener("page-title-updated", onTitle);
					node.addEventListener("did-fail-load", onFail);
					node.addEventListener("render-process-gone", onGone);
					node.addEventListener("destroyed", onGone);

					unsubscribeOpen = bridge.onOpenRequested(lease, (url) => {
						/* guest 的 setWindowOpenHandler 一律 deny，把 URL 交给我们；不处理就等于链路。 */
						if (!disposed) openExternal(url);
					});

					element = node;
					host.appendChild(node);
					/* 兜底：个别 Electron 版本不认 useragent 属性，直接设到 WebContents 上。 */
					if (typeof node.setUserAgent === "function") {
						try {
							node.setUserAgent(userAgent);
						} catch {
							/* 忽略：属性那条路已经生效。 */
						}
					}
				};

				attach();

				return () => {
					disposed = true;
					apiRef.current = null;
					if (typeof unsubscribeOpen === "function") unsubscribeOpen();
					unsubscribeOpen = null;
					if (element !== null) {
						try {
							const hub = ensureHookHub();
							if (hub !== null) hub.retire(element);
						} catch {
							/* 忽略。 */
						}
						try {
							element.remove();
						} catch {
							/* 忽略。 */
						}
						element = null;
					}
					ready = false;
					const id = lease;
					lease = "";
					if (id !== "") Promise.resolve(bridge.release(id)).catch(() => {});
				};
			}, []);

			/* 2) 当前站点变化 → 在同一 guest 里导航（不换元素，避免租约一次性失效）。 */
			React.useEffect(() => {
				if (activeUrl === null) return;
				setStatus((prev) => ({ ...prev, loading: true, error: null, title: "" }));
				/* 只解除「可恢复」的阻断态：acquire 失败与进程崩溃可以在切站点时重试；
				   bridge 缺失是环境性的，清掉就只剩白屏，必须一直显示提示。 */
				setBlocked((current) => (current === null || current.kind === "bridge" ? current : null));
				if (apiRef.current !== null) apiRef.current.load(activeUrl);
			}, [activeUrl]);

			const persist = React.useCallback((list) => {
				setSites(list);
				writeSites(list);
			}, []);

			const selectSite = (id) => {
				setActiveId(id);
				writeActiveId(id);
			};

			const reload = () => {
				if (apiRef.current === null) return;
				setBlocked(null);
				setStatus((prev) => ({ ...prev, error: null, loading: true }));
				apiRef.current.reload();
			};

			const goBack = () => {
				if (apiRef.current === null) return;
				apiRef.current.back();
			};

			const goForward = () => {
				if (apiRef.current === null) return;
				apiRef.current.forward();
			};

			const goHome = () => {
				if (apiRef.current === null || activeUrl === null) return;
				setBlocked(null);
				setStatus((prev) => ({ ...prev, error: null, loading: true }));
				apiRef.current.load(activeUrl);
			};

			const openExternally = () => {
				if (activeUrl === null) return;
				openExternal(activeUrl);
			};

			const addSite = () => {
				const url = normalizeUrl(draft.url);
				if (url === null) {
					setDraftError("网址无效，需要 http/https 链接，例如 chat.deepseek.com");
					return;
				}
				const label = draft.label.trim() === "" ? new URL(url).hostname : draft.label.trim().slice(0, 24);
				if (sites.some((site) => site.url === url)) {
					setDraftError("这个地址已经在清单里了。");
					return;
				}
				const next = sites.concat([{ id: makeId(label), label: label, url: url }]);
				persist(next);
				setDraft({ label: "", url: "" });
				setDraftError(null);
			};

			const removeSite = (id) => {
				if (sites.length <= 1) {
					setDraftError("至少保留一个站点。");
					return;
				}
				const next = sites.filter((site) => site.id !== id);
				persist(next);
				if (id === activeId) selectSite(next[0].id);
			};

			const restoreDefaults = () => {
				persist(DEFAULT_SITES.slice());
				selectSite(DEFAULT_SITES[0].id);
				setDraftError(null);
			};

			const bar = h(
				"div",
				{ className: "dsdb_bar" },
				IconButton({ title: "后退", path: ICON.back, onClick: goBack, disabled: !status.canBack }),
				IconButton({ title: "前进", path: ICON.forward, onClick: goForward, disabled: !status.canForward }),
				IconButton({ title: "刷新", path: ICON.reload, onClick: reload }),
				IconButton({ title: "回到首页", path: ICON.home, onClick: goHome }),
				h("div", { className: "dsdb_pills" },
					sites.map((site) =>
						h("button", {
							key: site.id,
							type: "button",
							className: site.id === activeId ? "dsdb_pill dsdb_pillActive" : "dsdb_pill",
							title: site.url,
							onClick: () => selectSite(site.id)
						}, site.label)
					),
					h("button", {
						type: "button",
						className: "dsdb_pill dsdb_pillAdd",
						title: "添加站点",
						onClick: () => { setManaging(true); setDraftError(null); }
					}, "+ 添加")
				),
				h("div", { className: "dsdb_spacer" }),
				h("span", { className: "dsdb_title", title: status.title === "" ? (active === null ? "" : active.url) : status.title },
					status.loading ? "加载中…" : (status.title === "" ? (active === null ? "" : new URL(active.url).hostname) : status.title)),
				IconButton({ title: "在系统浏览器打开", path: ICON.external, onClick: openExternally }),
				IconButton({ title: "站点管理", path: ICON.settings, onClick: () => { setManaging(true); setDraftError(null); } })
			);

			const overlay = (() => {
				if (blocked !== null) {
					const title = blocked.kind === "bridge" ? "当前环境不支持内嵌网页"
						: blocked.kind === "acquire" ? "桌面授权失败"
							: "网页进程已退出";
					const hint = blocked.kind === "acquire"
						? "主进程拒绝了浏览器租约。重启 DSH 后再试；如果反复出现，把下面的错误发给插件作者。"
						: blocked.kind === "crash"
							? "点「重新加载」重建网页进程；若连续崩溃，先切到别的站点再切回来。"
							: "请用桌面版 DSH（Electron 窗口）打开这个入口。";
					return h("div", { className: "dsdb_overlay" },
						h("div", { className: "dsdb_overlayInner" },
							h("div", { className: "dsdb_overlayTitle" }, title),
							h("div", { className: "dsdb_overlayText" }, blocked.detail),
							h("div", { className: "dsdb_overlayText" }, hint),
							h("div", { style: { display: "flex", gap: 8 } },
								h("button", { type: "button", className: "dsdb_primary", onClick: goHome }, "重新加载"),
								h("button", { type: "button", className: "dsdb_ghost", onClick: openExternally }, "交给系统浏览器")
							)
						));
				}
				if (status.error !== null) {
					return h("div", { className: "dsdb_overlay" },
						h("div", { className: "dsdb_overlayInner" },
							h("div", { className: "dsdb_overlayTitle" }, "打不开这个页面"),
							h("div", { className: "dsdb_overlayText" }, status.error),
							h("div", { style: { display: "flex", gap: 8 } },
								h("button", { type: "button", className: "dsdb_primary", onClick: goHome }, "重试"),
								h("button", { type: "button", className: "dsdb_ghost", onClick: openExternally }, "交给系统浏览器")
							)
						));
				}
				return null;
			})();

			const body = h(
				"div",
				{ className: "dsdb_body" },
				h("div", { ref: hostRef, style: { position: "absolute", inset: 0, display: "flex" } }),
				status.loading && status.error === null && blocked === null ? h("div", { className: "dsdb_progressBar" }) : null,
				overlay,
				managing ? renderManager() : null
			);

			function renderManager() {
				return h(
					"div",
					{ className: "dsdb_card" },
					h("div", { className: "dsdb_cardInner" },
						h("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
							h("h3", { className: "dsdb_cardTitle" }, "站点管理"),
							h("div", { className: "dsdb_spacer" }),
							h("button", { type: "button", className: "dsdb_ghost", onClick: () => setManaging(false) }, "完成")
						),
						h("p", { className: "dsdb_cardHint" }, "点顶部胶囊切换站点；这里可以增删站点、恢复默认清单。清单只保存在本机（localStorage），不随插件同步。"),
						h("p", { className: "dsdb_cardHint" }, "登录状态保存在本次运行的 DSH 进程内：切站点、切面板不会掉登录，重启 DSH 后需要重新登录（分区由 DSH 主进程分配，插件改不了）。"),
						h("div", { className: "dsdb_list" },
							sites.map((site) =>
								h("div", { key: site.id, className: "dsdb_row" },
									h("div", { className: "dsdb_rowMain" },
										h("span", { className: "dsdb_rowLabel" }, site.label),
										h("span", { className: "dsdb_rowUrl", title: site.url }, site.url)
									),
									h("button", { type: "button", className: "dsdb_ghost", onClick: () => { selectSite(site.id); setManaging(false); } }, "打开"),
									h(IconButton, { title: "删除 " + site.label, path: ICON.trash, onClick: () => removeSite(site.id) })
								)
							)
						),
						h("div", { className: "dsdb_form" },
							h("input", {
								className: "dsdb_input dsdb_inputName",
								placeholder: "名称（可空）",
								value: draft.label,
								onChange: (event) => setDraft({ label: event.target.value, url: draft.url }),
								onKeyDown: (event) => { if (event.key === "Enter") addSite(); }
							}),
							h("input", {
								className: "dsdb_input dsdb_inputUrl",
								placeholder: "网址，例如 chat.deepseek.com",
								value: draft.url,
								onChange: (event) => setDraft({ label: draft.label, url: event.target.value }),
								onKeyDown: (event) => { if (event.key === "Enter") addSite(); }
							}),
							h("button", { type: "button", className: "dsdb_primary", onClick: addSite }, "添加"),
							h("button", { type: "button", className: "dsdb_ghost", onClick: restoreDefaults }, "恢复默认清单")
						),
						draftError === null ? null : h("div", { className: "dsdb_error" }, draftError),
						h("p", { className: "dsdb_cardHint" }, "浏览器的 Cookie 与登录态由 DSH 主进程按工作区分配，属于进程内隔离存储：切站点、切面板都不会丢，重启 DSH 后需要重新登录一次。这是桌面版的安全策略，插件侧改不了。")
					)
				);
			}

			return h("div", { className: "dsdb_root" }, bar, body);
		}

		/* ────────────────────────────── 插件装配 ────────────────────────────── */

		/**
		 * 注册左栏入口与主面板。
		 *
		 * 两步都必须先 slots.inject(slotName, ...) 再 slots.register：
		 * 宿主还没声明该 slot 时直接 register 会被丢弃（且不报错），这是本机
		 * 0.2.1-rc.3 上最容易踩的坑之一。
		 */
		function apply(ctx) {
			ensureStyle();

			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register({
					name: "sidebar.panellist",
					id: PANEL_ID,
					order: PANEL_ORDER,
					label: () => "DeepSeek 浏览器"
				}, (ownerProps) => h(BrowserRowIcon, ownerProps && typeof ownerProps === "object" ? ownerProps : {}))
			);

			ctx.slots.inject("main", () =>
				ctx.slots.register({
					name: "main",
					key: PANEL_ID
				}, () => h(BrowserPanel))
			);
		}

		const inject = ["slots"];

		return { apply: apply, inject: inject };
	}
});
