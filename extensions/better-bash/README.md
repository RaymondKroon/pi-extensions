# better-bash

Wait discipline for pi's `bash` tool. (Formerly `require-bash-timeout.ts`.)

## What it enforces

1. **Mandatory, capped timeouts.** Every foreground `bash`/`powershell` call
   must specify a `timeout` (seconds), hard-capped at 300s. Timeout-less
   calls and over-cap calls are blocked with a reason so the model retries
   correctly.
2. **No `sleep`, no busy-wait loops.** A quote/comment/heredoc-aware parser
   extracts the command name at every command position (subshells,
   `$(…)`, backticks, wrappers, here-docs) and blocks `DISALLOWED_COMMANDS`
   (currently `sleep`) and no-op spin loops (`while :; do :; done`).
3. **Tracked background jobs.** The `bash` tool is overridden to accept
   `background: true`: the command is spawned detached (own session,
   output appended to a log file in the temp dir) and the call returns
   immediately with a **job id, pid, and log path**. The extension owns the
   spawn, so it reaps the child and knows the **exit code** — no `$!`
   parsing, no `/proc` guessing by the model. With `background: true` the
   `timeout` parameter becomes the job's kill deadline (exempt from the
   cap). Jobs survive the session ending (nohup semantics).
4. **No manual backgrounding.** Bare `&` operators, `$!`, and daemon
   launchers at command position (`nohup`, `disown`, `setsid`) are blocked
   with a reason steering the model to `background: true` —
   fire-and-forget jobs lose their pid and exit code. Not flagged: `&&`,
   the `&>` / `N>&M` redirections, and `&` inside arithmetic
   (`$((…))`, `((…))`).
5. **`wait_for` / `alarm` / `jobs` tools** for waiting on background work
   without busy-waiting:
   - `wait_for` — block (up to the cap) until a job finishes (`job: N`) or
     a shell condition exits 0 (`command`). Job waits report the exit code
     and, on failure, the last log lines.
   - `alarm` — schedule a later wake-up (timed, job-based, or
     condition-based, with `list` / `cancel` / `repeat`) so the agent can
     do other work.
   - `jobs` — list tracked jobs (status, pid, runtime, exit code, log
     path) or kill one (`kill: N`, SIGTERM to the whole process tree).

## Condition guards

Shell conditions are one-shot tests re-run every `interval` seconds. To
keep them honest, `better-bash` audits them:

- **Entry guard** — disallowed commands (`sleep`) and busy-wait loops are
  rejected before any waiting starts.
- **`pgrep -f` / `pkill -f` self-match audit** — the polling shell runs as
  `sh -c <condition>`, so its own command line contains the pattern; a naive
  `! pgrep -f "cargo test"` can therefore *never* be true. The pattern is
  tested against the polling shell's command line and blocked with an
  explanation (bracket patterns like `pgrep -f 'cargo[ ]test'` pass).
- **Multi-match audit** — a `/proc/*/cmdline` scan errors when the pattern
  matches more than one process (ambiguous boolean), listing every pid.

Prefer `job: N` for jobs started via `background: true` — it is immune to
all of the above. For processes you did not launch, recommended completion
checks are `[ ! -d /proc/$PID ]` or a marker file the job writes when done.

## Testing

```sh
bun test .
```

Covers the command-name parser, the backgrounding detector (`&`, `$!`,
arithmetic/redirect/quote/heredoc cases, fuzz), the daemon-launcher
detector, busy-wait detector (including the bare-`)` regression and a
3000-case fuzz), pgrep pattern extraction, the self-match and multi-match
audits (live decoy processes on Linux), and the condition guards.
