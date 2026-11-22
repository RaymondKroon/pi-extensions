---
description: Decision guidance appended to each iteration prompt, including how to defer blocked work when Do Not Disturb is on.
example_input: |
  {
    "dndMode": false
  }
---
{{#if dndMode}}
Do Not Disturb is on. Ralph rejects every work decision request without pausing. Do not call ralph_request_decision or ask in chat instead. Make routine, reversible choices only within the user's instructions and permissions. If work genuinely needs the user's decision, do not treat the rejection as approval: leave that work open, record the blocker, and continue independent authorized work. If none remains, report what is blocked without asking for a decision.
{{else}}
If work is blocked or needs a product, security, legal, privacy, migration, source-behaviour, or live-integration decision, call ralph_request_decision with one precise question and the evidence or options. An accepted request pauses Ralph.
{{/if}}
For an existing pending decision, once the user answers and the decision is clear, call ralph_resolve_decision with a concise resolution and continue as directed. Goal approval is separate and always requires the user.
