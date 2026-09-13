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
- Approval record (task 16, 2026-09-13): the user approved the minified
  `prompts/iteration-goal-execution.md` via the ralph_request_decision pause,
  with a further user refinement over the proposal (even shorter). Final
  steps: (1) "Call ralph_todo with action \"next\" to get the next open
  task{{categoryScope}}" (renumbered 1, 2, 3 per the user: "My bad: 1,2,3").
  (2) "Add focused tests and run every quality command required by the
  backlog." (3) "Only after all acceptance criteria pass, complete the task
  with a concise note. The note becomes the completion log entry."
  Intro: "add or adjust tasks to the plan's list" (per the proposal). Dropped
  vs the original: steps 2 ("Do not work on a later task") and 3 ("implement
  exactly one coherent vertical slice") → the `categoryGuard` var is removed
  from the renderPrompt call in index.ts; the "wider backlog" clause and
  "its number, body, and checkpoint" from step 1; the note-content list and
  the restated "Do not edit {{todoPath}} directly" guard from step 5 → the
  `todoPath` var is also removed from the renderPrompt call. Kept
  "completion log" (tests assert it). Approver: the user.
  Rationale: trust-the-model minify style per the task-13 feedback, pushed
  further by the user.
  Evidence: the user's replies in this session's decision pauses.
- Approval record (task 17, 2026-09-13): the user approved the minified
  `prompts/iteration-ralph.md` via the ralph_request_decision pause, with one
  refinement over the proposal: use bullet items ('-') instead of numbered
  steps. Final steps (bullets): (1) "Call ralph_todo with action \"next\" to
  get the next open task{{categoryScope}}" (2) "Add focused tests and run
  every quality command required by the backlog." (3) "Only after all
  acceptance criteria pass, complete the task with a concise note. The note
  becomes the completion log entry." Dropped vs the original: "its number,
  body, and checkpoint" + the wider-backlog clause from step 1; step 2 ("Do
  not work on a later task") → the `categoryGuard` var is removed from the
  renderPrompt call; step 3 ("one coherent vertical slice"); from step 5 the
  ralph_todo action mechanics, the note-content list, "— the single
  completion record — so do not call action 'log' separately", and the
  restated "Do not edit {{todoPath}} directly" guard (already in the backlog
  note) → the `todoPath` var is also removed from the renderPrompt call.
  Kept: "Run the Ralph loop for this repository" (index.test.ts, e2e) and
  "completion log" (tests assert it). Code: `ralphCloseStep = closeStep('-',
  …)` (bullet) for iteration-ralph; iteration-goal-execution keeps its
  user-chosen numbers and gets its own `closeStep('4', …)` (fixing the 6→4
  inconsistency from task 16); iteration-markdown keeps `closeStep('6', …)`.
  Approver: the user.
  Rationale: trust-the-model minify style per the task-13 feedback, plus the
  user's bullet refinement.
  Evidence: the user's reply in this session's decision pause ("Approve, but
  just use bullet items ('-') instead of numbers"); bun test and the commit
  "ralph: minify iteration-ralph prompt (user-approved)".
- Decision record (task 18, 2026-09-13): instead of minifying
  `prompts/iteration-markdown.md`, the user decided to remove the unused
  markdown prompt path entirely ("Remove this path if it is not used
  anymore"). Scope: delete `prompts/iteration-markdown.md` and
  `prompts/context-checkpoint-markdown.md`; remove the `!isRalphBacklog`
  fallbacks in `iterationPromptBody` and `contextCheckpointPromptBody`
  (replaced by a defensive throw for legacy restored sessions that could
  still carry a non-ralph baseline) and the `markdownCloseStep` variable;
  re-point the two `prompt-template.test.ts` tests that used these
  templates to `iteration-ralph`.
  Rationale: loops only start on ralph-format backlogs (start refuses
  otherwise, commit ff56722), so both fallbacks are dead code; the
  iteration-markdown template also carried a latent placeholder/variable
  mismatch bug from task 17 ({{ralphCloseStep}} vs markdownCloseStep).
  Evidence: the user's reply in this session's decision pause;
  `git log -S "Ralph loops run on ralph-format backlogs only"`.
  Approver: the user.
- Approval record (task 19, 2026-09-13): the user approved the minified
  `prompts/iteration-auto.md` (~1792 → ~760 bytes) via the
  ralph_request_decision pause, with user refinements over the proposal:
  (1) the first sentence of the backlog paragraph becomes "Read the
  backlog." ("ralph format is old") — the "(ralph format) is read and
  updated only through the ralph_todo tool — never … (no file tools, no
  grep/cat/sed)" wording is dropped, but the category sentence ("The
  backlog may contain several categories and the loop works through all of
  them; new todos you record go to your category \"{{category}}\".") is
  KEPT ("Do add info about categories"); (2) the last bullet is only "Keep
  the project's knowledge current." (DEBUG.md details dropped); (3) the
  final "When this iteration reaches its context budget …" paragraph is
  removed ("we will tell this at the end of an iteration" — it is the
  finish-up prompt's job). Final bullets: next / focused tests + quality
  commands / complete with a concise note ("completion log entry") / commit
  locally, do not push / {{closeStep}} / no-open-tasks / knowledge current.
  Code: auto `closeStep` prefix "5." → "-" (both variants), "go back to
  step 1" → "go back to the first step". Tests: the
  'only through the ralph_todo tool' assertion (index.test.ts) is updated to
  'Read the backlog.'; the 'your category "…"' assertions stay valid. Kept
  (test-asserted): 'Run the Ralph auto loop', 'Commit the completed task
  locally', 'Do not push', 'completion log'; 'context budget' is satisfied
  by the contextNote on context-limit rotations. Approver: the user.
  Rationale: trust-the-model minify style per the task-13 feedback, plus
  the user's refinements.
  Evidence: the user's replies in this session's decision pauses.
