# RuleCanvas

RuleCanvas by ENNORM is a local visual workbench for analysts who need to explain how business rules choose an outcome. Build a decision graph, test boundary cases, and save a version you can replay later.

## Current vertical slice

- Create a named project and reopen it from local JSON storage.
- Try a guided eligibility rule from an empty workspace. Run the prefilled boundary case and follow the trace through each node.
- Create a draft ruleset with a persistent revision number.
- Edit an interactive SVG graph: drag condition, logic-group, and outcome nodes from the palette, move nodes, and connect typed flow ports by pointer or keyboard.
- Build nested AND/OR groups in the inspector with typed condition leaves; nested groups explicitly define mixed-operator precedence and expose true/false graph branches.
- Select and remove an incorrect connection directly, with undo support; endpoint nodes and other branches remain in place.
- Confirm node deletion before its connected links are removed; undo remains available afterward.
- Undo and redo graph edits with grouped text entry, toolbar controls, and editor keyboard shortcuts.
- Define typed input fields (`string`, `number`, `boolean`, `date`, and `enum`), required state, and enum options.
- Validate branch completeness, edge compatibility, duplicate IDs, missing references, cycles, and unreachable nodes.
- Evaluate the intended saved revision against typed input and follow a deterministic, ordered node trace.
- Open **Evaluation runs** from a project to review up to 500 recent evaluations, see their draft revisions or saved versions, and distinguish completed evaluations from evaluation errors. Run history stores outcome labels or error codes and omits submitted inputs, output payloads, and traces.
- Reject stale concurrent draft writes with a revision conflict instead of silently overwriting.
- Keep a conflicting unsaved draft in the editor, warn before leaving the page, and offer a local JSON download before reloading the server copy.
- Export the current draft to versioned JSON and import either a draft export or conflict copy after server-side graph validation.
- Save valid drafts as immutable, locally stored graph versions with SHA-256 consistency hashes; replay a chosen version independently from later draft edits. Hashes can detect accidental or one-sided changes, but are not authentication or tamper-proof protection against someone who can edit the local data file.
- Record local project and ruleset creation, draft-save, and version-save events for inspection through the API.
- Inspect saved versions and project activity in the app, and replay a saved version with its own typed input form.
- Migrate the known pre-versioned JSON shape on the next write and refuse unknown future data versions without rewriting them.
- Keep node coordinates as layout metadata; evaluation semantics use node and edge data only.

## Run locally

Requires Node.js 22 or newer.

```sh
npm ci          # Clean install dependencies from lockfile
npm test        # Run automated test suite
npm run check   # Run syntax checks
npm run build   # Build production React frontend via Vite
npm start       # Start server on http://127.0.0.1:4178
```

Open `http://127.0.0.1:4178`. By default, project data is written to `data/rulecanvas.json`, which is ignored by Git. Set `RULECANVAS_DATA_FILE` to use another local path.

On Windows with Microsoft Edge installed, run `node scripts/browser-smoke.mjs` after building. It starts its own loopback server, synthetic test store, and temporary browser profile.

## Architecture and scope

- `src/rule-engine.mjs` contains pure graph validation, typed input validation, and deterministic evaluation.
- `src/storage.mjs` serializes local JSON file changes with atomic replacement and per-process optimistic revisions.
- `src/server.mjs` serves the app and a small JSON API, binding to `127.0.0.1` by default.
- `src/App.tsx` and `src/components/` contain the React workspace. `public/` provides shared browser modules, static assets, and the legacy shell served when a React build is absent.

This is a local single-user prototype. Version records and the event ledger are local workspace data, not a hosted publishing or approval system; there is no authentication, role system, remote database, actor identity beyond `local workspace`, or multi-process locking. A previous pre-write checkpoint is kept beside the JSON data file as `.bak`; if the active file is malformed, the app loads that prior snapshot and shows a persistent recovery notice. Before a recovery write replaces the damaged file, the exact original bytes are preserved in a unique `.corrupt-*` sidecar. Recovery can roll back the most recent successful write, does not recover a deleted file, and is not a substitute for external backups. Local file persistence and a same-process conflict test do not establish production durability or multi-user concurrency. Do not bind this server to a public interface.

The server factory also has an integration seam for a trusted authentication proxy. When called with `hosted`, every API request requires a short-lived signed assertion and an application-supplied `resolveAuthorizedStore` callback. That callback receives the verified principal and must enforce membership and permissions and select the tenant's scoped store. The standard `npm start` command uses the local configuration. A production deployment still requires a configured ingress, durable tenant storage, and operational testing.

When the hosted integration supplies `resolveReleaseRoles`, `GET /api/rulesets/:id/releases` reads release history and `POST` to the same URL accepts `propose`, `approve`, `reject`, `activate`, or `rollback`. The server supplies the actor from the signed identity and resolves the version from the authorized store. Activation and rollback require the expected active version ID (`null` when empty). `POST /api/rulesets/:id/releases/:environment/evaluate` evaluates the environment's active immutable graph and reports its version. The release routes require hosted configuration and server-assigned roles.

The visual language incorporates the verified RuleCanvas design system:
- **Workspace navigation:** Project and rule breadcrumbs, draft save state, version history, and a compact actions menu on narrow screens. The [sitemap](SITEMAP.md) lists the deep links for each workspace view.
- **Three-Zone Workspace:**
  - *Left Panel:* Build palette (draggable/clickable Condition, Logic group, and Outcome cards) and typed Input Fields (Schema) editor with type badges and required states.
  - *Center Canvas:* Distraction-free SVG decision canvas with geometric dot grid, floating quick-add pills (`+ Condition`, `+ Logic group`, `+ Outcome`), node stats, zoom/fit controls, remove link, and inspector collapse toggle. Upgraded SVG cards (240x130px) with solid pastel badges and distinct branch port markers.
  - *Right Panel:* Node Inspector (properties and nested logic groups with interactive segmented AND/OR pills) and Test Runner with live decision trace output. Collapses to a compact 42px strip to maximize canvas area.
- **Palette & Tokens:** Pale mint/off-white canvas (`#f4f8f4`), crisp white cards, restrained solid pastels (mint `#d8f4e2`, yellow `#fce8b2`, purple `#ede4f7`, peach `#fdd8c5`, blue `#dcecff`), compact typography, and strictly no decorative gradients.
- **Responsive Architecture:** Segmented tab control on mobile viewports (`[ ◇ Canvas ] [ ▦ Build & Fields ] [ ⚙ Properties & Test ]`) providing dedicated full-width access to each workbench zone without crowded wrapping or vertical squishing. Zero page-level horizontal overflow (`scrollWidth === clientWidth`) across 390px mobile, 450px zoomed, 768px tablet, and desktop viewports.

Real browser flows have been verified directly in modern browser sessions:
- Unconditional decision graphs (`Start → Outcome`) evaluate with empty schema `{}` returning terminal outcomes and execution traces.
- Input field creation, renaming, and type changes reliably persist with monotonic edit-generation guards.
- Keyboard and pointer connections for boundary conditions (e.g. `amount >= 100`) evaluate deterministic outcomes across test inputs.
- Nested AND/OR logic groups with explicit precedence (e.g. root `AND [input==A, input==A, nested OR(input==A, input==B)]`) evaluate correct branch traces and persist across reloads.
- Immutable versions save with SHA-256 consistency hashes and replay accurately independent of active draft edits.
- Responsive layouts maintain zero root horizontal overflow (`document.documentElement.scrollWidth === clientWidth`) across 390px mobile, 450px zoomed, 768px tablet, and desktop viewports, preserving local canvas pan. This verification confirms local layout stability and usability; it does not claim full accessibility or device-matrix certification.

Autosave and conflict management are fully implemented:
- Debounced autosave (1.8s) with fixed 5-second failure retry and draft preservation on network error.
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
