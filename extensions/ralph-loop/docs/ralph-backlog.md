---
name: ralph-backlog
description: Full reference for the ralph_todo and ralph_goal actions and parameters. Read before using an action you are unsure about.
---

# Ralph backlog reference

If the `ralph_todo`/`ralph_goal` tools are not available in this session,
call `ralph_enable` first, then continue with this reference.

The ralph-format backlog is a SQLite-backed TODO file. `ralph_todo` is its only
interface: never read or modify the file by any other means (no file tools, no
grep/cat/sed). With an active Ralph loop the tool targets the loop's backlog
(scoped to the loop's category); otherwise it targets the project's
`TODO.ralph`. Tasks are addressed by their position number in the list as
shown by `list`/`next` (e.g. "1", "2", …).

## Actions

### next
Compact view of the first open task. Prefer it over `list` when you only need
the next task.

### list
Compact by default: counts, per-list counts, and open tasks.
- `category` — filter to one list (must exist).
- `task` — show a single task's detail (body, checkpoint, completion log)
  instead of the whole backlog.
- `verbose: true` — also include completed tasks, checkpoints, and completion
  log entries.

### search
Case-insensitive substring match over task titles, bodies, checkpoints, and
completion log notes. Requires `query`; `category` optionally scopes the
match. Use it instead of grepping the backlog file.

### complete
Marks the task (number via `task`) done. With `note` it also records the
completion log entry in the same call. In an active loop, stop working after
this — the loop records the completion and starts a fresh iteration.

### checkpoint
Loop only. Records a checkpoint note (`note`) on the task.

### add
Adds a task (`title`, optional `body` as markdown bullets) to an **existing**
list given by `category` (required). It never creates a list; use `new-list`
for that.

### add-many
Adds several tasks at once via the `tasks` array (`title`, optional `body`,
optional per-task `category` that overrides the batch `category`) to the list
given by `category` (required). All-or-nothing: if any entry is invalid,
nothing is added.

### new-list
Creates a new list with `name`. Creating a list is explicit and separate from
adding a task.

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
