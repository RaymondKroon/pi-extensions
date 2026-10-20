import { describe, expect, spyOn, test } from "bun:test";
import { createOverlayChannel } from "./overlay-channel";

/** Minimal CdpSession stand-in: evaluate() only needs s.send("Runtime.evaluate"). */
function fakeSession(tickReturn: unknown = null): any {
  const calls: string[] = [];
  const s: any = {
    closed: false,
    url: "https://example.test/",
    overlayScriptId: undefined as string | undefined,
    overlayScriptSource: undefined as string | undefined,
    send: async (method: string, params: any) => {
      if (method !== "Runtime.evaluate") return {};
      calls.push(params.expression);
      // CDP shape: evaluate() returns st.result?.value
      return { result: { value: tickReturn } };
    },
    /** Expressions passed to evaluate(), newest last. */
    evalCalls: calls,
  };
  return s;
}

interface Harness {
  channel: ReturnType<typeof createOverlayChannel>;
  attachedList: Array<{ key: string; url: string }>;
  ensureCalls: number[];
}

function makeHarness(sessions: Record<string, any>, tickReturn: unknown = null): Harness {
  const attachedList: Array<{ key: string; url: string }> = Object.keys(sessions).map((key) => ({
    key,
    url: sessions[key].url,
  }));
  const ensureCalls: number[] = [];
  const channel = createOverlayChannel({
    attached: () => attachedList,
    sessionFor: (p?: string) => sessions[p ?? "*"],
    ensureOverlay: async (s: any) => {
      ensureCalls.push(Date.now());
      s.overlayScriptId = s.overlayScriptId ?? "script-1";
    },
    onSignal: () => {},
  });
  return { channel, attachedList, ensureCalls };
}

describe("createOverlayChannel", () => {
  test("queues updates for an attached tab and delivers them on the next tick", async () => {
    const s = fakeSession();
    s.overlayScriptId = "script-1";
    const { channel } = makeHarness({ "*": s });
    channel.broadcastUpdates([{ kind: "status", busy: true }]);
    expect(channel.pendingFor("*")).toEqual([{ kind: "status", busy: true }]);
    await channel.pollOverlays();
    const expr = s.evalCalls.at(-1) as string;
    expect(expr).toContain("window.__piOverlay.tick(");
    expect(expr).toContain('"busy":true');
    expect(channel.pendingFor("*")).toEqual([]);
  });

  test("self-heals a session without overlay registration: update is kept, overlay reinstalled", () => {
    const s = fakeSession();
    const { channel, ensureCalls } = makeHarness({ "*": s });
    channel.broadcastUpdates([{ kind: "tool", name: "bash", ok: true, args: "{}", result: "out" }]);
    // The update must NOT be dropped while the overlay is being healed.
    expect(channel.pendingFor("*")).toHaveLength(1);
    // ensureOverlay is fire-and-forget but the fake body is synchronous.
    expect(ensureCalls.length).toBe(1);
    expect(s.overlayScriptId).toBe("script-1");
  });

  test("poller heals a registration-less session, then drains the queue next tick", async () => {
    // ensureOverlay delayed by a microtask, so the broadcast's fire-and-forget
    // heal has not run yet when the poller does its (synchronous) check — this
    // isolates the poller's own heal path.
    const s = fakeSession();
    const attachedList: Array<{ key: string; url: string }> = [{ key: "*", url: s.url }];
    const channel = createOverlayChannel({
      attached: () => attachedList,
      sessionFor: () => s,
      ensureOverlay: async (x: any) => {
        await Promise.resolve();
        x.overlayScriptId = "script-1";
      },
      onSignal: () => {},
    });
    channel.broadcastUpdates([{ kind: "msg", role: "agent", text: "hi" }]);
    expect(s.overlayScriptId).toBeUndefined();
    await channel.pollOverlays(); // heals; no tick yet
    expect(s.overlayScriptId).toBe("script-1");
    expect(s.evalCalls).toHaveLength(0);
    await channel.pollOverlays(); // now ticks with the queued update
    const expr = s.evalCalls.at(-1) as string;
    expect(expr).toContain('"text":"hi"');
    expect(channel.pendingFor("*")).toEqual([]);
  });

  test("routes page signals returned by an overlay tick to onSignal", async () => {
    const s = fakeSession([{ type: "chat", text: "hello" }]);
    s.overlayScriptId = "script-1";
    const signals: any[] = [];
    const attachedList: Array<{ key: string; url: string }> = [{ key: "*", url: s.url }];
    const channel = createOverlayChannel({
      attached: () => attachedList,
      sessionFor: () => s,
      ensureOverlay: async () => {},
      onSignal: (sig) => signals.push(sig),
    });
    await channel.pollOverlays();
    expect(signals).toEqual([{ type: "chat", text: "hello" }]);
  });

  test("stamps page signals with the sending tab's identity (key, targetId, url)", async () => {
    const s = fakeSession([{ type: "dock-detach" }, { type: "chat", text: "hi" }]);
    s.overlayScriptId = "script-1";
    s.targetId = "target-9";
    const origins: Array<{ key: string; targetId: string; url: string }> = [];
    const channel = createOverlayChannel({
      attached: () => [{ key: "*", url: s.url }],
      sessionFor: () => s,
      ensureOverlay: async () => {},
      onSignal: (_sig, origin) => origins.push(origin),
    });
    await channel.pollOverlays();
    expect(origins).toEqual([
      { key: "*", targetId: "target-9", url: "https://example.test/" },
      { key: "*", targetId: "target-9", url: "https://example.test/" },
    ]);
  });

  test("rekey moves the pending queue from the old key to the new one", () => {
    const s = fakeSession();
    s.overlayScriptId = "script-1";
    const { channel } = makeHarness({ "*": s });
    channel.broadcastUpdates([{ kind: "msg", role: "agent", text: "hi" }]);
    expect(channel.pendingFor("*")).toHaveLength(1);
    channel.rekey("*", "target-9");
    expect(channel.pendingFor("*")).toEqual([]);
    expect(channel.pendingFor("target-9")).toEqual([{ kind: "msg", role: "agent", text: "hi" }]);
    // re-keying to an empty key is a no-op
    channel.rekey("*", "nowhere");
    expect(channel.pendingFor("target-9")).toHaveLength(1);
  });

  test("keeps the poller running while a session is healing, stops when none attached", async () => {
    const s = fakeSession();
    const { channel, attachedList } = makeHarness({ "*": s });
    const clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    try {
      channel.startPoll();
      await channel.pollOverlays(); // heals — session still attached
      expect(clearIntervalSpy).not.toHaveBeenCalled();
      attachedList.length = 0; // tab closed / manager empty
      await channel.pollOverlays();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearIntervalSpy.mockRestore();
      channel.stopPoll();
    }
  });

  test("startPoll is idempotent and flush drains without ticking empty queues", async () => {
    const s = fakeSession();
    s.overlayScriptId = "script-1";
    const { channel } = makeHarness({ "*": s });
    const setIntervalSpy = spyOn(globalThis, "setInterval").mockReturnValue(123 as any);
    try {
      channel.startPoll();
      channel.startPoll();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
      channel.stopPoll();
    }
    await channel.flush(); // empty queue — no evaluate
    expect(s.evalCalls).toHaveLength(0);
    channel.broadcastUpdates([{ kind: "status", busy: false }]);
    await channel.flush();
    expect(s.evalCalls.at(-1)).toContain('"busy":false');
    channel.clearQueue();
    expect(channel.pendingFor("*")).toEqual([]);
  });

  test("caps the pending queue at 200 updates", () => {
    const s = fakeSession();
    s.overlayScriptId = "script-1";
    const { channel } = makeHarness({ "*": s });
    const updates = Array.from({ length: 210 }, (_, i) => ({ kind: "msg", role: "agent", text: String(i) }));
    channel.broadcastUpdates(updates);
    const pending = channel.pendingFor("*") as Array<{ text: string }>;
    expect(pending).toHaveLength(200);
    expect(pending[0].text).toBe("10"); // oldest dropped
    expect(pending.at(-1)?.text).toBe("209");
  });

  test("ignores keys whose session is gone (re-attach churn)", () => {
    const s = fakeSession();
    s.overlayScriptId = "script-1";
    const { channel, attachedList } = makeHarness({ "*": s });
    attachedList.push({ key: "gone", url: "https://gone.test/" }); // no session object
    channel.broadcastUpdates([{ kind: "status", busy: true }]); // must not throw
    expect(channel.pendingFor("*")).toHaveLength(1);
    expect(channel.pendingFor("gone")).toEqual([]);
  });
});
