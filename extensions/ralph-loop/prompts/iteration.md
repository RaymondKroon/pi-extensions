---
description: |
  Iteration prompt body (after the automated prefix) for all five iteration
  modes: auto, ralph, goal planning / execution / re-evaluation. Branches on
  isAuto, then isGoal, then phase.
example_input: |
  {
    "loopWord": "loop",
    "isAuto": false,
    "isGoal": false,
    "phase": "",
    "contextNote": "This is the first iteration of the Ralph loop in this session. Start with a clean review of the repository.",
    "category": "",
    "backlogNote": "The backlog is accessible with the ralph_todo tool.",
    "goalBlock": "",
    "categoryScope": "",
    "closeStep": "- Commit the completed task locally in a single commit. Do not push. After committing, immediately go back to the first step and start the next open task. …",
    "decisionNote": "If work is blocked or needs a product, security, legal, … decision, call the ralph_request_decision tool with one precise question. It pauses Ralph in this session …"
  }
---
Run the Ralph {{loopWord}} for this repository. {{contextNote}}

{{#if isAuto~}}
Read the backlog. The backlog may contain several categories and the loop works through all of them; new todos you record go to your category "{{category}}".

- Call ralph_todo with action "next" to get the next open work task.
- Add focused tests and run every quality command required by the backlog.
- Only after all acceptance criteria pass, complete the task with a concise note. The note becomes the completion log entry.
- Commit the completed task locally in a single commit. Do not push.
{{closeStep}}
- If there are no open tasks, do the work the user asked for in chat (if any); do not invent backlog work.
- Keep the project's durable knowledge current (project documentation, project skills).
- Externalize, don't memorize: if the task needs state or repeated procedure that outgrows context (parity ledgers, API mappings, progress tracking), write it as a project skill (procedural knowledge, auto-listed in the system prompt) or a project extension (a tool with enforced behavior), and include it in the commit. Then ralph_cycle(reload: true) noting how to verify it. A plain file is the fallback; a tool enforces its own usage.

{{decisionNote}}
{{~else if isGoal~}}
{{backlogNote}}

{{goalBlock}}

{{#if (eq phase "planning")~}}
This is a planning iteration: the goal is open and the backlog has no tasks yet.

1. Decompose the goal into small, ordered tasks covering every acceptance criterion — each task small enough to complete and verify in a single iteration, ordered so dependencies come first.
2. Record the plan as a new list with ralph_todo, named after the goal (a short name derived from the goal body).
3. Do not implement the goal in this iteration: the plan is the deliverable.
4. Report the plan's list name and task count.

{{decisionNote}}
{{~else if (eq phase "re-evaluation")~}}
This is a re-evaluation iteration: the goal is open and every planned task is complete.

1. Verify every acceptance criterion of the goal against the repository, running every verification command required by the goal and the backlog.
2. If any criterion is not met, add tasks for the missing work to the plan's list and stop after recording them.
3. If every criterion is met and verified, complete the goal with ralph_goal, with the verification evidence (the commands run and their results) as the note.

{{decisionNote}}
{{~else~}}
You are executing the goal: keep the plan honest — when reality diverges from the plan, add or adjust tasks to the plan's list so the backlog always reflects the remaining work.

- Call ralph_todo with action "next" to get the next open task{{categoryScope}}
- Add focused tests and run every quality command required by the backlog.
- Only after all acceptance criteria pass, complete the task with a concise note. The note becomes the completion log entry.
- When every task in the plan is complete, stop — the loop runs a re-evaluation iteration next.
- Keep the project's durable knowledge current (project documentation, project skills).
- Externalize, don't memorize: if the task needs state or repeated procedure that outgrows context (parity ledgers, API mappings, progress tracking), write it as a project skill (procedural knowledge, auto-listed in the system prompt) or a project extension (a tool with enforced behavior), and include it in the commit. Then ralph_cycle(reload: true) noting how to verify it. A plain file is the fallback; a tool enforces its own usage.
{{closeStep}}

{{decisionNote}}
{{~/if~}}
{{~else~}}
{{backlogNote}}

- Call ralph_todo with action "next" to get the next open task{{categoryScope}}
- Add focused tests and run every quality command required by the backlog.
- Only after all acceptance criteria pass, complete the task with a concise note. The note becomes the completion log entry.
{{closeStep}}
- If there are no open tasks, do the work the user asked for in chat (if any); do not invent backlog work.
- Keep the project's durable knowledge current (project documentation, project skills).
- Externalize, don't memorize: if the task needs state or repeated procedure that outgrows context (parity ledgers, API mappings, progress tracking), write it as a project skill (procedural knowledge, auto-listed in the system prompt) or a project extension (a tool with enforced behavior), and include it in the commit. Then ralph_cycle(reload: true) noting how to verify it. A plain file is the fallback; a tool enforces its own usage.

{{decisionNote}}
{{~/if}}
