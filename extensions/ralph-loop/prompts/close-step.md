---
description: Closing-step bullet for the iteration prompts — what happens after a completed task, per cycle policy.
example_input: |
  {
    "commit": true,
    "task": false
  }
---
- {{#if commit~}}Commit the completed task locally in a single commit. Do not push. {{/if}}{{#if task~}}This is the last step of the iteration: stop working when the commit is made.{{~else~}}After committing, immediately go back to the first step and start the next open task. Keep working task after task until no open tasks remain or you are told to finish up. When told to finish up, save progress so the next iteration can continue. Do not stop after a completed task while open tasks remain.{{~/if}}
