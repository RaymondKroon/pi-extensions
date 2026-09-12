---
name: ralph-backlog
description: Full reference for the ralph_todo and ralph_goal actions and parameters. Read before using an action you are unsure about.
---

# Ralph backlog reference

If the `ralph_todo`/`ralph_goal` tools are not available in this session,
call `ralph_enable` first, then continue with this reference.

The ralph-format backlog is a SQLite-backed TODO file. `ralph_todo` is its only
interface: never read or modify the file by any other means (no file tools, no
grep/cat/sed). Target: with an active Ralph loop the loop's backlog;
otherwise the project's `TODO.ralph`. The optional `backlog` parameter makes
the target explicit: `"project"` for the project's `TODO.ralph`, `"session"`
for the per-session auto backlog (`<session-id>.ralph` in pi's global agent
directory). Tasks are addressed by their position number as shown by
`list`/`next` (e.g. "1", "2", …). Task-numbered actions are scoped to the
active loop's category — except the auto loop, which works through **every
list** (one global numbering, each task shows its list).

## Actions

### next
Compact view of the first open task. Prefer it over `list` when you only need
the next task. On the session backlog, reference entries (titles starting
with `Goal: ` or `Findings: `) are not work items and are skipped; when only
reference entries remain open, the result says so and lists them. Project
backlogs may legitimately carry such titles: they are not skipped there.

### list
Compact by default: counts, per-list counts, and open tasks.
- `category` — filter to one list (must exist).
- `task` — show a single task's detail (completion time, body, checkpoint,
  completion log) instead of the whole backlog.
- `verbose: true` — also include completed tasks (the 10 most recent by
  completion time, plus a counter with the number ranges of the older ones)
  and checkpoints. Completion log entries are never listed (they grow
  unbounded in long sessions); read them with `task` (single-task detail) or
  `search`.

### search
Case-insensitive substring match over task titles, bodies, checkpoints, and
completion log notes. Requires `query`; `category` optionally scopes the
match. Use it instead of grepping the backlog file.

### complete
Marks the task (number via `task`) done. With `note` it also records the
completion log entry in the same call. In an active loop under the `task`
rotation policy, stop working after this — the loop records the completion
and starts a fresh iteration. Under the `budget` policy (and in the auto
loop), continue with the next open task.

### checkpoint
Loop only. Records a checkpoint note (`note`) on the task.

### add
Adds a task (`title`, optional `body` as markdown bullets) to a list given by
`category`. Project backlog: the list must **exist** — the action never
creates a list there; use `new-list` for that. Session backlog: missing
lists are created, and an omitted `category` defaults to the loop's session
category (auto-created at loop start). `add` on the session backlog starts
the auto loop first when auto mode is "on" and no loop is active yet; each
entry should be self-contained for a fresh session: what remains, why,
relevant paths, and the exact next step.

### add-many
Adds several tasks at once via the `tasks` array (`title`, optional `body`,
optional per-task `category` that overrides the batch `category`) to the list
given by `category` (required). All-or-nothing: if any entry is invalid,
nothing is added.

### new-list
Creates a new list with `name`. Creating a list is explicit and separate from
adding a task.

### update
Changes an existing task's `title` and/or `body` (`task` number required;
`body` replaces the whole body, an empty string clears it). Use it when a
recorded task is stale or wrong instead of adding a duplicate — including
planned tasks in a task/goal loop. On the session backlog it starts the auto
loop first when auto mode is "on" and no loop is active yet.

### log
Records a completion entry for a task (requires `task`). `date` is
`YYYY-MM-DD` (defaults to today). `kind: "reopen"` (default `"done"`) marks
the entry with a cross instead of a check when re-opening a completed task.

### move
Reorders a task within the list: `direction` "up" or "down", optional `by`
(number of positions, default 1).

### import
Converts a Markdown TODO file (`file`, relative to the project) into the
ralph format, always merging into the project's `TODO.ralph` (even with an
active loop). Each source file is only imported once. Imported tasks are
stamped with `category`, which defaults to a name derived from the file name
(`TODO_EMAIL.md` → `Email`). `force: true` overwrites an existing non-ralph
`TODO.ralph` (default false).

### init
Bootstraps an empty backlog at the target path when it does not exist yet.
Idempotent; refuses to overwrite a non-ralph file.

## ralph_goal actions

`ralph_goal` manages the single goal of the same backlog (active loop's
backlog, else `TODO.ralph`). The goal is the user's contract: its title/body
are read-only; only its state changes, via this tool.

### show
Prints the goal's title, status, body, evidence, and checkpoint. Works
anywhere (no active loop needed).

### checkpoint
Goal loop only. Replaces the single goal checkpoint — the durable state of
task-less planning/re-evaluation iterations. Requires `note`.

### complete
Goal loop only. Requires the goal `open` and no open tasks. `note` is the
verification evidence. Claims the goal and pauses the loop for the user's
approval, or goes straight to `done` when auto-approve decisions is enabled.

### confirm
Goal loop only. `claimed` → `done`. Call it only after the user approved the
completion (and the decision is recorded).

### withdraw
Goal loop only. `claimed` → `open`. `note` describes what is missing and
becomes the goal checkpoint.

## Auto mode

The **auto loop** (the "Auto mode" setting in `/ralph config`: off / on) runs
through the per-session auto backlog with `ralph_todo` (`backlog:
"session"`). It stores its state in a per-session file in the `ralph`
directory of pi's global agent directory (`<session-id>.ralph`, like sessions
in its `sessions` directory) and uses one session category per session, named
after the pi session when it has a name (e.g. `Fix-login-flow`, spaces become
dashes) or `General` for unnamed sessions (a restarted loop continues the same
category). The loop works through **every list** in the file — `next`,
`list`, and `complete` are unscoped (one global task numbering, each task
shows its list) — while `add` records to the session's own list by default, so
lists you add by hand are picked up automatically. It rotates on its context
budget by default (see Rotation policy), tells the model to finish up and
record todos for the next iteration, and activates only the backlog tool (not
the full ralph tool set). The loop itself only starts via `/ralph start`.

- `off`: nothing automatic; a plain `/ralph start` runs the regular task loop.
- `on`: the auto loop arms itself when the context crosses the budget — at
  session start (e.g. a resumed long session) or mid-session — asks the model
  to record the remaining work as todos, then iterates from the backlog.
  A plain `/ralph start` also starts the auto loop. Stopping the loop
  suspends the automatic intercept for the rest of the session (an explicit
  `ralph_todo` `add`/`complete` on the session backlog still re-arms the
  loop).

The handoff is deliberately tolerant of a bad state: when an iteration reaches
its context budget, the model may leave the code broken or half-done — the
finish-up turn records the remaining work (including what is broken) as
self-contained todos for the next iteration. Auto mode commits every completed
task locally (never pushes): the backlog is the handoff, and the per-task
commit is the durable checkpoint of finished work. The finish-up turn commits
completed work that is still uncommitted, but never broken or half-done work.
`SPEC.md` is optional: the auto
loop runs in any project and creates it (along with `DEBUG.md`) when the
project is not yet documented. Every finish-up also logs the
iteration's important findings as reference entries (titles starting with
`Findings: ` — root causes, failed approaches, environment quirks, key code
locations) so the next round does not rediscover them from scratch; the loop
reads them before starting work and marks them done once read, so the backlog
does not accumulate open reference entries. From the second
iteration on, the backlog also carries big-picture tracking tasks (titles
starting with `Goal: `) that keep the larger objectives visible: the loop adds
them when missing, skips them when selecting work (`next` never returns one),
and completes one only when its objective is actually met.

Without an active auto loop, `ralph_todo` reads the session backlog unscoped
(`backlog: "session"`). `add`, `add-many`, `update`, and `complete` on the
session backlog start the auto loop first when auto mode is "on" and no loop
is active yet — including right after an explicit `/ralph stop`, because the
recorded todo is a new request that supersedes the stop (the stop only
suspends the automatic context-budget intercept).

## Rotation policy (`rotateOn`)

`/ralph config` offers `rotateOn`: when a fresh iteration starts.

- `"task"` — a fresh iteration after every completed task (planned,
  feature-sized backlogs). The quality preset: per-task context isolation, a
  guaranteed per-task commit, and `maxIterations` ≈ task count. `complete`
  tells the model to stop working; the loop records the completion and starts
  the fresh iteration.
- `"budget"` — work task after task, a fresh iteration only at the context
  budget (fine-grained rolling handoff todos). The throughput preset: fewer
  rotations, less per-request overhead growth control, assumptions persist
  until the budget crossing. `maxIterations` counts budget crossings, not
  tasks — the cap weakens; that is the point of the policy.

Defaults per mode: `"task"` for the task and goal loops, `"budget"` for the
auto loop. The value is captured into the loop state at start, so editing the
config mid-loop does not change a running loop. Stop conditions are
policy-independent: the task loop stops on an empty backlog, the goal loop
when the goal is done, the auto loop never on an empty backlog. Under
`"budget"` the goal loop additionally rotates on a **phase change**
(planning → execution → re-evaluation) so a finished plan with context
headroom still reaches the re-evaluation prompt instead of stalling.
