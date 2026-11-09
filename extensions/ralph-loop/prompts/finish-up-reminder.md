---
description: |
  Reminder steer sent when the model keeps making work tool calls after the
  finish-up recording prompt (the finish-up watchdog).
example_input: |
  { "count": 7 }
---
Reminder: the finish-up instruction is still pending, and you have made {{count}} work tool calls since it. Stop working now — no more diagnostics, tests, or edits. Follow the finish-up instruction immediately: record the remaining work with ralph_todo, commit only work that is fully verified and complete, and end the turn with your short report. A fresh iteration will continue from the backlog — anything you do not record now is lost from the next context.
