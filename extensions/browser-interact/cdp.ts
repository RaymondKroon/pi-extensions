// browser-interact — minimal Chrome DevTools Protocol client for a single tab.
//
// Talks raw CDP over the native WebSocket (Node >= 22) to a Chrome that is
// already running with --remote-debugging-port=<port> (default 9222).
//
// Unlike a per-process WebView bridge (short per-command timeouts, in-page
// console hook), raw CDP:
//   - has no per-command timeout, so `wait` is ONE Runtime.evaluate with
//     awaitPromise (an in-page async poll loop) instead of a watcher + poll;
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
  private ws: WebSocket;
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

  /** All currently attached sessions (for status reporting). */
  attached(): Array<{ key: string; url: string }> {
    return [...this.sessions.entries()]
      .filter(([, s]) => !s.closed)
      .map(([key, s]) => ({ key, url: s.url }));
  }

  async status(pattern?: string): Promise<Record<string, unknown>> {
    const key = this.keyFor(pattern);
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
      return { attached: true, url: href, title };
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
    const key = this.keyFor(pattern);
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
      const dead = session.closed || /connection closed|socket|websocket/i.test(msg);
      if (!dead) throw e;
      this.sessions.delete(key);
      const fresh = await this.attach(pattern);
      return await fn(fresh);
    }
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
    this.lastTargetId.clear();
  }

  private async listTargets(): Promise<CdpTarget[]> {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${this.port}/json`, { signal: AbortSignal.timeout(5000) });
    } catch (e: any) {
      throw new Error(
        `Chrome is not listening on 127.0.0.1:${this.port} — start it with --remote-debugging-port=${this.port} (${e?.message ?? e})`,
      );
    }
    if (!res.ok) throw new Error(`CDP /json failed: HTTP ${res.status}`);
    return (await res.json()) as CdpTarget[];
  }

  private async attach(pattern?: string): Promise<CdpSession> {
    const targets = await this.listTargets();
    const pages = targets.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
    // Prefer the previously attached target (it may have navigated away from
    // the pattern URL); fall back to the URL pattern.
    const remembered = this.lastTargetId.get(this.keyFor(pattern));
    let matches = remembered ? pages.filter((t) => t.id === remembered) : [];
    if (!matches.length) matches = pattern ? pages.filter((t) => t.url.includes(pattern)) : pages;
    if (!matches.length) {
      throw new Error(
        pattern
          ? `no tab matching "${pattern}" found in Chrome on port ${this.port} — open it in the browser first`
          : `no page tabs found in Chrome on port ${this.port}`,
      );
    }
    // Prefer the shortest matching URL: the app's base tab, not derived
    // file/preview tabs that share the same host pattern.
    const t = [...matches].sort((a, b) => a.url.length - b.url.length)[0];
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
    await s.send("Runtime.enable");
    await s.send("Page.enable");
    this.sessions.set(this.keyFor(pattern), s);
    this.lastTargetId.set(this.keyFor(pattern), t.id);
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
