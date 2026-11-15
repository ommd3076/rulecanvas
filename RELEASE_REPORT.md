# RuleCanvas Release Report

**Date:** 2026-11-15  
**Project:** RuleCanvas by ENNORM  
**Checkout Path:** `C:\tmp\QUEUE\AUTONOMOUS_DEV_WORKSPACE\01_RuleCanvas`  
**Branch:** `main`  
**Public Remote Repository:** `https://github.com/ommd3076/rulecanvas`  

---

## 1. Executive Summary

RuleCanvas has reached the status of a **verified local single-user prototype**. The baseline functional slice, reported user-facing browser defects, autosave concurrency race guards, responsive viewport overflows, and AI Studio visual navigation treatments have been implemented and verified.

The application remains strictly a dependency-free, local-first single-user system backed by local JSON file replacement (`data/rulecanvas.json`). **Hosted multi-tenant authentication, durable shared persistence, multi-user approval workflows, and remote database clustering are explicitly unimplemented and outside the current prototype scope.**

The test suite stands at **42 passing tests**, running in ~650ms. Syntax checking across all 12 modules (`npm run check`) and Git hygiene (`git diff --check`) pass with zero errors.

---

## 2. Gaps Implemented, Defects Resolved & Visual Treatment Integration

### P0 Defect: Unconditional Graph (Empty Schema) Evaluation
- **Issue:** Graphs with zero schema fields (e.g., direct `Start → Outcome` decision graphs) previously disabled the **Run test** button and displayed a prompt requiring input fields, preventing valid unconditional decisions from executing in the UI.
- **Resolution:** Updated `renderTestPanel()` in `public/app.js` to keep the test runner enabled for empty schemas and display appropriate guidance. Verified that submitting `{ input: {} }` returns the terminal outcome and complete node trace.
- **Evidence:** Automated tests in `tests/rule-engine.test.mjs` and `tests/http-flow.test.mjs`; verified live in browser by project owner against project `RuleCanvas Acceptance > Boundary decision`.

### P0 Defect: `Add input field` Click Dispatcher
- **Issue:** The `+` button in the Input Fields panel emitted `data-action="add-field"`, but the click listener in `public/app.js` lacked a dispatcher branch for `add-field`, causing clicks to be silently ignored.
- **Resolution:** Wired `action === 'add-field'` to invoke `addField()`, correctly generating schema fields with default name `Input 1`, type `string`, and required state.
- **Evidence:** Verified live in browser by project owner; automated regression test with typed schema field handling.

### P0 Concurrency & Concurrency Guard: Delayed Save & Edit Generation
- **Issue:** `saveDraft()` previously replaced `state.graph` and cleared `state.dirty` upon awaiting the HTTP PUT response without checking whether subsequent edits were made while the request was in flight. Edits made during a slow save could be silently overwritten, and navigating away could corrupt view state or dereference null pointers.
- **Resolution:**
  1. Implemented `editGeneration` monotonic counter tracking every mutation.
  2. Captured immutable request snapshots (`snapshotGraph`, `savedGeneration`, `targetRulesetId`, `targetProjectId`, `targetRevision`).
  3. Created `public/save-coordination.js` (`applySaveSuccess`) to verify that `state.editGeneration === savedGeneration` before syncing `state.graph` or clearing `dirty`.
  4. Serialized write requests using an in-flight promise lock (`inFlightSave`), automatically queuing/rescheduling saves when subsequent edits occur.
  5. Avoided full `render()` on autosaves, preserving active user input focus and cursor positions.
  6. Guarded post-save project refresh to prevent dereferencing null objects when navigating between views.
- **Evidence:** Automated unit test suite in `tests/save-coordination.test.mjs` testing clean saves, in-flight edit preservation, and cross-view navigation safety; confirmed in owner browser retesting during typing.

### Reliable Autosave, Retry & Conflict Handling
- **Implementation:** Added debounced autosave (`scheduleAutosave()` at 1.8s) and automatic failure retry (fixed 5-second retry timer, NOT exponential backoff).
- **Draft Preservation:** Local drafts remain intact in memory upon 5xx/network errors, displaying a dedicated `Retry save` button.
- **Conflict Management:** HTTP 409 revision conflicts retain the unsaved draft in the editor, present a one-click local JSON download (`rulecanvas-conflict-<id>.json`), and warn on navigation via `beforeunload`.

### Decisive Visual Workspace Redesign (AI Studio Reference Integration)
- **Elimination of Redundant Sidebar & Stacked Toolbars:**
  - Removed the legacy 238px sidebar that duplicated the top floating pill navigation, freeing up screen width for the decision canvas.
  - Eliminated the separate secondary `editor-toolbar`, unifying all navigation, breadcrumbs, ruleset title editing, history undo/redo, save status, and actions (`Validate`, `Export`, `Import`, `Save version`, `Save draft`) into a single cohesive, sticky `.top-nav` header.
- **Three-Zone Workspace Hierarchy:**
  - *Left Panel (Build & Schema):* 260px wide panel containing draggable/clickable node palette cards (Condition, Logic group, Outcome with distinct solid pastel symbols) and typed Schema editor with type badges (`N`, `S`, `B`, `D`, `E`), inline type selector, and required toggles.
  - *Center Canvas:* Clean, spacious SVG canvas with geometric dot pattern and top floating toolbar featuring solid pastel quick-add pills (`+ Condition`, `+ Logic group`, `+ Outcome`), node and edge count statistics, zoom controls (`−`, `100%`, `+`, `Fit`), `Remove link`, and inspector toggle. Upgraded SVG cards to 240x130px with solid pastel icon badges, uppercase kind labels, divider rules, and distinct true ("Yes" green) and false ("No" peach) branch ports.
  - *Right Panel (Inspector & Test Runner):* 310px collapsible drawer featuring properties inspector for selected nodes (with nested AND/OR depth hierarchy and segmented operator pills) and test runner with dynamic schema inputs and step-by-step decision trace list.
- **Restrained Solid Pastel Design Tokens:** Deep ink (`#142018`), natural muted slate-green (`#647569`), calm mint/off-white canvas (`#f4f8f4`), border lines (`#d5e0d5`), solid pastel yellow (`#fce8b2`), solid pastel purple (`#ede4f7`), solid pastel mint (`#d8f4e2`), solid pastel peach (`#fdd8c5`), and solid pastel blue (`#dcecff`). Strictly no decorative linear or radial gradients.
- **Responsive Mobile Architecture (<= 768px):**
  - Segmented 3-tab control on mobile viewports: `[ ◇ Canvas ] [ ▦ Build & Fields ] [ ⚙ Properties & Test ]`. Each tab grants 100% viewport width to its respective zone, preventing cramped multi-row button wrapping and vertical squishing.
  - Horizontally scrollable action and pill bars preventing mobile header overflow.
  - Verified via real Edge headless CDP: `document.documentElement.scrollWidth === clientWidth` across **390px** mobile (`scrollWidth 390 == clientWidth 390`), **450px** zoomed, **768px** tablet, and **1280px** desktop with zero overflowing elements.

---

## 3. Test & Verification Evidence

### A. Automated Test Suite (`npm test` — Agent Executed)
```text
> rulecanvas@0.1.0 test
> node --test

✔ conflict download retains the exact local draft graph and stale base revision (3.6ms)
✔ removes only the selected connection while preserving endpoint nodes and other branches (2.7ms)
✔ undoes and redoes graph edits without sharing mutable snapshot objects (3.6ms)
✔ groups rapid field typing into one undo step and separates edits after a pause (0.4ms)
✔ clears redo history when a new branch edit is made (0.4ms)
✔ creates and reloads a project and ruleset through the local HTTP API (177.4ms)
✔ persists nested AND OR groups and replays their typed evaluation trace (87.5ms)
✔ rejects stale draft writes instead of silently overwriting a newer revision (23.9ms)
✔ creates validated immutable versions with replay and local audit evidence (59.2ms)
✔ refuses invalid or stale version snapshots (17.0ms)
✔ serves app assets from the public directory and blocks traversal (18.0ms)
✔ returns client errors for malformed and non-object JSON request bodies (8.2ms)
✔ health reports recovery after the app loads a prior local checkpoint (13.4ms)
✔ creates and evaluates an unconditional ruleset with empty schema through HTTP API (20.5ms)
✔ evaluates ruleset with default schema field name Input 1 through HTTP API (22.5ms)
✔ escapes untrusted field names and values in generated HTML attributes (2.2ms)
✔ validates and deterministically evaluates a typed graph with an ordered trace (9.2ms)
✔ moving nodes changes layout metadata but does not change result or trace (1.8ms)
✔ rejects a condition value that does not match its declared field type (0.6ms)
✔ rejects incompatible ports and incomplete branches (0.5ms)
✔ reports cycles and unreachable nodes by stable node ID (0.6ms)
✔ reports cycles in unreachable components as well as unreachable nodes (0.6ms)
✔ validates a deep graph without recursive stack overflow (177.6ms)
✔ rejects missing required and wrongly typed evaluation inputs (1.1ms)
✔ supports inclusive and exclusive numeric boundaries without coercion (1.0ms)
✔ enforces declared enum choices and validates calendar dates (2.8ms)
✔ evaluates explicit nested AND/OR groups with group-first precedence and stable trace (3.3ms)
✔ rejects malformed, untyped, oversized and deeply nested logical groups (1.0ms)
✔ evaluates an unconditional graph with empty schema using empty input object (1.1ms)
✔ evaluates graph with default schema field name containing spaces such as Input 1 (0.7ms)
✔ evaluates scholarship eligibility boundary conditions accurately across the full matrix (2.4ms)
✔ exports and imports graph drafts without losing graph or base revision metadata (4.8ms)
✔ imports a downloaded conflict draft and rejects malformed, oversized, or unsupported files (1.7ms)
✔ applies save cleanly when no edits occur while save is in flight (1.8ms)
✔ preserves in-flight edits and schedules rerun when edits occur while save is in flight (0.5ms)
✔ does not corrupt state if user navigated away while save was in flight (0.3ms)
✔ version reads reject graph data changed without updating its content hash (58.5ms)
✔ recovers malformed store JSON from the previous checkpoint and repairs it on next write (36.4ms)
✔ does not overwrite an unreadable store when no recovery checkpoint exists (9.1ms)
✔ migrates the known legacy store shape on the next successful write (16.8ms)
✔ does not downgrade or overwrite a future store schema version (6.7ms)
✔ includes a required empty string as a provided value but omits optional blank values (2.8ms)
ℹ tests 42
ℹ suites 0
ℹ pass 42
ℹ fail 0
ℹ duration_ms 672.9
```

### B. Static Analysis & Syntax Verification (`npm run check` — Agent Executed)
```text
> rulecanvas@0.1.0 check
> node --check src/rule-engine.mjs && node --check src/graph-editing.mjs && node --check src/storage.mjs && node --check src/server.mjs && node --check public/app.js && node --check public/history.js && node --check public/graph-editing.js && node --check public/conflict-copy.js && node --check public/rule-transfer.js && node --check public/typed-input.js && node --check public/render-utils.js && node --check public/save-coordination.js
[Exit code: 0]
```

### C. Git Hygiene (`git diff --check` — Agent Executed)
Clean with zero whitespace or line-ending defects.

### D. Owner-Operated Live Browser Evidence
- **Environment:** Manual testing by repository owner in Google Chrome / Windows 11 running against local server `http://127.0.0.1:4178`.
- **Project:** `RuleCanvas Acceptance` (`f63f6117-695b-40ba-8d71-9e7df47ce566`).
- **Owner Flow 1 (Empty Schema Run):** Decision graph `Start → Outcome` evaluated via test panel with empty input, returning `"approved"` and trace `['start', 'node-1a7b142c...']`.
- **Owner Flow 2 (Field Creation & Autosave):** `Add input field` clicked; `Input 1` created with `string` type. Renamed and type changed; autosave confirmed with revision increment.
- **Owner Flow 3 (Keyboard Boundary Connection):** Amount condition (`amount >= 100`) connected via keyboard; evaluated 99 (declined) and 100 (approved) with distinct branch traces.
- **Owner Flow 4 (Nested Logic Groups & Immutable Replay):** `Grouped decision` ruleset tested with root `AND [input==A, input==A, nested OR(input==A, input==B)]`; correctly returned `approved` for `input=A` and `declined` for `input=B` (traces show inner OR evaluated true while outer AND evaluated false); saved immutable version 1.
- **Owner Flow 5 (Responsive Zoom Finding):** Under native browser zoom at CSS viewport 450px, owner identified `document.scrollWidth 466 > clientWidth 450`, leading directly to the toolbar/canvas-topline fix.

---

## 4. Scope Boundaries and Limitations

1. **Local Single-User Architecture:** Storage is backed by local JSON atomic replacement (`data/rulecanvas.json`). It does not provide multi-process file locking, remote database clustering, or server-side identity authentication.
2. **Unimplemented Hosted Capabilities:** Hosted multi-tenant authentication, user roles, remote backups, and formal approval/publishing workflows are not implemented.
3. **SHA-256 Hashes:** Version hashes detect data integrity and accidental changes; they are not cryptographic authorization against direct local file modification.
4. **No External Runtime Dependencies:** The application remains dependency-free, running on standard Node.js (>=22.0.0) and vanilla JavaScript / SVG in the browser.
5. **Responsive and Accessibility Scope:** Layout stability (`scrollWidth === clientWidth`) is verified at 390px, 450px, 768px, and 1280px viewports with keyboard navigation supported. This verification confirms local functional stability; it does not claim full WCAG AA accessibility certification or comprehensive cross-device matrix coverage.
