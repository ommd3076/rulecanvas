# RuleCanvas

RuleCanvas is a visual workbench for building, validating, and evaluating deterministic business rules. This checkout is a new implementation started because the original application source and repository were not available; it does not claim to contain imported history or existing application code.

## Current vertical slice

- Create a named project and reopen it from local JSON storage.
- Create a draft ruleset with a persistent revision number.
- Edit an interactive SVG graph: drag condition, logic-group, and outcome nodes from the palette, move nodes, and connect typed flow ports by pointer or keyboard.
- Build nested AND/OR groups in the inspector with typed condition leaves; nested groups explicitly define mixed-operator precedence and expose true/false graph branches.
- Select and remove an incorrect connection directly, with undo support; endpoint nodes and other branches remain in place.
- Confirm node deletion before its connected links are removed; undo remains available afterward.
- Undo and redo graph edits with grouped text entry, toolbar controls, and editor keyboard shortcuts.
- Define typed input fields (`string`, `number`, `boolean`, `date`, and `enum`), required state, and enum options.
- Validate branch completeness, edge compatibility, duplicate IDs, missing references, cycles, and unreachable nodes.
- Evaluate a saved graph against typed input and return a deterministic result with an ordered node-ID trace.
- Reject stale concurrent draft writes with a revision conflict instead of silently overwriting.
- Keep a conflicting unsaved draft in the editor, warn before leaving the page, and offer a local JSON download before reloading the server copy.
- Export the current draft to versioned JSON and import either a draft export or conflict copy after server-side graph validation.
- Save valid drafts as immutable, locally stored graph versions with SHA-256 consistency hashes; replay a chosen version independently from later draft edits. Hashes can detect accidental or one-sided changes, but are not authentication or tamper-proof protection against someone who can edit the local data file.
- Record local project and ruleset creation, draft-save, and version-save events for inspection through the API.
- Inspect saved versions and project activity in the app, and replay a saved version with its own typed input form.
- Migrate the known pre-versioned JSON shape on the next write and refuse unknown future data versions without rewriting them.
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

This is a local single-user prototype. Version records and the event ledger are local workspace data, not a hosted publishing or approval system; there is no authentication, role system, remote database, actor identity beyond `local workspace`, or multi-process locking. A previous pre-write checkpoint is kept beside the JSON data file as `.bak`; if the active file is malformed, the app loads that prior snapshot and shows a persistent recovery notice. Before a recovery write replaces the damaged file, the exact original bytes are preserved in a unique `.corrupt-*` sidecar. Recovery can roll back the most recent successful write, does not recover a deleted file, and is not a substitute for external backups. Local file persistence and a same-process conflict test do not establish production durability or multi-user concurrency. Do not bind this server to a public interface.

The visual language incorporates the verified RuleCanvas design system: floating pill workbench navigation, ENNORM brand subtitle, pale mint/off-white canvas (`#f4f8f4`), white cards, restrained solid pastels (mint `#d8f4e2`, yellow `#fce8b2`, peach `#fdd8c5`, blue `#dcecff`), compact typography, and collapsible inspector panels.

Real browser flows have been verified directly in modern browser sessions:
- Unconditional decision graphs (`Start → Outcome`) evaluate with empty schema `{}` returning terminal outcomes and execution traces.
- Input field creation, renaming, and type changes reliably persist with monotonic edit-generation guards.
- Keyboard and pointer connections for boundary conditions (e.g. `amount >= 100`) evaluate deterministic outcomes across test inputs.
- Nested AND/OR logic groups with explicit precedence (e.g. root `AND [input==A, input==A, nested OR(input==A, input==B)]`) evaluate correct branch traces and persist across reloads.
- Immutable versions save with SHA-256 consistency hashes and replay accurately independent of active draft edits.
- Responsive layouts maintain zero root horizontal overflow (`document.documentElement.scrollWidth === clientWidth`) across 390px mobile, 450px zoomed, 768px tablet, and desktop viewports, preserving local canvas pan. This verification confirms local layout stability and usability; it does not claim full accessibility or device-matrix certification.

Autosave and conflict management are fully implemented:
- Debounced autosave (1.8s) with failure backoff retry (5s) and draft preservation on network error.
- Edit-generation tracking and serialized in-flight write guards prevent network races from overwriting unsaved user edits or losing input focus.
- 409 revision conflicts retain local in-memory drafts with one-click JSON download.

## Evaluation semantics

Graphs use one `start` node, `condition` nodes, `group` nodes, and terminal `outcome` nodes. Conditions and groups have `true` and `false` flow outputs; each requires one edge on each branch. A group combines its direct terms with one operator (`and` or `or`); terms can be typed conditions or nested groups. Nesting supplies explicit parentheses and precedence; a group cannot mix operators among its direct terms. Validation bounds group depth to 16, each group to 128 terms, and a graph to 2,048 total group terms. Evaluation checks all terms rather than short-circuiting, so traces include each branch decision in stable order. Connections must use declared output and input ports. Values are type checked without string-to-number coercion. Optional missing values are treated as `null`; a comparison against an absent optional value follows the `false` branch. Dates use strict `YYYY-MM-DD` values and UTC calendar comparisons. Evaluation follows edges, never canvas coordinates.

## Next gates

1. Decide and implement authenticated actors, durable shared persistence, approval rules, and authorization before any hosted multi-user release.
2. Add API abuse limits and cross-process locking before treating the local server as a shared backend.
3. Expanded cross-browser and assistive technology audits for formal accessibility certification.

## License

No license has been selected. All rights reserved until the project owner adds an explicit license.
