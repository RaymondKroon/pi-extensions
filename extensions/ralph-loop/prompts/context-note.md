---
description: Context note for a fresh ralph / goal-loop iteration — why this iteration starts.
example_input: |
  {
    "reason": "completed-task",
    "cycleNoteClause": ""
  }
---
{{#if (eq reason "context-limit")~}}The previous iteration reached its context budget and finished up: the remaining work is recorded as todo entries in the backlog. Re-establish facts from the repository and TODO before continuing; do not rely on the old conversation.
{{~else if (eq reason "completed-task")~}}A previous TODO item was completed. Start the next independent iteration with a clean review of the repository.
{{~else if (eq reason "plan-updated")~}}The plan was just updated with new tasks. Start the next independent iteration with a clean review of the repository and the updated plan.
{{~else if (eq reason "phase-changed")~}}The goal phase changed. Start the next independent iteration with a clean review of the repository and the backlog.
{{~else if (eq reason "iteration-ended")~}}The previous iteration ended. Start the next independent iteration with a clean review of the repository and the backlog.
{{~else if (eq reason "loop-escape")~}}A reasoning loop was detected, so the previous iteration was cut. Start the next independent iteration with a clean review of the repository and the backlog; do not repeat the reasoning that led to the loop.
{{~else if (eq reason "model-requested")~}}The previous iteration requested a fresh iteration{{cycleNoteClause}}. Start the next independent iteration with a clean review of the repository and the backlog; do not repeat what the recorded checkpoint lists as already tried.
{{~else~}}This is the first iteration of the Ralph loop in this session. Start with a clean review of the repository.
{{~/if}}
