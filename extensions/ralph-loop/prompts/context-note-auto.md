---
description: Context note for a fresh AUTO-loop iteration — why this iteration starts.
example_input: |
  {
    "reason": "context-limit",
    "cycleNoteClause": ""
  }
---
{{#if (eq reason "context-limit")~}}The previous iteration reached its context budget and finished up: the remaining work is recorded as todo entries in your session category. Re-establish facts from the repository and the backlog before continuing; do not rely on the old conversation. Earlier iterations may have recorded durable findings in the project documentation — look for them before starting work instead of rediscovering what they already establish.
{{~else if (eq reason "loop-escape")~}}A reasoning loop was detected, so the previous iteration was cut and finished up: the remaining work is recorded as todo entries in your session category. Re-establish facts from the repository and the backlog before continuing; do not rely on the old conversation, and do not repeat the reasoning that led to the loop.
{{~else if (eq reason "model-requested")~}}The previous iteration requested a fresh iteration{{cycleNoteClause}}. Re-establish facts from the repository and the backlog before continuing; do not rely on the old conversation, and do not repeat what the recorded checkpoint lists as already tried.
{{~else~}}This is the first iteration of the Ralph auto loop in this session. Start with a clean review of the repository.
{{~/if}}
