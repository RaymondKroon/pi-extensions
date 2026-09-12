# DEBUG.md — durable debug findings (ralph-loop)

## 2026-07-11 — consolidation: ralph_auto → ralph_todo, merged finish-up prompt

- **Root cause of 5 stale `index.test.ts` failures after the phase 1+2
  consolidation:** the tests were retargeted to the merged tool, but three
  expectations still carried `ralph_auto`-era text: the auto `add` output is
  now the ralph_todo wording (`Added task N "…" in category "…"`), not
  `Recorded todo N`; the pre-activation test kept a leftover
  `not.toContain('ralph_todo')` line contradicting the line above it; and the
  goal finish-up test expected the exact substring `ralph_todo (action
  "complete")` while the merged prompt says `ralph_todo (action "complete",
  with a concise note)`.
- **Real bug found by the retargeted tests:** the merged `ralph_todo` computed
  its scope as `state.category` for *any* active loop, which scoped the auto
  loop to its session category. The spec (1.3) requires the auto loop to be
  **unscoped** (all lists, one global numbering). Fix: exclude
  `state.mode === 'auto'` from the scope expression in the tool's execute.
  Task numbers are per-list in the file but the tool addresses tasks by
  global position when unscoped (`Backlog.taskNumbers()` without a category).
- **Prompt text to grep for in tests:** the merged context-limit/phase-change
  recording turn says `Finish up now` (was `Create a durable checkpoint now`
  for ralph backlogs); the task-policy recording turns say `A Ralph TODO task
  was just completed` / `The Ralph plan was just updated`; the fresh
  iteration after a context-limit rotation contains `context budget` and
  `Re-establish facts from the repository`.
- **Environment:** the e2e suite (`index.e2e.test.ts`, mocked LLM endpoint)
  is fast in this environment — the full `bun test` (364+ tests, 5 files)
  finishes in ~10 s, not the 30 s+/test the backlog entry feared.
