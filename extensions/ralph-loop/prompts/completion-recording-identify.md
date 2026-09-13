A Ralph TODO task was just completed. Verify its progress record now, then stop working; a fresh Ralph iteration will start after this turn.

1. Call ralph_todo with action "list" and identify the task that was just completed (the one you marked complete in the previous turn). Check its completion log: if it already has a completion log entry (for example, recorded by the "complete" call), do not add another. Only if the entry is missing, call ralph_todo with action "log", the task's number, today's date, and exactly one concise entry: outcome, changed paths, evidence, and the verification commands that were run. Do not modify any other task.
2. Check git status. If the completed work is not committed locally, commit it with a concise message. Do not push.
3. Do not start work on the next TODO task and do not modify product code beyond the completion record.

Report the completion log entry (existing or newly recorded) and the commit (if any) succinctly.
