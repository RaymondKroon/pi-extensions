# Ralph goal loop — specification

## 1. Purpose

Extend the ralph-loop extension with a second loop mode — the **goal loop** —
for projects that start with one large goal and no task list (e.g. "rewrite
this app in a new framework"). The loop plans, executes, re-evaluates, and
only stops when the goal is verified complete and approved. The existing
**task loop** (finite backlog of small tasks) keeps working exactly as today.

Primary users: developers running long autonomous rewrites/builds with pi.
Boundary: this project changes only the ralph-loop extension in this
repository; the pi core is untouched.

## 2. Evidence and source of truth

- The current extension code in this repository: `index.ts` (loop engine,
  commands, tools), `backlog.ts` (ralph-format file format + SQLite-backed
  `Backlog` API), `todos-view.ts` / `list-picker.ts` (TUI), and their tests.
- The pi extension SDK (tools, commands, events, `ctx.ui.custom` overlays).
- Unknown behaviour of the pi TUI/SDK must be verified against
  `/home/raymond/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs`
  before relying on it.

## 3. Scope

### In scope

- A **goal** (objective + acceptance criteria) stored in a ralph-format
  backlog: `## Goal` section with title, status, body, evidence, checkpoint.
- `/ralph start --goal`: the goal loop — planning → execution →
  re-evaluation → completion.
- A `ralph_goal` tool: `show`, `checkpoint`, `complete`, `confirm`,
  `withdraw` — separate from `ralph_todo`.
- User approval gate for goal completion, reusing the existing decision
  workflow (`blockLoop` / `ralph_request_decision` pattern).
- Bare `/ralph [file]` opens a **home GUI**: pinned goal row + list rows;
  the `todos` subcommand and the standalone list picker are removed.
- Status line shows loop mode and goal state.
- `/ralph-init --goal` template (SPEC with goal + acceptance criteria,
  backlog with a goal and no tasks).

### Explicitly out of scope

- Running two loops at once (the single-active-loop invariant stays).
- Multiple goals per backlog (exactly one goal per backlog file).
- Model-initiated edits to the goal text (the goal is the user's contract;
  only the user edits it, via the GUI or the file).
- Approving goal completion from the GUI (approval happens in chat, where
  the blocked loop already talks to the user).
- Any change to task-loop behaviour, prompts, or file format for files
  without a goal.

Changing an out-of-scope item requires the user's explicit approval via the
Ralph decision workflow.

## 4. Target architecture

- **One engine, two policies.** `RalphState` gains `mode: 'tasks' | 'goal'`
  (default `'tasks'`; persisted old sessions normalize to it). All shared
  machinery — context rotation, checkpoints, pause/stop/block, abort
  detection, decisions, `maxIterations` — stays single-implemented. Only
  start validation, the done check, rotation triggers, and prompts branch on
  mode.
- **The goal lives in the backlog file** (ralph v2 format, SQLite-backed).
  File states: `open` → `claimed` → `done`, plus `claimed` → `open`
  (withdraw). `Backlog` API: `goal()`, `setGoal({title, body})`,
  `deleteGoal()`, `claimGoal(evidence)`, `confirmGoal()`,
  `withdrawGoal(note)`, `setGoalCheckpoint(note, iteration)`.
- **`ralph_goal` tool** targets the active loop's backlog, else
  `TODO.ralph`. Mutations require an active goal loop; `show` works
  anywhere. Both `ralph_todo` and `ralph_goal` share the
  parse → mutate → render → write discipline; turns are serialized, so no
  locking is needed.
- **GUI:** the popup machinery (popup box, form, confirm, input/reason,
  body editor, footer layout) is extracted from `todos-view.ts` into a
  shared view kit. A new `ralph-home.ts` (home view) is built on the kit;
  `list-picker.ts` is deleted. `TodosView` (task list) is unchanged and
  gains no goal functionality.
- TypeScript, bun runtime, `bun test`; no new dependencies.

## 5. Domain and lifecycle rules

- Goal state machine: `open` → (claim: requires **no open tasks** + evidence
  note) → `claimed` → (confirm) → `done`; `claimed` → (withdraw: note
  becomes the goal checkpoint) → `open`. Invalid transitions throw.
- **Planning vs re-evaluation** (both are "goal open, no open tasks"): zero
  tasks in the backlog = planning iteration; tasks exist but none open =
  re-evaluation iteration.
- **Rotation triggers (goal mode):** a task completed (existing
  completed-task rotation) or the plan grew (new open task ids in the
  baseline diff, no completions → `plan-updated` rotation with a
  commit-only recording turn).
- **Stall:** a goal-mode turn that ends with no plan growth, no completion,
  and the goal still open stops the loop with a clear notification.
- The loop stops when the goal is `done` in the file.
- The model is read-only on the goal title/body; it may only change goal
  state through `ralph_goal` with its enforced preconditions.
- Checkpoints: task iterations checkpoint the task (existing); task-less
  iterations (planning/re-evaluation) checkpoint the goal via
  `ralph_goal checkpoint`.

## 6. Authorization and security

- Goal completion requires **user approval** by default: `ralph_goal
  complete` claims the goal, blocks the loop with the question and evidence,
  and terminates the turn (the `ralph_request_decision` pattern). After the
  user answers, the model records the decision per the existing protocol and
  calls `ralph_resolve_decision`, then `ralph_goal confirm` (approved) or
  `ralph_goal withdraw` (rejected, with what is missing).
- With the existing `autoApproveDecisions` config enabled, `complete` goes
  straight to `done` with approver "auto-approved" (delegated approval,
  consistent with the existing decision semantics). No new config flag.
- No secrets or credentials may appear in goal evidence, checkpoints, or
  completion log entries.

## 7. User journeys and acceptance criteria

1. **New project, giant goal.** User runs `/ralph-init --goal <brief>`,
   reviews/edits the generated SPEC and goal, runs `/ralph start --goal`.
   Acceptance: the first iteration is a planning iteration that decomposes
   the goal into small ordered tasks; subsequent iterations execute tasks;
   when the plan is exhausted the loop re-evaluates the goal against the
   repository; the loop stops only after verified, approved completion.
2. **Claim and approval.** All criteria pass; the model runs full
   verification, calls `ralph_goal complete` with evidence. Acceptance: the
   loop pauses with the question and evidence; approving ends the loop with
   the goal `done` and a decision record; rejecting returns the goal to
   `open` with the rejection as the next step and the loop continues.
3. **GUI.** User runs bare `/ralph`. Acceptance: the home view shows the
   goal (status-colored, expandable) and the lists with counts; `A`
   add/edits the goal, `D` deletes it, `S` starts the goal loop, enter on a
   list opens the unchanged task view; `/ralph <file>` opens the same view
   on that file; the `todos` subcommand no longer exists.
4. **Existing task workflow.** Acceptance: `/ralph start` (task mode),
   categories, imports, pause/stop/resume, decisions, and the task prompts
   behave exactly as before; backlogs without a goal parse and render
   byte-identically to today.

## 8. Quality, accessibility, privacy, and operations

- Quality commands: `bun test` (all suites: `backlog.test.ts`,
  `index.test.ts`, `todos-view.test.ts`, `index.e2e.test.ts`).
- The view-kit extraction must cause **no snapshot drift** in the existing
  `todos-view.test.ts`.
- TUI text stays single-line-per-row where the current views do, uses the
  existing theme (dim/accent/bold), and footer key hints follow the current
  convention (uppercase = goal ops, lowercase = list/task ops).
- No network access, no new dependencies, no secrets in any recorded text.

## 9. Definition of done for every Ralph iteration

A task is complete only when it implements one coherent vertical slice, has
focused tests, passes `bun test` in full, updates the backlog completion
log with evidence (changed paths, commands, results), and contains no
unrelated changes or secrets.

## 10. Release gates

- All backlog tasks complete, including the end-to-end goal loop test.
- The existing task-loop e2e still passes (no regression).
- The user has reviewed the home GUI and the approval flow in a real
  session before the work is considered releasable.
