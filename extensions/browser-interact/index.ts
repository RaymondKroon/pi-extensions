// browser-interact — general interaction tools for a single website / tab.
//
// Drives ONE Chrome tab (already running with --remote-debugging-port=9222)
// over raw CDP: status, list, evaluate, wait, screenshot, click (trusted input),
// hover, type, press, scroll, console, dismiss, navigate, open, close.
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
//   4. the active page tab (shortest URL fallback if Chrome reports none)
// Port: $BROWSER_INTERACT_PORT, else config `port`, else 9222.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CdpManager, evaluate, screenshot, type CdpSession, type CdpTarget } from "./cdp";
import { OVERLAY_SCRIPT, OVERLAY_V } from "./overlay";
import { createOverlayChannel, type OverlayChannel } from "./overlay-channel";
import { ToolCallTracker } from "./tool-update";

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

// Hover actionability: same as click, minus the disabled check — hover is
// still meaningful on disabled elements (tooltips on greyed-out buttons),
// and a disabled parent must not block hovering a live child.
const HOVER_ACTIONABILITY = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, reason: 'not-found' };
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return { ok: false, reason: 'not-visible' };
  let r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return { ok: false, reason: 'not-visible' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  if (top && top !== el && !el.contains(top)) {
    const cls = String(top.className || '').split(/\\s+/)[0];
    return { ok: false, reason: 'covered-by-' + (top.tagName || '?').toLowerCase() + (cls ? '.' + cls : '') };
  }
  return { ok: true, x, y, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80) };
}`;

// Is `sel` in the DOM and visible? Returns { tag, text } or null — used to
// confirm a hover produced its result (tooltip, hover menu, preview).
const VISIBLE_FN = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { tag: el.tagName, text: (el.textContent || '').trim().slice(0, 120) };
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

  // ----------------------------------------------------------------- chat --
  // The in-page chat dock is a UI surface over THIS pi session: chat text
  // arrives as user messages, and session events are broadcast back to every
  // docked tab. The dock renders agent replies in the page DOM, so the page
  // itself can read them — the secrets never leave this process.
  let agentBusy = false;
  /** toolCallId → serialized arguments, paired with the result for the dock's expandable tool rows. */
  const toolTracker = new ToolCallTracker();
  // pi → page update channel for every docked tab (queue + 1s poller, with
  // self-healing of a lost overlay registration after a CDP socket drop).
  let channel: OverlayChannel;

  const assistantText = (m: any): string => {
    if (!m) return "";
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("\n");
    }
    return "";
  };

  pi.on("agent_start", () => {
    agentBusy = true;
    channel.broadcastUpdates([{ kind: "status", busy: true }]);
  });
  pi.on("agent_end", () => {
    agentBusy = false;
    channel.broadcastUpdates([{ kind: "status", busy: false }]);
  });
  pi.on("message_end", (ev) => {
    const m = (ev as any).message;
    if (m?.role === "assistant") {
      const text = assistantText(m).trim();
      if (text) channel.broadcastUpdates([{ kind: "msg", role: "agent", text: text.slice(0, 8000) }]);
      toolTracker.trackAssistant(m);
    } else if (m?.role === "toolResult") {
      channel.broadcastUpdates([toolTracker.toolResult(m)]);
    }
  });

  // Page → pi: the overlay queues signals (console events are dropped by the
  // Browser Bridge proxy, so the poller pops them). Chat text only ever comes
  // from trusted user events on the page (isTrusted guard in the overlay).
  const handlePageSignal = (sig: Record<string, unknown>): void => {
    if (sig.type === "chat") {
      const t = typeof sig.text === "string" ? sig.text.trim().slice(0, 4000) : "";
      if (!t) return;
      // While a run is active, queue it as a follow-up; otherwise start one.
      pi.sendUserMessage(`[browser chat] ${t}`, agentBusy ? { deliverAs: "followUp" } : {});
      return;
    }
    if (sig.type !== "note-saved") return;
    const index = String(sig.index ?? "?");
    const text = typeof sig.text === "string" && sig.text ? `: "${sig.text}"` : "";
    pi.sendUserMessage(
      `[lens] note ${index} saved${text} on the page — call tab_lens to read the annotations and their cropped screenshots.`,
      { deliverAs: "steer" },
    );
  };

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
        "URL substring identifying the target tab (default: configured tab via $BROWSER_INTERACT_TAB or .pi/browser-interact.json, else the active page tab)",
    }),
  );

  const text = (v: unknown): string =>
    v === undefined ? "undefined" : typeof v === "string" ? v : JSON.stringify(v, null, 2);

  /** Text-only tool result; `details` is unused but required by current pi types. */
  const toolResult = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

  const defaultShot = (url: string): string => {
    let host = "page";
    try {
      host = new URL(url).hostname || "page";
    } catch {}
    return `/tmp/tab-${host.replace(/[^a-z0-9.-]/gi, "_")}-shot.png`;
  };

  // ---------------------------------------------------------- overlay ------

  /** Install the page overlay (lens + chat dock) on the target: best-effort
   * per-document install script (auto re-install on reload) plus a runtime
   * check — if the current document lacks the overlay (registration lost to a
   * re-attach or proxy quirk), inject it directly. User state survives all of
   * this via sessionStorage. */
  const ensureOverlay = async (s: CdpSession): Promise<void> => {
    // Re-register the new-document script when the source changed (extension
    // update) — a stale registration would keep installing the old overlay.
    if (!s.overlayScriptId || s.overlayScriptSource !== OVERLAY_SCRIPT) {
      if (s.overlayScriptId) {
        await s.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: s.overlayScriptId }, 5_000).catch(() => {});
      }
      const { identifier } = await s.send(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: OVERLAY_SCRIPT },
        10_000,
      );
      s.overlayScriptId = identifier;
      s.overlayScriptSource = OVERLAY_SCRIPT;
    }
    const has = await evaluate(s, `!!(window.__piOverlay && window.__piOverlay.__v === ${OVERLAY_V})`, { timeoutMs: 10_000 }).catch(
      () => false,
    );
    if (!has) await evaluate(s, OVERLAY_SCRIPT, { timeoutMs: 10_000 });
    channel.startPoll();
  };

  // Overlay channel: per-tab update queue + one poller tick per second that
  // drains it into the overlay AND pops the page's signal queue in the same
  // call (console events cannot be used — dropped by the Browser Bridge
  // proxy). Self-heals an attached session that lost its overlay registration
  // (CDP socket drop → fresh session on re-attach): without this the dock
  // silently goes stale, because broadcasts and the poller both require
  // overlayScriptId.
  channel = createOverlayChannel({
    attached: () => mgr.attached(),
    sessionFor: (p?: string) => mgr.sessionFor(p),
    ensureOverlay,
    onSignal: handlePageSignal,
  });

  const LENS_ACTIONS = ["on", "off", "list", "clear"] as const;
  type LensAction = (typeof LENS_ACTIONS)[number];

  /** Shared by the tab_lens tool; returns text. */
  const lensAction = async (action: LensAction, cwd: string, tab?: string): Promise<string> => {
    if (action === "on" || action === "off") {
      await run(tab, cwd, async (s) => {
        await ensureOverlay(s);
        await evaluate(s, `window.__piOverlay && window.__piOverlay.lens.setEnabled(${action === "on"})`, {
          timeoutMs: 10_000,
        });
      });
      return action === "on"
        ? "lens armed — in the browser: drag a box around what to show, type the note in the pop-up and press Enter (drag more boxes for more notes; Esc turns the lens off). Read it back with tab_lens {action:'list'}."
        : "lens disarmed — annotations are kept; read them with tab_lens {action:'list'}";
    }
    if (action === "clear") {
      await run(tab, cwd, async (s) => {
        await ensureOverlay(s);
        await evaluate(s, "window.__piOverlay && window.__piOverlay.lens.clear()", { timeoutMs: 10_000 });
      });
      return "ok — lens annotations cleared";
    }
    // list: read the annotations, then save a cropped screenshot per box.
    const snap: any = await run(tab, cwd, async (s) => {
      await ensureOverlay(s);
      const r = await evaluate(s, "window.__piOverlay ? window.__piOverlay.lens.snapshot() : null", { timeoutMs: 10_000 });
      if (!r) throw new Error("overlay is not installed on this page — arm it with action:'on'");
      return r;
    });
    let host = "page";
    try {
      host = new URL(snap.url).hostname || "page";
    } catch {}
    host = host.replace(/[^a-z0-9.-]/gi, "_");
    const annotated: any[] = [];
    for (const n of snap.notes ?? []) {
      const p = `/tmp/tab-${host}-lens-${n.index}.png`;
      await run(tab, cwd, async (s) => {
        // Scroll the box into view first so lazy-loaded content (images,
        // iframes) renders. The clip itself is in DOCUMENT coordinates with
        // captureBeyondViewport — a viewport-relative clip captures the wrong
        // region (verified: dark top-margin instead of the box).
        await evaluate(s, `window.scrollTo(0, ${Math.max(0, n.docY - 100)})`, { timeoutMs: 10_000 });
        await new Promise((r) => setTimeout(r, 250)); // let lazy content settle
        const { data } = await s.send(
          "Page.captureScreenshot",
          {
            format: "png",
            captureBeyondViewport: true,
            clip: {
              x: Math.round(n.docX),
              y: Math.round(n.docY),
              width: Math.round(n.w),
              height: Math.round(n.h),
              scale: 1,
            },
          },
          30_000,
        );
        writeFileSync(p, Buffer.from(String(data), "base64"));
      });
      annotated.push({ ...n, screenshot: p });
    }
    return text({
      url: snap.url,
      title: snap.title,
      lensEnabled: !!snap.enabled,
      count: (snap.notes ?? []).length,
      notes: annotated,
      hint: annotated.length
        ? "read each note's screenshot with the read tool to see exactly what the user framed"
        : "no annotations yet — arm the lens (action:'on') and ask the user to drag a box in the browser, type the note and press Enter",
    });
  };

  pi.registerTool({
    name: "tab_status",
    label: "Tab Status",
    description:
      "Show which page the target tab is on (attached? target id, url, title). Run this first to orient before interacting. The targetId is the exact handle for tab_close.",
    promptSnippet: "Show the target tab's current URL/title (CDP)",
    parameters: Type.Object({ tab: TAB }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const status = await run(params.tab, ctx.cwd, async (s) => {
        const { href, title } = await evaluate(s, "({ href: location.href, title: document.title })", {
          timeoutMs: 10_000,
        });
        return { attached: true, targetId: s.targetId, url: href, title };
      });
      return toolResult(text(status));
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
      return toolResult(text(result));
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
      // Poll from the extension side: each iteration is a plain
      // Runtime.evaluate (debug channel, exempt from page CSP). An in-page
      // eval() loop would be blocked by strict CSP pages (e.g. Slack).
      const result = await run(params.tab, ctx.cwd, async (s) => {
        const t0 = Date.now();
        for (;;) {
          try {
            const r = await evaluate(s, params.expression, { timeoutMs: 10_000 });
            if (r) return { done: true, result: r, ms: Date.now() - t0 };
          } catch (e: any) {
            const msg = String(e?.message ?? e);
            // A full page reload destroys the execution context — retry on
            // the (same, re-usable) session. Anything else (e.g. a syntax
            // error in the expression) is reported and stops the wait.
            if (/context|navigat|destroyed/i.test(msg)) {
              if (Date.now() - t0 > timeoutMs) return { done: true, result: null, ms: Date.now() - t0 };
              await new Promise((r) => setTimeout(r, 1000));
              continue;
            }
            return { done: true, error: msg, ms: Date.now() - t0 };
          }
          if (Date.now() - t0 > timeoutMs) return { done: true, result: null, ms: Date.now() - t0 };
          await new Promise((r) => setTimeout(r, 500));
        }
      });
      return toolResult(text(result ?? { done: true, result: null }));
    },
  });

  pi.registerTool({
    name: "tab_screenshot",
    label: "Tab Screenshot",
    description:
      "Save a PNG screenshot of the target tab's viewport and return the file path (read it with the read tool). Use screenshots when visual inspection is useful, such as before a visually dependent action or to verify an important page change; don't take one before and after every action if DOM state is sufficient.",
    promptSnippet: "Screenshot the target tab to a PNG file",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Output PNG path (default /tmp/tab-<host>-shot.png)" })),
      tab: TAB,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const out = await run(params.tab, ctx.cwd, (s) => screenshot(s, params.path ?? defaultShot(s.url)));
      return toolResult(out);
    },
  });

  pi.registerTool({
    name: "tab_lens",
    label: "Tab Lens",
    description:
      "A LENS the USER uses to show you things on the page. action 'on': arms bounding-box selection in the live browser tab (the in-page dock's 🔍 looking-glass button lights up, crosshair cursor; the user drags a box around a region, types a note in the pop-up input and presses Enter; repeat for multiple boxes; Esc disarms). 'off': disarms (annotations kept). 'list' (default): returns the annotations (viewport + document coords, note text, timestamp) and saves a cropped PNG of each box to /tmp. 'clear': removes all annotations (removing a single box: the user clicks its numbered chip in the browser). Saving a note pushes a message into the session automatically. After the user has drawn boxes, call action:'list' and read the returned screenshot files with the read tool to see what they framed.",
    promptSnippet: "Lens: user-drawn bounding boxes + notes on the page, read back with cropped screenshots",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union(
          [
            Type.Literal("on"),
            Type.Literal("off"),
            Type.Literal("list"),
            Type.Literal("clear"),
          ],
          {
            description:
              "on = arm box selection in the browser; off = disarm; list = read annotations + save cropped screenshots (default); clear = remove all annotations",
          },
        ),
      ),
      tab: TAB,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const out = await lensAction(params.action ?? "list", ctx.cwd, params.tab);
      return toolResult(out);
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
      return toolResult(text(result));
    },
  });

  pi.registerTool({
    name: "tab_hover",
    label: "Tab Hover",
    description:
      "Move the mouse in the target tab: over a CSS selector (polls until visible and not covered, then a TRUSTED CDP mouseMoved to its centre) or to exact viewport COORDINATES x/y (no polling; negative coords move the mouse outside the page). Fires :hover / mouseenter / mouseover so tooltips, hover menus and previews appear; the mouse STAYS where it is, so a follow-up tab_click can click what the hover revealed. The result reports elementAt — what is actually under the cursor: hover-generated overlays (link previews, menus) can land there, and the next jump may re-hover them. To UNHOVER reliably, move to an empty spot (e.g. x:-500, y:-500) — hovering body can land on a hover overlay and keep the hover alive. Pass waitFor to also wait for a result element (e.g. a tooltip or menu item) and return its tag/text. Selector mode fails with a reason: not-found, not-visible, covered-by-<el>.",
    promptSnippet: "Trusted hover (mouseMoved) on a CSS selector or x/y coordinates in the target tab",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "CSS selector of the element to hover (alternative to x/y)" })),
      x: Type.Optional(Type.Number({ description: "Viewport x coordinate to move the mouse to (alternative to selector; pair with y). Negative = outside the page (unhover)." })),
      y: Type.Optional(Type.Number({ description: "Viewport y coordinate to move the mouse to (alternative to selector; pair with x). Negative = outside the page (unhover)." })),
      waitFor: Type.Optional(
        Type.String({
          description:
            "CSS selector that should APPEAR as a result of the hover (e.g. a tooltip or hover-menu item); waits for it before returning",
        }),
      ),
      timeoutMs: Type.Optional(Type.Number({ description: "Max wait for actionability / waitFor in ms (default 10000)" })),
      tab: TAB,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const byCoords = params.x !== undefined || params.y !== undefined;
      if (byCoords === (params.selector !== undefined)) {
        throw new Error("tab_hover: pass either a selector or BOTH x and y coordinates");
      }
      const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 10_000, 500), 120_000);
      const result = await run(params.tab, ctx.cwd, async (s) => {
        let st: { x: number; y: number; tag?: string; text?: string };
        if (params.selector !== undefined) {
          const t0 = Date.now();
          let last: any = null;
          for (;;) {
            const chk = await evaluate(s, `(${HOVER_ACTIONABILITY})(${JSON.stringify(params.selector)})`, {
              timeoutMs: 10_000,
            });
            if (chk?.ok) {
              st = chk;
              break;
            }
            last = chk;
            if (Date.now() - t0 > timeoutMs) {
              throw new Error(
                `hover: selector "${params.selector}" not actionable after ${timeoutMs}ms (${last?.reason ?? "unknown"})`,
              );
            }
            await new Promise((r) => setTimeout(r, 500));
          }
        } else {
          st = { x: Number(params.x), y: Number(params.y) };
        }
        // The trusted mouse move IS the hover: Blink fires mousemove/
        // mouseover/mouseenter at the new position (full enter/leave chains
        // when the jump crosses element boundaries), and the position is
        // retained for the next action.
        await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: st.x, y: st.y }, 10_000);
        // What is ACTUALLY under the cursor now — hover overlays can
        // intercept; null means outside the page content (unhovered).
        const elementAt = await evaluate(
          s,
          `(() => { const el = document.elementFromPoint(${st.x}, ${st.y}); return el ? { tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80) } : null })()`,
          { timeoutMs: 10_000 },
        );
        let wait: { selector: string; found: boolean; tag?: string; text?: string; ms: number } | undefined;
        if (params.waitFor) {
          const wt0 = Date.now();
          let found: any = null;
          for (;;) {
            found = await evaluate(s, `(${VISIBLE_FN})(${JSON.stringify(params.waitFor)})`, { timeoutMs: 10_000 });
            if (found || Date.now() - wt0 > timeoutMs) break;
            await new Promise((r) => setTimeout(r, 250));
          }
          wait = {
            selector: params.waitFor,
            found: !!found,
            ...(found ? { tag: found.tag, text: found.text } : {}),
            ms: Date.now() - wt0,
          };
        }
        return { ok: true, trusted: true, hovered: st.tag ? { tag: st.tag, text: st.text } : { x: st.x, y: st.y }, elementAt, ...(wait ? { wait } : {}) };
      });
      return toolResult(text(result));
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
      return toolResult("ok");
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
      return toolResult("ok");
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
      return toolResult("ok");
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
      const messages = await run(params.tab, ctx.cwd, async (s) => {
        const out = [...s.consoleBuffer];
        if (params.clear) s.consoleBuffer.length = 0;
        return out;
      });
      return toolResult(messages.length ? messages.join("\n") : "(no console errors/warnings)");
    },
  });

  pi.registerTool({
    name: "tab_network",
    label: "Tab Network",
    description:
      "List HTTP requests made by the target tab since attach (CDP Network domain: documents, fetch, XHR, assets — survives reloads, includes failures and pending requests). Each row: method, status (or pending/failed), resource type, response size, duration, url. filter matches a URL substring; types filters by resource type (default: document, xhr, fetch — pass e.g. [\"script\",\"image\"] for assets); failedOnly shows failures/pending/4xx/5xx only; limit caps the rows (newest last); clear empties the buffer after reading.",
    promptSnippet: "List network requests captured by CDP for the target tab",
    parameters: Type.Object({
      filter: Type.Optional(Type.String({ description: "URL substring to match" })),
      types: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Resource types to include (default: document, xhr, fetch). Values: document, xhr, fetch, script, stylesheet, image, font, media, other", 
        }),
      ),
      failedOnly: Type.Optional(Type.Boolean({ description: "Only show failed, pending, and HTTP 4xx/5xx requests" })),
      limit: Type.Optional(Type.Number({ description: "Max rows to return, newest last (default 30, max 200)" })),
      clear: Type.Optional(Type.Boolean({ description: "Clear the buffer after reading" })),
      tab: TAB,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const all = await run(params.tab, ctx.cwd, async (s) => {
        const rows = s.networkSnapshot().map((e: any) => ({
          n: e.seq,
          method: e.method,
          status: e.status ?? (e.error ? `failed${e.canceled ? " (canceled)" : ": " + e.error}` : "pending"),
          // Chrome reports e.g. "Fetch"/"XHR" — normalize for filtering.
          type: (e.type ?? "other").toLowerCase(),
          sizeB: e.size ?? null,
          ms: e.ms ?? null,
          url: e.url,
        }));
        if (params.clear) s.clearNetwork();
        return rows;
      });
      let rows = params.filter ? all.filter((r: any) => r.url.includes(params.filter)) : all;
      if (params.failedOnly) {
        rows = rows.filter((r: any) => typeof r.status !== "number" || r.status >= 400);
      } else {
        const types = ((params.types as string[] | undefined) ?? ["document", "xhr", "fetch"]).map((t) => t.toLowerCase());
        rows = rows.filter((r: any) => types.includes(r.type));
      }
      const limit = Math.min(Math.max(Number(params.limit) || 30, 1), 200);
      const shown = rows.slice(-limit);
      return toolResult(
        text({
          capturing: true,
          scope: "since attach of this tab (survives reloads; buffer capped at 250)",
          matched: rows.length,
          shown: shown.length,
          requests: shown,
        }),
      );
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
      return toolResult(text(result ?? { dismissed: 0, items: [] }));
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
      return toolResult(`navigated to ${params.url}`);
    },
  });

  pi.registerTool({
    name: "tab_list",
    label: "Tab List",
    description:
      "List the tabs this extension has ATTACHED to in the current session (pattern, target id, url, title). Only shows tabs a tab_* tool has touched — not all browser tabs. Use tab_open to open new ones.",
    promptSnippet: "List attached browser-interact tabs",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      resolveConfig(ctx.cwd);
      const attached = mgr.attached();
      if (!attached.length) {
        return toolResult("(no attached tabs — the next tab_* tool attaches)");
      }
      const rows = [];
      for (const a of attached) {
        const st = await mgr.status(a.key === "*" ? undefined : a.key);
        rows.push({ key: a.key === "*" ? "(default)" : a.key, ...st });
      }
      return toolResult(text(rows));
    },
  });

  pi.registerTool({
    name: "tab_open",
    label: "Tab Open",
    description:
      "Open a NEW tab in the debugged Chrome (does not touch existing tabs). Returns the new tab's target id and url — pass the id to tab_close to close it precisely, or target the tab by URL substring like any other tab_* tool.",
    promptSnippet: "Open a new tab in the debugged Chrome",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "URL to open (default about:blank)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      resolveConfig(ctx.cwd);
      const t = await mgr.openTarget(params.url);
      // Attach so the new tab shows up in tab_list immediately.
      await mgr.attachTarget(t);
      return toolResult(`opened tab ${t.id} at ${t.url}`);
    },
  });

  pi.registerTool({
    name: "tab_close",
    label: "Tab Close",
    description:
      "Close a tab in the debugged Chrome. Prefer the exact target id (from tab_open or tab_status) — it always closes the right tab. Without an id, the `tab` URL substring must match EXACTLY ONE page tab (fails on zero or multiple matches, listing candidates). Refuses to close the last remaining page tab unless force: true.",
    promptSnippet: "Close a tab in the debugged Chrome (by target id or unique URL substring)",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({ description: "Exact CDP target id to close (from tab_open / tab_status); takes precedence over tab" }),
      ),
      tab: TAB,
      force: Type.Optional(Type.Boolean({ description: "Allow closing the last remaining page tab" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      resolveConfig(ctx.cwd);
      const pages = await mgr.pageTargets();
      if (!pages.length) throw new Error("no page tabs found in Chrome on port " + mgr.port);
      let target: CdpTarget | undefined;
      if (params.id) {
        target = pages.find((t) => t.id === params.id);
        if (!target) {
          throw new Error(
            `no live page tab with id "${params.id}" — open tabs: ${pages.map((t) => `${t.id} (${t.url})`).join(", ")}`,
          );
        }
      } else {
        const pattern = params.tab ?? mgr.defaultTab;
        if (!pattern) {
          throw new Error("tab_close needs a target id or a tab URL substring — refusing to guess which tab to close");
        }
        const matches = pages.filter((t) => t.url.includes(pattern));
        if (matches.length === 0) {
          throw new Error(`no tab matching "${pattern}" — open tabs: ${pages.map((t) => t.url).join(", ")}`);
        }
        if (matches.length > 1) {
          throw new Error(
            `"${pattern}" is ambiguous — matches: ${matches.map((t) => t.url).join(", ")}. Pass the exact id instead.`,
          );
        }
        target = matches[0];
      }
      if (pages.length === 1 && !params.force) {
        throw new Error("refusing to close the last remaining page tab (pass force: true to override)");
      }
      await mgr.closeTarget(target.id);
      mgr.forgetTarget(target.id);
      return toolResult(`closed tab ${target.id} (${target.url})`);
    },
  });

  // Drain any queued dock updates before tearing down: in one-shot modes the
  // session ends right after the final assistant message, and a poller that
  // never ticks would swallow the last reply (the dock would stay silent).
  pi.on("session_shutdown", async () => {
    channel.stopPoll();
    await channel.flush();
    channel.clearQueue();
    mgr.closeAll();
  });

  pi.registerCommand("tab", {
    description:
      "browser-interact: show tab status, open the in-page dock (chat + lens) with /tab interact [on|off], check a URL against the CDT allowlist with /tab check <url>, or detach with /tab shutdown",
    getArgumentCompletions: (prefix) => {
      if (/\s/.test(prefix)) return null; // only complete the subcommand itself
      const subs = [
        { value: "interact ", label: "interact [on|off]", description: "open/close the in-page dock (chat + lens; click 🔍 to arm box selection)" },
        { value: "check ", label: "check <url>", description: "check a URL against the CDT allowlist" },
        { value: "shutdown", label: "shutdown", description: "close all CDP sessions" },
      ];
      const filtered = subs.filter((s) => s.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      resolveConfig(ctx.cwd);
      if (args?.trim() === "shutdown") {
        mgr.closeAll();
        ctx.ui.notify("browser-interact: all CDP sessions closed", "info");
        return;
      }
      const interact = args?.trim().match(/^interact(?:\s+(on|off))?$/);
      if (interact) {
        try {
          const open = interact[1] !== "off";
          await run(undefined, ctx.cwd, async (s) => {
            await ensureOverlay(s);
            await evaluate(s, `window.__piOverlay && window.__piOverlay.chat.setOpen(${open})`, { timeoutMs: 10_000 });
          });
          ctx.ui.notify(
            open
              ? "interaction dock opened in the browser — the user can type tasks into it, and click 🔍 to arm the lens (drag boxes + notes)"
              : "interaction dock minimized in the browser",
            "info",
          );
        } catch (e: any) {
          ctx.ui.notify(String(e?.message ?? e), "error");
        }
        return;
      }
      const check = args?.trim().match(/^check\s+(.+)$/);
      if (check) {
        const url = check[1].trim();
        let t;
        try {
          t = await mgr.openTarget(url);
          // The CDT bridge may only block at attach time (websocket), so
          // exercise that too — that's what the tab_* tools do.
          await mgr.attachTarget(t);
          ctx.ui.notify(`allowlist check: OK — ${url} opened and attached without a block (tab left open)`, "info");
        } catch (e: any) {
          const raw = String(e?.message ?? e);
          const msg = /not on the allowlist/i.test(raw)
            ? `allowlist check: BLOCKED — ${url}\n  Not on the CDT allowlist. Approve it in the CDT Bridge popup, then retry.`
            : `allowlist check: FAILED — ${url}\n  ${raw}`;
          ctx.ui.notify(msg, "error");
        }
        return;
      }
      const arg = args?.trim();
      if (arg) {
        ctx.ui.notify(
          `unknown /tab subcommand: "${arg}" — use: /tab (status), /tab interact [on|off], /tab check <url>, or /tab shutdown`,
          "error",
        );
        return;
      }
      const attached = mgr.attached();
      if (!attached.length) {
        if (!(await mgr.reachable())) {
          ctx.ui.notify(
            `browser-interact: Chrome is not reachable on 127.0.0.1:${mgr.port} — start it with --remote-debugging-port=${mgr.port}, then retry`,
            "error",
          );
          return;
        }
        const pages = await mgr.pageTargets().catch(() => []);
        ctx.ui.notify(
          pages.length
            ? `browser-interact: connected (port ${mgr.port}, ${pages.length} page tab${pages.length === 1 ? "" : "s"}), none attached yet — the next tab_* tool attaches${mgr.defaultTab ? ` to "${mgr.defaultTab}"` : " to the base page tab (shortest URL)"}`
            : `browser-interact: connected (port ${mgr.port}) but no page tabs are open — open one in the browser first`,
          "info",
        );
        return;
      }
      for (const a of attached) {
        const st = await mgr.status(a.key === "*" ? undefined : a.key);
        ctx.ui.notify(
          `browser-interact [${a.key}]: ${st.attached ? `${st.title ?? ""} — ${st.url} (id ${st.targetId})` : JSON.stringify(st)}`,
          "info",
        );
      }
    },
  });
}
