// browser-interact — CdpManager tab-switching/detach logic (task 8), tested
// against a fake CDP endpoint: a stubbed /json fetch and a FakeWebSocket that
// auto-answers every command (and Runtime.evaluate with a per-test value).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CdpManager, type CdpTarget } from "./cdp";

/** What each Runtime.evaluate returns in the fake browser. */
let evalHandler = (_ws: FakeWS, _expr: string): unknown => ({});

class FakeWS {
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Array<Record<string, any>> = [];
  closed = false;
  constructor(readonly url: string) {
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    if (typeof msg.id === "number") {
      const value = msg.method === "Runtime.evaluate" ? evalHandler(this, String(msg.params?.expression)) : {};
      queueMicrotask(() => {
        if (!this.closed) this.onmessage?.({ data: JSON.stringify({ id: msg.id, result: { result: { value } } }) });
      });
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

const T = (id: string, url: string): CdpTarget => ({
  id,
  type: "page",
  url,
  title: `tab ${id}`,
  webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
});

const A = T("A", "https://a.test/app");
const B = T("B", "https://b.test/");
const C = T("C", "https://b.test/longer-path");

let restoreFetch: (() => void) | null = null;
let restoreWS: (() => void) | null = null;

beforeEach(() => {
  const realWS = globalThis.WebSocket;
  restoreWS = () => {
    globalThis.WebSocket = realWS;
  };
  // Route CDP websockets to the fake (never to a real Chrome on :9222).
  (globalThis as any).WebSocket = FakeWS;
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  restoreWS?.();
  restoreWS = null;
  evalHandler = () => ({});
});
/** Stub the debug-port HTTP endpoint (only /json is served; anything else
 * throws so an accidental /json/new or /json/close fails loudly). */
function stubTargets(targets: CdpTarget[]): void {
  const real = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = real;
  };
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.endsWith("/json")) {
      return { ok: true, status: 200, json: async () => targets, text: async () => "" };
    }
    throw new Error(`unexpected HTTP call: ${u} (browser tab must stay open!)`);
  }) as typeof fetch;
}

function mgr(): CdpManager {
  const m = new CdpManager();
  m.port = 9222; // stubbed fetch ignores the host anyway
  return m;
}

describe("CdpManager.resolveTarget", () => {
  test("exact target id wins", async () => {
    stubTargets([A, B]);
    const t = await mgr().resolveTarget("B");
    expect(t.id).toBe("B");
  });

  test("URL substring: several matches → shortest URL", async () => {
    stubTargets([A, B, C]);
    const t = await mgr().resolveTarget("b.test");
    expect(t.id).toBe("B");
  });

  test("no match → clear error", async () => {
    stubTargets([A]);
    await expect(mgr().resolveTarget("zzz.test")).rejects.toThrow(/no tab matching "zzz.test"/);
  });

  test("\"active\" probes for the focused tab", async () => {
    stubTargets([A, B]);
    evalHandler = (ws) => ({ visible: true, focused: ws.url.includes("/B") });
    const t = await mgr().foregroundTarget();
    expect(t.id).toBe("B");
  });

  test("foreground probe cleans up its probe sessions", async () => {
    stubTargets([A, B]);
    evalHandler = (ws) => ({ visible: true, focused: ws.url.includes("/B") });
    const m = mgr();
    await m.foregroundTarget();
    // probe sessions are transient — nothing should be left attached
    expect(m.attached()).toEqual([]);
  });
});

describe("CdpManager.pointDefault", () => {
  test("connects the default (\"*\") key when nothing is attached", async () => {
    stubTargets([A, B]);
    const m = mgr();
    const { session, rekeyed } = await m.pointDefault(B);
    expect(rekeyed).toBeUndefined();
    expect(session.targetId).toBe("B");
    expect(m.sessionFor()?.targetId).toBe("B");
  });

  test("switching re-keys the previous default session to its own target id (multi-dock)", async () => {
    stubTargets([A, B]);
    const m = mgr();
    const first = await m.pointDefault(A);
    const { session, rekeyed } = await m.pointDefault(B);
    expect(rekeyed).toEqual({ from: "*", to: "A" });
    expect(session.targetId).toBe("B");
    // the old default tab is still connected (under its target id) and live
    const attached = m.attached().map((a) => `${a.key}:${a.url}`);
    expect(attached.sort()).toEqual(["*:https://b.test/", "A:https://a.test/app"]);
    expect(m.hasTarget("A")).toBe(true);
    expect(first.session.targetId).toBe("A"); // same session object, re-keyed
    expect(first.session.closed).toBe(false);
  });

  test("pointing the default at the already-default target is a no-op", async () => {
    stubTargets([A, B]);
    const m = mgr();
    const first = await m.pointDefault(A);
    const second = await m.pointDefault(A);
    expect(second.rekeyed).toBeUndefined();
    expect(second.session).toBe(first.session);
  });

  test("re-attaches when the remembered default target was closed", async () => {
    stubTargets([A, B]);
    const m = mgr();
    await m.pointDefault(A);
    m.forgetTarget("A"); // tab closed out-of-band
    const { session, rekeyed } = await m.pointDefault(B);
    expect(rekeyed).toBeUndefined();
    expect(session.targetId).toBe("B");
  });
});

describe("CdpManager.detach", () => {
  test("detaching the default releases the session WITHOUT closing the browser tab", async () => {
    stubTargets([A, B]);
    const m = mgr();
    await m.pointDefault(A);
    const r = await m.detach();
    expect(r).toEqual({ key: "*", targetId: "A", url: "https://a.test/app" });
    expect(m.attached()).toEqual([]);
    expect(m.hasTarget("A")).toBe(false);
    // the tab is still listed by /json (the stub serves the same list) — the
    // stub itself throws on any /json/close, so reaching this line proves the
    // browser tab was never closed
    const pages = await m.pageTargets();
    expect(pages.map((p) => p.id)).toEqual(["A", "B"]);
  });

  test("detaching removes the in-page overlay first (off is off)", async () => {
    stubTargets([A]);
    const m = mgr();
    await m.pointDefault(A);
    const destroyed: string[] = [];
    evalHandler = (_ws, expr) => {
      if (expr.includes("__piOverlay.destroy")) destroyed.push("1");
      return {};
    };
    await m.detach("A");
    expect(destroyed).toEqual(["1"]);
    expect(m.hasTarget("A")).toBe(false);
  });

  test("detaching tolerates a dead page (destroy evaluate failing)", async () => {
    stubTargets([A]);
    const m = mgr();
    await m.pointDefault(A);
    evalHandler = (_ws, expr) => {
      if (expr.includes("__piOverlay.destroy")) throw new Error("page gone");
      return {};
    };
    // must not throw — the session is still released
    const r = await m.detach("A");
    expect(r?.targetId).toBe("A");
    expect(m.hasTarget("A")).toBe(false);
  });

  test("detaches by exact target id", async () => {
    stubTargets([A, B]);
    const m = mgr();
    await m.pointDefault(A);
    await m.pointDefault(B); // A is now re-keyed to "A"
    const r = await m.detach("A");
    expect(r?.url).toBe("https://a.test/app");
    expect(m.hasTarget("A")).toBe(false);
    expect(m.hasTarget("B")).toBe(true);
  });

  test("detaches by a URL substring matching exactly one tab", async () => {
    stubTargets([A, B]);
    const m = mgr();
    await m.pointDefault(A);
    await m.pointDefault(B);
    expect((await m.detach("b.test"))?.targetId).toBe("B");
    expect(m.hasTarget("A")).toBe(true);
  });

  test("ambiguous URL substring throws and lists candidates", async () => {
    stubTargets([A, B, C]);
    const m = mgr();
    await m.pointDefault(B);
    await m.pointDefault(C); // both b.test tabs connected
    // ambiguous matches reject (detach is async now), before any session is released
    await expect(m.detach("b.test")).rejects.toThrow(/matches 2 connected tabs/);
    // nothing was released
    expect(m.attached()).toHaveLength(2);
  });

  test("no match → null (no throw)", async () => {
    stubTargets([A, B]);
    const m = mgr();
    await m.pointDefault(A);
    expect(await m.detach("zzz.test")).toBeNull();
    expect(m.attached()).toHaveLength(1);
  });
});

describe("CdpManager target-id tab addressing (run/status/attach)", () => {
  test("run() with an exact target id reuses the session under whatever key it holds", async () => {
    stubTargets([A, B]);
    const m = mgr();
    await m.pointDefault(A); // A sits under the "*" key
    const seen = await m.run("A", async (s) => s.targetId);
    expect(seen).toBe("A");
    // the default slot is still the A session — no duplicate was created
    expect(m.sessionFor()?.targetId).toBe("A");
    expect(m.attached()).toHaveLength(1);
  });

  test("run() with an exact target id attaches by id even when the URL is ambiguous", async () => {
    stubTargets([B, C]); // both match "b.test"
    const m = mgr();
    await m.pointDefault(B); // B under "*"; C not attached
    const seen = await m.run("C", async (s) => s.targetId);
    expect(seen).toBe("C");
    expect(m.attached()).toHaveLength(2);
    // and the second call reuses the id-keyed session
    expect(await m.run("C", async (s) => s.targetId)).toBe("C");
    expect(m.attached()).toHaveLength(2);
  });

  test("run() with an unknown target id → clear error", async () => {
    stubTargets([A]);
    const m = mgr();
    await expect(m.run("Z", async () => "x")).rejects.toThrow(/no tab matching "Z"/);
  });

  test("status() resolves an exact target id to the session under another key", async () => {
    stubTargets([A, B]);
    const m = mgr();
    await m.pointDefault(A); // under "*"
    evalHandler = () => ({ href: "https://a.test/app", title: "tab A" });
    const st: any = await m.status("A");
    expect(st.attached).toBe(true);
    expect(st.url).toBe("https://a.test/app");
    expect(st.targetId).toBe("A");
  });
});

describe("CdpManager docked targets (opt-in dock/lens UI)", () => {
  test("dock() marks a target; detach(), closeAll() and forgetTarget() unmark it", async () => {
    stubTargets([A, B]);
    const m = mgr();
    await m.pointDefault(A);
    expect(m.isDocked("A")).toBe(false);
    m.dock("A");
    expect(m.isDocked("A")).toBe(true);

    // a tool re-attach after eject must stay headless: detach undocks
    expect(await m.detach("A")).not.toBeNull();
    expect(m.isDocked("A")).toBe(false);

    m.dock("B");
    await m.pointDefault(B);
    expect(m.isDocked("B")).toBe(true);
    await m.closeAll();
    expect(m.isDocked("B")).toBe(false);

    m.dock("B");
    expect(m.isDocked("B")).toBe(true);
    m.forgetTarget("B");
    expect(m.isDocked("B")).toBe(false);
  });
});
