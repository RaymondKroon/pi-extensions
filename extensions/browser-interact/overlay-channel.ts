// browser-interact — the chat dock's update channel between this pi session
// and every docked tab.
//
// pi → page: session events (agent text, tool lines, busy state) are queued
// per attached tab and drained by a 1-second poller that calls the overlay's
// tick(). Page → pi: the same tick pops the overlay's signal queue (console
// events cannot be used — they are dropped by the Browser Bridge proxy).
//
// Self-healing: a CDP socket drop makes the next tab tool re-attach with a
// FRESH session whose overlay registration is gone (overlayScriptId
// undefined). Without healing, the dock silently goes stale — broadcasts are
// skipped and the poller stops ticking. So both paths treat "attached but no
// overlay registration" as a heal: (re)install the overlay and keep ticking.

import { evaluate, type CdpSession } from "./cdp";

/** Identity of the tab a page signal was popped from. Attribution is exact:
 * each tab has its own CDP session, and the poller pops each session's
 * signal queue individually. */
export interface SignalOrigin {
  key: string;
  targetId: string;
  url: string;
}

export interface OverlayChannelDeps {
  /** All attached sessions (key + url), as reported by the CdpManager. */
  attached: () => Array<{ key: string; url: string }>;
  /** The live session for a key (or undefined = the default tab). */
  sessionFor: (pattern?: string) => CdpSession | undefined;
  /** (Re)install the overlay on a session: new-document script + runtime inject. */
  ensureOverlay: (s: CdpSession) => Promise<void>;
  /** Page → pi signals popped from an overlay's queue, with the tab they came from. */
  onSignal: (sig: Record<string, unknown>, origin: SignalOrigin) => void;
}

export interface OverlayChannel {
  /** Queue updates for every attached tab; heals missing overlay registration. */
  broadcastUpdates: (updates: unknown[]) => void;
  /** One poller tick: heal, drain each queue into an overlay tick, pop signals. */
  pollOverlays: () => Promise<void>;
  startPoll: () => void;
  stopPoll: () => void;
  /** Drain all queues without the poller (session shutdown). */
  flush: () => Promise<void>;
  clearQueue: () => void;
  /** Move a pending queue from one key to another (its session was re-keyed). */
  rekey: (from: string, to: string) => void;
  /** Pending (not yet delivered) updates for one key — read-only. */
  pendingFor: (key: string) => unknown[];
}

export const createOverlayChannel = (deps: OverlayChannelDeps): OverlayChannel => {
  /** Per-tab update queue, drained by the poller (keyed like mgr.attached()). */
  const chatQueue = new Map<string, unknown[]>();
  let overlayPoll: ReturnType<typeof setInterval> | null = null;
  let overlayPollBusy = false;

  const sessionForKey = (key: string): CdpSession | undefined =>
    deps.sessionFor(key === "*" ? undefined : key);

  const tick = async (s: CdpSession, key: string): Promise<void> => {
    const updates = chatQueue.get(key) ?? [];
    if (updates.length) chatQueue.delete(key);
    const sigs = await evaluate(
      s,
      `window.__piOverlay ? window.__piOverlay.tick(${JSON.stringify(updates)}) : null`,
      { timeoutMs: 3_000 },
    ).catch(() => null);
    if (Array.isArray(sigs))
      for (const sig of sigs) if (sig && typeof sig === "object")
        deps.onSignal(sig, { key, targetId: s.targetId, url: s.url });
  };

  const broadcastUpdates = (updates: unknown[]): void => {
    for (const a of deps.attached()) {
      const s = sessionForKey(a.key);
      if (!s) continue;
      if (!s.overlayScriptId) void deps.ensureOverlay(s).catch(() => {});
      const q = chatQueue.get(a.key) ?? [];
      for (const u of updates) {
        q.push(u);
        if (q.length > 200) q.splice(0, q.length - 200);
      }
      chatQueue.set(a.key, q);
    }
  };

  const pollOverlays = async (): Promise<void> => {
    if (overlayPollBusy) return;
    overlayPollBusy = true;
    try {
      let anySession = false;
      for (const a of deps.attached()) {
        const s = sessionForKey(a.key);
        if (!s) continue;
        anySession = true;
        if (!s.overlayScriptId) {
          // Re-attach (socket drop) or a missed install: heal, flush next tick.
          await deps.ensureOverlay(s).catch(() => {});
          continue;
        }
        await tick(s, a.key);
      }
      // Keep ticking while any session is attached — a healing session has no
      // overlay yet but the next tick must still run; stop only when empty.
      if (!anySession && overlayPoll) {
        clearInterval(overlayPoll);
        overlayPoll = null;
      }
    } finally {
      overlayPollBusy = false;
    }
  };

  return {
    broadcastUpdates,
    pollOverlays,
    startPoll: () => {
      if (overlayPoll) return;
      overlayPoll = setInterval(pollOverlays, 1_000);
    },
    stopPoll: () => {
      if (overlayPoll) clearInterval(overlayPoll);
      overlayPoll = null;
    },
    flush: async () => {
      for (const a of deps.attached()) {
        const s = sessionForKey(a.key);
        if (!s || !s.overlayScriptId) continue;
        if (!(chatQueue.get(a.key) ?? []).length) continue; // nothing pending
        await tick(s, a.key);
      }
    },
    clearQueue: () => chatQueue.clear(),
    rekey: (from, to) => {
      if (from === to) return;
      const q = chatQueue.get(from);
      if (!q) return;
      chatQueue.delete(from);
      chatQueue.set(to, [...(chatQueue.get(to) ?? []), ...q]);
    },
    pendingFor: (key: string) => chatQueue.get(key) ?? [],
  };
};
