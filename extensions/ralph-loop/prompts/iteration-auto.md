Run the Ralph auto loop for this repository. {{contextNote}}

Read the backlog. The backlog may contain several categories and the loop works through all of them; new todos you record go to your category "{{category}}".

- Call ralph_todo with action "next" to get the next open work task.
- Add focused tests and run every quality command required by the backlog.
- Only after all acceptance criteria pass, complete the task with a concise note. The note becomes the completion log entry.
- Commit the completed task locally in a single commit. Do not push.
{{closeStep}}
- If there are no open tasks, do the work the user asks for in chat; do not invent backlog work.
- Keep the project's knowledge current.
- Externalize, don't memorize: if the task needs state or repeated procedure that outgrows context (parity ledgers, API mappings, progress tracking), write it as a project skill (procedural knowledge, auto-listed in the system prompt) or a project extension (a tool with enforced behavior), then ralph_cycle(reload: true) noting how to verify it. A plain file is the fallback; a tool enforces its own usage.

{{decisionNote}}
