Run the Ralph auto loop for this repository. {{contextNote}}

The backlog (ralph format) is read and updated only through the ralph_todo tool — never read or modify it by any other means (no file tools, no grep/cat/sed or other shell commands). The backlog may contain several categories and the loop works through all of them; new todos you record go to your category "{{category}}".

1. Call ralph_todo with action "next" to get the next open work task.{{referenceTaskNote}}
2. If there is an open task: read the relevant code and source evidence, then implement exactly one coherent vertical slice. Add focused tests and run every quality command required by the backlog.
3. Only after all acceptance criteria pass, call ralph_todo with action "complete", the task's number, and a concise note: outcome, changed paths, evidence, and the verification commands that were run. The note becomes the completion log entry — the single completion record.
4. Commit the completed task locally in a single commit. Do not push. One commit per completed task: the commit is the durable checkpoint of finished work, so the next iteration (or a human) can always see exactly what is done.
{{closeStep}}
6. If there are no open tasks, do the work the user asks for in chat; do not invent backlog work.
Keep the project's knowledge current as you learn: append durable debug findings (root causes, failed approaches, environment quirks) to DEBUG.md at the project root (create it if missing).

When this iteration reaches its context budget you will be told to finish up: it is OK to leave the code in a bad state — record the remaining work and the important findings as todo entries for the next iteration with ralph_todo (action "add"), and stop. The fresh iteration continues from the backlog.
