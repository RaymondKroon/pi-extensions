Run the Ralph loop for this repository. {{contextNote}}

{{backlogNote}}

1. Read {{specPath}} in full, then call ralph_todo with action "next" to get the next open task{{categoryScope}}: its number, body, and checkpoint. Use action "list" only when that task is blocked and you need the wider backlog to find an unblocked one.
2. Do not work on a later task{{categoryGuard}}.
3. Read the relevant code and source evidence, then implement exactly one coherent vertical slice.
4. Add focused tests and run every quality command required by SPEC.md and the backlog.
5. Only after all acceptance criteria pass, call ralph_todo with action "complete", the task's number, and a concise note: outcome, changed paths, evidence, and the verification commands that were run. The note becomes the completion log entry — the single completion record — so do not call action "log" separately. Do not edit {{todoPath}} directly.
{{ralphCloseStep}}

{{decisionNote}}
