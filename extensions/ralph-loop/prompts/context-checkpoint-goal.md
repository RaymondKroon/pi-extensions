The current Ralph goal iteration has reached its configured context budget. Create a durable checkpoint now, then stop working; a fresh Ralph iteration will continue from the files. This is iteration {{iteration}} of {{maxIterations}}.

1. Call ralph_goal with action "checkpoint" and a concise note: planning or re-evaluation evidence so far, relevant changed paths, known failures or risks, and the exact next step. The tool replaces any older checkpoint: keep only the single most recent one, because an older checkpoint's state and next step are stale.
2. Keep a single exact next step in the checkpoint note.
3. Do not change the goal's state, do not claim unverified work, do not modify product code, and do not commit. Do not continue work after recording the checkpoint.

Report the checkpoint and the next step succinctly.
