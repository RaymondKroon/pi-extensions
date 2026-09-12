# Ralph loop consolidation spec

Two independent changes that together collapse the "normal" (tasks/goal) and auto
loops from three parallel code paths to one loop with two orthogonal axes:

- **Axis 1 — loop mode** (`RalphState.mode`): where the backlog lives, its scope,
  and when the loop stops. `tasks` | `goal` | `auto`. (Unchanged conceptually.)
- **Axis 2 — rotation policy** (`RalphConfig.rotateOn`): when a fresh iteration
  starts. `task` | `budget`. (New; today hard-coded per mode.)

Plus the interface consolidation they enable:

- **Spec 1** — one backlog tool: merge `ralph_auto` into `ralph_todo`.
- **Spec 2** — one rotation policy: `rotateOn` config flag for all modes.

Both specs are behavior-preserving at the defaults: T/G default to
`rotateOn: "task"`, A defaults to `rotateOn: "budget"`, and tool behavior for an
active loop matches today's per-mode tools.

---

## Spec 1 — Merged backlog tool: `ralph_todo`

### 1.1 Name & activation

- Keep the name **`ralph_todo`**. `ralph_auto` is deleted.
- `RALPH_TOOL_NAMES` becomes
  `['ralph_todo', 'ralph_goal', 'ralph_request_decision', 'ralph_resolve_decision']`;
  `AUTO_TOOL_NAME` is removed.
- `syncToolActivation` collapses to: active loop (any mode) → activate the set;
  idle + `autoMode: 'on'` → pre-activate the set (cache-neutral arming, same
  rationale as today's `ralph_auto` pre-activation). One branch instead of three.
- `ralph_enable` description drops `ralph_auto`.

### 1.2 Target resolution

```
backlog param omitted  → active loop's state.todoPath, else <project>/TODO.ralph
backlog: "session"     → <agent-dir>/ralph/<session-id>.ralph   (the auto backlog)
backlog: "project"     → <project>/TODO.ralph  (explicit; = omitted unless a loop is active)
import                 → always <project>/TODO.ralph (unchanged)
```

New optional param `backlog: 'project' | 'session'`. It makes today's implicit
two-defaults (ralph_todo→project, ralph_auto→session) explicit instead of
mode-magic.

### 1.3 Scope (category)

| Mode | Scope for task-numbered actions |
|---|---|
| T / G | `state.category` (as today; `list`/`search` may override via `category`) |
| A / I | none (all lists) |

### 1.4 Action table

Modes: **T** = task loop, **G** = goal loop, **A** = auto loop, **I** = idle.
✓ = allowed, — = rejected with the named error.

| Action | Params (required) | T | G | A | I·project | I·session |
|---|---|---|---|---|---|---|
| `next` | — | ✓ scoped | ✓ scoped | ✓ skips `Goal:`/`Findings:` | ✓ | ✓ (no arm) |
| `list` | — / `task` → detail view | ✓ scoped | ✓ scoped | ✓ | ✓ | ✓ (no arm) |
| `search` | `query` | ✓ scoped | ✓ scoped | ✓ *(new for auto)* | ✓ | ✓ |
| `complete` | `task`; `note` → dated log entry | ✓ scoped, output: "Stop working now — the iteration is finished" (only under `rotateOn: "task"`, see 2.4) | ✓ scoped, same | ✓ no stop instruction | ✓ | ✓ **arms** |
| `checkpoint` | `task`, `note` | ✓ | ✓ (execution phase only; else `ralph_goal checkpoint`) | — "the auto loop records progress with add/update at the context budget" | — "requires an active loop" | — |
| `add` | `title`; `category` | ✓ category must exist | ✓ | ✓ category optional → session category, auto-created | ✓ must exist | ✓ **arms**, auto-created |
| `add-many` | `tasks[]`, `category` | ✓ | ✓ | ✓ *(D2)* | ✓ | ✓ **arms** *(D2)* |
| `new-list` | `name` | ✓ | ✓ | ✓ | ✓ | ✓ (no arm) |
| `update` | `task`, `title` and/or `body` | ✓ *(D1)* | ✓ *(D1)* | ✓ (core use case) | ✓ | ✓ **arms** |
| `log` | `task`, `note`; `date`, `kind` opt. | ✓ scoped | ✓ scoped | ✓ *(new for auto — closes the write-only log gap)* | ✓ | ✓ |
| `move` | `task`, `direction` | ✓ scoped | ✓ scoped | ✓ *(D3)* | ✓ | ✓ |
| `import` | `file` | ✓ → project | ✓ → project | ✓ → project | ✓ | — "import targets the project backlog" |
| `init` | — | no-op (exists) | no-op | no-op | ✓ bootstraps | ✓ bootstraps session file |

**Arming rule** (single, replaces the `ralph_auto` special case):
idle + `autoMode: 'on'` + target = session + action ∈ {`add`, `add-many`?,
`update`, `complete`} → `setupAutoLoop()` first (promise-cached as today), then
execute against the loop's backlog. Reads never arm. An explicit `/ralph stop`
still does not block arming (a recorded todo supersedes the stop) — unchanged.

**Category rule** (single, keyed on target, not mode):
project backlog → category must pre-exist (create via `new-list`);
session backlog → missing categories auto-created, omitted category defaults to
the loop's session category (or `autoCategoryName` when idle-arming).

### 1.5 Output-text rules

- `complete`: T/G keep the "Stop working now" suffix **only under
  `rotateOn: "task"`**; under `"budget"` and in A/I the model continues to the
  next open task.
- Arming mutations append "The Ralph auto loop was started (iteration 1)."
  (unchanged.)
- Everything else: identical to today's respective tool.

### 1.6 Unchanged

- `ralph_goal`, `ralph_request_decision`, `ralph_resolve_decision` — separate
  domains.
- `Backlog` API, `withBacklogLock`, `commitBacklog`, view functions in
  `backlog.ts`.
- State-file and config-file formats (except the new `rotateOn` field, Spec 2).

---

## Spec 2 — Rotation policy: `rotateOn`

### 2.1 Config

```jsonc
// ralph-loop.json (RalphConfig)
{
  "rotateOn": "task" | "budget"   // new; default per mode: "task" for T/G, "budget" for A
}
```

- `isRalphConfig` / `isRalphConfigPartial` / `normalizeConfig` gain the field;
  missing → per-mode default (so existing configs are untouched).
- The `/ralph config` UI gains the setting with the description:
  `"task"` — fresh iteration after every completed task (planned,
  feature-sized backlogs); `"budget"` — work task after task, fresh iteration
  only at the context budget (fine-grained rolling handoff todos).
- The value is captured into `RalphState` at loop start (like
  `contextThreshold`), so a mid-loop config edit cannot change a running loop.

### 2.2 The matrix

| | `rotateOn: "task"` | `rotateOn: "budget"` |
|---|---|---|
| **T** | today's task loop | work task-after-task; rotate at budget |
| **G** | today's goal loop | phase-change + budget (see 2.3) |
| **A** | fresh context per auto todo | today's auto loop |

### 2.3 Triggers (consolidated `agent_settled`)

```
rotateOn === 'task':
  T:  hasCompletedTodoItem(baseline, current, category)      → queueRotation('completed-task')
  G:  hasCompletedTodoItem(...) or planGrew(...)             → queueRotation('completed-task' | 'plan-updated')
  A:  hasCompletedTodoItem(...) [unscoped]                   → queueRotation('completed-task')
rotateOn === 'budget':
  G:  phaseChanged(baseline, current)  [planning→execution→re-evaluation]
                                                            → queueRotation('phase-changed')
all modes, both policies:
  contextFraction >= threshold                               → queueRotation('context-limit')
```

- **Goal stall fix (required):** under `"budget"`, goal mode must rotate on
  **phase change** — otherwise a finished plan with headroom never reaches the
  re-evaluation prompt and the loop stalls. `phaseChanged` compares
  `goalPhase(state)` derived from baseline vs current backlog.
- Stop conditions are untouched and policy-independent: T stops on empty
  backlog, G stops on goal done, A never stops on an empty backlog.

### 2.4 Prompts

- **Iteration prompt** — one body, one conditional line:
  - `rotateOn: "task"`: step 6 = "commit ... This is the last step of the
    iteration: stop working when the commit is made." (today's T/G wording)
  - `rotateOn: "budget"`: step 5 = "After committing, immediately go back to
    step 1 ... Do not stop after a completed task while open tasks remain."
    (today's auto wording)
  - Mode notes (goal block / planning / re-evaluation, auto reference-task and
    big-picture notes) are appended per mode as today.
- **Recording turns** — two, not four:
  - `'completed-task'` / `'plan-updated'` (only reachable under `"task"`):
    today's `completionRecordingPrompt` / `planRecordingPrompt`, unchanged.
  - `'context-limit'` / `'phase-changed'`: **one merged finish-up prompt** —
    today's `autoFinishPrompt` extended with the T/G duties: "ensure every task
    completed in this iteration has a completion log entry (add via `log` if
    missing)" and "commit all completed work". Today's
    `contextCheckpointPrompt` (mid-task checkpoint, no commit, no complete) is
    dropped: under the merged prompt a half-done current task is recorded as a
    todo/checkpoint entry like the auto loop already does.
  - Goal planning/re-evaluation iterations keep their dedicated
    `ralph_goal checkpoint` path (no task to checkpoint).

### 2.5 State & bookkeeping

- `RotationReason` becomes `'completed-task' | 'plan-updated' | 'phase-changed' | 'context-limit'`.
- `RalphState` gains `rotateOn: 'task' | 'budget'` (validated + normalized).
- `completedTasks`, `hasCompletedTodoItem`, `planGrew`, `completedTaskNumbers`
  stay (used under `"task"`, and `hasCompletedTodoItem` additionally for A).
- Status words: "recording" / "checkpointing" / "finishing" map off
  `rotationReason` as today; no new words needed.
- `maxIterations` semantics under `"budget"`: counts budget crossings, not
  tasks — documented in the config description (the cap weakens; that is the
  point of the policy).

### 2.6 Trade-off on record

`rotateOn: "task"` is the quality preset (per-task context isolation,
guaranteed per-task commit, `maxIterations` ≈ task count). `"budget"` is the
throughput preset (fewer rotations, less per-request overhead growth control,
assumptions persist until the budget crossing). The auto loop's fine-grained
handoff todos are the canonical `"budget"` workload; a planned feature backlog
is the canonical `"task"` workload. Nothing is removed — both doors stay open.

---

## Cross-cutting changes

### Prompts & docs renamed (`ralph_auto` → `ralph_todo`)

- Auto iteration prompt, merged finish-up prompt, `resumePrompt`, tool
  descriptions, `ralph_enable` description: ~15 sites.
- `docs/ralph-backlog.md`: merge the "ralph_auto actions" section into the
  ralph_todo section; document `backlog` param and `rotateOn`.

### Tests

- `index.test.ts` / `index.e2e.test.ts`: `ralph_auto` tests retarget to
  `ralph_todo` (+ `backlog: "session"` where the session file was the target).
- New cases: D1–D5 below; arming via the merged tool; A under `rotateOn: "task"`
  (per-todo rotation + light recording turn); G under `"budget"` (phase-change
  rotation, no stall); T under `"budget"` (multi-task iteration, stop-on-empty
  still at settle); `rotateOn` captured at loop start (mid-loop config edit
  ignored).

### Migration

- No state-file migration beyond `normalizeState` filling `rotateOn` from the
  per-mode default for old sessions.
- No migration of existing `<session-id>.ralph` files or project backlogs.
- Existing `ralph-loop.json` configs without `rotateOn` keep today's behavior.

## Open decisions

- **D1 — `update` in T/G?** Allow rewriting planned tasks' title/body (the goal
  prompt already says "add or adjust tasks"). *Recommend: allow.*
- **D2 — `add-many` in A?** Useful for the finish-up turn's multi-todo
  recording. *Recommend: allow* and offer it in the finish-up prompt.
- **D3 — `move` in A?** Harmless; keeps the table uniform. *Recommend: allow.*
- **D4 — `next` reference-task skipping** (`Goal:`/`Findings:`): A-only, or
  universal? *Recommend: A-only* — the convention is created by the auto
  prompts; project backlogs may legitimately contain such titles.
- **D5 — idle default target:** merged default is the project backlog; the
  session file stays reachable via `backlog: "session"`. Today's ralph_auto
  idle reads of the session file change. *Recommend: accept.*
