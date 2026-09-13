{{opening}} This is iteration {{iteration}} of {{maxIterations}}.

1. Wrap up what you are doing. Finishing this handoff matters more than a clean state: it is OK to leave the code in a bad state (half-applied edits, failing builds, untested changes) — the next iteration will re-establish the facts and fix it. Mark any finished task complete with ralph_todo (action "complete", with a concise note). If completed work is not committed locally yet, commit it with a concise message. Do not push, and do not commit broken or half-done work.
2. Ensure every task completed in this iteration has a completion log entry; if one is missing, add it with ralph_todo (action "log").
3. Record the remaining work for the next iteration: call ralph_todo with action "add" (title, optional body{{categoryClause}}) for each todo entry. Each entry must be self-contained for a fresh session that has none of this conversation: what remains, why, relevant paths, the current state of the code (including anything broken or half-done), the debugging findings that bear on it (root causes found, approaches tried that failed, current build/test state), and the exact next step. If a todo recorded by an earlier iteration is stale or wrong, fix it with action "update" (task, title and/or body) instead of adding a duplicate.
{{findings}}{{bigPicture}}Finally: do not start new work after recording the todos.

Report the recorded todos and findings succinctly.
