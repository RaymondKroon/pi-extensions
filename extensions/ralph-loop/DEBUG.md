# Debug findings

Durable findings from Ralph loop iterations: root causes, failed approaches,
environment quirks. Organized by topic.

## Backlog / completion identification

- Completion timestamps (`D <id> <completedAt>`) are **second-granular**
  (`YYYY-MM-DDTHH:MM:SSZ`), while wall-clock references (e.g. the iteration
  baseline) are millisecond-granular. Comparing them directly with `>=`/`>`
  misclassifies a completion in the *same second* as the reference:
  - `floor(completedAt) < baselineMs` even though the completion happened
    after the baseline → false negative (observed: unit + e2e tests failed
    when loop start and completion landed in the same second).
  - A task completed just *before* the baseline in the same second looks
    fresh → false positive.
  - Rule that works: a strictly later *second* proves "this iteration", a
    strictly earlier *second* proves "earlier", and a same-second timestamp is
    ambiguous — fall back to the baseline snapshot diff.
- Task ids in the ralph format are the numbers written in the file
  (`T <id>`), not stable rowids across hand rewrites: if the model rewrites
  the file with renumbered ids, an id-diff against the baseline snapshot
  names the wrong task (or none). Completion timestamps are the robust
  identification signal; the id-diff only covers hand-written `D <id>`
  records without a timestamp.
- The completed-task rotation is gated on the *completed count* increasing
  since the baseline (`hasCompletedTodoItem`). Deleting a pre-existing
  completed task while completing one new one keeps the count equal → no
  rotation. Keep this in mind when constructing test scenarios.

## Process
- The minify-prompts workflow requires user approval: present the new prompt
  (before / after / where used) and STOP — do not complete the task or commit
  until the user approves in chat. Task 10 was completed without that pause
  (user feedback 2026-09-13); tasks 11–19 must present-then-wait.
- Minify style per user feedback (2026-09-13, task 13): trust the model even
  more aggressively than the first proposals did —
  - No iteration counter ("This is iteration N of M") in finish-up.md.
  - Committing completed work and completion log entries belong to task
    completion (the iteration prompt + ralph_todo "complete"), not to the
    finish-up prompt — do not restate them there.
  - finish-up-findings.md is literally just: "Log what a fresh iteration
    would otherwise rediscover from scratch."
  - Apply the same restraint to the remaining minify tasks (14–19): drop
    anything already established elsewhere or obvious to the model.
- Approval record (task 14, 2026-09-13): the user approved the minified
  `prompts/iteration-goal-planning.md` (drop the ralph_todo action mechanics
  from step 2 — they live in the tool description — and the restated
  "do not edit the todo file" guard from step 3 — it lives in the backlog
  note) via the ralph_request_decision pause. Approver: the user.
  Rationale: trust-the-model minify style per the task-13 feedback.
  Evidence: `bun test` 411 pass / 0 fail; commit "ralph: minify
  iteration-goal-planning prompt (user-approved)".
- Approval record (task 15, 2026-09-13): the user approved the minified
  `prompts/iteration-goal-re-evaluation.md` via the ralph_request_decision
  pause, with one refinement over the proposal: step 3 is exactly
  "complete the goal with ralph_goal." (no ", with the evidence"). Final
  steps: (1) "Verify every acceptance criterion of the goal against the
  repository, running every verification command required by the goal and
  the backlog." (2) "If any criterion is not met, add tasks for the missing
  work to the plan's list and stop after recording them." (3) "If every
  criterion is met and verified, complete the goal with ralph_goal."
  Dropped: ralph_todo/ralph_goal action mechanics (documented in the tool
  descriptions) and the restated "Do not edit {{todoPath}} directly" guard
  (already in the backlog note) → the `todoPath` var is removed from the
  renderPrompt call in index.ts. Approver: the user.
  Rationale: trust-the-model minify style per the task-13 feedback.
  Evidence: the user's reply in this session's decision pause.
