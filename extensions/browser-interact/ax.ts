// browser-interact — CDP accessibility tree: tab_ax snapshot + role+name targeting.
//
// The Accessibility domain exposes the same tree a screen reader consumes:
// semantic roles, COMPUTED accessible names (visible label, aria-label, text
// content), and states. Compared to CSS selectors it is stable across
// style rewrites and — because the AX tree is flattened across shadow roots —
// it reaches into web components that querySelector cannot.
//
// Bad-accessibility pages degrade, they don't break: the resolver fails with
// an informative error (what roles/names actually exist), and every tool
// keeps its CSS-selector / coordinate paths as fallback.
//
// Layering: the pure functions (parseTarget / matchTargets / shownNodes /
// formatAXTree / ancestorRoles) work on a plain node array and are unit
// tested without a browser; the async glue (axTree / axFind / axPoint /
// axScrollIntoView / axCover) is thin CDP.

import type { CdpSession } from "./cdp";

/** Raw node of CDP `Accessibility.getFullAXTree`, as consumed here.
 * Role/name are TOP-LEVEL structured fields in the real payload (tests may
 * also pass them as plain strings in `properties` — axProps accepts both). */
export interface RawAXNode {
  nodeId: string;
  ignored?: boolean;
  childIds?: string[];
  parentId?: string;
  rootId?: string;
  /** The underlying DOM node (for DOM.requestNode / DOM.resolveNode) — the
   * Accessibility-domain `nodeId` is NOT accepted by DOM commands. */
  backendDOMNodeId?: number;
  role?: { type?: string; value?: string };
  name?: { type?: string; value?: string; sources?: unknown[] };
  properties?: Array<{ name: string; value: string | { type?: string; value?: unknown } }>;
}

/** Chrome-internal role names that map to a different (ARIA-style) spelling. */
const ROLE_ALIASES: Record<string, string> = {
  rootwebarea: "document",
  webarea: "document",
  genericcontainer: "generic",
  textfield: "textbox",
  togglebutton: "button",
};

/** The node's role as a lowercase ARIA-style string ("", when unknown). */
export function axRole(n: RawAXNode): string {
  const raw = n.role?.value;
  if (typeof raw !== "string" || !raw) return "";
  if (raw.startsWith("Doc")) return raw.slice(3).toLowerCase();
  const lower = raw.toLowerCase();
  return ROLE_ALIASES[lower] ?? lower;
}

/** A node's props as a flat name → string map: top-level role + name plus
 * the unwrapped `properties` array (values arrive as {type, value} wrappers,
 * e.g. {type:"booleanOrUndefined", value:true} or {type:"triState", value:"mixed"}). */
export function axProps(n: RawAXNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of n.properties ?? []) {
    if (!p || typeof p.name !== "string") continue;
    const v = p.value && typeof p.value === "object" ? (p.value as { value?: unknown }).value : p.value;
    if (v === undefined || v === null) continue;
    out[p.name] = String(v);
  }
  const role = axRole(n);
  if (role) out.role = role;
  if (typeof n.name?.value === "string" && n.name.value.trim()) out.name = n.name.value;
  return out;
}

/** Roles recognised in the `role "name"` target syntax (ARIA + Chrome roles). */
export const AX_ROLES: ReadonlySet<string> = new Set([
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button",
  "caption", "cell", "checkbox", "columnheader", "combobox", "complementary",
  "contentinfo", "definition", "dialog", "directory", "document", "feed", "figure",
  "form", "generic", "grid", "gridcell", "group", "heading", "img", "input", "link",
  "list", "listbox", "listitem", "log", "main", "marquee", "math", "menu", "menubar",
  "menuitem", "menuitemcheckbox", "menuitemradio", "meter", "none", "note",
  "notification", "option", "paragraph", "presentation", "progressbar", "radio",
  "range", "region", "row", "rowgroup", "rowheader", "scrollbar", "search",
  "searchbox", "section", "separator", "slider", "spinbutton", "status", "strong",
  "subscript", "sup", "switch", "tab", "table", "tablist", "tabpanel", "term",
  "textbox", "time", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
]);

export type Target =
  | { kind: "ax"; role: string; name: string }
  | { kind: "selector"; value: string };

/**
 * Parse a tool `target` argument into either a role+name AX target or a CSS
 * selector. Role+name forms: `button "Submit"` (quoted name, may contain
 * spaces/CSS metachars) or `menuitem Close` (bare name: no CSS metachars).
 * Anything else — including a first token that is not a known AX role
 * (`div .foo`) or a name with selector metachars — is a CSS selector.
 */
export function parseTarget(raw: string): Target {
  const t = (raw ?? "").trim();
  if (!t) return { kind: "selector", value: t };
  const quoted = t.match(/^([a-zA-Z][a-zA-Z0-9-]*)\s+"((?:[^"\\]|\\.)*)"\s*$/);
  if (quoted && AX_ROLES.has(quoted[1].toLowerCase())) {
    return { kind: "ax", role: quoted[1].toLowerCase(), name: quoted[2] };
  }
  const bare = t.match(/^([a-zA-Z][a-zA-Z0-9-]*)\s+(\S[\s\S]*)$/);
  if (bare) {
    const role = bare[1].toLowerCase();
    const name = bare[2].trim();
    // A bare name must not look like a CSS fragment (`.save`, `#x`, `[href]`,
    // `:hover`, combinators...) and the first token must be a real role.
    if (AX_ROLES.has(role) && !/[.#\[:>*~(]/.test(name)) {
      return { kind: "ax", role, name };
    }
  }
  return { kind: "selector", value: t };
}

export interface AxMatch {
  node: RawAXNode;
  role: string;
  name: string;
  /** true = role AND name matched exactly (case-insensitive). */
  exact: boolean;
}

/**
 * Match `role` + `name` against a raw tree. Skips ignored nodes and unnamed
 * ones. Exact role+name wins over substring (name contained in either
 * direction); result keeps tree order within each score class.
 */
export function matchTargets(nodes: RawAXNode[], role: string, name: string): AxMatch[] {
  const r = role.trim().toLowerCase();
  const q = name.trim().toLowerCase();
  if (!r || !q) return [];
  const out: AxMatch[] = [];
  for (const n of nodes) {
    if (n.ignored) continue;
    const p = axProps(n);
    if ((p.role ?? "").toLowerCase() !== r) continue;
    const nm = (p.name ?? "").trim();
    if (!nm) continue;
    const nl = nm.toLowerCase();
    if (nl === q) out.push({ node: n, role: p.role, name: nm, exact: true });
    else if (nl.includes(q) || q.includes(nl)) out.push({ node: n, role: p.role, name: nm, exact: false });
  }
  out.sort((a, b) => Number(b.exact) - Number(a.exact));
  return out;
}

/** Ancestor context for a node: up to `max` non-generic ancestor
 * `role "name"` pairs, outermost first (e.g. `dialog "Settings" > group`). */
export function ancestorRoles(nodes: RawAXNode[], nodeId: string, max = 2): string {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const parts: string[] = [];
  let cur = byId.get(nodeId)?.parentId;
  while (cur && parts.length < max) {
    const a = byId.get(cur);
    if (!a) break;
    // The document root labels the whole page, not the node's context
    // (in CDP data every node carries rootId pointing at the root).
    if (a.nodeId === a.rootId) break;
    const p = axProps(a);
    const role = (p.role ?? "").toLowerCase();
    if (role && role !== "generic" && role !== "none" && role !== "presentation") {
      parts.push(`${role}${p.name ? ` "${p.name}"` : ""}`);
    }
    cur = a.parentId;
  }
  return parts.reverse().join(" > ");
}

/** One node of the PRUNED display tree (what tab_ax prints and #indexes). */
export interface ShownAX {
  nodeId: string;
  role: string;
  name: string;
  props: Record<string, string>;
  depth: number;
  /** 1-based position in the printed tree. */
  index: number;
}

/** Roles that carry no orientation value on their own. */
const GENERIC_ROLES = new Set(["generic", "none", "presentation", "paragraph", "statictext", "text"]);

/** Chrome-internal nodes that are never useful to show (text runs duplicate
 * their statictext parent). */
const NEVER_SHOWN = new Set(["inlinetextbox"]);

const STATE_SHOW: Array<[string, (v: string) => boolean]> = [
  ["disabled", (v) => v === "true"],
  ["focused", (v) => v === "true"],
  ["checked", (v) => v === "true" || v === "mixed"],
  ["expanded", (v) => v === "true"],
  ["selected", (v) => v === "true"],
  ["pressed", (v) => v === "true" || v === "mixed"],
  ["haspopup", (v) => v === "true"],
  ["required", (v) => v === "true"],
  ["multiline", (v) => v === "true"],
];

/** States worth printing for a node. */
export function axStates(props: Record<string, string>): string[] {
  const out = STATE_SHOW.filter(([state, is]) => is(props[state] ?? "")).map(([state]) => state);
  const level = Number(props.level);
  if (Number.isFinite(level) && level > 1) out.push(`level:${Math.round(level)}`);
  return out;
}

/**
 * Walk the raw tree and return the pruned, display-ordered nodes: ignored
 * nodes are collapsed (children re-parented to the nearest shown ancestor),
 * as are unnamed generic-role nodes without notable states. Output is capped
 * at `maxNodes` SHOWN nodes (document order).
 */
export function shownNodes(
  nodes: RawAXNode[],
  opts: { maxNodes?: number } = {},
): { items: ShownAX[]; total: number; truncated: boolean } {
  const maxNodes = opts.maxNodes ?? 300;
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  // In CDP data EVERY node carries rootId; the root is the node whose own id
  // it is (fallback: a node without a parent, then the first node).
  const rootId =
    nodes.find((n) => n.nodeId === n.rootId)?.nodeId ??
    nodes.find((n) => !n.parentId)?.nodeId ??
    nodes[0]?.nodeId;
  const items: ShownAX[] = [];
  let truncated = false;
  const visited = new Set<string>();

  const isShown = (n: RawAXNode): boolean => {
    if (n.ignored) return false;
    const p = axProps(n);
    if (NEVER_SHOWN.has((p.role ?? "").toLowerCase())) return false;
    if ((p.name ?? "").trim()) return true;
    if (axStates(p).length) return true;
    const role = (p.role ?? "").toLowerCase();
    return !!role && !GENERIC_ROLES.has(role);
  };

  const dfs = (id: string, depth: number): void => {
    if (visited.has(id) || items.length >= maxNodes) {
      if (id !== rootId && items.length >= maxNodes) truncated = true;
      return;
    }
    const n = byId.get(id);
    if (!n) return;
    visited.add(id);
    if (isShown(n)) {
      const p = axProps(n);
      items.push({
        nodeId: n.nodeId,
        role: (p.role ?? "generic").toLowerCase(),
        name: (p.name ?? "").trim(),
        props: p,
        depth,
        index: items.length + 1,
      });
      for (const c of n.childIds ?? []) dfs(c, depth + 1);
    } else {
      for (const c of n.childIds ?? []) dfs(c, depth);
    }
  };

  if (rootId) dfs(rootId, 0);
  // Offscreen/hidden subtrees are in the payload but not reachable through
  // childIds — pick them up after the main walk (still in payload order).
  for (const n of nodes) {
    if (items.length >= maxNodes) break;
    if (!visited.has(n.nodeId)) dfs(n.nodeId, 0);
  }
  return { items, total: nodes.length, truncated };
}

/** Default cap on shown nodes for a tab_ax snapshot. */
export const AX_MAX_NODES = 300;

/** Render the pruned tree as indented, #indexed lines. */
export function formatAXTree(
  nodes: RawAXNode[],
  maxNodes = AX_MAX_NODES,
): { text: string; shown: number; total: number; truncated: boolean } {
  const { items, total, truncated } = shownNodes(nodes, { maxNodes });
  const lines = items.map((n) => {
    const states = axStates(n.props);
    const name = n.name.length > 60 ? `${n.name.slice(0, 57)}…` : n.name;
    return `${"  ".repeat(n.depth)}${n.index} ${n.role}${name ? ` "${name}"` : ""}${
      states.length ? ` [${states.join(", ")}]` : ""
    }`;
  });
  const header = `AX tree: ${items.length} of ${total} nodes${truncated ? ` (TRUNCATED at ${maxNodes})` : ""}`;
  return { text: [header, ...lines].join("\n"), shown: items.length, total, truncated };
}

/** What a `no match` error should say: candidates + the bad-a11y hint. */
export function notFoundHint(nodes: RawAXNode[], role: string, name: string, limit = 6): string {
  const { items } = shownNodes(nodes, { maxNodes: 5000 });
  const q = name.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter((t) => t.length > 2);
  let near = items.filter((i) => {
    if (i.role === role.trim().toLowerCase()) return true;
    const nm = i.name.toLowerCase();
    return tokens.some((t) => nm.includes(t));
  });
  if (!near.length) near = items;
  const list = near.slice(0, limit).map((i) => `#${i.index} ${i.role}${i.name ? ` "${i.name}"` : ""}`);
  return [
    `candidates: ${list.join("; ") || "(tree is empty — page still loading?)"}`,
    "if the page has poor accessibility (many unnamed/generic nodes), use a CSS selector, tab_evaluate, or coordinates (tab_screenshot + tab_hover x/y)",
  ].join("\n");
}

// ----------------------------------------------------------------- CDP glue ---

/** Fetch the full AX tree of the session's tab. */
export async function axTree(s: CdpSession, timeoutMs = 15_000): Promise<RawAXNode[]> {
  const r = await s.send("Accessibility.getFullAXTree", {}, timeoutMs);
  return Array.isArray(r?.nodes) ? (r.nodes as RawAXNode[]) : [];
}

/** First match of role+name in the live tree, or null. */
export async function axFind(s: CdpSession, role: string, name: string): Promise<AxMatch | null> {
  const nodes = await axTree(s);
  return matchTargets(nodes, role, name)[0] ?? null;
}

export type AxErrorCode = "not-found" | "ambiguous" | "no-box";

/** Error from axPoint with a machine-readable code (callers poll only "not-found"). */
export class AxTargetError extends Error {
  constructor(
    message: string,
    readonly code: AxErrorCode,
  ) {
    super(message);
    this.name = "AxTargetError";
  }
}

/** Resolved clickable point for a role+name target. */
export interface AxPoint {
  match: AxMatch;
  x: number;
  y: number;
  props: Record<string, string>;
  /** Ancestor context string ("" when none), e.g. `dialog "Settings"`. */
  context: string;
}

/**
 * Resolve role+name to a viewport point: match in the AX tree, centre of the
 * element's bounding rect (scrolling it into view once when the rect is
 * missing/empty). Throws AxTargetError: "not-found" (page may still be
 * loading — poll), "ambiguous" (list of candidates with context), "no-box".
 */
export async function axPoint(s: CdpSession, role: string, name: string): Promise<AxPoint> {
  const nodes = await axTree(s);
  const m = matchTargets(nodes, role, name);
  const exact = m.filter((x) => x.exact);
  const pool = exact.length ? exact : m;
  if (!pool.length) {
    throw new AxTargetError(
      `no ${role} named "~${name}" in the accessibility tree.\n${notFoundHint(nodes, role, name)}`,
      "not-found",
    );
  }
  if (pool.length > 1) {
    const list = pool
      .slice(0, 6)
      .map((x) => {
        const ctx = ancestorRoles(nodes, x.node.nodeId);
        return `${ctx ? `${ctx} > ` : ""}${x.role} "${x.name}"`;
      })
      .join("  |  ");
    throw new AxTargetError(
      `${pool.length} ${role}s named "~${name}" — ambiguous, pick one (or use a CSS selector / coordinates):\n  ${list}`,
      "ambiguous",
    );
  }
  const chosen = pool[0];
  const p = axProps(chosen.node);
  let center = await axCenter(s, chosen.node);
  if (!center) {
    await axScrollIntoView(s, chosen.node);
    center = await axCenter(s, chosen.node);
  }
  if (!center) {
    throw new AxTargetError(
      `${role} "${name}" has no bounding box (display:none or not laid out)`,
      "no-box",
    );
  }
  return {
    match: chosen,
    x: center.x,
    y: center.y,
    props: p,
    context: ancestorRoles(nodes, chosen.node.nodeId),
  };
}

/** Viewport-space centre of a node: DOM.resolveNode on the AX node's
 * backendDOMNodeId → the element's RemoteObject → getBoundingClientRect
 * (exactly the viewport space Input.dispatchMouseEvent expects, same as the
 * in-page ACTIONABILITY check). Null when the node has no box.
 * (DOM.requestNode/getBoxModel were the original plan, but recent Chrome
 * builds' requestNode binding demands objectId and no longer accepts
 * backendNodeId — resolveNode does.) */
async function axCenter(s: CdpSession, n: RawAXNode): Promise<{ x: number; y: number } | null> {
  if (!n.backendDOMNodeId) return null;
  const { objectId } = (await s
    .send("DOM.resolveNode", { backendNodeId: n.backendDOMNodeId }, 10_000)
    .catch(() => undefined))?.object ?? {};
  if (!objectId) return null;
  const r = await s
    .send(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration:
          "function () { const b = this.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }",
        returnByValue: true,
      },
      10_000,
    )
    .catch(() => undefined);
  const rect = r?.result?.value;
  if (!rect || typeof rect.x !== "number" || typeof rect.y !== "number") return null;
  if (rect.w === 0 && rect.h === 0) return null;
  return { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) };
}

/** Scroll an AX node's element into view (best effort; dead page tolerated). */
export async function axScrollIntoView(s: CdpSession, n: RawAXNode): Promise<void> {
  const { objectId } = (await s
    .send("DOM.resolveNode", { backendNodeId: n.backendDOMNodeId }, 10_000)
    .catch(() => undefined))?.object ?? {};
  if (!objectId) return;
  await s
    .send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { this.scrollIntoView({ block: 'center', inline: 'center' }); }",
    }, 10_000)
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
}

/**
 * What is at (x, y) relative to the node's own element: "self" (itself or a
 * descendant — clickable), the covering element's tag, "offpage" (the point
 * is outside the document — scroll it into view), "unresolved".
 */
export async function axCover(s: CdpSession, n: RawAXNode, x: number, y: number): Promise<string> {
  const { objectId } = (await s
    .send("DOM.resolveNode", { backendNodeId: n.backendDOMNodeId }, 10_000)
    .catch(() => undefined))?.object ?? {};
  if (!objectId) return "unresolved";
  const r = await s
    .send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration:
        "function (x, y) { const top = document.elementFromPoint(x, y); if (!top) return 'offpage'; return (top === this || this.contains(top)) ? 'self' : (top.tagName || '?').toLowerCase(); }",
      arguments: [{ value: x }, { value: y }],
      returnByValue: true,
    }, 10_000)
    .catch(() => undefined);
  return r?.result?.value ?? "unresolved";
}
