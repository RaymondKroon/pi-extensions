---
description: Decision guidance appended to each iteration prompt, including the higher bar for asking in Away mode.
example_input: |
  {
    "awayMode": false
  }
---
{{#if awayMode}}
Away mode is on. Before asking the user, reread their instructions and check the relevant code, tests, and project conventions. Prefer the interpretation best supported by that evidence. For a low-cost, reversible choice, state your assumption briefly and keep going. Do not ask for reassurance or routine preferences.
Ask only if an unresolved choice materially changes the outcome and there is no reasonable way to proceed without the user's input. Use ralph_request_decision with one precise question and three context lines: `Checked:` what you checked, `Recommendation:` what you would choose, and `Risk:` what could go wrong without an answer. Do not ask in chat instead of using the tool.
{{else}}
If work is blocked or needs a product, security, legal, privacy, migration, source-behaviour, or live-integration decision, call ralph_request_decision with one precise question and the evidence or options.
{{/if}}
A decision request pauses Ralph when accepted. Once the user answers and the decision is clear, call ralph_resolve_decision with a concise resolution and continue the blocked work. Goal approval is separate and always requires the user.
