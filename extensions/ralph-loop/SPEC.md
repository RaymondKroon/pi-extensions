# [Product name] specification

## 1. Purpose

State the problem, primary users, product outcome, and the boundary of this
project. This document is the durable product and engineering contract.
`TODO.md` is the ordered execution queue.

## 2. Evidence and source of truth

List authoritative inputs: existing code, approved product material, external
contracts, source applications, design systems, and applicable policies. For
unknown behaviour, state whether it is verified or inferred. Never treat an
assumption as source evidence.

## 3. Scope

### In scope

List the first releasable capabilities as user-observable outcomes.

### Explicitly out of scope

List excluded integrations, migrations, automation, reports, or other
capabilities. State what approval is required before any excluded item changes.

## 4. Target architecture

Describe the implementation constraints: framework/runtime, persistence,
authentication, server/client boundaries, configuration, migration strategy,
external-service adapters, logging, and deployment constraints.

## 5. Domain and lifecycle rules

Describe the core records, ownership, important relationships, validation,
state transitions, audit requirements, retention constraints, and any business
rules that must not be bypassed.

## 6. Authorization and security

Define roles and a capability matrix. Every protected read and write must have
server-side authorization. Record the decision and evidence needed for any
unknown scope or permission.

## 7. User journeys and acceptance criteria

For each primary journey, state the actor, outcome, validation/authorization
requirements, accessibility expectations, and observable acceptance criteria.

## 8. Quality, accessibility, privacy, and operations

Specify required quality commands, test types, UI language/accessibility,
security and privacy controls, observability, safe failure behaviour, and
operational documentation.

## 9. Definition of done for every Ralph iteration

A task is complete only when it implements one coherent vertical slice, has the
required evidence, authorization and validation, focused tests, all required
quality checks, an updated TODO completion note, and no unrelated changes or
secrets.

## 10. Release gates

List conditions that must be met before release, such as approved decisions,
end-to-end journey coverage, operational ownership, privacy controls, and
integration/migration plans.
