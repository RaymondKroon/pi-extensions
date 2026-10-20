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

1. the tool's `tab` parameter — a URL substring, e.g. `localhost:5173`
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

## Tools

| tool | effect |
|---|---|
| `tab_status` | attached? which page? Returns the tab's **targetId** — the exact handle for `tab_close` (run first to orient) |
| `tab_list` | list the tabs attached in this session (pattern, targetId, url, title) — attached only, not all browser tabs |
| `tab_evaluate "<expr>"` | evaluate a JS expression (promises awaited, JSON result) |
| `tab_wait "<expr>" [ms]` | wait until a **synchronous** expression is truthy (default 60 s, max 300 s). Polls every 500 ms from the extension side (plain `Runtime.evaluate` per poll — CSP-safe; an in-page `eval()` loop would be blocked by strict-CSP pages like Slack). Survives full reloads (retries on destroyed context). |
| `tab_screenshot [path]` | PNG of the viewport (default `/tmp/tab-<host>-shot.png`); read the file with the `read` tool |
| `tab_lens [action]` | **Lens**: the USER shows the agent things on the page. `on` arms bounding-box selection in the browser (the dock's **🔍** button lights up, crosshair cursor); the user drags a box, types a note in the pop-up input, presses Enter (repeat for more boxes; Esc turns the lens off). `list` (default) returns the annotations (viewport + document coords, text, time) **and saves a cropped PNG of each box** to `/tmp/tab-<host>-lens-<n>.png` — read it with `read`. `off` disarms (notes kept). `clear` removes all annotations; removing ONE box: click its numbered chip on the page (✕). Saving a note **pushes a message into the session automatically** (the agent checks the lens without being told). Notes + on/off state survive page reloads (`sessionStorage`), and the overlay auto-upgrades across extension updates |
| `tab_click "<selector>" [ms]` | polls actionability (default 10 s), then a **trusted** CDP mouse sequence at the element's centre. Fails with a reason: `not-found`, `not-visible`, `disabled`, `covered-by-<el>` (fix the overlay/selector, don't retry blindly) |
| `tab_hover "<selector>" [waitFor] [ms]` or `tab_hover {x, y}` | move the mouse over a CSS selector (trusted CDP `mouseMoved` to its centre — fires `:hover` / `mouseenter` / `mouseover`, full enter/leave chains on boundary crossings) or to exact **viewport coordinates** (`x`/`y`, negative = outside the page). The mouse **stays** where it is, so a follow-up `tab_click` can click what the hover revealed. Result reports **`elementAt`** — what is actually under the cursor: hover overlays (link previews, menus) can land there and the next jump may re-hover them. **Unhover reliably with `x:-500, y:-500`** (outside the page) — hovering `body` can land on a hover overlay and keep the hover alive. `waitFor` is a selector that should appear as a result of the hover (e.g. a tooltip); its tag/text is returned. Selector mode fails with `not-found`, `not-visible`, `covered-by-<el>` (no `disabled` gate — hover on disabled elements is valid) |
| `tab_type "<text>"` | trusted `Input.insertText` into the **focused** element (click the field first); fires `input`, no `keydown` |
| `tab_press "<key>"` | trusted key event: Enter (**submits the focused form** — the keyDown carries `text: "\r"`, which is what triggers Blink's implicit form submission; a bare keyDown does not), Tab, Escape, Backspace, Delete, arrows, Home/End, PageUp/Down, Space, or one character |
| `tab_scroll <x> <y>` / `tab_scroll "<selector>"` | scroll by offset or element into view |
| `tab_console [clear]` | `console.error`/`warn` + uncaught exceptions captured via CDP events (survives reloads — no in-page hook) |
| `tab_network [filter] [types] [failedOnly] [limit] [clear]` | HTTP requests captured via the CDP **Network domain** since attach (survives reloads; buffer capped at 250; redirect hops excluded). Each row: method, status (number, or `pending`/`failed`), resource type, response size, duration, url. `filter` matches a URL substring; `types` filters by resource type (default `document`, `xhr`, `fetch` — pass e.g. `["script","image"]` for assets); `failedOnly` shows failures/pending/4xx/5xx only; `limit` caps the rows (default 30, max 200, newest last); `clear` empties the buffer. Types are normalized to lowercase (Chrome reports `Fetch`/`XHR` capitalized) |
| `tab_dismiss` | detect and close visible modal dialogs / toasts (app-specific extras via config); returns `{dismissed, items[]}` — `type: "waiting"` items are visible but cannot be dismissed. **Run before navigating or interacting.** |
| `tab_navigate "<url>"` | navigate and wait for `readyState === "complete"` |
| `tab_open [url]` | open a **new** tab (`/json/new`); returns the new tab's target id + url. Does not touch existing tabs |
| `tab_close [id] [tab] [force]` | close a tab (`/json/close`). Prefer the exact **target id** (from `tab_open`/`tab_status`) — always closes the right tab. Without an id, the URL substring must match **exactly one** page tab (fails on zero or multiple, listing candidates). Refuses to close the last remaining page tab unless `force: true` |

### Tab handles: URL substring vs target id

All tools take `tab` — a URL substring (first match, shortest URL wins, sticky
per pattern). Without a configured or explicit pattern, tools target Chrome's
focused tab (or a visible tab if the browser window itself is unfocused), then
fall back to the shortest URL. That is cheap and readable, but ambiguous when
several tabs share a host. For the destructive case, `tab_close` therefore also accepts the
exact CDP **target id** (stable across navigations; dies with the tab), which
takes precedence and never guesses. `tab_status` and `tab_open` both return
the id so the model has it in context when needed.

## Commands

- `/tab` — show attached tabs and their current page
- `/tab interact [on|off]` — open (default) / minimize the in-page interaction dock in the browser (chat + the **🔍** looking glass that arms the lens; see `tab_lens`)
- `/tab check <url>` — open + attach a URL to verify the CDT allowlist (the tab is left open)
- `/tab shutdown` — detach all CDP sessions

## Chat dock

A floating in-page chat panel over **this** pi session, injected into the page's
main world. The dock appears on any tab the extension has attached an overlay
to (the first `tab_lens` call or `/tab interact`).

- **Input:** the user types tasks into the dock (Enter = send, Shift+Enter =
  newline). Text arrives in the session as a user message prefixed
  `[browser chat]`; while an agent run is active it is queued as a follow-up.
- **Output:** agent replies and one line per tool call render in the dock via a
  live ~1 s poller (busy state shown as a dot); a shutdown flush delivers
  updates queued at session end, so one-shot sessions don't lose the final
  reply. Tool rows are **expandable**: click one to reveal the call's
  arguments and (truncated) result output — failed calls show an
  *error* section; the args/result are paired per `toolCallId` between the
  assistant message and its result. The floating **💬 pi** button opens the
  panel; drag the header to move, the bottom-right corner to resize, `–` to
  minimize, `✕` to close, and the header's **🔍** toggles the lens.
- **State:** the transcript tail (last 50 messages), open state, and
  position/size live in `sessionStorage`, so everything survives a reload in
  the same tab — the overlay re-installs on every document via
  `Page.addScriptToEvaluateOnNewDocument` (plus a runtime re-injection when a
  re-attach lost the registration).
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
> works in the first place.

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

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry: registers `tab_*` tools + `/tab` command; chat-dock/lens event broadcasting, page-signal polling, network formatting |
| `tool-update.ts` | `ToolCallTracker`: pairs assistant `toolCall` blocks with `toolResult` messages (truncated args + result) for the dock's expandable tool rows |
| `cdp.ts` | Minimal CDP client: session manager, attach/re-attach, console + Network-domain capture (250-entry cap), evaluate, screenshot |
| `overlay.ts` | The in-page overlay (one main-world script, single template literal): user-facing lens + chat dock — DOM/UI, `sessionStorage` state, isTrusted input guards, the `tick()` bridge polled by the extension |
| `tool-update.test.ts`, `overlay.test.ts` | Focused tests: tracker pairing/truncation, and the overlay booted in a happy-dom window (expandable rows, isTrusted click guard, persistence). `bun test .`; `bunx tsc --noEmit` typechecks |
