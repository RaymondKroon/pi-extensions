A Ralph TODO task was just completed: {{target}}. Verify its progress record now, then stop working; a fresh Ralph iteration will start after this turn.

1. Call ralph_todo with action "list" and {{numberRef}} to check the completion log. If {{taskRef}} already has a completion log entry (for example, recorded by the "complete" call), do not add another. Only if the entry is missing, call ralph_todo with action "log" for {{target}}, today's date, and exactly one concise {{entryWord}}: outcome, changed paths, evidence, and the verification commands that were run. Do not modify any other task.
2. Check git status. If the completed work is not committed locally, commit it with a concise message. Do not push.
3. Do not start work on the next TODO task and do not modify product code beyond the completion record.

Report the completion log {{reportWord}} (existing or newly recorded) and the commit (if any) succinctly.
