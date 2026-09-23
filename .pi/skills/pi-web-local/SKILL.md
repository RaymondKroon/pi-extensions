---
name: pi-web-local
description: Run, restart, and debug the local pi-web dev runtime (sessiond + server on port 8504) and test pi-web plugins (browser panel + sessiond backend) against it. Also documents the ralph panel's start/stop design (prompt staging via context.prompt.insertText) and architecture. Use when starting/stopping pi-web, when a pi-web plugin is missing from the manifest or not loading, after editing a plugin's browser.js/server.js, or when driving the pi-web UI in the browser to test a panel.
---

# pi-web local runtime

Local pi-web is NOT systemd-managed. It runs from a `local-dev.sh` script in the pi-web local runtime directory, which starts `pi-web-sessiond` then `pi-web-server` (port 8504, host 127.0.0.1). State lives in `PI_WEB_DATA_DIR=<runtime dir>/.local/data/pi-web` (socket: `sessiond.sock`). It uses the normal pi config (the pi agent directory, `PI_CODING_AGENT_DIR`, default `~/.pi/agent`), so normal models/auth apply.

**Finding the runtime directory** (this skill stays self-contained — never hardcode it):
- From a tracked job: the job log's command line contains the `cd` into the runtime dir.
- From the running server: `readlink /proc/$(lsof -nP -i :8504 -sTCP:LISTEN -t | head -1)/cwd` (the server runs with cwd = runtime dir).
- Search: `find ~/Development -maxdepth 3 -name local-dev.sh -path '*pi-web*' 2>/dev/null`.

## Starting / restarting

1. Check `jobs` first — pi-web may already run as a tracked background job. Also check whether the user runs it in their zellij session (port 8504 busy but no tracked job → ask before killing).
2. Start as a tracked background job with a LONG kill deadline (it is a long-lived server):
   `cd <runtime dir> && ./local-dev.sh` with `background: true, timeout: 3600` (or more). A 300s deadline kills the server mid-work.
3. Wait for readiness: `curl -s http://127.0.0.1:8504/pi-web-plugins/manifest.json` returns 200.

## Plugin registration (package contract)

A pi package exposes plugins via `package.json`:

```json
"piWeb": { "plugins": [ { "id": "myplugin", "browserRoot": "pi-web", "module": "pi-web/browser.js", "serverModule": "pi-web/server.js" } ] }
```

- `id`: lowercase hyphenated, not a reserved id; browser+server modules force `machineSpecific: true`.
- The package must be listed in the pi agent settings (`settings.json` → `packages` in the pi agent directory); pi-web discovers plugins only through pi's configured packages (for this repo: the extension's own directory, e.g. the ralph-loop extension).
- `browserRoot` must contain `module`; paths are validated (no `..`, no node_modules).

## The stale-revision trap (read before debugging "plugin disappeared")

pi-web hashes the WHOLE plugin package (minus .git/node_modules) into a revision. The sessiond records the revision when it activates the server plugin at startup; the server recomputes the desired revision from disk on every manifest request. The lifecycle reconciler (`dist/server/piWebPluginLifecycle.js`) publishes a browser plugin to the manifest ONLY when the server record is `active` AND desired revision == active revision AND health is not unhealthy.

Consequence: **any edit to any file in the plugin package** (browser.js, server.js, even a comment) makes the revision stale and pi-web SILENTLY drops the browser plugin from the manifest — the server backend keeps working, which is misleading. No error is logged.

- Diagnose: `curl -s http://127.0.0.1:8504/api/plugins` → look at the plugin's `server` block: `state`, `staleRevision`, `restartRequired`, `health`.
- Fix: restart pi-web (sessiond re-records the current revision). A browser page reload alone is NOT enough.
- Verify after restart: manifest lists the plugin (`/pi-web-plugins/manifest.json`) and `/api/plugins` shows `staleRevision: false`.

Other failure modes:
- Safe-start blocklist (a plugin that threw during activate): `pi-web plugins safe-start show` (pi-web CLI; config under the user's pi-web config dir, default `~/.config/pi-web/config.json`, or `PI_WEB_DATA_DIR`).
- Discovery errors (bad paths, bad metadata) are reported as diagnostics in `/api/plugins` → `diagnostics` and as `Skipping PI WEB plugin ...` warnings in the sessiond log.

## Testing the UI in the browser

- The app is deeply nested in shadow DOM. Walk recursively from `document` into every `el.shadowRoot`. Top element: `pi-web-app`; inside its shadow root: `workspace-panel`; inside THAT shadow root: `button.icon-tab` elements (one per plugin, `title` = plugin name, e.g. "Ralph"). The plugin panel element (e.g. `pi-web-ralph-panel`) appears after clicking its icon-tab.
- Button labels may use fullwidth characters (e.g. "＋ Add task") — match with `.includes`, not `===`.
- Give the app up to 60s to boot after a reload (body holds only `<pi-web-app>` while loading).
- The user may co-test in the same tab and click around: re-screenshot before acting; the active tab/session can change under you.
- Use reversible mutations for testing (add a "ZZZ TEST - safe to delete" entry, verify, delete it).
- Server-side operations can be tested directly against the plugin backend routes: `POST /api/plugin-backends/<id>/projects/<projectId>/workspaces/<workspaceId>/<op>` (see the job log for the exact shape), or with a standalone script hitting the same store the server uses.

## Quality bar for plugin code

- `node --check` on browser.js and server.js (plain JS, no build step).
- Extension unit tests: `bun test .` in the extension directory.
- After any plugin change: restart pi-web, verify manifest + `/api/plugins`, then live-test the affected UI flow.

## Ralph panel: state auto-creation (TUI parity, do not redesign)

Like the TUI's /ralph home view (openHome creates an empty backlog at the session ralph file when none exists), the panel auto-creates ralph state: when `status` rejects with "no ralph state for session <id>" (the backend proxy wraps provider errors, so match with `.includes`, not startsWith), the panel calls the `init` op, which does `Backlog.empty().save(<agentDir>/ralph/<sessionId>.db)` if missing (idempotent) and returns the snapshot; `status` then returns `{session: {sessionId, state: null, todoPath}, config, sources}` and the panel renders the home view (Loop card "not started" + Start controls, empty Backlog, Goal, Config). Consequence: the server probe claims a project whenever a config store dirs entry exists OR the project's session directory exists (pi creates it at session start, even for a 0-message session whose .jsonl is not flushed yet) — NOT only when ralph state exists. The ralph provider is primary tier; the bundled Git provider is fallback, so claiming never conflicts, and ralph's list() mirrors the git worktree listing anyway. A session with a .db but no loop state has `state: null` — the loop card must handle that.

## Ralph panel: start/stop design (do not redesign)

Starting/stopping the Ralph loop is an AGENT action: `startLoop()` in the extension's index.ts needs a live pi session (`ExtensionCommandContext`). The pi-web server entry runs in the session daemon, NOT inside a live agent, and the pi-web plugin API exposes NO submit-prompt method (sendPrompt/sessions.send are app-internal). The working solution: the ▶ Start / ▶ Start goal / ■ Stop buttons call `context.prompt.insertText(cmd)`, which inserts the exact command AND auto-focuses the prompt editor; the user presses Enter to run it in the live session (same as typing it in the terminal). Commands: `/ralph start`, `/ralph start --category <name>` (quoted if it contains spaces/quotes), `/ralph start --goal`, `/ralph stop`. A notice line confirms "Staged in the prompt — press Enter to run". This is the intended, robust design — do NOT try to auto-submit via a synthetic Enter (fragile, not exposed by the API). After live-testing the Stop/Start buttons, CLEAR the staged prompt text (select-all + delete in the CodeMirror `.cm-content`) so it can't be accidentally submitted.

## Ralph panel: architecture

The web panel mirrors the `/ralph` TUI. The task list is scoped by a selected list (category) or "(all)"; display numbers are the 1-based index within the displayed (filtered) list, matching the TUI's scoping — they are NOT stable task ids (verify server-side effects via the `tasks.position` column in the ralph .db, not the displayed numbers). Mutations pass the view scope as `category` (undefined for "all"); the server resolves the task's position number within that scope (`taskNumbers(scope)`) for move/log ops. There is NO list-delete op (TUI or panel) — an explicitly created empty list (`M list` meta entry) persists as a 0/0 chip. The old "TUI text (formatBacklog)" debug section was removed per user request (they want a real TUI-equivalent, not a raw-text dump); the server still returns a `rendered` field (harmless, unused by the browser).

## Ralph panel: compact loop status in the chat (do not redesign)

The compact loop status shows as a small injected line directly BELOW the prompt editor, in EVERY view (user: "it should always be there, also when on the ralph panel"). pi-web has NO chat-area plugin hook (the registry has exactly five contribution types: actions, workspacePanels, workspaceLabels, themes, themePairs; the in-chat `status-bar` token meter is app-internal), so browser.js injects a `<div class="ralph-chat-status-strip">` into `pi-web-app`'s shadow root, between `prompt-editor` and `status-bar`. Key facts: the app reuses ONE `<main>` and swaps its class between `chat-view` and `workspace-view`, and the prompt editor exists in all views — so the injector just looks for `main prompt-editor` (no class filtering); a childList MutationObserver on the app shadow root plus a 10s tick keep the strip attached across re-renders/view swaps.

The text is the TUI's status line with ONE deliberate difference: the TUI's task counter ("task: X/Y (iteration K)") is OMITTED — the next-open-task position is not a reliable indicator of which task the agent is working on, so the web does not show it (user request). `tuiStatusText` in pi-web/status-text.js mirrors index.ts `updateStatus` and is unit-tested against the TUI's own strings: running → e.g. `Ralph (auto): on (compaction) · cycle: budget · iteration 11/50 · category: General · context: 28% / 70%`; state words blocked→`waiting`, paused→`paused`, cycleCheckpointing→`recording`/`checkpointing`/`finishing`, stopRequested→`stopping`, cycleQueued→`starting`, else `on`; idle + autoMode on → `Ralph: auto · cycle: … · context: …`, else `Ralph: off`. The earlier task-title text, the "ralph: " prefix, and the 48-char truncation are GONE (the full line is in the tooltip). The strip's font is 12px — the same as the app's status-bar token meter (the user asked for parity). The SAME status line is shown in the panel's Loop card (top section, a `.status-line` box) — the panel's old Mode/Iteration/Category/Task/Context-threshold rows were removed as redundant; the card keeps the badges, the Start/Stop controls, and only the Decision (when blocked) + Backlog-file rows. The strip WRAPS to multiple lines when it does not fit the width: `renderStrip` splits the text on ' · ' and renders each segment as a `white-space:nowrap` span in a `white-space:normal` container, so segments stay intact and the strip grows — the TUI's wrapStatusSegments behavior (do NOT revert to single-line ellipsis truncation).

Data: the strip polls the backend proxy ITSELF every 10s (the panel may be closed): project/workspace/session come from the app URL query params; the revision from GET /api/plugins (ralph server activeRevision); the loop data is the `summary` op, which returns `{state, config, goalState?}` — `state` is the persisted loop state plus the derived `baselinePhase` (the TUI's baselineGoalPhase, computed server-side from state.baseline), `config` the resolved ralph config (null when none), `goalState` the backlog goal's status. (The TUI's task counter is deliberately NOT computed — see above.) The context percentage and the active model come from pi-web's own API, the same data the TUI reads via ctx.getContextUsage()/ctx.model: `GET /api/machines/local/sessions/<sid>/status?cwd=<workspacePath>` → `contextUsage.percent` (percentage points) + `model {provider,id}`; the strip resolves the workspace path from `GET /api/projects/<pid>/workspaces` (id → path, cached per project), while the PANEL uses `context.workspace.path` directly (no extra fetch) and falls back to the session file's last `model_change` for the model key. Unknown context renders the TUI's `calculating…` form. The strip hides when the summary op fails (no ralph state / not owned).

Gotcha: the backend proxy rejects op results containing `undefined` values ("result must contain only JSON values") — the summary op omits optional fields instead. Gotcha 2: the strip needs `flex:none` inline — the message list is a shrinkable flex item with a huge content height, so a default shrinkable strip absorbs the flex shrink and collapses to ~0px (invisible) once the conversation is long enough to overflow the viewport.
