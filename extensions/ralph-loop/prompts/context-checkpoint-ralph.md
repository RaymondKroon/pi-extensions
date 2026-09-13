The current Ralph iteration has reached its configured context budget. Create a durable checkpoint now, then stop working; a fresh Ralph iteration will continue from the files. This is iteration {{iteration}} of {{maxIterations}} (iteration {{taskIteration}} for the current task).

1. Call ralph_todo with action "list" and identify the currently selected open task.
2. Call ralph_todo with action "checkpoint", the task's number, and a concise note: completed implementation/test evidence, relevant changed paths, known failures or risks, and the exact next step. The tool replaces any older checkpoint: keep only the single most recent one, because an older checkpoint's state and next step are stale. Do not record this in the completion log: the task is not complete.
3. Keep a single exact next step in the checkpoint note.
4. Do not mark the task complete, do not claim unverified work, do not modify product code, and do not commit. Do not continue implementation after recording the checkpoint.

Report the checkpoint and the next step succinctly.
