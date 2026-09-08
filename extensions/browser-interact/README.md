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
4. the first page tab (shortest URL — the app's base tab, not derived tabs)

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
| `tab_status` | attached? which page? (run first to orient) |
| `tab_evaluate "<expr>"` | evaluate a JS expression (promises awaited, JSON result) |
| `tab_wait "<expr>" [ms]` | wait until a **synchronous** expression is truthy (default 60 s, max 300 s). One in-page async poll loop — raw CDP has no short per-command timeout, so no watcher+poll workaround is needed. Survives full reloads (retries on destroyed context). |
| `tab_screenshot [path]` | PNG of the viewport (default `/tmp/tab-<host>-shot.png`); read the file with the `read` tool |
| `tab_click "<selector>" [ms]` | polls actionability (default 10 s), then a **trusted** CDP mouse sequence at the element's centre. Fails with a reason: `not-found`, `not-visible`, `disabled`, `covered-by-<el>` (fix | `tab_press "<key>"` | trusted key event: Enter (**submits the focused form** — the keyDown carries `text: "\r"`, which is what triggers Blink's implicit form submission; a bare keyDown does not), Tab, Escape, Backspace, Delete, arrows, Home/End, PageUp/Down, Space, or one character |st); fires `input`, no `keydown` |
| `tab_press "<key>"` | trusted key event: Enter, Tab, Escape, Backspace, Delete, arrows, Home/End, PageUp/Down, Space, or one character |
| `tab_scroll <x> <y>` / `tab_scroll "<selector>"` | scroll by offset or element into view |
| `tab_console [clear]` | `console.error`/`warn` + uncaught exceptions captured via CDP events (survives reloads — no in-page hook) |
| `tab_dismiss` | detect and close visible modal dialogs / toasts (app-specific extras via config); returns `{dismissed, items[]}` — `type: "waiting"` items are visible but cannot be dismissed. **Run before navigating or interacting.** |
| `tab_navigate "<url>"` | navigate and wait for `readyState === "complete"` |

## Commands

- `/tab` — show attached tabs and their current page
- `/tab shutdown` — detach all CDP sessions

## Workflow

1. `tab_status` — which page is the tab on?
2. `tab_dismiss` — clear any lingering popups (they block clicks and corrupt screenshots).
3. Interact: `tab_click` / `tab_type` / `tab_press` / `tab_navigate`.
4. `tab_wait` after anything that changes the page — an SPA click often does not fire `load`.
5. `tab_screenshot` every step (before/after) + `tab_console` after actions.
6. If a click is "not found" or "covered": screenshot, look at it, fix the
   selector — don't retry the same call blindly.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry: registers `tab_*` tools + `/tab` command |
| `cdp.ts` | Minimal CDP client: session manager, attach/re-attach, console capture, evaluate, screenshot |
