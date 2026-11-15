# RuleCanvas

RuleCanvas is a visual workspace for creating, validating, and evaluating deterministic business rules. Its goal is to make rule behavior inspectable: people should be able to see how a decision was reached, change a draft safely, and reproduce an evaluation against a specific version.

## Product goals

- Build typed rule graphs with explicit conditions, branches, and outcomes.
- Catch invalid connections, cycles, unreachable nodes, and incomplete paths before evaluation.
- Evaluate a saved rule version deterministically and return a node-by-node explanation.
- Keep draft editing, validation, publishing, version history, and audit events distinct.
- Make graph editing usable with pointer and keyboard input, without allowing layout to change rule meaning.

## Project status

This repository is currently a product brief. The original application source has not yet been located, so no framework, API, database, graph format, or implementation is claimed here. Implementation should begin only after the existing source and its history are recovered or the product owner supplies the intended starting point.

## Design principles

- Rule evaluation follows explicit graph data and ordering, never visual position.
- A fixed rule version and input produce the same result and stable explanation.
- Invalid or ambiguous rules return actionable validation errors instead of silently selecting an outcome.
- Published versions remain immutable; drafts can be edited and reopened.
- Dashboards and status indicators reflect persisted state, or clearly identify themselves as empty/demo states.
- Keep the interface calm and practical: light surfaces, muted solid accents, restrained borders, and no gradients.

## Development approach

The first implementation milestone should be a complete vertical slice using the recovered application's actual architecture:

1. Create and persist a project.
2. Create a typed draft rule graph and save/reopen it.
3. Validate graph structure and typed inputs.
4. Evaluate boundary cases and show a stable, node-identified trace.
5. Verify the same result after reload and against an explicit rule version.

Do not replace an existing application with a speculative stack or mock-only presentation. See the product owner's implementation guide for the source-first audit and acceptance scenarios.

## License

No license has been selected. All rights reserved until the project owner adds an explicit license.
