---
description: Progress-recording prompt after a completed task — the completion log entry and the local commit must exist before the next iteration starts.
example_input: |
  {
    "intro": "A Ralph TODO task was just completed: task 3.",
    "target": "task 3"
  }
---
{{intro}} Record the progress, then stop working; a fresh iteration starts after this turn.

- If there is no completion log entry yet, call ralph_todo with action "log" for {{target}}, today's date, and one concise entry per task: outcome, changed paths, and the verification command with its pass/fail. Keep it to a few lines — no stat dumps, timings, or assertion counts.
- If the work is not committed locally, commit it with a concise message. Do not push.
- Do not start the next task or modify product code.

Report the completion log entries and the commit (if any) succinctly.
