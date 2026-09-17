Run the Ralph goal loop for this repository. {{contextNote}}

{{backlogNote}}

{{goalBlock}}

You are executing the goal: keep the plan honest — when reality diverges from the plan, add or adjust tasks to the plan's list so the backlog always reflects the remaining work.

- Call ralph_todo with action "next" to get the next open task{{categoryScope}}
- Add focused tests and run every quality command required by the backlog.
- Only after all acceptance criteria pass, complete the task with a concise note. The note becomes the completion log entry.
- Externalize, don't memorize: if the task needs state or repeated procedure that outgrows context (parity ledgers, API mappings, progress tracking), write it as a project skill (procedural knowledge, auto-listed in the system prompt) or a project extension (a tool with enforced behavior) and include it in the commit, then ralph_cycle(reload: true) noting how to verify it. A plain file is the fallback; a tool enforces its own usage.
{{goalCloseStep}}

{{decisionNote}}
