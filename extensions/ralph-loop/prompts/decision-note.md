---
description: Decision guidance appended to each iteration prompt, including the higher bar for asking in Away mode.
example_input: |
  {
    "awayMode": false
  }
---
{{#if awayMode}}
Away mode is on. Reread the user's instructions and check the relevant code, tests, and project conventions. If your recommended path stays within the user's instructions and existing permissions and is reasonably safe and reversible, take it. A measured downside or an invitation to ask for input is not itself a blocker. You can preserve existing behavior, report the tradeoff, and keep going. Don't create a separate decision record for a routine choice unless the user or project requires one.
Ask only if you can name a concrete next step that cannot reasonably proceed without the user's answer. Use ralph_request_decision with one precise question and four context lines: `Checked:` what you checked, `Recommendation:` your best candidate, `Blocked:` the specific next step you cannot take, and `Risk:` why taking your recommendation or keeping the status quo would be unsafe, hard to reverse, or outside your authority. If you can't explain that, keep working; don't ask in chat instead.
{{else}}
If work is blocked or needs a product, security, legal, privacy, migration, source-behaviour, or live-integration decision, call ralph_request_decision with one precise question and the evidence or options.
{{/if}}
A decision request pauses Ralph when accepted. Once the user answers and the decision is clear, call ralph_resolve_decision with a concise resolution and continue the blocked work. Goal approval is separate and always requires the user.
