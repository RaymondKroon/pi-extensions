---
description: Sent (as a follow-up) when loop-police aborts the run itself on a reasoning loop — break the loop by requesting a fresh iteration, then stop; a model that is actually making progress may dispute the detection.
example_input: |
  {
    "event": "repeated the same failing approach without progress"
  }
---
A reasoning loop was detected ({{event}}): you are repeating the same reasoning without making progress. If you are stuck, break the loop by requesting a fresh iteration: call ralph_cycle with a note describing the stuck pattern — what you are repeating, why it is not working, and what a fresh iteration should try instead — specific enough that the fresh iteration can avoid the same path, then stop working. The fresh iteration continues from the backlog with a clean context. If you are actually making progress and disagree with the detection, you may ignore this instruction: say so in one line and keep working. Progress is verified — work done after the detection is accepted, but a renewed detection while you are still not progressing forces the fresh iteration.
