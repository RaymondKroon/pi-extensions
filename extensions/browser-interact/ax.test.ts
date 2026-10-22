// browser-interact — ax.ts: pure targeting/formatting functions + the CDP
// glue, tested against a fake session (no browser needed).
import { describe, expect, test } from "bun:test";
import { CdpManager, type CdpSession, type CdpTarget } from "./cdp";
import {
  AxTargetError,
  ancestorRoles,
  axCover,
  axPoint,
  axStates,
  axTree,
  formatAXTree,
  matchTargets,
  notFoundHint,
  parseTarget,
  shownNodes,
  type RawAXNode,
} from "./ax";

// ------------------------------------------------------------------- helpers

function N(
  nodeId: string,
  role: string,
  name: string,
  extra: Partial<RawAXNode> & { props?: Record<string, string> } = {},
): RawAXNode {
  const { props = {}, ...rest } = extra;
  return {
    nodeId,
    backendDOMNodeId: rest.backendDOMNodeId ?? Number(nodeId) * 100,
    childIds: rest.childIds ?? [],
    role: { type: "internalRole", value: role },
    ...(name ? { name: { type: "computedString", value: name } } : {}),
    properties: Object.entries(props).map(([n, v]) => ({ name: n, value: { type: "booleanOrUndefined", value: v } })),
    ...rest,
  };
}

/** Tree:
 * 1 document "Page"
 *   2 generic (ignored)
 *     3 heading "Title"
 *     4 generic "" (no name, generic → collapsed)
 *       5 button "Go"
 *     6 generic "" (leaf noise)
 *   7 link "" (unnamed but real role → shown)
 *   8 button "Disabled" [disabled]
 *   9 generic (ignored)
 *     10 checkbox "A" [checked]
 */
const TREE: RawAXNode[] = [
  N("1", "document", "Page", { rootId: "1", childIds: ["2", "7", "8", "9"] }),
  N("2", "generic", "", { parentId: "1", rootId: "1", ignored: true, childIds: ["3", "4", "6"] }),
  N("3", "heading", "Title", { parentId: "2", rootId: "1", props: { level: "1" } }),
  N("4", "generic", "", { parentId: "2", rootId: "1", childIds: ["5"] }),
  N("5", "button", "Go", { parentId: "4", rootId: "1" }),
  N("6", "generic", "", { parentId: "2", rootId: "1" }),
  N("7", "link", "", { parentId: "1", rootId: "1" }),
  N("8", "button", "Disabled", { parentId: "1", rootId: "1", props: { disabled: "true" } }),
  N("9", "generic", "", { parentId: "1", rootId: "1", ignored: true, childIds: ["10"] }),
  N("10", "checkbox", "A", { parentId: "9", rootId: "1", props: { checked: "true" } }),
];

/** Minimal stand-in for CdpSession: only `send`, answered by a handler. */
function fakeSession(handler: (method: string, params: any) => any): CdpSession {
  const calls: Array<{ method: string; params: any }> = [];
  (fakeSession as any).calls = calls;
  return {
    targetId: "fake",
    url: "https://fake.test/",
    closed: false,
    consoleBuffer: [],
    async send(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      return handler(method, params);
    },
  } as unknown as CdpSession;
}

// ---------------------------------------------------------------- parseTarget

describe("parseTarget", () => {
  test("quoted name", () => {
    expect(parseTarget('button "Submit"')).toEqual({ kind: "ax", role: "button", name: "Submit" });
  });
  test("quoted name with spaces and CSS metachars", () => {
    expect(parseTarget('link "View > Orders (all)"')).toEqual({
      kind: "ax",
      role: "link",
      name: "View > Orders (all)",
    });
  });
  test("bare name, multi-word", () => {
    expect(parseTarget("menuitem Close all items")).toEqual({
      kind: "ax",
      role: "menuitem",
      name: "Close all items",
    });
  });
  test("case-insensitive role", () => {
    expect(parseTarget("Button Submit")).toEqual({ kind: "ax", role: "button", name: "Submit" });
  });
  test("unknown first token → selector", () => {
    expect(parseTarget("div .foo")).toEqual({ kind: "selector", value: "div .foo" });
    expect(parseTarget("a View")).toEqual({ kind: "selector", value: "a View" });
  });
  test("name with CSS metachars → selector", () => {
    expect(parseTarget("button .save")).toEqual({ kind: "selector", value: "button .save" });
  });
  test("plain selectors", () => {
    expect(parseTarget("button.save")).toEqual({ kind: "selector", value: "button.save" });
    expect(parseTarget("#main")).toEqual({ kind: "selector", value: "#main" });
    expect(parseTarget("input[type=search]")).toEqual({ kind: "selector", value: "input[type=search]" });
  });
});

// ---------------------------------------------------------------- matchTargets

describe("matchTargets", () => {
  test("exact beats substring, case-insensitive", () => {
    const nodes = [N("a", "button", "Save draft"), N("b", "button", "SAVE")];
    const m = matchTargets(nodes, "button", "save");
    expect(m.map((x) => x.node.nodeId)).toEqual(["b", "a"]);
    expect(m.every((x) => (x.node.nodeId === "b" ? x.exact : !x.exact))).toBe(true);
  });
  test("substring in both directions", () => {
    const nodes = [N("a", "button", "Save"), N("b", "button", "Save draft now")];
    expect(matchTargets(nodes, "button", "draft").map((x) => x.node.nodeId)).toEqual(["b"]);
  });
  test("skips ignored and unnamed nodes", () => {
    const nodes = [N("a", "button", "Go", { ignored: true }), N("b", "button", "")];
    expect(matchTargets(nodes, "button", "go")).toEqual([]);
  });
  test("role must match", () => {
    expect(matchTargets([N("a", "link", "Go")], "button", "go")).toEqual([]);
  });
});

// ------------------------------------------------------------------ axStates

describe("axStates", () => {
  test("keeps the meaningful states", () => {
    expect(axStates({ disabled: "true", level: "2", haspopup: "true" })).toEqual([
      "disabled",
      "haspopup",
      "level:2",
    ]);
  });
  test("hides false states and level 1", () => {
    expect(axStates({ disabled: "false", expanded: "false", level: "1", focused: "true" })).toEqual([
      "focused",
    ]);
  });
  test("checked mixed counts", () => {
    expect(axStates({ checked: "mixed" })).toEqual(["checked"]);
  });
});

// ---------------------------------------------------------------- shownNodes

describe("shownNodes / formatAXTree", () => {
  test("prunes ignored + unnamed generics, re-parenting children", () => {
    const { items, total, truncated } = shownNodes(TREE);
    expect(truncated).toBe(false);
    expect(total).toBe(10);
    expect(
      items.map((i) => `${i.index} d${i.depth} ${i.role} "${i.name}"`).join(" | "),
    ).toBe(
      '1 d0 document "Page" | 2 d1 heading "Title" | 3 d1 button "Go" | 4 d1 link "" | 5 d1 button "Disabled" | 6 d1 checkbox "A"',
    );
  });
  test("caps at maxNodes and flags truncation", () => {
    const r = shownNodes(TREE, { maxNodes: 3 });
    expect(r.truncated).toBe(true);
    expect(r.items.length).toBe(3);
  });
  test("formatAXTree renders header, indices, states", () => {
    const { text } = formatAXTree(TREE);
    const lines = text.split("\n");
    expect(lines[0]).toBe("AX tree: 6 of 10 nodes");
    expect(lines).toContain('1 document "Page"');
    expect(lines).toContain('  3 button "Go"');
    expect(lines).toContain('  5 button "Disabled" [disabled]');
    expect(lines).toContain('  6 checkbox "A" [checked]');
  });
  test("formatAXTree truncation notice", () => {
    const { text, truncated } = formatAXTree(TREE, 2);
    expect(truncated).toBe(true);
    expect(text.split("\n")[0]).toContain("TRUNCATED at 2");
  });
});

describe("ancestorRoles", () => {
  test("nearest ancestors, outermost first, root excluded", () => {
    const nodes = [
      N("1", "document", "Page", { rootId: "1", childIds: ["2"] }),
      N("2", "dialog", "Settings", { parentId: "1", rootId: "1", childIds: ["3"] }),
      N("3", "group", "Actions", { parentId: "2", rootId: "1", childIds: ["4"] }),
      N("4", "button", "Close", { parentId: "3", rootId: "1" }),
    ];
    expect(ancestorRoles(nodes, "4")).toBe('dialog "Settings" > group "Actions"');
  });
  test("generic and ignored wrappers are skipped", () => {
    const nodes = [
      N("1", "document", "Page", { rootId: "1", childIds: ["2"] }),
      N("2", "dialog", "Settings", { parentId: "1", rootId: "1", childIds: ["3"] }),
      N("3", "generic", "", { parentId: "2", rootId: "1", ignored: true, childIds: ["4"] }),
      N("4", "button", "Close", { parentId: "3", rootId: "1" }),
    ];
    expect(ancestorRoles(nodes, "4")).toBe('dialog "Settings"');
  });
  test("no context at the root", () => {
    expect(ancestorRoles(TREE, "7")).toBe("");
  });
});

describe("notFoundHint", () => {
  test("lists same-role candidates first", () => {
    const hint = notFoundHint(TREE, "button", "Nope");
    expect(hint).toContain('button "Go"');
    expect(hint).toContain('button "Disabled"');
    expect(hint).toContain("poor accessibility");
  });
  test("falls back to any candidates when nothing matches", () => {
    const hint = notFoundHint(TREE, "slider", "zzzzz");
    expect(hint).toContain("candidates:");
  });
});

// -------------------------------------------------------------- CDP glue

describe("axTree (glue)", () => {
  test("returns nodes from getFullAXTree", async () => {
    const s = fakeSession((m) => {
      if (m === "Accessibility.getFullAXTree") return { nodes: TREE };
      throw new Error(`unexpected ${m}`);
    });
    expect(await axTree(s)).toBe(TREE);
  });
  test("empty on malformed result", async () => {
    const s = fakeSession(() => ({}));
    expect(await axTree(s)).toEqual([]);
  });
});

describe("axPoint", () => {
  const RECT = { x: 10, y: 10, w: 20, h: 10 }; // centre (20, 15)

  test("resolves the element centre via resolveNode + getBoundingClientRect", async () => {
    const s = fakeSession((m, p) => {
      if (m === "Accessibility.getFullAXTree") return { nodes: [N("1", "button", "Save", { rootId: "1" })] };
      if (m === "DOM.resolveNode") {
        expect(p.backendNodeId).toBe(100);
        return { object: { objectId: "obj1" } };
      }
      if (m === "Runtime.callFunctionOn") return { result: { value: RECT } };
      throw new Error(`unexpected ${m}`);
    });
    const pt = await axPoint(s, "button", "Save");
    expect(pt.x).toBe(20);
    expect(pt.y).toBe(15);
    expect(pt.match.role).toBe("button");
  });

  test("ambiguous → AxTargetError listing the candidates", async () => {
    const s = fakeSession(() => ({
      nodes: [N("1", "button", "Close", { rootId: "1", childIds: ["2"] }), N("2", "button", "Close", { parentId: "1" })],
    }));
    await expect(axPoint(s, "button", "Close")).rejects.toMatchObject({ code: "ambiguous" });
    await expect(axPoint(s, "button", "Close")).rejects.toThrow(/2 buttons named/);
  });

  test("no match → AxTargetError with candidates", async () => {
    const s = fakeSession(() => ({ nodes: TREE }));
    const err: any = await axPoint(s, "button", "zzz").catch((e) => e);
    expect(err).toBeInstanceOf(AxTargetError);
    expect(err.code).toBe("not-found");
    expect(err.message).toContain('button "Go"');
  });

  test("missing box → scroll into view, then re-measure", async () => {
    let measures = 0;
    const s = fakeSession((m, p) => {
      if (m === "Accessibility.getFullAXTree") return { nodes: [N("1", "button", "Deep", { rootId: "1" })] };
      if (m === "DOM.resolveNode") return { object: { objectId: "obj1" } };
      if (m === "Runtime.callFunctionOn") {
        if (String(p.functionDeclaration).includes("scrollIntoView")) return { result: { value: undefined } };
        measures++;
        return { result: { value: measures === 1 ? { x: 0, y: 0, w: 0, h: 0 } : RECT } };
      }
      throw new Error(`unexpected ${m}`);
    });
    const pt = await axPoint(s, "button", "Deep");
    expect(pt.x).toBe(20);
    expect(measures).toBe(2);
  });

  test("requestNode fails (no backend node) → no-box error", async () => {
    const s = fakeSession((m) => {
      if (m === "Accessibility.getFullAXTree") return { nodes: [N("1", "button", "Save", { rootId: "1" })] };
      if (m === "DOM.resolveNode") return {};
      return {};
    });
    await expect(axPoint(s, "button", "Save")).rejects.toMatchObject({ code: "no-box" });
  });

  test("zero-size rect → no-box error", async () => {
    const s = fakeSession((m) => {
      if (m === "Accessibility.getFullAXTree") return { nodes: [N("1", "button", "Ghost", { rootId: "1" })] };
      if (m === "DOM.resolveNode") return { object: { objectId: "obj1" } };
      if (m === "Runtime.callFunctionOn") return { result: { value: { x: 5, y: 5, w: 0, h: 0 } } };
      return {};
    });
    await expect(axPoint(s, "button", "Ghost")).rejects.toMatchObject({ code: "no-box" });
  });

  test("exact match wins over substring duplicates", async () => {
    const s = fakeSession((m) => {
      if (m === "Accessibility.getFullAXTree")
        return { nodes: [N("1", "button", "Save draft", { rootId: "1", childIds: ["2"] }), N("2", "button", "Save", { parentId: "1" })] };
      if (m === "DOM.resolveNode") return { object: { objectId: "obj2" } };
      if (m === "Runtime.callFunctionOn") return { result: { value: RECT } };
      throw new Error(`unexpected ${m}`);
    });
    const pt = await axPoint(s, "button", "save");
    expect(pt.match.node.nodeId).toBe("2");
    expect(pt.match.exact).toBe(true);
  });
});

describe("axCover", () => {
  const NODE = N("1", "button", "X", { rootId: "1" });
  const session = (coverValue: string) =>
    fakeSession((m, p) => {
      if (m === "DOM.resolveNode") {
        expect(p.backendNodeId).toBe(100);
        return { object: { objectId: "obj1" } };
      }
      if (m === "Runtime.callFunctionOn") {
        expect(p.functionDeclaration).toContain("elementFromPoint");
        return { result: { value: coverValue } };
      }
      throw new Error(`unexpected ${m}`);
    });

  test("self / covering tag / offpage passthrough", async () => {
    expect(await axCover(session("self"), NODE, 1, 2)).toBe("self");
    expect(await axCover(session("div"), NODE, 1, 2)).toBe("div");
    expect(await axCover(session("offpage"), NODE, 1, 2)).toBe("offpage");
  });
  test("unresolved when the node has no DOM object", async () => {
    const s = fakeSession((m) => (m === "DOM.resolveNode" ? {} : {}));
    expect(await axCover(s, NODE, 1, 2)).toBe("unresolved");
  });
});

describe("CdpManager domain enablement", () => {
  test("connect() enables the Accessibility domain alongside the others", async () => {
    const realWS = globalThis.WebSocket;
    const realFetch = globalThis.fetch;
    const sent: string[] = [];
    class FakeWS {
      onmessage: ((ev: { data: string }) => void) | null = null;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      constructor(private url: string) {
        queueMicrotask(() => this.onopen?.());
      }
      send(data: string) {
        const msg = JSON.parse(data);
        if (typeof msg.id === "number") {
          sent.push(String(msg.method));
          queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result: {} }) }));
        }
      }
      close() {
        if (this.closed) return;
        this.closed = true;
        this.onclose?.();
      }
    }
    const T: CdpTarget = {
      id: "A",
      type: "page",
      url: "https://a.test/app",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/A",
    };
    (globalThis as any).WebSocket = FakeWS;
    (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => [T] });
    try {
      const m = new CdpManager();
      await m.run("a.test", () => Promise.resolve("ok"));
      await m.closeAll();
    } finally {
      (globalThis as any).WebSocket = realWS;
      (globalThis as any).fetch = realFetch;
    }
    for (const d of ["Runtime.enable", "Page.enable", "Network.enable", "DOM.enable", "Accessibility.enable"]) {
      expect(sent).toContain(d);
    }
  });
});
