---
description: |
  Finish-up prompt body (after the automated prefix) — the progress-recording
  turn at the context budget / goal phase change / model-requested cycle /
  iteration end / loop escape.
example_input: |
  {
    "opening": "The current Ralph iteration has reached its configured context budget. Finish up now, then stop working; a fresh Ralph iteration will continue from the backlog.",
    "categoryClause": "",
    "isAuto": true
  }
---
{{opening}}

1. Wrap up: mark tasks complete with ralph_todo (action "complete", concise note) only when their acceptance criteria pass — in-progress or broken work is not complete; record it in step 3. It is OK to leave the code in a bad state — the next iteration re-establishes the facts.
2. Commit completed work that is not committed yet, with a concise message. Do not push. Never commit broken or half-done work.
3. Record the remaining work: for the in-progress task, update it with ralph_todo (action "update") so its body is self-contained about what remains; use action "add" (title, optional body{{categoryClause}}) only for genuinely new work items. A fresh session has none of this conversation, so each entry includes:
   - what remains and why
   - relevant paths
   - current code state, including anything broken
   - relevant debugging findings
   - the exact next step
   Fix stale todos from earlier iterations with action "update" instead of adding a duplicate.
{{#if isAuto}}Only if this iteration produced a durable, non-obvious finding (root cause, environment quirk, failed approach with evidence), record it in the project documentation: update the appropriate existing document, or create one if none fits. Update or replace stale entries rather than appending. If there is nothing durable, write nothing.
{{/if}}Do not start new work after recording the todos.

Report the recorded todos and findings succinctly.
