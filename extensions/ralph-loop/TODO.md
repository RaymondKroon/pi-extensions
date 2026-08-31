# [Project name] — Ralph loop backlog

Read the project specification before every iteration. This document is the
ordered, living execution queue: complete the first unblocked unchecked item,
keep the change small, and record completion evidence here.

## Ralph loop protocol

1. Read the specification, this backlog, relevant code, and any authoritative
   evidence before selecting work.
2. Select the highest-priority unblocked `- [ ]` item. Do not skip to a later
   item merely because it is more interesting or easier.
3. Implement exactly one coherent vertical slice. Do not make unrelated
   refactors or scope changes.
4. Add or update focused tests and run every quality command required by the
   specification and this backlog.
5. Only after the acceptance criteria pass, check the item and add exactly one
   dated, concise entry for it to the completion log (changed paths, evidence,
   and test results). The completion log is the single completion record: do
   not also add a note below the checked item.
6. Add newly discovered work as unchecked items in the appropriate priority or
   deferred section.
7. When work requires a product, security, privacy, legal, migration,
   source-behaviour, or live-integration decision, use the Ralph decision
   workflow. Do not guess and do not use a TODO item to unblock work.
8. If Ralph reaches its configured context budget before the task is complete,
   add a concise non-checkbox **Context checkpoint** beneath that task with
   completed evidence, changed paths, risks, and the exact next step. Keep only
   one checkpoint per task: a new checkpoint replaces the previous one. Add
   ordered unchecked sub-todos only when the remaining work needs smaller,
   independently verifiable slices. Do not mark the parent complete or put the
   checkpoint in the completion log.
9. Commit a completed iteration locally; do not push unless separately asked.

## Current baseline

_Record only facts that describe the starting state and constraints for this
project. Do not turn this section into an implementation plan._

- [Baseline fact, relevant evidence, and quality commands]

## Priority [N] — [outcome-oriented phase]

- [ ] **[ID] [Small, outcome-oriented task title].**
  - [Concrete implementation boundaries; cite source or decision evidence when
    applicable.]
  - Acceptance: [observable result, validation/authorization requirements,
    focused tests, and required quality commands.]

_Add additional priority sections and tasks in dependency order. Each task must
be independently understandable, small enough for one Ralph iteration, and
have measurable acceptance criteria. Use identifiers only when they help
traceability; do not invent roadmap content merely to fill the template._

## Deferred or explicitly out-of-scope work

- [ ] **[ID] [Capability intentionally not being implemented now].**
  - Promotion requires: [named decision, evidence, owner, or prerequisite.]

## Completion log

_Add one short dated entry for every completed task. Keep changed paths,
evidence, and commands concise; do not include secrets or sensitive data._

- YYYY-MM-DD **[ID]** — [Outcome]. Changed: [paths]. Evidence: [source or
  decision]. Verified: [commands/tests].
