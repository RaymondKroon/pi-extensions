---
description: Sent when a paused loop is resumed by a typed user message without a pending cycle — continue from the durable state; the message is extra info.
example_input: |
  {
    "extraInfo": "The API key is in .env, not the config."
  }
---
The user resumed the interrupted loop with extra info. Continue where the interrupted turn left off:
{{extraInfo}}
