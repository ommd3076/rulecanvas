# RuleCanvas

RuleCanvas is a visual workbench for building, validating, and evaluating deterministic business rules. This checkout is a new implementation started because the original application source and repository were not available; it does not claim to contain imported history or existing application code.

## Current vertical slice

- Create a named project and reopen it from local JSON storage.
- Create a draft ruleset with a persistent revision number.
- Edit an interactive SVG graph: drag condition and outcome nodes from the palette, move nodes, and connect typed flow ports by pointer or keyboard.
- Define typed input fields (`string`, `number`, `boolean`, `date`, and `enum`), required state, and enum options.
- Validate branch completeness, edge compatibility, duplicate IDs, missing references, cycles, and unreachable nodes.
- Evaluate a saved graph against typed input and return a deterministic result with an ordered node-ID trace.
- Reject stale concurrent draft writes with a revision conflict instead of silently overwriting.
- Keep node coordinates as layout metadata; evaluation semantics use node and edge data only.

## Run locally

Requires Node.js 22 or newer. No third-party runtime packages are required.

```sh
npm test
npm run check
npm start
```

Open `http://127.0.0.1:4178`. By default, project data is written to `data/rulecanvas.json`, which is ignored by Git. Set `RULECANVAS_DATA_FILE` to use another local path.

## Architecture and scope

- `src/rule-engine.mjs` contains pure graph validation, typed input validation, and deterministic evaluation.
- `src/storage.mjs` serializes local JSON file changes with atomic replacement and per-process optimistic revisions.
- `src/server.mjs` serves the app and a small JSON API, binding to `127.0.0.1` by default.
- `public/` contains the dependency-free HTML, CSS, SVG canvas, and browser interaction code.

This is a local single-user prototype. It has no authentication, role system, remote database, multi-process locking, audit history, immutable published versions, or production deployment. Local file persistence and a same-process conflict test do not establish production durability or multi-user concurrency. Do not bind this server to a public interface.

The visual language follows the provided light dashboard references: pale mint/off-white surfaces, compact sans type, white cards, restrained pastel accents, and minimal borders. The graph canvas prioritizes branch labels, typed fields, precise selection, and visible validation. Browser/device visual QA has not yet been performed; no screenshot or browser-pass claim is made.

## Evaluation semantics

Graphs use one `start` node, `condition` nodes with `true` and `false` flow outputs, and terminal `outcome` nodes. Every condition requires one edge on each branch. Connections must use declared output and input ports. Values are type checked without string-to-number coercion. Optional missing values are treated as `null`; a comparison against an absent optional value follows the `false` branch. Dates use strict `YYYY-MM-DD` values and UTC calendar comparisons. Evaluation follows edges, never canvas coordinates.

## Next gates

1. Run pointer and keyboard flows in a real browser at desktop, tablet, and mobile widths; inspect saved/reopened node positions and connections.
2. Add explicit undo/redo, delete confirmation, autosave/retry states, import/export, and stronger schema migration handling.
3. Decide and implement authentication, durable shared persistence, audit events, immutable published versions, and authorization before any hosted multi-user release.
4. Add API abuse limits and cross-process locking before treating the local server as a shared backend.

## License

No license has been selected. All rights reserved until the project owner adds an explicit license.
