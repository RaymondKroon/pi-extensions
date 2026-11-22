---
description: Decision guidance appended to each iteration prompt, including how to make decisions autonomously in Do Not Disturb.
example_input: |
  {
    "dndMode": false
  }
---
{{#if dndMode}}
Do Not Disturb is on. Figure it out yourself and keep working on the current task. Use the user's stated goals, the code, tests, docs, and project conventions to make the best supported decision. If the evidence is inconclusive, pick a reasonable, low-risk assumption or try a reversible experiment, then verify the result. If your first approach is unavailable, look for another way to achieve the same goal. Don't skip or postpone work just because you'd normally ask for a decision. Do not call ralph_request_decision or ask in chat; new requests are rejected without pausing. Stay within the user's instructions and permissions. If no authorized approach can meet a requirement, report the exact constraint and what you tried without claiming the requirement is met.
{{else}}
If work is blocked or needs a product, security, legal, privacy, migration, source-behaviour, or live-integration decision, call ralph_request_decision with one precise question and the evidence or options. An accepted request pauses Ralph.
{{/if}}
For an existing pending decision, once the user answers and the decision is clear, call ralph_resolve_decision with a concise resolution and continue as directed. Goal approval is separate and always requires the user.
