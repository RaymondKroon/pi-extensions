---
description: |
  Progress-recording prompt body for a queued cycle when the iteration reaches
  its context budget: checkpoint the task (or the goal for task-less goal
  iterations), then stop — a fresh iteration continues from the checkpoint.
example_input: |
  {
    "isGoal": false
  }
---
The current Ralph {{#if isGoal}}goal {{/if}}iteration is finished. Record a checkpoint now, then stop working; a fresh iteration continues from it.

{{#if isGoal}}Checkpoint the current task (if any) with a concise note: one-line verification status (commands run, pass/fail — no stats, timings, or assertion counts), changed paths, known risks, approaches already tried (and why they failed), and the single exact next step. Keep it to a few lines: the checkpoint is re-injected into every later iteration, so it only needs to serve the next one.

Do not change the goal's state, do not claim unverified work, do not modify product code, and do not commit.
{{else}}Checkpoint the currently selected open task with a concise note: one-line verification status (commands run, pass/fail — no stats, timings, or assertion counts), changed paths, known risks, approaches already tried (and why they failed), and the single exact next step. Do not log a completion: the task is not complete. Keep it to a few lines: the checkpoint is re-injected into every later iteration, so it only needs to serve the next one.

Do not mark the task complete, do not claim unverified work, do not modify product code, and do not commit.
{{/if}}

Report the checkpoint succinctly.
