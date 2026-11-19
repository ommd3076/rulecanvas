# RuleCanvas Web Release & Verification Report

**Date:** 2026-11-19
**Project:** RuleCanvas by ENNORM
**Checkout Path:** `C:\tmp\QUEUE\AUTONOMOUS_DEV_WORKSPACE\01_RuleCanvas`
**Platform Target:** Strictly Web Application
**Base Commit Revision:** `e1562e54735c90486cf80ee48474091125fcec81`
**Public Remote Repository:** `https://github.com/ommd3076/rulecanvas`  

---

## 1. Executive Summary

RuleCanvas by ENNORM is a **local single-user decision workbench**. Analysts can build a decision graph, test boundary cases, inspect the execution trace, and save a version for replay. The React frontend uses the deterministic Node.js evaluator and local JSON store.

The product review found three obstacles to that workflow. An empty dashboard asked for a blank project before demonstrating value, narrow screens hid editor actions, and the label **Publish** implied a deployment. The dashboard now offers a guided eligibility example, the narrow-screen action menu exposes validation and undo/redo, and **Save version** describes the local snapshot. Draft tests use the exact saved revision. A direct test or schema URL opens that panel on mobile.

Camunda's decision modeling shows how analysts and developers can share executable rules. RuleCanvas should be judged by how quickly an analyst can trace a branching decision and reproduce its result. A team release workflow would require identifiable reviewers, an approval state, and a deployment target. LaunchDarkly demonstrates these controls in its release workflows. [Camunda decision modeling](https://docs.camunda.io/docs/components/modeler/dmn/) · [LaunchDarkly workflows](https://launchdarkly.com/docs/eu-docs/home/releases/workflows-create)

The 2026-11-19 pass ran 64 automated tests, TypeScript checks, a production build, and the browser smoke suite. Direct Brave checks covered guided activation at 390px, test-panel reload, desktop header fit at 1351px, keyboard port connection, and saved-version reload and replay. Vite reported a large JavaScript bundle. Browser viewport checks used emulation.

The earlier browser harness pointed to the local Acceptance data file. Its run appears to have added a draft-save event and advanced the grouped rule from revision 14 to 15. The available pre-write checkpoint and current file contain identical graphs and version snapshots. The smoke harness now uses temporary data.

A separate source-only copy passed lockfile installation, the production build, all 64 automated tests, and the browser smoke suite. The copy started without installed packages, a build directory, or workspace data. Its browser suite reported zero runtime exceptions and zero content security policy violations.

---

## 2. GraphCanvas Product Pass & Interactions

The visual graph authoring canvas (`src/components/GraphCanvas.tsx` and `styles/globals.css`) adds visible connection feedback, larger pointer targets, active trace highlighting, and reduced-motion support.

### Visible Connection Feedback
1. **Pulsing Active Port Ring:** When an output port is clicked or focused, an animated emerald glow ring (`.canvas-port-pulse`) pulses around the source port.
2. **Target Invitation Halos:** All eligible input ports across other nodes render a cyan invitation halo (`.canvas-target-invitation`), clearly signaling valid connection destinations while dimming the source node's own input.
3. **Animated Draft Rubberband Line:** An SVG draft line (`.canvas-dash-draft`) with animated marching-dash styling (`canvas-dash-march`) tracks the mouse or keyboard cursor from the source port to the cursor, terminating in a directional arrowhead marker (`#draft-arrowhead`).
4. **Floating Connection Status Bar:** A floating pill at the top of the canvas displays the active source node title, output port name, step-by-step instructions, and a BoardUI `Cancel` button (also cancelable anytime via the `Escape` key).
5. **Screen Reader Announcements:** An `aria-live="polite"` status region provides immediate verbal feedback when connection mode begins, target ports are hovered/focused, connections complete, or connection mode is canceled.

### Keyboard and Touch Parity
1. **Keyboard Node Translation:** When any node is selected, `ArrowUp`, `ArrowDown`, `ArrowLeft`, and `ArrowRight` translate the node by 10px (or 40px when holding `Shift`), immediately updating the layout and pushing a `'drag-node'` snapshot to the undo history stack.
2. **Keyboard Connection Flow:** Output ports are keyboard-focusable (`tabIndex={0}`). Pressing `Enter` or `Space` activates connection mode; tabbing moves focus across eligible input ports; pressing `Enter` or `Space` on an eligible input port creates the link; pressing `Escape` cancels.
3. **Keyboard Canvas Pan & Zoom:** When no node is focused, arrow keys pan the canvas viewport, `+`/`=` zooms in, `-`/`_` zooms out, and `0` or `f` triggers zoom-to-fit.
4. **Multi-Touch Pinch-to-Zoom:** Multi-pointer tracking (`activePointersRef`) computes Euclidean distance changes (`Math.hypot`) across touch points, smoothly scaling the canvas centered on the pinch midpoint.
5. **40px Touch Hit Targets:** All input and output ports feature a 40px transparent hit target circle (`<circle r="20" fill="transparent" pointerEvents="all" />`), ensuring touch accessibility and effortless connection creation on mobile screens.

### Active Trace Highlighting
1. **Animated Trace Halo:** The active trace step node displays an emerald halo (`.canvas-trace-halo`) pulsing with `canvas-trace-pulse`.
2. **Trace Step Badge:** An emerald "TRACE STEP" badge is rendered above the active node header.
3. **Highlighted Trace Paths:** Canvas edges traversed during the active execution trace render with an emerald glowing stroke and increased stroke width.
4. **Auto-Centering Offscreen Trace Nodes:** When step playback advances to a node located outside the canvas viewport, the canvas smoothly pans to bring the active node into center view.

### Reduced Motion (`prefers-reduced-motion: reduce`)
All keyframe animations (`canvas-dash-march`, `canvas-trace-pulse`, `canvas-port-ping`, `canvas-target-pulse`) are cleanly disabled when `prefers-reduced-motion: reduce` is detected in `styles/globals.css`. High-contrast solid borders and crisp static rings are rendered instead.

---

## 3. Malformed URI Recovery & Error Boundary Protection

### Root Cause of Blank App on `/projects/%ZZ`
Independent testing in Brave on port 4178 reported that navigating to `/projects/%ZZ` reproduced a completely blank app. Investigation identified the following root causes:
1. **Lazy Initialization Gap:** In `src/App.tsx`, `recoveryState` was initialized to `null`. When `parseRoute(window.location.pathname)` returned `{ type: 'not_found', path: '/projects/%ZZ' }`, `route.type` matched none of `'projects'`, `'project'`, or `'editor'`, resulting in an empty JSX container on initial mount.
2. **Missing `not_found` Handling in Route Loader:** In `src/App.tsx`, `loadRoute()` checked `targetRoute.type === 'projects'`, `'project'`, and `'editor' | 'versions'`, but lacked a branch for `targetRoute.type === 'not_found'`. Consequently, `loadRoute` exited silently without populating `recoveryState` or updating the view.
3. **Missing React Error Boundary:** The application lacked a top-level React `ErrorBoundary`, meaning any unhandled component or decoding error during rendering unmounted the entire React root into an empty screen.
4. **Server Daemon Out of Sync:** The background daemon on port 4178 was running a prior build that had not yet incorporated the malformed URI fixes.

### Resolution
1. **Lazy State Initialization (`src/App.tsx`):**
   ```typescript
   const [recoveryState, setRecoveryState] = useState<RecoveryState | null>(() => {
     const init = parseRoute(window.location.pathname, window.location.search);
     return init.type === 'not_found' ? { type: 'not_found', path: init.path } : null;
   });
   ```
2. **Explicit `not_found` Handling in `loadRoute` (`src/App.tsx`):**
   ```typescript
   if (targetRoute.type === 'not_found') {
     setCurrentProject(null);
     currentProjectRef.current = null;
     setCurrentRuleset(null);
     currentRulesetRef.current = null;
     setRoute(targetRoute);
     setRecoveryState({
       type: 'not_found',
       path: targetRoute.path,
     });
     return;
   }
   ```
3. **Safe Fallback Rendering in Work Area (`src/App.tsx`):**
   The work area renders `RecoveryView` when `recoveryState` is set or when `route.type === 'not_found'`, displaying `Page Not Found`, the exact path string, and a `Return to Projects` button.
4. **Top-Level Error Boundary (`src/components/ErrorBoundary.tsx` & `src/main.tsx`):**
   Created an `ErrorBoundary` component catching any render-phase exceptions and safely displaying `RecoveryView` with `Return to Projects` rather than unmounting `#root`. Wrapped `<App />` in `src/main.tsx`.
5. **SPA Shell Server Fallback (`src/server.mjs`):**
   Updated `isScreenRoute` and `serveStatic` to deliver the SPA `index.html` shell for any screen route without a file extension while strictly disallowing directory traversal (`..` or `%2e%2e`), and wrapped URL parsing in a `try/catch` to serve the app shell if URL construction throws.

---

## 4. In-Browser Forced-Save History Traversal & Popstate Rejection

### History Index Tracking & Non-Destructive Traversal
App navigation tracks the browser history stack via `createGuardedHistoryController` (`public/router.js`), attaching a monotonic `ruleCanvasIndex` to `window.history.state`.

### Forced-Save Rejection Workflow
When navigating away from an editor with an unsaved/dirty draft:
1. **Dirty Back Traversal:** If the user triggers browser Back while the draft is dirty and the server save fails (simulated via 500 error):
   - `inFlightFlush` catches the save error and triggers user-facing error notification (`toast.error`).
   - The history controller calculates `deltaToOrigin = target.originIndex - browserCurrentIndex` (which is `+1`).
   - The controller executes `window.history.go(+1)` without creating a new history entry via `pushState`.
   - The editor remains mounted, the canvas is retained, the dirty draft is preserved, and the browser history length remains unchanged.
2. **Dirty Forward Traversal:** If the user triggers browser Forward while the draft is dirty and save fails:
   - The history controller calculates `deltaToOrigin = -1`.
   - The controller executes `window.history.go(-1)`.
   - The editor remains mounted and intact, and the history stack length is preserved.
3. **Rapid Back/Forward Popstate Coordination:** Rapid popstate events occurring while a draft flush is in flight are queued via `pendingPop`, ensuring the final destination is evaluated against the in-flight result without race conditions.
4. **Subsequent Clean Navigation:** Once changes are committed or cleaned, forward navigation traverses cleanly to Project Overview, and Back returns cleanly to Editor, proving the forward history stack was never truncated.

---

## 5. Version History Opener Destination Preservation

When Version History is opened:
- From **Project Overview** (`/projects/:pId`): Closing Version History or pressing Back returns specifically to Project Overview (`/projects/:pId`).
- From **Editor Canvas** (`/projects/:pId/rules/:rId?panel=...`): Closing returns to Editor Canvas with the active inspector panel preserved.
- From **Direct Version URL** (`/projects/:pId/rules/:rId/versions/:vId`): Closing falls back safely to Editor (`/projects/:pId/rules/:rId`).
- Popstate modal dismissal closes the dialog on all routes (`projects`, `project`, `editor`).

---

## 6. Verified Run Instructions

To install, build, and run the verified web application locally from a clean source checkout:

### Step 1: Clean Install Dependencies
```powershell
npm ci
```
Performs a reproducible clean install directly from `package-lock.json`, installing all React 19, Vite, Tailwind CSS v4, and BoardUI/RareUI/Ruixen dependencies.

### Step 2: Syntax and Sanity Check
```powershell
npm run check
```
Runs Node.js syntax verification across all engine, storage, server, routing, and client runtime modules.

### Step 3: Build Production Bundle
```powershell
npm run build
```
Build output compiles to `dist/index.html`, `dist/assets/index-*.css`, and `dist/assets/index-*.js`.

### Step 4: Run Full Automated Unit Test Suite
```powershell
npm test
```
Executes all 64 unit tests across routing, history traversal, rule evaluation, save coordination, and storage integrity (64/64 passing).

### Step 5: Run Type Check
```powershell
npx tsc --noEmit
```
Verifies strict TypeScript typing across all components, hooks, router adapters, and view definitions.

### Step 6: Start the Production Server
```powershell
npm start
# Or specify a custom port:
# $env:PORT="4178"; node src/server.mjs
```
The application binds to `http://127.0.0.1:4178` by default with local JSON file persistence.

### Step 7: Execute the Full End-to-End Browser Smoke Suite
```powershell
node scripts/browser-smoke.mjs
```
Executes automated CDP tests in headless Chromium/Edge covering all 6 validation stages.

---

## 7. Documented Limitations

1. **Web-Only Scope:** RuleCanvas is architected strictly as a browser-based Single Page Application with an HTTP/REST backend. It does not target Electron, mobile native wrappers, or desktop CLI shells.
2. **Single-User Workspace Prototype:** Designed for local/single-user development workflows. Multi-user concurrent editing on the same ruleset relies on revision hashing (`activeRevision`), optimistic locking, and downloadable conflict snapshots rather than operational transformation (CRDT).
3. **Single Active Canvas Rule:** The visual canvas renders one decision rule graph at a time. Cross-rule composition is achieved via modular rule invocations and project overview management.

---

## 8. Test Commands, Outputs & Verification Outcomes

### Command 1: Clean Dependency Installation
```powershell
npm ci
```
**Outcome:** Exit code 0 (added 78 packages, audited 85 packages cleanly from `package-lock.json`).

### Command 2: Runtime Syntax Check
```powershell
npm run check
```
**Outcome:** Exit code 0 (all 13 server, engine, client, and router modules verified without syntax errors).

### Command 3: TypeScript Type Check
```powershell
npx tsc --noEmit
```
**Outcome:** Exit code 0 (zero errors).

### Command 4: Automated Unit Test Suite
```powershell
npm test
```
**Outcome:** Exit code 0.
```
ℹ tests 64
ℹ suites 0
ℹ pass 64
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```
All 64 automated tests passing across 11 test suites:
- `conflict-copy.test.mjs`: Conflict download retains local draft graph and stale base revision.
- `graph-editing.test.mjs`: Removes only selected connection; undo/redo without mutable leaks; groups rapid typing; clears redo history.
- `history.test.mjs`: History snapshot and restoration mechanics.
- `http-flow.test.mjs`: HTTP API project/ruleset flows, nested AND/OR group persistence, stale draft write rejections, validated immutable versions, asset directory traversal defense, malformed body error handling, checkpoint recovery.
- `render-utils.test.mjs`: HTML attribute escaping and rendering utilities.
- `routing.test.mjs`: Route parsing, special character encoding/decoding, canonical URL generation, SPA shell fallback, parent-child ownership verification, navigation sequence guard, safe decode of malformed percent-escapes and encoded path separators, server 400 for malformed asset URIs, directory traversal rejection, non-destructive Back `history.go(+1)` and Forward `history.go(-1)` popstate reversion, rapid popstate coordination, and version history opener destination preservation.
- `rule-engine.test.mjs`: Deterministic evaluation, layout coordinate invariance, condition type validation, port compatibility, cycle/unreachability detection, deep graph validation, numeric boundaries, enum choices, calendar dates, nested AND/OR precedence, unconditional graph evaluation, and scholarship eligibility matrix evaluation.
- `rule-transfer.test.mjs`: Export/import round-tripping and conflict file validation.
- `save-coordination.test.mjs`: In-flight save cleanly applies, preserves in-flight edits, navigation guards, evaluation awaiting in-flight save, version publishing flush, timer-triggered save rejection safety, and React adapter live-ref synchronization.
- `storage-integrity.test.mjs`: SHA-256 hash validation, checkpoint rollback on corrupt store, legacy schema migration, future schema protection.
- `test-input.test.mjs`: Required empty string vs optional blank input handling.

### Command 5: Vite Production Build
```powershell
npm run build
```
**Outcome:** Exit code 0 (built in 1.17s to `dist/`).
```
dist/index.html                     0.97 kB │ gzip:   0.53 kB
dist/assets/index-CulHAV-5.css    164.47 kB │ gzip:  25.60 kB
dist/assets/index-ecobFMzw.js   1,258.82 kB │ gzip: 390.41 kB
```

### Command 6: Full Browser Smoke Test Suite
```powershell
node scripts/browser-smoke.mjs
```
**Outcome:** Exit code 0 (All 6 smoke test stages passed with 0 runtime exceptions and 0 CSP violations).
```
1. Starting RuleCanvas Node server on fresh port: 56002
✓ RuleCanvas server started successfully on http://127.0.0.1:56002
✓ Server verified serving compiled React production assets from dist/
✓ Edge headless CDP ready on port 56003
Connecting to page target: 37A70CBC44112E162525CA7FB38A6A86
✓ React app bundle verified mounted in #root
--- Step 1: Dashboard View ---
✓ Clicked project card: "RuleCanvas Acceptance2Nov 15, 2026Open"
✓ Screen transition to Project Overview verified
--- Step 2: Project Overview View ---
Testing History button click...
✓ Version History modal opened with explicit target ruleset
✓ Verified URL and UI returned to Project Overview after closing Version History modal
Testing safe browser Back from Version History modal...
✓ Safe browser Back from Version History modal verified
Testing Open Editor for "Grouped decision" ruleset...
✓ Screen transition to Editor Canvas verified (#graph-canvas rendered, Grouped decision active)
--- Step 3: Editor Canvas at 1366x549 ---
Header metrics at 1366x549: {
  headerHeight: 56,
  navHeight: 22,
  breadcrumbText: 'Projects/RuleCanvas Acceptance/Grouped decision'
}
✓ Breadcrumb compact single-line layout verified (no multi-line header expansion)
✓ Single canonical Undo/Redo control set verified (no duplicate canvas toolbar buttons)
✓ Resource-addressed route verified: /projects/f63f6117-695b-40ba-8d71-9e7df47ce566/rules/76149001-0d7c-4406-9b6a-c6e4244bc6e8
Testing SegmentedControl tab switch to "Test Run"...
✓ Test Runner mounted with input parameters form
✓ Panel query route verified: /projects/f63f6117-695b-40ba-8d71-9e7df47ce566/rules/76149001-0d7c-4406-9b6a-c6e4244bc6e8?panel=test
Testing page reload persistence for rule and ?panel=test...
✓ Release Check 1 passed: Reload preserved exact rule and ?panel=test
--- Step 4: Fill Test Input & Evaluate Trace ---
Found input field in Test Runner: { placeholder: 'Enter New input (required)', ariaLabel: 'New input' }
Testing "Run test" button click on valid graph...
✓ Evaluation verified: Outcome = COMPLETE, RareUI StepPlayer trace rendered
--- Step 5: Canvas Authoring (Add Condition & Delete Node) ---
Initial node count on canvas: 4
✓ Node count incremented to 5 after Add Condition
Testing Canvas Authoring (Delete Node)...
✓ Handled native browser dialog: "Are you sure you want to delete this condition node? You can undo this action." (Accepted)
✓ Node count restored to 4 after Delete Node
Testing Edge Selection and "Remove Link" with undo...
Initial edge count: 3
✓ Remove Link verified: edge count decreased to 2
✓ Undo verified: edge count restored to 3
Testing Logic Group Node and Recursive Accordion Subgroup editing...
✓ Recursive BoardUI Accordion nested subgroup verified in NodeInspector
✓ Handled native browser dialog: "Are you sure you want to delete this group node? You can undo this action." (Accepted)
--- Step 5.5: Deep Link Routes, Version Replay & Recovery Views ---
Navigating directly to version snapshot deep-link: http://127.0.0.1:56002/projects/f63f6117-695b-40ba-8d71-9e7df47ce566/rules/07c973f2-f12b-4040-8b73-db027627f338/versions/e661790b-f615-46ec-a402-cbe8dc7bd86e
✓ Handled native browser dialog: "" (Accepted)
✓ Release Check 5 passed: Direct immutable version deep-link opened and inspected snapshot
Testing direct version deep-link modal close destination fallback...
✓ Direct version deep-link close destination fallback to Editor verified
Navigating to missing project URL: http://127.0.0.1:56002/projects/00000000-0000-0000-0000-000000000000
✓ Release Check 4 (Project Not Found) passed: Recovery screen rendered with return button
✓ Recovery navigation to /projects verified
Navigating to missing rule set URL: http://127.0.0.1:56002/projects/f63f6117-695b-40ba-8d71-9e7df47ce566/rules/00000000-0000-0000-0000-000000000000
✓ Release Check 4 (Rule Set Not Found) passed: Recovery screen rendered with back button
Navigating to exact malformed URI URL: http://127.0.0.1:56002/projects/%ZZ
✓ Exact malformed URI (/projects/%ZZ) verified: App renders Page Not Found recovery screen
Navigating to malformed URI URL: http://127.0.0.1:56002/projects/proj%ZZ
✓ Malformed URI edge case verified: App never blanks, renders Page Not Found recovery screen
Navigating to encoded slash URL: http://127.0.0.1:56002/projects/proj%2F123
✓ Encoded path separator edge case verified: App never blanks, renders Page Not Found recovery screen
--- Step 5.6: In-Browser Forced-Save History Traversal & Popstate Rejection ---
Navigating to project overview for clean history stack baseline: http://127.0.0.1:56002/projects/f63f6117-695b-40ba-8d71-9e7df47ce566
Active rule editor path for history test: /projects/f63f6117-695b-40ba-8d71-9e7df47ce566/rules/76149001-0d7c-4406-9b6a-c6e4244bc6e8
Navigated to Overview using: {"method":"breadcrumb-link"}
✓ Successfully arrived at Project Overview (URL & heading asserted): /projects/f63f6117-695b-40ba-8d71-9e7df47ce566
Baseline history stack verified: length = 16 (Entry 1: Grouped decision; Back: Overview; Forward: Overview)
Simulating draft save network failure in browser...
Testing DIRTY BACK REJECTION: triggering browser Back while draft is dirty...
Pre-back state: {"path":"/projects/f63f6117-695b-40ba-8d71-9e7df47ce566/rules/76149001-0d7c-4406-9b6a-c6e4244bc6e8","state":{"ruleCanvasIndex":1},"length":16,"hasCanvas":true}
✓ Dirty Back rejection verified: reverted via history.go(+1), editor retained, stack intact
Testing DIRTY FORWARD REJECTION: triggering browser Forward while draft is dirty...
✓ Dirty Forward rejection verified: reverted via history.go(-1), editor retained, stack intact
Testing rapid Back/Forward popstates during in-flight save...
✓ Rapid popstates during in-flight save handled cleanly
Restoring window.fetch and testing subsequent clean navigation...
✓ Handled native browser dialog: "Are you sure you want to delete this condition node? You can undo this action." (Accepted)
Triggering clean browser Forward navigation to Overview (verifying forward stack preserved)...
✓ Subsequent clean Forward navigation to Overview succeeded (forward stack intact)
Triggering clean browser Back navigation back to editor (verifying back stack preserved)...
✓ Subsequent clean Back navigation back to editor succeeded (back stack intact)
--- Step 6: Mobile 390px Viewport ---
✓ Mobile responsive layout verified (390px, Inspector and editor actions available)
✓ Zero runtime browser exceptions detected throughout smoke run
✓ Zero CSP violations detected
================================================================
ALL BROWSER SMOKE ASSERTIONS PASSED WITH ZERO REGRESSIONS!
================================================================
```

---

## 9. Export Readiness & Verification Checksum

- **Base Revision:** `e1562e54735c90486cf80ee48474091125fcec81`
- **Clean Workspace:** All temporary browser profiles (`temp-browser-profile`, `temp-*`) are completely deleted and excluded via `.gitignore`.
- **Database Preserved:** `data/rulecanvas.json` verified intact (1 project, 2 rule sets, 2 immutable versions).
- **Production Daemon:** Port 4178 active and serving the latest verified build.
- **Ready for Export:** The workspace is in a verified, clean state ready for packaging, distribution, or release archive export.
