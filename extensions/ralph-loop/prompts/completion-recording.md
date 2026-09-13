A Ralph TODO task was just completed{{targetIntro}}. Record its progress, then stop working; a fresh iteration starts after this turn.

- If {{taskRef}} has no completion log entry yet, call ralph_todo with action "log" for {{target}}, today's date, and one concise {{entryWord}}: outcome, changed paths, evidence, verification commands.
- If the work is not committed locally, commit it with a concise message. Do not push.
- Do not start the next task or modify product code.

Report the completion log {{reportWord}} and the commit (if any) succinctly.
