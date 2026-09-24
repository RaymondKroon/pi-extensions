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
The current Ralph {{#if isGoal}}goal {{/if}}iteration has reached its context budget. Record a checkpoint now, then stop working; a fresh iteration continues from it.

{{#if isGoal}}Checkpoint the current task (if any) with a concise note: evidence so far, changed paths, known risks, approaches already tried (and why they failed), and the single exact next step.

Do not change the goal's state, do not claim unverified work, do not modify product code, and do not commit.
{{else}}Checkpoint the currently selected open task with a concise note: evidence so far, changed paths, known risks, approaches already tried (and why they failed), and the single exact next step. Do not log a completion: the task is not complete.

Do not mark the task complete, do not claim unverified work, do not modify product code, and do not commit.
{{/if}}

Report the checkpoint succinctly.
