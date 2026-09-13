Create the Ralph specification now. This is planning work only; do not implement the product brief.

Project brief:
{{brief}}

Output target: specification: {{specFile}}.

First read the bundled generic planning template in full:
- specification template: {{templateSpec}}

It is the authoritative example for the level of product/engineering detail, durable-spec content, acceptance criteria, decision handling, and source-evidence conventions. Adapt its structure and rigor to this project brief; do not copy its placeholder text or assume the project has an existing SPEC.md.

Create exactly the target file above{{forceClause}}. Do not modify any other file{{templateWarning}}. Use the write tool to produce a complete Markdown document, not a prose preview. Make it self-contained while linking to the Ralph backlog where useful.{{goalNote}}

The specification must be a durable, implementation-ready product and engineering contract: purpose, scope, non-goals, source/evidence rules where applicable, architecture, domain/lifecycle and authorization constraints, user journeys and acceptance criteria, quality/security requirements, definition of done, and release gates. Derive scope, architecture, risks, quality checks, and decisions from the project brief; identify unknowns explicitly rather than inventing them. After writing, read the generated file and verify that it is complete, internally consistent, and contains no unrelated implementation changes. Then report the generated path succinctly.
