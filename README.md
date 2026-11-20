# RuleCanvas

RuleCanvas by ENNORM is a visual workbench for teams that need to build, test, and explain business rules. Create a decision graph, exercise boundary cases, and replay saved versions. Hosted workspaces add team access controls, version approvals, and environment deployments.

## Product workflow

- Open the product homepage at `/` and enter the Projects workspace. Create a project or launch the guided eligibility example and follow a boundary case through each node.
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
- Review project creation, draft edits, saved versions, and hosted release activity. Hosted events identify the signed actor.
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

Local mode uses a single-user JSON store and labels audit events `local workspace`. A pre-write checkpoint is kept beside the JSON file as `.bak`. If the active file is malformed, RuleCanvas loads the previous snapshot and shows a recovery notice. The next successful write also preserves the original bytes in a `.corrupt-*` file. Keep local mode on loopback and maintain external backups for workspace data.

The server factory also has an integration seam for a trusted authentication proxy. When called with `hosted`, every API request requires a short-lived signed assertion and an application-supplied `resolveAuthorizedStore` callback. That callback receives the verified principal and must enforce membership and permissions and select the tenant's scoped store. The standard `npm start` command uses the local configuration. A production deployment still requires a configured ingress, durable tenant storage, and operational testing.

When the hosted integration supplies `resolveReleaseRoles`, `GET /api/rulesets/:id/releases` reads release history and `POST` to the same URL accepts `propose`, `approve`, `reject`, `activate`, or `rollback`. The server supplies the actor from the signed identity and resolves the version from the authorized store. Activation and rollback require the expected active version ID (`null` when empty). In Releases, an author, runner, or admin can test the deployed version against its own typed schema and inspect the resulting trace. The evaluation endpoint `POST /api/rulesets/:id/releases/:environment/evaluate` accepts `input` and optional `expectedVersionId` and reports the exact version used. A stale expected version returns `409` before evaluation.

### Hosted startup

1. Apply `db/001-workspaces.sql` and `db/002-memberships.sql` to the intended PostgreSQL database with a migration account. Give the runtime account workspace read/write permissions and membership read permission.
2. Configure `RULECANVAS_DATABASE_URL`, `RULECANVAS_ASSERTION_ISSUER`, `RULECANVAS_ASSERTION_AUDIENCE`, and `RULECANVAS_ASSERTION_SECRET`. Supply the assertion secret as a base64url-encoded key of at least 32 random bytes through your secret manager.
3. Populate enabled memberships with the exact tenant, issuer, and subject used by the authentication proxy. Roles are `author`, `reviewer`, `deployer`, `runner`, and `admin`.
4. Build the frontend and run `npm run start:hosted`. Put a trusted TLS proxy in front of the loopback listener. The proxy must replace incoming identity headers and mint short-lived `x-rulecanvas-assertion` credentials with `iss`, `aud`, `sub`, `tenant`, `iat`, and `exp`. Maintain database backups and test restoration before serving customer data.

For hosted Team settings, apply `db/003-team-audit.sql`, allow the runtime account to insert memberships and update their `roles` and `enabled` columns, and grant `INSERT` on `public.hosted_team_membership_audit`. Set `RULECANVAS_TEAM_MANAGEMENT=1` for that runtime. An existing administrator can then add or update operational roles for SSO subjects in their tenant. Bootstrap administrator accounts through your deployment's existing membership setup. Each successful change and its audit record commit together. Disabled memberships lose access on their next authenticated API request.

To opt into the database integration test, point `RULECANVAS_TEST_DATABASE_URL` at a disposable PostgreSQL test database. The test never uses the hosted application's database environment variable.

Hosted mode binds to `127.0.0.1` by default. Set `RULECANVAS_HOST` to a private listener IP when the proxy runs separately, and restrict network access to the trusted proxy and health checks. Use `/health/live` for process health and `/health/ready` for PostgreSQL connectivity. Both endpoints return only an `ok` flag and require no tenant identity.

Build the hosted image with `docker build -t rulecanvas-hosted .`. It runs as a non-root user, serves the compiled UI, and listens on port 4178 inside the container. Apply migrations separately, inject the hosted settings at runtime, and keep its port on the proxy's private network.

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

1. Deploy the hosted image behind an authorized identity proxy with managed PostgreSQL and verify it using synthetic accounts.
2. Verify ingress rate limits, production observability, and database backup and restore before admitting customer data.
3. Expand cross-browser and assistive technology coverage for a formal accessibility audit.

## License

No license has been selected. All rights reserved until the project owner adds an explicit license.
