// browser-interact — minimal Chrome DevTools Protocol client for a single tab.
//
// Talks raw CDP over the native WebSocket (Node >= 22) to a Chrome that is
// already running with --remote-debugging-port=<port> (default 9222).
//
// Unlike a per-process WebView bridge (short per-command timeouts, in-page
// console hook), raw CDP:
//   - has no per-command timeout, but `evaluate` adds one; `wait` polls
//     from the extension side (each poll is a plain Runtime.evaluate —
//     an in-page eval() loop would be blocked by strict CSP pages);
//   - delivers console events (Runtime.consoleAPICalled / exceptionThrown)
//     directly, surviving full page reloads — no in-page hook to reinstall;
//   - can dispatch TRUSTED input (Input.dispatchMouseEvent / insertText /
//     dispatchKeyEvent) instead of synthetic in-page events.
//
// One persistent session per tab pattern. The CDP session is bound to the
// target, not the document: it survives navigations and full reloads. A
// closed tab or Chrome restart drops the socket; the next command
// re-attaches automatically (fresh /json lookup).

import { writeFileSync } from "node:fs";

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl: string;
}

/** One captured network request (CDP Network domain), as reported by tab_network. */
export interface NetEntry {
  reqId: string;
  seq: number;
  url: string;
  method: string;
  /** CDP resourceType: document, xhr, fetch, script, stylesheet, image, font, media, other, ... */
  type: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  /** Response body bytes (encodedDataLength from loadingFinished). */
  size?: number;
  /** Start → finish duration in ms. */
  ms?: number;
  error?: string;
  canceled?: boolean;
  /** A 3xx hop of a redirect chain (never finalized) — hidden from tool output. */
  redirectHop?: boolean;
  /** CDP timestamp (seconds) the request was sent. */
  ts: number;
}

const NET_CAP = 250;

interface Pending {
  method: string;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CdpSession {
  readonly targetId: string;
  url: string;
  closed = false;
  /** console.error / console.warn / uncaught exceptions, oldest first, capped. */
  consoleBuffer: string[] = [];
  /** Recent network activity of this target (CDP Network domain), oldest first,
   * capped at NET_CAP. Survives reloads (bound to the target). */
  private netByReq = new Map<string, NetEntry>();
  private netSeq = 0;
  /** id from Page.addScriptToEvaluateOnNewDocument, set once the page overlay
   * (lens + chat dock) is armed on this target (so it re-installs automatically
   * on every reload). */
  overlayScriptId?: string;
  /** source of the installed new-document script (re-register when it changes,
   * e.g. after an extension update). */
  overlayScriptSource?: string;  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(params: any) => void>>();

  constructor(ws: WebSocket, target: CdpTarget) {
    this.ws = ws;
    this.targetId = target.id;
    this.url = target.url;
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = () => this.markClosed();
    ws.onerror = () => this.markClosed();
  }

  on(method: string, fn: (params: any) => void): void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(fn);
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("CDP session is closed"));
    const p = new Promise<any>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.markClosed();
        reject(e);
      }
    });
    // Safety net: a caller that abandons this promise (e.g. the sibling of a
    // Promise.all that already rejected, or a race lost to navigation) must
    // not take the whole process down with an unhandled rejection.
    p.catch(() => {});
    return p;
  }

  /** Record a CDP Network.requestWillBeSent (one entry per requestId). */
  netStart(p: { requestId?: string; timestamp?: number; type?: string; request?: { url?: string; method?: string } }): void {
    if (!p?.requestId || this.netByReq.has(p.requestId)) return;
    this.netByReq.set(p.requestId, {
      reqId: p.requestId,
      seq: ++this.netSeq,
      url: p.request?.url ?? "",
      method: p.request?.method ?? "GET",
      type: p.type ?? "other",
      ts: p.timestamp ?? Date.now() / 1000,
    });
    while (this.netByReq.size > NET_CAP) {
      const oldest = this.netByReq.keys().next().value;
      if (oldest === undefined) break;
      this.netByReq.delete(oldest);
    }
  }

  netResponse(p: { requestId?: string; response?: { status?: number; statusText?: string; mimeType?: string } }): void {
    const e = p?.requestId ? this.netByReq.get(p.requestId) : undefined;
    if (!e) return;
    e.status = p.response?.status;
    e.statusText = p.response?.statusText;
    e.mimeType = p.response?.mimeType;
    if (e.status !== undefined && e.status >= 300 && e.status < 400) e.redirectHop = true;
  }

  netFinished(p: { requestId?: string; timestamp?: number; encodedDataLength?: number }): void {
    const e = p?.requestId ? this.netByReq.get(p.requestId) : undefined;
    if (!e) return;
    e.size = p.encodedDataLength;
    if (p.timestamp) e.ms = Math.max(0, Math.round((p.timestamp - e.ts) * 1000));
  }

  netFailed(p: { requestId?: string; timestamp?: number; errorText?: string; canceled?: boolean }): void {
    const e = p?.requestId ? this.netByReq.get(p.requestId) : undefined;
    if (!e) return;
    e.error = p.errorText;
    e.canceled = !!p.canceled;
    if (p.timestamp) e.ms = Math.max(0, Math.round((p.timestamp - e.ts) * 1000));
  }

  /** All captured entries, oldest first. Redirect hops are excluded. */
  networkSnapshot(): NetEntry[] {
    return [...this.netByReq.values()].filter((e) => !e.redirectHop);
  }

  clearNetwork(): void {
    this.netByReq.clear();
  }

  close(): void {
    this.markClosed();
    try {
      this.ws.close();
    } catch {}
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("CDP connection closed"));
    }
    this.pending.clear();
  }

  private onMessage(data: unknown): void {
    let msg: any;
    try {
      msg = typeof data === "string" ? JSON.parse(data) : null;
    } catch {
      return;
    }
    if (!msg) return;
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? `CDP ${p.method} failed`));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === "string") {
      const set = this.listeners.get(msg.method);
      if (set) for (const fn of set) safeCall(fn, msg.params ?? {});
    }
  }
}

function safeCall(fn: (params: any) => void, params: any): void {
  try {
    fn(params);
  } catch {}
}

function fmtRemoteObject(a: any): string {
  if (!a) return "";
  if (a.type === "string") return String(a.value ?? "");
  if (a.value !== undefined) return String(a.value);
  if (a.unserializableValue !== undefined) return String(a.unserializableValue);
  return a.description ?? a.type ?? "";
}

export function pushConsole(s: CdpSession, line: string): void {
  s.consoleBuffer.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
  if (s.consoleBuffer.length > 200) s.consoleBuffer.shift();
}

/** Runtime.evaluate with returnByValue; throws on page-side exceptions. */
export async function evaluate(
  s: CdpSession,
  expression: string,
  opts: { awaitPromise?: boolean; timeoutMs?: number } = {},
): Promise<any> {
  const st = await s.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: opts.awaitPromise ?? false },
    opts.timeoutMs ?? 90_000,
  );
  if (st.exceptionDetails) {
    const d = st.exceptionDetails;
    const text = d.exception?.description ?? d.text ?? "evaluation failed";
    throw new Error(`page error: ${String(text).split("\n")[0]}`);
  }
  return st.result?.value;
}

export class CdpManager {
  port = 9222;
  defaultTab?: string;
  private sessions = new Map<string, CdpSession>();
  /** Last attached target id per key — lets us re-attach even after the tab
   * navigated to a URL that no longer matches the pattern. */
  private lastTargetId = new Map<string, string>();

  keyFor(pattern?: string): string {
    return pattern ?? this.defaultTab ?? "*";
  }

  /**
   * Session key for `pattern`, resolving an exact CDP target id to the key
   * the live session actually holds. Chat messages and tool results carry
   * target ids; a session can sit under any key (URL pattern, "*", or its
   * own id after a default re-key), so id lookups must not assume the id is
   * the key.
   */
  private keyForIdAware(pattern?: string): string {
    let key = this.keyFor(pattern);
    if (pattern) {
      const byId = [...this.sessions.entries()].find(([k, s]) => !s.closed && s.targetId === pattern);
      if (byId) key = byId[0];
    }
    return key;
  }

  /** The live session for a pattern, if any (used by the lens signal poller). */
  sessionFor(pattern?: string): CdpSession | undefined {
    return this.sessions.get(this.keyFor(pattern));
  }

  /** Is Chrome reachable on the debug port? (Cheap: one /json fetch.) */
  async reachable(): Promise<boolean> {
    try {
      await this.listTargets();
      return true;
    } catch {
      return false;
    }
  }

  /** Is a live session attached to this target id (under any key)? */
  hasTarget(id: string): boolean {
    return [...this.sessions.values()].some((s) => !s.closed && s.targetId === id);
  }

  /** All currently attached sessions (for status reporting). */
  attached(): Array<{ key: string; url: string }> {
    return [...this.sessions.entries()]
      .filter(([, s]) => !s.closed)
      .map(([key, s]) => ({ key, url: s.url }));
  }

  async status(pattern?: string): Promise<Record<string, unknown>> {
    const key = this.keyForIdAware(pattern);
    const s = this.sessions.get(key);
    if (!s || s.closed) {
      return { attached: false, note: "not attached yet — the next command attaches" };
    }
    try {
      const { href, title } = await evaluate(
        s,
        "({ href: location.href, title: document.title })",
        { timeoutMs: 10_000 },
      );
      return { attached: true, targetId: s.targetId, url: href, title };
    } catch {
      this.sessions.delete(key);
      s.close();
      return { attached: false, note: "session dead — the next command re-attaches" };
    }
  }

  /**
   * Run fn against the session for `pattern`, attaching if needed and
   * re-attaching once if the session died mid-flight (tab closed, Chrome
   * restarted).
   */
  async run<T>(pattern: string | undefined, fn: (s: CdpSession) => Promise<T>): Promise<T> {
    pattern = pattern ?? this.defaultTab;
    const key = this.keyForIdAware(pattern);
    let session = this.sessions.get(key);
    if (session?.closed) {
      this.sessions.delete(key);
      session = undefined;
    }
    if (!session) session = await this.attach(pattern);
    try {
      return await fn(session);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      // Socket-level death, or CDP saying the target/session is gone while
      // the socket is still open (tab closed out-of-band) — both mean
      // re-attach, not surface the error.
      const dead =
        session.closed ||
        /connection closed|socket|websocket|unknown session|cannot find (target|context)|target (closed|crashed)|no target/i.test(
          msg,
        );
      if (!dead) throw e;
      this.sessions.delete(key);
      const fresh = await this.attach(pattern);
      return await fn(fresh);
    }
  }

  /** Remove the in-page overlay (DOM, window listeners, sessionStorage) from
   * a session's tab. Swallows errors — a dead page just can't be cleaned. */
  private async destroyOverlay(s: CdpSession): Promise<void> {
    await evaluate(
      s,
      "try { window.__piOverlay && window.__piOverlay.destroy(); } catch (e) {}",
      { timeoutMs: 3_000 },
    ).catch(() => {});
  }

  /** Target ids where the user explicitly asked for the in-page UI (dock or
   * lens). Plain tool-driven attaches stay headless — no 💬 button on pages
   * the agent merely drives. The channel's self-heal only (re)installs
   * overlays for these ids, and detach/shutdown clear them, so an ejected
   * dock does not reappear when a later tool call re-attaches. */
  private dockedTargets = new Set<string>();
  dock(targetId: string): void {
    this.dockedTargets.add(targetId);
  }
  undock(targetId: string): void {
    this.dockedTargets.delete(targetId);
  }
  isDocked(targetId: string): boolean {
    return this.dockedTargets.has(targetId);
  }

  /** Close all sessions (used by /tab shutdown and pi session end). Pass
   * keepOverlays to leave the in-page UI as-is — the pi session shutdown does
   * this so the shutdown flush's final reply stays visible in the dock. */
  async closeAll(keepOverlays = false): Promise<void> {
    const live = [...this.sessions.values()].filter((s) => !s.closed);
    if (!keepOverlays) await Promise.allSettled(live.map((s) => this.destroyOverlay(s)));
    for (const s of live) s.close();
    this.sessions.clear();
    this.lastTargetId.clear();
    this.dockedTargets.clear();
  }

  /** Drop all cached state for a target that was closed (session + sticky id),
   * so the next command re-resolves against the remaining tabs. */
  forgetTarget(id: string): void {
    for (const [key, s] of [...this.sessions]) {
      if (s.targetId === id) {
        this.sessions.delete(key);
        s.close();
      }
    }
    this.undock(id);
    for (const [key, tid] of [...this.lastTargetId]) {
      if (tid === id) this.lastTargetId.delete(key);
    }
  }

  /** Release the CDP session for a target WITHOUT closing the browser tab
   * (the escape hatch for "let go of this tab"): removes the in-page overlay
   * first — off is off — then closes the CDP session. The BROWSER TAB STAYS
   * OPEN. `match` is an exact target id, a session key, or a URL substring
   * that matches exactly one connected tab (multiple matches throw, listing
   * the candidates); undefined = the default target. Returns the released
   * tab, or null when nothing matches. */
  async detach(match?: string): Promise<{ key: string; targetId: string; url: string } | null> {
    const live = [...this.sessions.entries()].filter(([, s]) => !s.closed);
    let hit: [string, CdpSession] | undefined;
    if (match === undefined) {
      hit = live.find(([key]) => key === this.keyFor(undefined));
    } else {
      hit = live.find(([, s]) => s.targetId === match) ?? live.find(([key]) => key === match);
      if (!hit) {
        const urlHits = live.filter(([, s]) => s.url.includes(match));
        if (urlHits.length === 1) hit = urlHits[0];
        else if (urlHits.length > 1) {
          throw new Error(
            `"${match}" matches ${urlHits.length} connected tabs (${urlHits.map(([, s]) => s.url).join(", ")}) — use the exact target id`,
          );
        }
      }
    }
    if (!hit) return null;
    const [key, s] = hit;
    this.sessions.delete(key);
    this.undock(s.targetId); // off is off: a later tool re-attach stays headless
    await this.destroyOverlay(s); // off is off: the dock/overlay leaves the page
    s.close();
    for (const [k, tid] of [...this.lastTargetId]) {
      if (tid === s.targetId || k === key) this.lastTargetId.delete(k);
    }
    return { key, targetId: s.targetId, url: s.url };
  }

  /** Probe each page target's visibility state and return the foreground tab
   * (a focused tab beats merely visible ones). Undefined when nothing is
   * visible (e.g. Chrome is backgrounded). */
  private async probeForeground(pages: CdpTarget[]): Promise<CdpTarget | undefined> {
    let visibleTarget: CdpTarget | undefined;
    for (const candidate of pages) {
      const probeKey = `__active_probe:${candidate.id}`;
      try {
        const probe = await this.connect(candidate, probeKey);
        const state = await evaluate(
          probe,
          "({ visible: document.visibilityState === 'visible', focused: document.hasFocus() })",
          { timeoutMs: 2_000 },
        );
        this.sessions.delete(probeKey);
        this.lastTargetId.delete(probeKey);
        probe.close();
        if (state?.focused) return candidate;
        if (state?.visible && !visibleTarget) visibleTarget = candidate;
      } catch {
        const probe = this.sessions.get(probeKey);
        if (probe) probe.close();
        this.sessions.delete(probeKey);
        this.lastTargetId.delete(probeKey);
      }
    }
    return visibleTarget;
  }

  /** Chrome's foreground page tab (focused tab; a visible one if the browser
   * window itself is unfocused). */
  async foregroundTarget(): Promise<CdpTarget> {
    const t = await this.probeForeground(await this.pageTargets());
    if (!t) throw new Error("no visible page tab found in Chrome — bring a tab to the front and retry");
    return t;
  }

  /** Resolve a user-supplied tab reference: an exact CDP target id, "active"
   * (the foreground tab), or a URL substring (several matches → shortest
   * URL, like attach()). */
  async resolveTarget(ref: string): Promise<CdpTarget> {
    const pages = await this.pageTargets();
    const byId = pages.find((t) => t.id === ref);
    if (byId) return byId;
    if (ref === "active") return this.foregroundTarget();
    const matches = pages.filter((t) => t.url.includes(ref));
    if (!matches.length) {
      throw new Error(
        `no tab matching "${ref}" found in Chrome on port ${this.port} — open it in the browser first`,
      );
    }
    return [...matches].sort((a, b) => a.url.length - b.url.length)[0];
  }

  /** Point the DEFAULT target (the key the tab_* tools use without a `tab`
   * param) at `t`. Other connected tabs stay connected (multi-dock): the
   * previous default session is re-keyed to its own target id so its dock
   * keeps updating. Returns the new default session plus what was re-keyed. */
  async pointDefault(
    t: CdpTarget,
  ): Promise<{ session: CdpSession; rekeyed?: { from: string; to: string } }> {
    const key = this.keyFor(undefined);
    const cur = this.sessions.get(key);
    if (cur && !cur.closed) {
      if (cur.targetId === t.id) return { session: cur };
      if (this.sessions.has(cur.targetId)) {
        this.sessions.delete(key); // default slot is a duplicate of a live tab — drop the dup
      } else {
        const newKey = cur.targetId;
        this.sessions.delete(key);
        this.sessions.set(newKey, cur);
        this.lastTargetId.set(newKey, cur.targetId);
        return { session: await this.connect(t, key), rekeyed: { from: key, to: newKey } };
      }
    } else if (cur) {
      this.sessions.delete(key);
      cur.close();
    }
    return { session: await this.connect(t, key) };
  }

  /** Open a NEW page tab. The URL is the RAW query string (/json/new?<url>).
   * Chrome >= 111 requires PUT; older builds only accept GET, so fall back. */
  async openTarget(url = "about:blank"): Promise<CdpTarget> {
    const path = `/json/new?${url}`;
    let res = await this.http(path, { method: "PUT" });
    if (res.status === 405) res = await this.http(path, { method: "GET" });
    if (!res.ok) throw new Error(`CDP /json/new failed: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
    const t = (await res.json()) as CdpTarget;
    if (!t?.id) throw new Error("CDP /json/new returned no target");
    // Chrome reports the new tab's url as "" until the navigation commits.
    // Wait for it so callers (and any attach-time URL gate) see the real
    // URL — attaching to a ""-url tab races cold/slow loads.
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000) {
      const fresh = (await this.listTargets()).find((x) => x.id === t.id);
      if (!fresh) break; // target already gone
      if (fresh.url) return fresh;
      await new Promise((r) => setTimeout(r, 200));
    }
    return t;
  }

  /** Close a tab by exact target id. */
  async closeTarget(id: string): Promise<void> {
    const res = await this.http(`/json/close/${id}`);
    // Chrome answers 200 with the plain-text body "Target is closing".
    if (!res.ok) throw new Error(`CDP /json/close failed: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
    await res.text();
  }

  /** All open page tabs (devtools pages excluded). */
  async pageTargets(): Promise<CdpTarget[]> {
    const targets = await this.listTargets();
    return targets.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  }

  private async http(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${this.port}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
    } catch (e: any) {
      throw new Error(
        `Chrome is not listening on 127.0.0.1:${this.port} — start it with --remote-debugging-port=${this.port} (${e?.message ?? e})`,
      );
    }
    return res;
  }

  private async listTargets(): Promise<CdpTarget[]> {
    const res = await this.http("/json");
    if (!res.ok) throw new Error(`CDP /json failed: HTTP ${res.status}`);
    return (await res.json()) as CdpTarget[];
  }

  private async attach(pattern?: string): Promise<CdpSession> {
    const pages = await this.pageTargets();
    // Exact CDP target id — the most precise reference (chat messages and
    // tool results carry it); connect under the id as key, mirroring
    // attachTarget/pointDefault re-keying.
    if (pattern) {
      const byId = pages.find((t) => t.id === pattern);
      if (byId) return this.connect(byId, this.keyFor(pattern));
    }
    // Prefer the previously attached target (it may have navigated away from
    // the pattern URL); fall back to the URL pattern.
    const remembered = this.lastTargetId.get(this.keyFor(pattern));
    // Drop the remembered id if /json no longer lists it (tab closed
    // out-of-band) — otherwise every attach would re-try the dead target.
    let matches = remembered ? pages.filter((t) => t.id === remembered) : [];
    if (remembered && !matches.length) this.lastTargetId.delete(this.keyFor(pattern));
    if (!matches.length) matches = pattern ? pages.filter((t) => t.url.includes(pattern)) : pages;
    if (!matches.length) {
      throw new Error(
        pattern
          ? `no tab matching "${pattern}" found in Chrome on port ${this.port} — open it in the browser first`
          : `no page tabs found in Chrome on port ${this.port}`,
      );
    }
    // With no URL pattern, prefer Chrome's foreground tab. /json does not
    // report which tab is active, so briefly probe each page's visibility
    // state. If Chrome is backgrounded or probing fails, retain the historic
    // shortest-URL fallback.
    if (!pattern && matches.length > 1) {
      const visibleTarget = await this.probeForeground(matches);
      if (visibleTarget) return this.connect(visibleTarget, this.keyFor(pattern));
    }
    // Prefer the shortest matching URL as a stable fallback: the app's base
    // tab, not derived file/preview tabs that share the same host pattern.
    const t = [...matches].sort((a, b) => a.url.length - b.url.length)[0];
    return this.connect(t, this.keyFor(pattern));
  }

  /** Attach a session directly to a known target (e.g. one just created by
   * openTarget), keyed by target id so it shows up in tab_list. */
  async attachTarget(t: CdpTarget): Promise<CdpSession> {
    return this.connect(t, t.id);
  }

  private async connect(t: CdpTarget, key: string): Promise<CdpSession> {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("CDP websocket open timed out"));
      }, 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        ws.close();
        reject(new Error("CDP websocket connect failed"));
      };
    });
    const s = new CdpSession(ws, t);
    // Console capture via CDP events — survives full page reloads, unlike
    // an in-page hook.
    s.on("Runtime.consoleAPICalled", (p) => {
      if (p.type !== "error" && p.type !== "warn") return;
      pushConsole(s, `[${p.type}] ${(p.args ?? []).map(fmtRemoteObject).join(" ")}`);
    });
    s.on("Runtime.exceptionThrown", (p) => {
      const d = p.exceptionDetails ?? {};
      pushConsole(s, `[exception] ${d.text ?? "uncaught"} ${d.exception?.description ?? ""}`.trim());
    });
    // Network capture for tab_network: metadata only (no bodies), so the
    // overhead is small and the buffer survives reloads with the session.
    s.on("Network.requestWillBeSent", (p) => s.netStart(p));
    s.on("Network.responseReceived", (p) => s.netResponse(p));
    s.on("Network.loadingFinished", (p) => s.netFinished(p));
    s.on("Network.loadingFailed", (p) => s.netFailed(p));
    await s.send("Runtime.enable");
    await s.send("Page.enable");
    await s.send("Network.enable");
    // DOM domain for the AX resolver: DOM.resolveNode maps an AX node's
    // backendDOMNodeId to a RemoteObject, whose getBoundingClientRect gives
    // the click point. (requestNode/getBoxModel were the original plan but
    // this Chrome's requestNode demands objectId — see ax.ts.) One
    // documentUpdated event per navigation — no listeners, no state kept.
    await s.send("DOM.enable");
    // Accessibility tree for tab_ax snapshots and role+name targeting. Enabling
    // the domain is what builds the tree in this tab (same as a screen reader
    // being attached) — the overhead is small and constant.
    await s.send("Accessibility.enable");
    this.sessions.set(key, s);
    this.lastTargetId.set(key, t.id);
    return s;
  }
}

/** Save a PNG screenshot of the tab to `out`. Retries once: Chrome
 * occasionally answers "Debugger command timed out" when the renderer is busy. */
export async function screenshot(s: CdpSession, out: string): Promise<string> {
  let data: string;
  try {
    ({ data } = await s.send("Page.captureScreenshot", { format: "png" }, 30_000));
  } catch (e: any) {
    if (!/timed out/i.test(String(e?.message ?? e))) throw e;
    await new Promise((r) => setTimeout(r, 1000));
    ({ data } = await s.send("Page.captureScreenshot", { format: "png" }, 30_000));
  }
  writeFileSync(out, Buffer.from(String(data), "base64"));
  return out;
}
