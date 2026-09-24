---
description: Opening line of the finish-up prompt — why the iteration is finishing up now.
example_input: |
  {
    "reason": "context-limit",
    "cycleNoteClause": ""
  }
---
{{#if (eq reason "phase-changed")~}}The goal phase changed. Finish up now, then stop working; a fresh Ralph iteration will continue from the backlog.
{{~else if (eq reason "model-requested")~}}You requested a fresh Ralph iteration{{cycleNoteClause}}. Finish up now, then stop working; a fresh Ralph iteration will continue from the backlog.
{{~else if (eq reason "iteration-ended")~}}The current Ralph iteration has ended. Finish up now, then stop working; a fresh Ralph iteration will continue from the backlog.
{{~else if (eq reason "loop-escape")~}}A reasoning loop was detected. Finish up now, then stop working; a fresh Ralph iteration will continue from the backlog with a clean context.
{{~else~}}The current Ralph iteration has reached its configured context budget. Finish up now, then stop working; a fresh Ralph iteration will continue from the backlog.
{{~/if}}
