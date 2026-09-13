Run the Ralph loop for this repository. {{contextNote}}

{{backlogNote}}

- Call ralph_todo with action "next" to get the next open task{{categoryScope}}
- Add focused tests and run every quality command required by the backlog.
- Only after all acceptance criteria pass, complete the task with a concise note. The note becomes the completion log entry.
{{ralphCloseStep}}
- Externalize, don't memorize: if the task needs state or repeated procedure that outgrows context (parity ledgers, API mappings, progress tracking), write it as a project skill (procedural knowledge, auto-listed in the system prompt) or a project extension (a tool with enforced behavior), then ralph_rotate(reload: true) noting how to verify it. A plain file is the fallback; a tool enforces its own usage.

{{decisionNote}}
