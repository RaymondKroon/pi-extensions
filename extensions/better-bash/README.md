# better-bash

Wait discipline for pi's `bash` tool. (Formerly `require-bash-timeout.ts`.)

## What it enforces

1. **Mandatory, capped timeouts.** Every `bash`/`powershell` call must specify
   a `timeout` (seconds), hard-capped at 300s. Timeout-less calls and
   over-cap calls are blocked with a reason so the model retries correctly.
2. **No `sleep`, no busy-wait loops.** A quote/comment/heredoc-aware parser
   extracts the command name at every command position (subshells,
   `$(…)`, backticks, wrappers, here-docs) and blocks `DISALLOWED_COMMANDS`
   (currently `sleep`) and no-op spin loops (`while :; do :; done`).
3. **`wait_for` / `alarm` tools** for waiting on background work without
   busy-waiting:
   - `wait_for` — block (up to the cap) until a shell condition exits 0.
   - `alarm` — schedule a later wake-up (timed or condition-based, with
     `list` / `cancel` / `repeat`) so the agent can do other work.

## Condition guards

Conditions are one-shot tests re-run every `interval` seconds. To keep them
honest, `better-bash` audits them:

- **Entry guard** — disallowed commands (`sleep`) and busy-wait loops are
  rejected before any waiting starts.
- **`pgrep -f` / `pkill -f` self-match audit** — the polling shell runs as
  `sh -c <condition>`, so its own command line contains the pattern; a naive
  `! pgrep -f "cargo test"` can therefore *never* be true. The pattern is
  tested against the polling shell's command line and blocked with an
  explanation (bracket patterns like `pgrep -f 'cargo[ ]test'` pass).
- **Multi-match audit** — a `/proc/*/cmdline` scan errors when the pattern
  matches more than one process (ambiguous boolean), listing every pid.

Recommended completion checks: `[ ! -d /proc/$PID ]` or a marker file the
job writes when done.

## Testing

```sh
bun test .
```

Covers the command-name parser, busy-wait detector (including the bare-`)`
regression and a 3000-case fuzz), pgrep pattern extraction, the self-match
and multi-match audits (live decoy processes on Linux), and the condition
guards.
