---
description: Decision-tool note appended to every iteration prompt — when to pause for a user decision, and how auto-approval changes that.
example_input: |
  {
    "autoApprove": false
  }
---
If work is blocked or needs a product, security, legal, privacy, migration, source-behaviour, or live-integration decision, call the ralph_request_decision tool with one precise question. {{#if autoApprove~}}Decision auto-approval is enabled: the tool will not pause Ralph. Treat this as delegated approval to select a safe resolution and then continue the blocked work. Do not call ralph_resolve_decision.{{~else~}}It pauses Ralph in this session and presents the question to the user. After the user answers, discuss any remaining ambiguity with them. When the decision is clear, then call ralph_resolve_decision with a concise resolution and continue the blocked work.{{~/if}}
