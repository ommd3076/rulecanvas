# RuleCanvas Release Report

**Date:** 2026-11-15  
**Project:** RuleCanvas by ENNORM  
**Checkout Path:** `C:\tmp\QUEUE\AUTONOMOUS_DEV_WORKSPACE\01_RuleCanvas`  
**Branch:** `main`  
**Git HEAD SHA:** `4971d7efe65c2018a01184ad3f7d3e366ab4f048`  
**Public Remote Repository:** `https://github.com/ommd3076/rulecanvas`  
**Verified Remote Push SHA:** `4971d7efe65c2018a01184ad3f7d3e366ab4f048`  

---

## 1. Executive Summary

RuleCanvas has reached a verified, production-grade local release state. All observed defects and prioritized implementation gaps have been resolved, verified against code and live browser execution on the local server at `http://127.0.0.1:4178`, and pushed by fast-forward to the public GitHub repository.

The test suite expanded from 34 baseline tests to **42 comprehensive tests**, all passing in under 1 second. Syntax checking (`npm run check`) and Git hygiene (`git diff --check`) pass with zero warnings or errors.

---

## 2. Gaps Implemented & Defects Resolved

### P0 Defect: Unconditional Graph (Empty Schema) Evaluation
- **Issue:** Graphs with zero schema fields (e.g., direct `Start → Outcome` decision graphs) previously disabled the **Run test** button and displayed a prompt requiring input fields, preventing valid unconditional decisions from executing in the UI.
- **Resolution:** Updated `renderTestPanel()` in `public/app.js` to keep the test runner enabled for empty schemas and display appropriate guidance. Verified that submitting `{ input: {} }` returns the terminal outcome and complete node trace.
- **Evidence:** Regression tests in `tests/rule-engine.test.mjs` and `tests/http-flow.test.mjs`. Verified live in browser against owner's acceptance project `RuleCanvas Acceptance > Boundary decision`.

### P0 Defect: `Add input field` Click Dispatcher
- **Issue:** The `+` button in the Input Fields panel emitted `data-action="add-field"`, but the click listener in `public/app.js` lacked a dispatcher branch for `add-field`, causing clicks to be silently ignored.
- **Resolution:** Wired `action === 'add-field'` to invoke `addField()`, correctly generating schema fields with default name `Input 1`, type `string`, and required state.
- **Evidence:** Verified in browser by owner; regression tested with typed schema field handling.

### P0 Concurrency & Concurrency Guard: Delayed Save & Edit Generation
- **Issue:** `saveDraft()` previously replaced `state.graph` and cleared `state.dirty` upon awaiting the HTTP PUT response without checking whether subsequent edits were made while the request was in flight. Edits made during a slow save could be silently overwritten, and navigating away could corrupt view state or dereference null pointers.
- **Resolution:**
  1. Implemented `editGeneration` monotonic counter tracking every mutation.
  2. Captured immutable request snapshots (`snapshotGraph`, `savedGeneration`, `targetRulesetId`, `targetProjectId`, `targetRevision`).
  3. Created `public/save-coordination.js` (`applySaveSuccess`) to verify that `state.editGeneration === savedGeneration` before syncing `state.graph` or clearing `dirty`.
  4. Serialized write requests using an in-flight promise lock (`inFlightSave`), automatically queuing/rescheduling saves when subsequent edits occur.
  5. Avoided full `render()` on autosaves, preserving active user input focus and cursor positions.
  6. Guarded post-save project refresh to prevent dereferencing null objects when navigating between views.
- **Evidence:** Unit test suite in `tests/save-coordination.test.mjs` testing clean saves, in-flight edit preservation, and cross-view navigation safety.

### Reliable Autosave, Retry & Conflict Handling
- **Implementation:** Added debounced autosave (`scheduleAutosave()` at 1.8s) and automatic failure retry (5s exponential backoff).
- **Draft Preservation:** Local drafts remain intact in memory upon 5xx/network errors, displaying a dedicated `Retry save` button.
- **Conflict Management:** HTTP 409 revision conflicts retain the unsaved draft in the editor, present a one-click local JSON download (`rulecanvas-conflict-<id>.json`), and warn on navigation via `beforeunload`.

### Field-Schema Safety & Invalidation
- **Implementation:** When fields are renamed, existing test inputs migrate under the new key. When a field referenced by a condition or logic group is deleted, the selector displays an explicit `Missing field (select replacement)` indicator and marks the node/leaf with `.is-invalid` styling.
- **Validation:** Validation errors explicitly cite the group term path (e.g., `term 0.1`) and provide direct links to select the affected node.

### Visual Constitution & Styling Compliance
- **Design Tokens:** Strictly adhered to mint/off-white canvas (`#f2f8f5`), white cards, and restrained solid pastels (`#d8f4e2` mint, `#fff1c9` yellow, `#ffe4d8` peach, `#dcecff` blue).
- **Prohibitions Maintained:** Zero gradients, no oversaturated colors, no fake dashboard metrics, and no simulated authentication/roles.

---

## 3. Test & Verification Evidence

### Automated Test Suite (`npm test`)
```text
> rulecanvas@0.1.0 test
> node --test

✔ conflict download retains the exact local draft graph and stale base revision (4.1ms)
✔ removes only the selected connection while preserving endpoint nodes and other branches (3.4ms)
✔ undoes and redoes graph edits without sharing mutable snapshot objects (3.4ms)
✔ groups rapid field typing into one undo step and separates edits after a pause (0.6ms)
✔ clears redo history when a new branch edit is made (0.4ms)
✔ creates and reloads a project and ruleset through the local HTTP API (149.6ms)
✔ persists nested AND OR groups and replays their typed evaluation trace (79.3ms)
✔ rejects stale draft writes instead of silently overwriting a newer revision (24.4ms)
✔ creates validated immutable versions with replay and local audit evidence (68.8ms)
✔ refuses invalid or stale version snapshots (21.2ms)
✔ serves app assets from the public directory and blocks traversal (21.5ms)
✔ returns client errors for malformed and non-object JSON request bodies (8.4ms)
✔ health reports recovery after the app loads a prior local checkpoint (14.9ms)
✔ creates and evaluates an unconditional ruleset with empty schema through HTTP API (23.3ms)
✔ evaluates ruleset with default schema field name Input 1 through HTTP API (25.6ms)
✔ escapes untrusted field names and values in generated HTML attributes (2.0ms)
✔ validates and deterministically evaluates a typed graph with an ordered trace (7.1ms)
✔ moving nodes changes layout metadata but does not change result or trace (0.7ms)
✔ rejects a condition value that does not match its declared field type (0.6ms)
✔ rejects incompatible ports and incomplete branches (0.5ms)
✔ reports cycles and unreachable nodes by stable node ID (0.5ms)
✔ reports cycles in unreachable components as well as unreachable nodes (2.7ms)
✔ validates a deep graph without recursive stack overflow (179.1ms)
✔ rejects missing required and wrongly typed evaluation inputs (0.8ms)
✔ supports inclusive and exclusive numeric boundaries without coercion (1.0ms)
✔ enforces declared enum choices and validates calendar dates (2.7ms)
✔ evaluates explicit nested AND/OR groups with group-first precedence and stable trace (3.2ms)
✔ rejects malformed, untyped, oversized and deeply nested logical groups (0.9ms)
✔ evaluates an unconditional graph with empty schema using empty input object (0.4ms)
✔ evaluates graph with default schema field name containing spaces such as Input 1 (0.3ms)
✔ evaluates scholarship eligibility boundary conditions accurately across the full matrix (2.5ms)
✔ exports and imports graph drafts without losing graph or base revision metadata (5.3ms)
✔ imports a downloaded conflict draft and rejects malformed, oversized, or unsupported files (1.7ms)
✔ applies save cleanly when no edits occur while save is in flight (1.7ms)
✔ preserves in-flight edits and schedules rerun when edits occur while save is in flight (0.4ms)
✔ does not corrupt state if user navigated away while save was in flight (0.3ms)
✔ version reads reject graph data changed without updating its content hash (60.5ms)
✔ recovers malformed store JSON from the previous checkpoint and repairs it on next write (37.9ms)
✔ does not overwrite an unreadable store when no recovery checkpoint exists (7.2ms)
✔ migrates the known legacy store shape on the next successful write (14.5ms)
✔ does not downgrade or overwrite a future store schema version (8.4ms)
✔ includes a required empty string as a provided value but omits optional blank values (1.3ms)
ℹ tests 42
ℹ suites 0
ℹ pass 42
ℹ fail 0
ℹ duration_ms 715.7
```

### Static Analysis & Syntax Verification (`npm run check`)
```text
> rulecanvas@0.1.0 check
> node --check src/rule-engine.mjs && node --check src/graph-editing.mjs && node --check src/storage.mjs && node --check src/server.mjs && node --check public/app.js && node --check public/history.js && node --check public/graph-editing.js && node --check public/conflict-copy.js && node --check public/rule-transfer.js && node --check public/typed-input.js && node --check public/render-utils.js && node --check public/save-coordination.js
[Exit code: 0]
```

### Git Check (`git diff --check`)
Clean with zero whitespace or line-ending defects.

### Live Browser Retest Evidence
- **Environment:** Chrome / Windows 11 running against `http://127.0.0.1:4178`.
- **Project:** `RuleCanvas Acceptance` (`f63f6117-695b-40ba-8d71-9e7df47ce566`).
- **Observed Flow 1:** Unconditional graph (`Start → Outcome`) evaluated via test panel with empty input, returning `"approved"` and trace `['start', 'node-1a7b142c...']`.
- **Observed Flow 2:** `Add input field` clicked; `Input 1` created with `string` type. Renamed and type changed; autosave confirmed with revision increment.
- **Observed Flow 3:** Amount condition (`amount >= 100`) connected via keyboard; evaluated 99 (declined) and 100 (approved) with distinct, deterministic branch traces.
- **Observed Flow 4:** Immutable version 1 replayed independently from active draft edits, returning identical initial snapshot outcome and hash verification.

---

## 4. GitHub Synchronization

- **Target Repository:** `https://github.com/ommd3076/rulecanvas`
- **Tracked Branch:** `main`
- **Sequential Commit History:**
  - `38f5285` Integrate nested logic groups in rule editor (Baseline HEAD)
  - `d0c7d06` Fix zero-field evaluation and add-field handler with reliable autosave and retry
  - `4971d7e` Add edit-generation save guard and write serialization with focused tests
- **Verification:** `git ls-remote origin main` confirms remote SHA `4971d7efe65c2018a01184ad3f7d3e366ab4f048`.

---

## 5. Scope Boundaries and Limitations

1. **Local Single-User Architecture:** Storage is backed by local JSON atomic replacement (`data/rulecanvas.json`). It does not provide multi-process file locking, remote database clustering, or server-side identity authentication.
2. **SHA-256 Hashes:** Version hashes detect consistency and inadvertent data changes; they are not cryptographic authorization against local file modification.
3. **No External Dependencies:** The application remains dependency-free, running on standard Node.js (>=22.0.0) and modern vanilla JavaScript / SVG in the browser.
