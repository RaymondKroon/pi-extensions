The current Ralph iteration has reached its configured context budget. Create a durable checkpoint now, then stop working; a fresh Ralph iteration will continue from the files. This is iteration {{iteration}} of {{maxIterations}} (iteration {{taskIteration}} for the current task).

1. Read {{todoPath}} and identify the currently selected unchecked item.
2. Update that item in {{todoPath}} with a concise, non-checkbox “Context checkpoint (iteration {{iteration}})” note. Include completed implementation/test evidence, relevant changed paths, known failures or risks, and the exact next step. Use the actual iteration number shown above in the label — never a placeholder. If the item already has a “Context checkpoint” note, replace it with this one: keep only the single most recent checkpoint, because an older checkpoint’s state and next step is stale. Do not put this in the completion log: the item is not complete.
3. Keep a single exact next step in the checkpoint note.
4. Do not mark the item complete, do not claim unverified work, do not modify product code, and do not commit. Do not continue implementation after recording the checkpoint.

Report the checkpoint path and the next step succinctly.
