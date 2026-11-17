---
description: One same-context continuation after a human message makes the model answer and stop; not a fresh iteration or a finish-up turn.
example_input: |
  {}
---
Continue the current Ralph iteration in the same context. Answering the human's message did not end the iteration. Apply their direction and resume the ongoing work; do not finish up merely because you answered. If their message asks you to stop or pause, honor that instead. If work requires a user decision, call ralph_request_decision rather than guessing.
