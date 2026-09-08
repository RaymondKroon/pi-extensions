// browser-interact — general interaction tools for a single website / tab.
//
// Drives ONE Chrome tab (already running with --remote-debugging-port=9222)
// over raw CDP: status, evaluate, wait, screenshot, click (trusted input),
// type, press, scroll, console, dismiss, navigate.
//
// Same discipline as a dedicated app bridge (one persistent attach per tab,
// dismiss before interacting, wait after navigation, console as evidence)
// but no app-specific selectors and no daemon process — the extension holds
// the CDP WebSocket directly.
//
// Target tab resolution (first match wins):
//   1. the tool's `tab` parameter (URL substring)
//   2. $BROWSER_INTERACT_TAB
//   3. .pi/browser-interact.json  { "tab": "localhost:5173", "port": 9222 }
//   4. the first page tab (shortest URL)
// Port: $BROWSER_INTERACT_PORT, else config `port`, else 9222.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CdpManager, evaluate, screenshot } from "./cdp";

const DEFAULT_PORT = 9222;

export interface DismissConfig {
  /** Extra container selectors for dialog-like popups (app-specific). */
  extraSelectors?: string[];
  /** Extra close-button labels, matched case-insensitively (e.g. Dutch). */
  closeLabels?: string[];
  /** Selectors that are reported but never touched (e.g. loading overlays). */
  reportOnly?: string[];
}

export interface BrowserInteractConfig {
  port?: number;
  tab?: string;
  dismiss?: DismissConfig;
}

const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.length ? v.filter((x): x is string => typeof x === "string") : undefined;

function loadConfig(cwd: string): BrowserInteractConfig {
  try {
    const p = join(cwd, CONFIG_DIR_NAME, "browser-interact.json");
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      return {
        port: typeof cfg.port === "number" ? cfg.port : undefined,
        tab: typeof cfg.tab === "string" && cfg.tab ? cfg.tab : undefined,
        dismiss:
          cfg.dismiss && typeof cfg.dismiss === "object"
            ? {
                extraSelectors: strList(cfg.dismiss.extraSelectors),
                closeLabels: strList(cfg.dismiss.closeLabels),
                reportOnly: strList(cfg.dismiss.reportOnly),
              }
            : undefined,
      };
    }
  } catch {}
  return {};
}

// ------------------------------------------------------------------ in-page

// Actionability check + centre point for a trusted CDP click. Viewport
// coordinates (getBoundingClientRect) are exactly what Input.dispatchMouseEvent
// expects. Returns { ok: false, reason } while not actionable so the caller
// can poll.
const ACTIONABILITY = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, reason: 'not-found' };
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return { ok: false, reason: 'not-visible' };
  let r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return { ok: false, reason: 'not-visible' };
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  if (top && top !== el && !el.contains(top)) {
    const cls = String(top.className || '').split(/\\s+/)[0];
    return { ok: false, reason: 'covered-by-' + (top.tagName || '?').toLowerCase() + (cls ? '.' + cls : '') };
  }
  return { ok: true, x, y, tag: el.tagName, text: (el.textContent || el.value || '').trim().slice(0, 80) };
}`;

// One Runtime.evaluate with awaitPromise: raw CDP has no short per-command
// timeout, so a single in-page async poll loop is reliable here (unlike the
// Bun.WebView chrome backend, which forced the watcher+poll design).
const WAIT_FN = `async (expr, timeoutMs) => {
  const t0 = Date.now();
  for (;;) {
    let r;
    try { r = eval(expr); } catch (e) { return { done: true, error: String(e), ms: Date.now() - t0 }; }
    if (r) return { done: true, result: r, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { done: true, result: null, ms: Date.now() - t0 };
    await new Promise((res) => setTimeout(res, 500));
  }
}`;

// Generic popup dismissal: modal dialogs, then toasts/notifications.
// Best effort — it reports what it clicked so the caller can verify.
// Project config (.pi/browser-interact.json → "dismiss") adds app-specific
// container selectors, close-button labels, and report-only selectors
// (e.g. loading overlays that cannot be closed).
function dismissExpression(dismiss?: DismissConfig): string {
  const extra = dismiss?.extraSelectors ?? [];
  const labels = (dismiss?.closeLabels ?? []).map((l) => l.toLowerCase());
  const reportOnly = dismiss?.reportOnly ?? [];
  return `(() => {
  const results = [];
  const handled = new Set();
  const isVisible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const isHandled = (el) => { for (const h of handled) if (h === el || h.contains(el) || el.contains(h)) return true; return false; };
  const label = (b) => (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase();
  const extraLabels = ${JSON.stringify(labels)};
  const isCloseBtn = (b) => /^(close|ok|got it|dismiss|cancel|×|x)$/.test(label(b)) || extraLabels.includes(label(b)) || /close/i.test(String(b.className || ''));
  const dialogSels = ['[role=dialog]', '[role=alertdialog]', '[class*=modal i]', '[class*=dialog i]', ...${JSON.stringify(extra)}];
  const dialogs = [...document.querySelectorAll(dialogSels.join(', '))].filter((d) => isVisible(d) && !isHandled(d));
  for (const d of dialogs) {
    const btn = d.querySelector('[aria-label*=close i], [class*=close i]') || [...d.querySelectorAll('button')].find(isCloseBtn);
    if (btn) { btn.click(); handled.add(d); results.push({ type: 'dialog', text: d.textContent.trim().slice(0, 80) }); }
  }
  const toasts = [...document.querySelectorAll('[role=alert], [class*=toast i], [class*=notification i], [class*=snackbar i]')]
    .filter((e) => isVisible(e) && e.textContent.trim() && !isHandled(e));
  for (const n of toasts) {
    const btn = n.querySelector('[aria-label*=close i], [class*=close i], button');
    if (btn) { btn.click(); handled.add(n); results.push({ type: 'toast', text: n.textContent.trim().slice(0, 80) }); }
  }
  for (const sel of ${JSON.stringify(reportOnly)}) {
    for (const el of document.querySelectorAll(sel)) {
      if (isVisible(el)) results.push({ type: 'waiting', selector: sel, text: 'visible, cannot dismiss — wait for it to clear' });
    }
  }
  return { dismissed: results.filter((r) => r.type !== 'waiting').length, items: results };
})()`;
}

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  " ": { key: " ", code: "Space", keyCode: 32, text: " " },
};

function keySpec(key: string): { key: string; code: string; keyCode: number; text?: string } {
  const known = KEYS[key];
  if (known) return known;
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const code = /[a-z]/i.test(key) ? `Key${upper}` : /\d/.test(key) ? `Digit${key}` : undefined;
    return {
      key,
      code: code ?? "",
      keyCode: /[a-z0-9]/i.test(key) ? upper.charCodeAt(0) : key.charCodeAt(0),
      text: key,
    };
  }
  throw new Error(
    `unknown key "${key}" — use Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, or a single character`,
  );
}

// ------------------------------------------------------------------ tools ---

export default function (pi: ExtensionAPI) {
  const mgr = new CdpManager();

  const resolveConfig = (cwd: string): void => {
    const cfg = loadConfig(cwd);
    mgr.port = Number(process.env.BROWSER_INTERACT_PORT) || cfg.port || DEFAULT_PORT;
    mgr.defaultTab = process.env.BROWSER_INTERACT_TAB || cfg.tab;
  };

  const run = <T>(tab: string | undefined, cwd: string, fn: (s: any) => Promise<T>): Promise<T> => {
    resolveConfig(cwd);
    return mgr.run(tab, fn);
  };

  const TAB = Type.Optional(
    Type.String({
      description:
        "URL substring identifying the target tab (default: configured tab via $BROWSER_INTERACT_TAB or .pi/browser-interact.json, else the first page tab)",
    }),
  );

  const text = (v: unknown): string =>
    v === undefined ? "undefined" : typeof v === "string" ? v : JSON.stringify(v, null, 2);

  const defaultShot = (url: string): string => {
    let host = "page";
    try {
      host = new URL(url).hostname || "page";
    } catch {}
    return `/tmp/tab-${host.replace(/[^a-z0-9.-]/gi, "_")}-shot.png`;
  };

  pi.registerTool({
    name: "tab_status",
    label: "Tab Status",
    description:
      "Show which page the target tab is on (attached? url, title). Run this first to orient before interacting.",
    promptSnippet: "Show the target tab's current URL/title (CDP)",
    parameters: Type.Object({ tab: TAB }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const status = await run(params.tab, ctx.cwd, async (s) => {
        const { href, title } = await evaluate(s, "({ href: location.href, title: document.title })", {
          timeoutMs: 10_000,
        });
        return { attached: true, url: href, title };
      });
      return { content: [{ type: "text", text: text(status) }] };
    },
  });

  pi.registerTool({
    name: "tab_evaluate",
    label: "Tab Evaluate",
    description:
      "Evaluate a JS expression in the target tab and return the result (JSON-serializable; promises are awaited). Use it to inspect the DOM, read state, or perform small actions.",
    promptSnippet: "Evaluate a JS expression in the target tab",
    parameters: Type.Object({
      expression: Type.String({ description: "JS expression (wrap multiple statements in an IIFE)" }),
      tab: TAB,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await run(params.tab, ctx.cwd, (s) => evaluate(s, params.expression));
      return { content: [{ type: "text", text: text(result) }] };
    },
  });

  pi.registerTool({
    name: "tab_wait",
    label: "Tab Wait",
    description:
      "Wait until a SYNCHRONOUS JS expression in the target tab is truthy (re-checked every 500ms). Use after any click/navigation instead of assuming the page updated. Returns {done, result, ms} or {done, error, ms}.",
    promptSnippet: "Wait until a JS expression is truthy in the target tab",
    parameters: Type.Object({
      expression: Type.String({
        description: "Synchronous JS expression, e.g. document.body.innerText.includes('Saved')",
      }),
      timeoutMs: Type.Optional(Type.Number({ description: "Max wait in ms (default 60000, max 300000)" })),
      tab: TAB,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 60_000, 1000), 300_000);
      const expr = `(${WAIT_FN})(${JSON.stringify(params.expression)}, ${timeoutMs})`;
      const result = await run(params.tab, ctx.cwd, async (s) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return await evaluate(s, expr, { awaitPromise: true, timeoutMs: timeoutMs + 15_000 });
          } catch (e: any) {
            // A full page reload destroys the execution context and kills
            // the promise — retry the wait on the (same, re-usable) session.
            if (/context|navigat|destroyed/i.test(String(e?.message ?? e)) && attempt < 2) {
              await new Promise((r) => setTimeout(r, 1000));
              continue;
            }
            throw e;
          }
        }
        return null;
      });
      return { content: [{ type: "text", text: text(result ?? { done: true, result: null }) }] };
    },
  });

  pi.registerTool({
    name: "tab_screenshot",
    label: "Tab Screenshot",
    description:
      "Save a PNG screenshot of the target tab's viewport and return the file path (read it with the read tool). Screenshot every step of a journey, before and after each action.",
    promptSnippet: "Screenshot the target tab to a PNG file",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Output PNG path (default /tmp/tab-<host>-shot.png)" })),
      tab: TAB,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const out = await run(params.tab, ctx.cwd, (s) => screenshot(s, params.path ?? defaultShot(s.url)));
      return { content: [{ type: "text", text: out }] };
    },
  });

  pi.registerTool({
    name: "tab_click",
    label: "Tab Click",
    description:
      "Click a CSS selector in the target tab: polls actionability (visible, enabled, not covered), then dispatches a TRUSTED CDP mouse sequence at the element's centre. Fails with a reason: not-found, not-visible, disabled, covered-by-<el> (fix the overlay/selector, don't retry blindly).",
    promptSnippet: "Trusted click on a CSS selector in the target tab",
    parameters: Type.Object({
      selector: Type.String({ description: "CSS selector of the element to click" }),
      timeoutMs: Type.Optional(Type.Number({ description: "Max wait for actionability in ms (default 10000)" })),
      tab: TAB,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 10_000, 500), 120_000);
      const result = await run(params.tab, ctx.cwd, async (s) => {
        const t0 = Date.now();
        let last: any = null;
        for (;;) {
          const st = await evaluate(s, `(${ACTIONABILITY})(${JSON.stringify(params.selector)})`, {
            timeoutMs: 10_000,
          });
          if (st?.ok) {
            // mouseMoved is best-effort: on some busy pages it hangs until
            // Chrome's internal debugger timeout; the press/release pair is
            // what produces the click.
            await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: st.x, y: st.y }, 5_000).catch(() => {});
            await s.send(
              "Input.dispatchMouseEvent",
              { type: "mousePressed", x: st.x, y: st.y, button: "left", clickCount: 1 },
              10_000,
            );
            await s.send(
              "Input.dispatchMouseEvent",
              { type: "mouseReleased", x: st.x, y: st.y, button: "left", clickCount: 1 },
              10_000,
            );
            return { ok: true, trusted: true, tag: st.tag, text: st.text };
          }
          last = st;
          if (Date.now() - t0 > timeoutMs) {
            throw new Error(
              `click: selector "${params.selector}" not actionable after ${timeoutMs}ms (${last?.reason ?? "unknown"})`,
            );
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      });
      return { content: [{ type: "text", text: text(result) }] };
    },
  });

  pi.registerTool({
    name: "tab_type",
    label: "Tab Type",
    description:
      "Type text into the FOCUSED element of the target tab (trusted Input.insertText — click the field first). Fires input events but no keydown; use tab_press for keys.",
    promptSnippet: "Type text into the focused element of the target tab",
    parameters: Type.Object({
      text: Type.String({ description: "Text to type" }),
      tab: TAB,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await run(params.tab, ctx.cwd, (s) => s.send("Input.insertText", { text: params.text }, 30_000));
      return { content: [{ type: "text", text: "ok" }] };
    },
  });

  pi.registerTool({
    name: "tab_press",
    label: "Tab Press",
    description:
      "Press a key in the target tab (trusted CDP key events): Enter (submits the focused form, like a real keypress), Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, or a single character.",
    promptSnippet: "Press a key in the target tab",
    parameters: Type.Object({
      key: Type.String({ description: "Key name or single character" }),
      tab: TAB,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const k = keySpec(params.key);
      await run(params.tab, ctx.cwd, async (s) => {
        const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode };
        // keyDown with `text` inserts the character; a separate `char` event
        // would type it twice.
        await s.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(k.text ? { text: k.text } : {}) }, 10_000);
        await s.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, 10_000);
      });
      return { content: [{ type: "text", text: "ok" }] };
    },
  });

  pi.registerTool({
    name: "tab_scroll",
    label: "Tab Scroll",
    description:
      "Scroll the target tab: by pixel offset (x, y) or scroll a CSS selector into view. Long tables need scrolling before screenshotting.",
    promptSnippet: "Scroll the target tab (offset or selector into view)",
    parameters: Type.Object({
      x: Type.Optional(Type.Number({ description: "Horizontal scroll offset in px" })),
      y: Type.Optional(Type.Number({ description: "Vertical scroll offset in px" })),
      selector: Type.Optional(Type.String({ description: "CSS selector to scroll into view" })),
      tab: TAB,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await run(params.tab, ctx.cwd, (s) =>
        params.selector
          ? evaluate(s, `document.querySelector(${JSON.stringify(params.selector)})?.scrollIntoView({ block: 'center' })`)
          : evaluate(s, `window.scrollBy(${Number(params.x) || 0}, ${Number(params.y) || 0})`),
      );
      return { content: [{ type: "text", text: "ok" }] };
    },
  });

  pi.registerTool({
    name: "tab_console",
    label: "Tab Console",
    description:
      "Read the target tab's console.error / console.warn / uncaught exceptions captured since attach (survives reloads). Check after actions — console errors are evidence of broken behaviour. Pass clear: true to empty the buffer.",
    promptSnippet: "Read (and optionally clear) the target tab's console errors/warnings",
    parameters: Type.Object({
      clear: Type.Optional(Type.Boolean({ description: "Clear the buffer after reading" })),
      tab: TAB,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const messages = await run(params.tab, ctx.cwd, (s) => {
        const out = [...s.consoleBuffer];
        if (params.clear) s.consoleBuffer.length = 0;
        return out;
      });
      return { content: [{ type: "text", text: messages.length ? messages.join("\n") : "(no console errors/warnings)" }] };
    },
  });

  pi.registerTool({
    name: "tab_dismiss",
    label: "Tab Dismiss",
    description:
      "Detect and close visible popups, modal dialogs, or toast notifications in the target tab. Returns {dismissed, items[]}; items with type 'waiting' are visible but cannot be dismissed (e.g. loading overlays) — wait for them to clear. App-specific selectors/labels can be configured in .pi/browser-interact.json. Run before navigating or interacting — a lingering popup blocks clicks and corrupts screenshots.",
    promptSnippet: "Dismiss visible popups/dialogs/toasts in the target tab",
    parameters: Type.Object({ tab: TAB }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd);
      const result = await run(params.tab, ctx.cwd, (s) =>
        evaluate(s, dismissExpression(cfg.dismiss), { timeoutMs: 15_000 }),
      );
      return { content: [{ type: "text", text: text(result ?? { dismissed: 0, items: [] }) }] };
    },
  });

  pi.registerTool({
    name: "tab_navigate",
    label: "Tab Navigate",
    description:
      "Navigate the target tab to a URL and wait for the page to finish loading. Prefer in-app navigation (clicking links) when the app supports it; use this to jump to a known URL.",
    promptSnippet: "Navigate the target tab to a URL",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL to navigate to" }),
      tab: TAB,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await run(params.tab, ctx.cwd, async (s) => {
        await s.send("Page.navigate", { url: params.url }, 30_000);
        const t0 = Date.now();
        for (;;) {
          const state = await evaluate(s, "document.readyState", { timeoutMs: 10_000 });
          if (state === "complete") break;
          if (Date.now() - t0 > 30_000) throw new Error("navigate: page did not finish loading after 30000ms");
          await new Promise((r) => setTimeout(r, 500));
        }
      });
      return { content: [{ type: "text", text: `navigated to ${params.url}` }] };
    },
  });

  pi.on("session_shutdown", () => {
    mgr.closeAll();
  });

  pi.registerCommand("tab", {
    description: "browser-interact: show tab status, or detach with /tab shutdown",
    handler: async (args, ctx) => {
      resolveConfig(ctx.cwd);
      if (args?.trim() === "shutdown") {
        mgr.closeAll();
        ctx.ui.notify("browser-interact: all CDP sessions closed", "info");
        return;
      }
      const attached = mgr.attached();
      if (!attached.length) {
        ctx.ui.notify(
          `browser-interact: not attached (port ${mgr.port}, default tab ${mgr.defaultTab ?? "first page tab"}) — the next tab_* tool attaches`,
          "info",
        );
        return;
      }
      for (const a of attached) {
        const st = await mgr.status(a.key === "*" ? undefined : a.key);
        ctx.ui.notify(`browser-interact [${a.key}]: ${st.attached ? `${st.title ?? ""} — ${st.url}` : JSON.stringify(st)}`, "info");
      }
    },
  });
}
