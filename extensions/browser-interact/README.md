# browser-interact

General interaction tools for **a single website / tab**: drives one Chrome
tab (already running with `--remote-debugging-port=9222`) over raw CDP and
exposes it to the agent as `tab_*` tools.

Same discipline as a dedicated app bridge (one persistent attach per tab,
dismiss before interacting, wait after navigation, console as evidence)
but no app-specific selectors and no daemon process: the extension holds
the CDP WebSocket directly in pi's process (raw CDP over Node's native
WebSocket).

## Target tab

First match wins:

1. the tool's `tab` parameter — a URL substring (e.g. `localhost:5173`) or an exact CDP target id
2. `$BROWSER_INTERACT_TAB`
3. `.pi/browser-interact.json` — `{ "tab": "localhost:5173", "port": 9222 }`
4. the active page tab (detected via `document.hasFocus()` / visibility; falls back to the shortest URL)

Port: `$BROWSER_INTERACT_PORT`, else config `port`, else `9222`.

### Dismiss configuration

`tab_dismiss` is generic (role/class-based dialogs, toasts, close buttons).
App-specific behaviour is configured per project in `.pi/browser-interact.json`:

```json
{
  "dismiss": {
    "extraSelectors": [".mx-popup"],
    "closeLabels": ["sluiten", "bevestig", "bevestiging"],
    "reportOnly": [".mx-underlay"]
  }
}
```

- `extraSelectors` — additional container selectors for dialog-like popups
- `closeLabels` — additional close-button labels (case-insensitive)
- `reportOnly` — selectors that are reported as `type: "waiting"` items but
  never touched (e.g. loading overlays); `dismissed` counts only real dismissals

The attach is persistent for the session and survives navigations and full
page reloads (a CDP session is bound to the target, not the document). A
closed tab or Chrome restart drops the socket; the next tool call
re-attaches automatically. Re-attach first looks for the previously attached
target by id (the tab may have navigated to a URL that no longer matches
the pattern), then falls back to the URL pattern.

**Switching the dock's target tab** — the remembered target is *sticky*, so
switching to a different tab in Chrome alone does NOT move the tools or the
dock. To re-point or let go:

- `/tab use <url-substring|target-id|active>` — connect the dock to a
  specific tab and make it the **default target** for the `tab_*` tools
  (`active` = the tab currently in front in Chrome). If other tabs are
  already connected, you are asked to confirm first.
- **Multi-dock:** connected tabs are not removed when you point the default
  elsewhere — every connected tab keeps its live dock (the previous default
  is re-keyed to its own target id). The `tab_*` tools without a `tab` param
  always target the default; pass `tab` to talk to another connected tab.
- `/tab detach [url-substring|target-id]` — **off is off**: removes the
  dock/overlay from the page (DOM + stored state) and releases the CDP
  session, **without closing the browser tab** (no argument = the default
target). The page is left exactly as found; the tab is also **undocked**, so
a later `tab_*` tool call re-attaches headless and does NOT bring the dock
back — reconnect with `/tab use` or `/tab interact on` for a fresh dock. The
session is told via a `[dock]` user message, so
the agent knows the tab is no longer driven (same for ⏏ and `/tab
  shutdown`).
- From the dock itself: the header's **⏏** disconnects the dock from the tab
  it is in (the browser tab stays open). It acts on the tab that clicked it
  (each tab has its own CDP session, so the session always knows which tab
  sent a signal — chat text from a
dock is the one thing that stays undifferentiated). If the pi session has
  already ended, the ⏏ signal has no one left to process it — the overlay
  detects this (a live session's poller ticks at least once a second) and,
  when no recent tick has arrived, removes **itself immediately**; with a
  live session the signal is processed within a second instead.

## Tools

| tool | effect |
|---|---|
| `tab_status` | attached? which page? Returns the tab's **targetId** — the exact handle for `tab_close` (run first to orient) |
| `tab_list` | list the tabs attached in this session (pattern, targetId, url, title) — attached only, not all browser tabs |
| `tab_evaluate "<expr>"` | evaluate a JS expression (promises awaited, JSON result) |
| `tab_wait "<expr>" [ms]` or `tab_wait {target} [ms]` | wait until a **synchronous** expression is truthy, or until a **target** (role+name, e.g. `button "Saved"`, or a visible CSS selector) appears — pass exactly one (default 60 s, max 300 s). Polls every 500 ms from the extension side (plain `Runtime.evaluate` per poll — CSP-safe; an in-page `eval()` loop would be blocked by strict-CSP pages like Slack). Survives full reloads (retries on destroyed context). |
| `tab_ax` | semantic snapshot of the page from the **accessibility tree** (what a screen reader sees): roles, computed accessible names, states (`[disabled] [focused] [checked] [expanded] [selected] [haspopup] [level:n]`). The source of truth for picking targets: take a role+name from the output and pass it verbatim to `tab_click` / `tab_hover` / `tab_scroll` / `tab_wait`. Ignored + unnamed-generic nodes are collapsed, `#n` indices per snapshot, capped at 300 nodes (truncation is announced) |
| `tab_screenshot [path]` | PNG of the viewport (default `/tmp/tab-<host>-shot.png`); read the file with the `read` tool |
| `tab_lens [action]` | **Lens**: the USER shows the agent things on the page. `on` arms bounding-box selection in the browser (the dock's **🔍** button lights up, crosshair cursor); the user drags a box, types a note in the pop-up input, presses Enter (repeat for more boxes; Esc turns the lens off). `list` (default) returns the annotations (viewport + document coords, text, time) **and saves a cropped PNG of each box** to `/tmp/tab-<host>-lens-<n>.png` — read it with `read`. `off` disarms (notes kept). `clear` removes all annotations; removing ONE box: click its numbered chip on the page (✕). Saving a note **pushes a message into the session automatically** (the agent checks the lens without being told). Notes + on/off state survive page reloads (`sessionStorage`), and the overlay auto-upgrades across extension updates |
| `tab_click "<target>" [ms]` | polls actionability (default 10 s), then a **trusted** CDP mouse sequence at the target's centre. `target` is **role+name** (preferred — `button "Submit"`; from `tab_ax`; stable and reaches shadow DOM) or a CSS selector. The role+name result reports **`matched: exact\|substring`** — a substring hit can be a weaker match, sanity-check `text`. Fails with a reason: `not-found` (retried until timeout), `disabled`, `covered-by-<el>` (fix the overlay/target, don't retry blindly), `ambiguous` (candidates listed with their ancestor context) |
| `tab_hover "<target>" [waitFor] [ms]` or `tab_hover {x, y}` | move the mouse over a target — **role+name** (preferred) or a CSS selector (polls until visible and not covered, then a trusted CDP `mouseMoved` to its centre — fires `:hover` / `mouseenter` / `mouseover`, full enter/leave chains on boundary crossings) — or to exact **viewport coordinates** (`x`/`y`, negative = outside the page). The mouse **stays** where it is, so a follow-up `tab_click` can click what the hover revealed. Result reports **`elementAt`** — what is actually under the cursor: hover overlays (link previews, menus) can land there and the next jump may re-hover them. **Unhover reliably with `x:-500, y:-500`** (outside the page) — hovering `body` can land on a hover overlay and keep the hover alive. `waitFor` is a target (role+name, e.g. `tooltip "Saved"`, or a CSS selector) that should appear as a result of the hover; its role/name (or tag/text) is returned; the role+name result also reports **`matched: exact\|substring`**. Fails with `not-found` (retried), `covered-by-<el>` (selector mode), `ambiguous` (role+name mode) — no `disabled` gate: hover on disabled elements is valid |
| `tab_type "<text>"` | trusted `Input.insertText` into the **focused** element (click the field first); fires `input`, no `keydown` |
| `tab_press "<key>"` | trusted key event: Enter (**submits the focused form** — the keyDown carries `text: "\r"`, which is what triggers Blink's implicit form submission; a bare keyDown does not), Tab, Escape, Backspace, Delete, arrows, Home/End, PageUp/Down, Space, or one character |
| `tab_scroll <x> <y>` / `tab_scroll "<target>"` | scroll by offset, or scroll a target (role+name, e.g. `heading "Billing"`, or a CSS selector) into view |
| `tab_console [clear]` | `console.error`/`warn` + uncaught exceptions captured via CDP events (survives reloads — no in-page hook) |
| `tab_network [filter] [types] [failedOnly] [limit] [clear]` | HTTP requests captured via the CDP **Network domain** since attach (survives reloads; buffer capped at 250; redirect hops excluded). Each row: method, status (number, or `pending`/`failed`), resource type, response size, duration, url. `filter` matches a URL substring; `types` filters by resource type (default `document`, `xhr`, `fetch` — pass e.g. `["script","image"]` for assets); `failedOnly` shows failures/pending/4xx/5xx only; `limit` caps the rows (default 30, max 200, newest last); `clear` empties the buffer. Types are normalized to lowercase (Chrome reports `Fetch`/`XHR` capitalized) |
| `tab_dismiss` | detect and close visible modal dialogs / toasts (app-specific extras via config); returns `{dismissed, items[]}` — `type: "waiting"` items are visible but cannot be dismissed. **Run before navigating or interacting.** |
| `tab_navigate "<url>"` | navigate and wait for `readyState === "complete"` |
| `tab_open [url]` | open a **new** tab (`/json/new`); returns the new tab's target id + url. Does not touch existing tabs |
| `tab_close [id] [tab] [force]` | close a tab (`/json/close`). Prefer the exact **target id** (from `tab_open`/`tab_status`) — always closes the right tab. Without an id, the URL substring must match **exactly one** page tab (fails on zero or multiple, listing candidates). Refuses to close the last remaining page tab unless `force: true` |

### Targeting: role+name vs CSS selectors

Every tool that takes a `target`/`selector` accepts two syntaxes, and the role+name one is preferred:

- **role+name** — `button "Submit"` (quoted name, may contain spaces) or `menuitem Close` (bare name). The role must be a real AX role; anything that looks like CSS (`.save`, `#x`, `[href]`, `div .foo`) stays a CSS selector. Resolution: `Accessibility.getFullAXTree` → match role (exact, case-insensitive) + name (exact beats substring; names are compared in canonical form, so unicode spaces like nbsp are folded to plain spaces — what you read in `tab_ax` is what matches) → `DOM.resolveNode(backendDOMNodeId)` → `getBoundingClientRect` centre → the same trusted CDP input as the selector path. The AX tree is what screen readers see: names are COMPUTED (label, aria-label, text), stable across CSS rewrites, and — unlike `querySelector` — flattened across shadow roots, so web components are reachable.
- **CSS selector** — unchanged in-page actionability check; the fallback for edge cases (visual targets, `:nth-child`, `aria-hidden` decoration).
- **coordinates** — `tab_hover {x, y}` (and `tab_screenshot` to find them): the bottom of the barrel that always works, regardless of how broken the page's semantics are.

Bad-accessibility pages degrade, they don't break: a failed role+name lookup fails with the candidates that DO exist (plus a hint to switch to selector/coordinates), and the tree is re-fetched per call, so a page that is still loading just needs the poll (`not-found` is retried until timeout). Error messages quote the searched name as-is — matching is exact-beats-substring, so `no button named "Save" (exact or substring)` means neither an exact nor a substring match existed, and the ambiguous message lists every matching candidate with its ancestor roles.

**Browser-bridge prerequisite.** The [cdt-bridge](~/Development/raymondkroon/cdt-bridge) relays CDP only for methods in its `SUPPORTED_METHODS` whitelist, so the AX layer needs these whitelisted in **both** lists — `src/bridge/constants.js` and `extension/service-worker.js`: `Accessibility.enable`, `Accessibility.getFullAXTree`, `DOM.enable`, `DOM.resolveNode` (plus the already-present `Runtime.callFunctionOn`, `Runtime.enable`, `Page.enable` that the rest of the extension relies on). `DOM.requestNode` and `DOM.getBoxModel` also appear in those lists but are **unused** by this code — recent Chrome's `requestNode` binding demands an `objectId` and no longer accepts a `backendNodeId`, so resolution goes through `DOM.resolveNode` instead. Without `Accessibility.enable` in the whitelist the tab never builds an AX tree and every role+name lookup fails with `not-found`.

### Tab handles: URL substring vs target id

All tools take `tab` — a URL substring (first match, shortest URL wins, sticky
per pattern) or an exact CDP **target id** (stable across navigations; dies
with the tab), which takes precedence and never guesses. Without a configured
or explicit pattern, tools target Chrome's focused tab (or a visible tab if
the browser window itself is unfocused), then fall back to the shortest URL.
That is cheap and readable, but ambiguous when several tabs share a host —
use the target id in that case. `tab_status` and `tab_open` both return the
id so the model has it in context when needed; browser-chat messages carry
it in their prefix too.

## Commands

- `/tab` — show attached tabs and their current page
- `/tab interact [on|off]` — open (default) / minimize the in-page interaction dock in the browser (chat + the **🔍** looking glass that arms the lens; see `tab_lens`)
- `/tab use <url-substring|target-id|active>` — connect the dock to a specific tab (confirms if other tabs are already connected); the new tab becomes the default target for the `tab_*` tools, other tabs stay docked
- `/tab detach [url-substring|target-id]` — remove the dock/overlay from a tab and release its CDP session without closing the browser tab (default: the default target)
- `/tab check <url>` — open + attach a URL to verify the CDT allowlist (the tab is left open)
- `/tab shutdown` — remove every dock/overlay and close all CDP sessions

## Chat dock

A floating in-page chat panel over **this** pi session, injected into the page's
main world. The overlay is **opt-in**: it is installed only when the user
explicitly asks for UI — `/tab interact [on]`, `/tab use`, or `tab_lens`
(which needs the lens UI). Plain `tab_*` tool calls (click, type, screenshot,
…) are **headless** — no 💬 button, no lens, nothing injected into the page.

- **Input:** the user types tasks into the dock (Enter = send, Shift+Enter =
  newline). Text arrives in the session as a user message prefixed
  `[browser chat @ <tab's current URL> (tab <targetId>)]` — the agent must
  interpret the request in the context of that exact tab (it can act on it
  via the `tab_*` tools, by URL substring or the carried target id); while
  an agent run is active it is queued as a follow-up.
- **Output:** agent replies and one line per tool call render in the dock via a
  live ~1 s poller; a shutdown flush delivers updates queued at session end, so
  one-shot sessions don't lose the final reply. While a run is active a fixed
  **⠋ working** bar (pi's braille spinner) sits pinned above the input field —
  it never scrolls out of view — and the **💬 pi** button / header dot pulse
  amber, so silence never means idle. Assistant **thinking** and text stream in
  **live**: throttled `message_update` snapshots render an in-place row whose
  thinking block is **open** while streaming and **auto-follows** the latest
  line (scrolling up pauses the follow; back to the bottom resumes it), then
  the final message row replaces it — the only one persisted. Tool calls get a
  **running row the moment they start**
  (matched by `toolCallId` and replaced by the final row), so long tools are
  not a silence gap. Agent replies are rendered as **markdown** (headings, bold/italic,
  inline + fenced code, lists, links incl. bare URLs, quotes, pipe tables) by a small
  escape-first renderer in the overlay — raw HTML in a reply can never reach
  the DOM as markup. Final **thinking** appears above the reply in a collapsed
  **▸ thinking** block; user messages stay plain text. Tool rows are
  **expandable**: click one to reveal the call's arguments and (truncated)
  result output — failed calls show an *error* section; the args/result are
  paired per `toolCallId` between the assistant message and its result. The
  floating **💬 pi** button opens the panel (reopening it re-renders anything
  that arrived while it was closed); drag the header to move, the
  bottom-right corner to resize, `–` to minimize, and the header's **🔍**
  toggles the lens. The header's **⏏** disconnects the dock from the tab it
  is in (the browser tab stays open; if the pi session has already ended,
  ⏏ removes the overlay immediately — see *Target tab*
  above); re-pointing the default to another tab is done from the pi chat
  with `/tab use`.
  Several tabs can be docked at once (multi-dock); the `@ <host>` part of the
  prefix says which dock the message came from.
- **State:** the transcript tail (last 50 messages), open state, and
  position/size live in `sessionStorage`, so everything survives a reload in
  the same tab — the overlay re-installs on every document via
  `Page.addScriptToEvaluateOnNewDocument` (plus a runtime re-injection when a
  re-attach lost the registration). The update channel self-heals the same
  way: a CDP socket drop re-attaches with a fresh session whose overlay
  registration is gone, and the next broadcast or poller tick reinstalls it
  instead of letting the dock go silently stale — but **only for docked
  tabs** (those the user asked for UI on); a headless tool session is never
  auto-injected, and an undocked tab (after ⏏/`/tab detach`) stays headless
  even when a later tool call re-attaches.
- **Trust model:** the dock renders agent text in the page's DOM, so **the
  page can read the replies** — secrets never leave the process, but don't
  treat the dock as confidential to the site. The reverse direction is
  guarded: chat text reaching the session only comes from **isTrusted** user
  events (input/keydown/click) — a page script can set the input's value or
  dispatch synthetic events, but none of that triggers a send.

> **CDP quirks** found during implementation: at new-document script time
> `document.documentElement` is still `NULL` (DOM boot is deferred to
> `DOMContentLoaded`), and the Browser Bridge proxy drops
> `Runtime.consoleAPICalled` but passes `Network.*` events — which is why the
> page↔pi channels are polled rather than event-driven, and why `tab_network`
> works in the first place. An on-page overlay version is **not** proof that a
> given session is running the new extension code: the overlay is injected per
> tab and may have been installed by a different (or earlier) pi process, so
> a tab can show the latest overlay while a session still streams pre-edit
> behaviour from its in-memory extension. Judge by live behaviour (e.g. after
> the expandable-rows commit, new tool rows must carry args/result), then
> reload the extension if it is stale. The mirror-image drift: after an
> extension **reload**, a docked tab keeps the **old** overlay until the
> session re-attaches it — the version check lives only in `ensureOverlay`,
> which runs for a docked tab on explicit UI paths or when the session has no
> `overlayScriptId` (i.e. after a re-attach); so right after a reload the
> page can still run the pre-reload script while the in-memory code is new
> (next `tab_*` call re-attaches, next broadcast re-injects). Compare
> `window.__piOverlay.__v` against the source `OVERLAY_V` before attributing
> page behaviour to the current code. Beware the normalisation trap when
> judging: the overlay stores tool rows with `args`/`result` keys even when
> the in-memory code predates them (old `{kind,name,ok}` broadcasts become
> rows with empty detail), so *empty* detail proves nothing — check that
> entries are actually new since the reload. A second quirk: a CDP socket
> drop (Chrome restart, proxy churn) used to leave the dock silently stale —
> the re-attach's fresh session had no overlay registration, so broadcasts
> and the poller both skipped it until `tab_lens` or `/tab interact` ran;
> the channel now self-heals on the next broadcast/poll (see
> `overlay-channel.ts`). Two more gotchas for **live** verification, found
> re-checking the dock in a running tab: (1) **several pi sessions can share
> one debug port** and contend for the same tab's overlay — each re-injects its
> own `OVERLAY_V` on its next broadcast/poll, so `window.__piOverlay.__v` can
> flip between sessions' versions (e.g. 5→4) *while you work*. A lower version
> appearing does **not** mean your reload failed: check your source
> `OVERLAY_V` and which session is currently driving the tab. (2) The dock
> **force-scrolls to the bottom on every agent message** (`addAgent` →
> `scrollDown(force=true)`, and it runs even for thinking-only messages), so
> **agent-driven** live click/expand checks are self-defeating: the dock
> auto-scrolls between a click's coordinate computation and its landing, moving
> the target row out from under the cursor (the trusted click *does* fire with
> `isTrusted:true`, it just lands on whatever is now at that point). Verify the
> click/expand path against the happy-dom tests, or from a moment when the dock
> is idle (no pending agent message to poll).

## Workflow

1. `tab_status` — which page is the tab on?
2. `tab_dismiss` — clear any lingering popups (they block clicks and corrupt screenshots).
3. Interact: `tab_click` / `tab_hover` / `tab_type` / `tab_press` / `tab_navigate`.
4. `tab_wait` after anything that changes the page — an SPA click often does not fire `load`.
5. Use `tab_screenshot` at useful visual checkpoints—for example, before an action
   that depends on layout or to verify an important visible change. Don't screenshot
   before and after every action when DOM state is sufficient. Check `tab_console`
   after actions when errors are relevant.
   When the USER wants to show you something specific, they arm the lens —
   `/tab interact on`, then click **🔍** in the dock — and draw boxes; you get
   interrupted automatically when a note is saved, so just call `tab_lens` and
   read the cropped screenshots.
6. If a click is "not found" or "covered": screenshot, inspect the page, fix the
   selector — don't retry the same call blindly.
7. The dock (and the default target) is sticky: if the user works in another
   tab, re-point with `/tab use <url-substring|target-id|active>` (the user
   can also just say "connect the dock to <tab>" to the agent). To stop
   driving a tab without closing it: `/tab detach` (or the dock's **⏏**
   button).

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry: registers `tab_*` tools + `/tab` command; session-event → dock wiring (tracker, throttled live `message_update` stream, `tool_execution_start` running rows, page signals, `ensureOverlay`) |
| `overlay-channel.ts` | The dock's update channel: per-tab queue + 1-second poller (drains into the overlay `tick()`, pops page signals), self-heals a lost overlay registration after a CDP re-attach |
| `tool-update.ts` | `ToolCallTracker`: pairs assistant `toolCall` blocks with `toolResult` messages (truncated args + result) for the dock's expandable tool rows |
| `cdp.ts` | Minimal CDP client: session manager, attach/re-attach, console + Network-domain capture (250-entry cap), evaluate, screenshot |
| `ax.ts` | Accessibility-tree layer: `tab_ax` snapshot formatting (pruning, #indices, states) and role+name target resolution (parse, match, box/rect centre, coverage) — pure functions + thin CDP glue |
| `overlay.ts` | The in-page overlay (one main-world script, single template literal): user-facing lens + chat dock — DOM/UI, `sessionStorage` state, isTrusted input guards, the `tick()` bridge polled by the extension |
| `tool-update.test.ts`, `overlay.test.ts`, `overlay-channel.test.ts`, `cdp.test.ts`, `ax.test.ts` | Focused tests: tracker pairing/truncation, the overlay booted in a happy-dom window (expandable rows, isTrusted click guard, persistence, dock-header tab controls), the update channel (queue/flush, self-heal, signal routing + origin stamping, poller lifecycle), the CdpManager's tab switching/detach logic against a fake CDP endpoint (resolveTarget, pointDefault re-keying, detach never closes the browser tab), and the AX layer (target parser, tree matching/pruning, resolver + coverage against a fake session). `bun test .`; `bunx tsc --noEmit` typechecks |
