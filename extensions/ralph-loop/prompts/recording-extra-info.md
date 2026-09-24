---
description: Appended to the recording prompt when the user message that interrupted it carries extra info for the loop.
example_input: |
  {
    "extraInfo": "Also fix the typo on the login page."
  }
---
Extra info from the user — take it into account in this recording turn. Record it in durable state (a backlog entry or the project documentation) only if it matters for future work.
{{extraInfo}}
