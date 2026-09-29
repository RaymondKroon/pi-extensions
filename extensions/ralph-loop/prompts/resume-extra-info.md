---
description: Sent when a paused loop is resumed by a typed user message without a pending cycle — the text is the user's own words (no automated prefix); continue where the interrupted turn left off.
example_input: |
  {
    "extraInfo": "The API key is in .env, not the config."
  }
---
(The Ralph loop was paused; this message resumes it. Continue where the interrupted turn left off.)
{{extraInfo}}
