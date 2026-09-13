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
