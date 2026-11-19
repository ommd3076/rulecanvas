import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRoute,
  buildRouteUrl,
  verifyOwnership,
  createNavigationSequenceGuard,
  safeDecodeId,
  createGuardedHistoryController,
} from '../public/router.js';
import { createRuleCanvasServer } from '../src/server.mjs';
import { JsonStore } from '../src/storage.mjs';

test('router parses valid routes and strips trailing slashes', () => {
  assert.deepEqual(parseRoute('/'), { type: 'projects' });
  assert.deepEqual(parseRoute('/projects'), { type: 'projects' });
  assert.deepEqual(parseRoute('/projects/'), { type: 'projects' });

  assert.deepEqual(parseRoute('/projects/p1'), {
    type: 'project',
    projectId: 'p1',
  });
  assert.deepEqual(parseRoute('/projects/p1/'), {
    type: 'project',
    projectId: 'p1',
  });
  assert.deepEqual(parseRoute('/projects/project%201/runs'), { type: 'runs', projectId: 'project 1' });

  assert.deepEqual(parseRoute('/projects/p1/rules/r1'), {
    type: 'editor',
    projectId: 'p1',
    ruleId: 'r1',
    panel: undefined,
  });
  assert.deepEqual(parseRoute('/projects/p1/rules/r1/releases'), {
    type: 'releases',
    projectId: 'p1',
    ruleId: 'r1',
  });

  assert.deepEqual(parseRoute('/projects/p1/rules/r1', '?panel=schema'), {
    type: 'editor',
    projectId: 'p1',
    ruleId: 'r1',
    panel: 'schema',
  });

  assert.deepEqual(parseRoute('/projects/p1/rules/r1', '?panel=test'), {
    type: 'editor',
    projectId: 'p1',
    ruleId: 'r1',
    panel: 'test',
  });

  assert.deepEqual(parseRoute('/projects/p1/rules/r1', '?panel=unknown'), {
    type: 'editor',
    projectId: 'p1',
    ruleId: 'r1',
    panel: undefined,
  });

  assert.deepEqual(parseRoute('/projects/p1/rules/r1/versions'), {
    type: 'versions',
    projectId: 'p1',
    ruleId: 'r1',
  });

  assert.deepEqual(parseRoute('/projects/p1/rules/r1/versions/v1'), {
    type: 'versions',
    projectId: 'p1',
    ruleId: 'r1',
    versionId: 'v1',
  });

  assert.deepEqual(parseRoute('/invalid/route/here'), {
    type: 'not_found',
    path: '/invalid/route/here',
  });
});

test('router decodes and encodes special characters in IDs', () => {
  const parsed = parseRoute('/projects/special%20id/rules/rule%231', '?panel=test');
  assert.deepEqual(parsed, {
    type: 'editor',
    projectId: 'special id',
    ruleId: 'rule#1',
    panel: 'test',
  });

  const url = buildRouteUrl(parsed);
  assert.equal(url, '/projects/special%20id/rules/rule%231?panel=test');
});

test('buildRouteUrl generates canonical URLs for all route states', () => {
  assert.equal(buildRouteUrl({ type: 'projects' }), '/projects');
  assert.equal(buildRouteUrl({ type: 'project', projectId: 'proj-1' }), '/projects/proj-1');
  assert.equal(buildRouteUrl({ type: 'runs', projectId: 'project 1' }), '/projects/project%201/runs');
  assert.equal(
    buildRouteUrl({ type: 'editor', projectId: 'p1', ruleId: 'r1' }),
    '/projects/p1/rules/r1'
  );
  assert.equal(
    buildRouteUrl({ type: 'editor', projectId: 'p1', ruleId: 'r1', panel: 'schema' }),
    '/projects/p1/rules/r1?panel=schema'
  );
  assert.equal(
    buildRouteUrl({ type: 'editor', projectId: 'p1', ruleId: 'r1', panel: 'properties' }),
    '/projects/p1/rules/r1'
  );
  assert.equal(
    buildRouteUrl({ type: 'versions', projectId: 'p1', ruleId: 'r1' }),
    '/projects/p1/rules/r1/versions'
  );
  assert.equal(
    buildRouteUrl({ type: 'releases', projectId: 'project 1', ruleId: 'rule#1' }),
    '/projects/project%201/rules/rule%231/releases'
  );
  assert.equal(
    buildRouteUrl({ type: 'versions', projectId: 'p1', ruleId: 'r1', versionId: 'v2' }),
    '/projects/p1/rules/r1/versions/v2'
  );
  assert.equal(buildRouteUrl({ type: 'not_found', path: '/anything' }), '/projects');
});

test('server delivers app shell for valid screen routes while preserving 404s for assets and API', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rulecanvas-routing-test-'));
  const server = createRuleCanvasServer({ store: new JsonStore(join(directory, 'store.json')) });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  // Screen routes return 200 text/html (app shell)
  const screenRoutes = [
    '/',
    '/projects',
    '/projects/00000000-0000-0000-0000-000000000001',
    '/projects/00000000-0000-0000-0000-000000000001/runs',
    '/projects/00000000-0000-0000-0000-000000000001/rules/00000000-0000-0000-0000-000000000002',
    '/projects/00000000-0000-0000-0000-000000000001/rules/00000000-0000-0000-0000-000000000002/releases',
    '/projects/00000000-0000-0000-0000-000000000001/rules/00000000-0000-0000-0000-000000000002?panel=schema',
    '/projects/00000000-0000-0000-0000-000000000001/rules/00000000-0000-0000-0000-000000000002?panel=test',
    '/projects/00000000-0000-0000-0000-000000000001/rules/00000000-0000-0000-0000-000000000002/versions',
    '/projects/00000000-0000-0000-0000-000000000001/rules/00000000-0000-0000-0000-000000000002/versions/ver-1',
  ];

  for (const route of screenRoutes) {
    const res = await fetch(`${base}${route}`);
    assert.equal(res.status, 200, `Expected 200 for screen route ${route}`);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const body = await res.text();
    assert.match(body, /RuleCanvas/);
  }

  // Missing asset returns 404 (not HTML!)
  const missingAsset = await fetch(`${base}/assets/nonexistent.js`);
  assert.equal(missingAsset.status, 404, 'Missing asset should return 404');
  const assetBody = await missingAsset.json();
  assert.equal(assetBody.error.code, 'static.not_found');

  // Missing API route returns 404 JSON (not HTML!)
  const missingApi = await fetch(`${base}/api/missing-endpoint`);
  assert.equal(missingApi.status, 404, 'Missing API route should return 404');
  const apiBody = await missingApi.json();
  assert.equal(apiBody.error.code, 'api.not_found');
});

test('verifyOwnership validates parent-child relationship and detects mismatches', () => {
  const project = { id: 'proj-1', name: 'Project 1' };
  const ruleset = { id: 'rule-1', name: 'Rule 1', projectId: 'proj-1' };

  // Valid match
  const valid = verifyOwnership({
    project,
    ruleset,
    requestedProjectId: 'proj-1',
    requestedRuleId: 'rule-1',
  });
  assert.equal(valid.status, 'ok');
  assert.equal(valid.project.id, 'proj-1');
  assert.equal(valid.ruleset.id, 'rule-1');

  // Missing project
  const missingProj = verifyOwnership({
    project: null,
    ruleset,
    requestedProjectId: 'missing-p',
    requestedRuleId: 'rule-1',
  });
  assert.equal(missingProj.status, 'error');
  assert.equal(missingProj.reason, 'project_not_found');
  assert.equal(missingProj.projectId, 'missing-p');

  // Missing ruleset
  const missingRule = verifyOwnership({
    project,
    ruleset: null,
    requestedProjectId: 'proj-1',
    requestedRuleId: 'missing-r',
  });
  assert.equal(missingRule.status, 'error');
  assert.equal(missingRule.reason, 'rule_not_found');
  assert.equal(missingRule.ruleId, 'missing-r');

  // Ownership mismatch: rule belongs to proj-2, but requested under proj-1
  const mismatchedRule = { id: 'rule-2', name: 'Rule 2', projectId: 'proj-2' };
  const mismatch = verifyOwnership({
    project,
    ruleset: mismatchedRule,
    requestedProjectId: 'proj-1',
    requestedRuleId: 'rule-2',
  });
  assert.equal(mismatch.status, 'error');
  assert.equal(mismatch.reason, 'project_rule_mismatch');
  assert.equal(mismatch.projectId, 'proj-1');
  assert.equal(mismatch.ruleId, 'rule-2');
  assert.equal(mismatch.actualProjectId, 'proj-2');
  assert.equal(mismatch.rulesetName, 'Rule 2');
});

test('navigation sequence guard rejects stale out-of-order network responses', async () => {
  const guard = createNavigationSequenceGuard();

  let activeScreenData = null;

  async function mockNavigate(destination, delayMs) {
    const navId = guard.next();
    await new Promise((r) => setTimeout(r, delayMs));
    // If a newer navigation occurred while this request was in flight, discard!
    if (!guard.isLatest(navId)) {
      return { status: 'discarded', navId };
    }
    activeScreenData = { destination, navId };
    return { status: 'applied', navId };
  }

  // Trigger navigation 1 (slow, 80ms) and navigation 2 (fast, 20ms)
  const p1 = mockNavigate('Rule-A', 80);
  const p2 = mockNavigate('Rule-B', 20);

  const [res1, res2] = await Promise.all([p1, p2]);

  assert.equal(res2.status, 'applied');
  assert.equal(res1.status, 'discarded');
  // Destination Rule-B must remain active and cannot be replaced by delayed Rule-A!
  assert.equal(activeScreenData.destination, 'Rule-B');
  assert.equal(activeScreenData.navId, res2.navId);
});

test('router safely handles malformed percent-escapes and encoded path separators without throwing URIError', () => {
  // safeDecodeId handles valid strings
  assert.equal(safeDecodeId('valid-id'), 'valid-id');
  assert.equal(safeDecodeId('proj%20name'), 'proj name');

  // safeDecodeId rejects malformed percent escapes (would cause URIError)
  assert.equal(safeDecodeId('proj%ZZ'), null);
  assert.equal(safeDecodeId('proj%'), null);
  assert.equal(safeDecodeId('proj%2'), null);
  assert.equal(safeDecodeId('%E0%A4%A'), null);

  // safeDecodeId rejects encoded path separators (%2f, %2F, %5c, %5C)
  assert.equal(safeDecodeId('proj%2f123'), null);
  assert.equal(safeDecodeId('proj%2F123'), null);
  assert.equal(safeDecodeId('proj%5c123'), null);
  assert.equal(safeDecodeId('proj%5C123'), null);

  // safeDecodeId rejects null bytes and traversal tokens
  assert.equal(safeDecodeId('..'), null);
  assert.equal(safeDecodeId('%2e%2e'), null);
  assert.equal(safeDecodeId('proj%00name'), null);

  // parseRoute returns not_found instead of throwing URIError
  assert.deepEqual(parseRoute('/projects/%ZZ'), {
    type: 'not_found',
    path: '/projects/%ZZ',
  });
  assert.deepEqual(parseRoute('/projects/proj%ZZ'), {
    type: 'not_found',
    path: '/projects/proj%ZZ',
  });
  assert.deepEqual(parseRoute('/projects/proj%2f123'), {
    type: 'not_found',
    path: '/projects/proj%2f123',
  });
  assert.deepEqual(parseRoute('/projects/p1/rules/r1%ZZ'), {
    type: 'not_found',
    path: '/projects/p1/rules/r1%ZZ',
  });
  assert.deepEqual(parseRoute('/projects/p1/rules/r1%2fr2'), {
    type: 'not_found',
    path: '/projects/p1/rules/r1%2fr2',
  });
  assert.deepEqual(parseRoute('/projects/p1/rules/r1/versions/v%ZZ'), {
    type: 'not_found',
    path: '/projects/p1/rules/r1/versions/v%ZZ',
  });
  assert.deepEqual(parseRoute('/projects/p1/rules/r1/versions/v1%2Fv2'), {
    type: 'not_found',
    path: '/projects/p1/rules/r1/versions/v1%2Fv2',
  });

  // Malformed search query parameter doesn't throw and defaults panel cleanly
  const malformedSearch = parseRoute('/projects/p1/rules/r1', '?panel=%ZZ');
  assert.deepEqual(malformedSearch, {
    type: 'editor',
    projectId: 'p1',
    ruleId: 'r1',
    panel: undefined,
  });
});

test('server fallback gracefully handles malformed URIs and blocks traversal without 500 crashes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rulecanvas-malformed-test-'));
  const server = createRuleCanvasServer({ store: new JsonStore(join(directory, 'store.json')) });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  // Malformed screen route delivers app shell (200 text/html) so client shows recovery screen
  const exactMalformedScreen = await fetch(`${base}/projects/%ZZ`);
  assert.equal(exactMalformedScreen.status, 200);
  assert.match(exactMalformedScreen.headers.get('content-type') || '', /text\/html/);
  const exactShellBody = await exactMalformedScreen.text();
  assert.match(exactShellBody, /RuleCanvas/);

  const malformedScreen = await fetch(`${base}/projects/proj%ZZ`);
  assert.equal(malformedScreen.status, 200);
  assert.match(malformedScreen.headers.get('content-type') || '', /text\/html/);
  const shellBody = await malformedScreen.text();
  assert.match(shellBody, /RuleCanvas/);

  // Screen route with encoded path separator in ID delivers app shell for client recovery
  const encodedSlashScreen = await fetch(`${base}/projects/proj%2F123`);
  assert.equal(encodedSlashScreen.status, 200);
  assert.match(encodedSlashScreen.headers.get('content-type') || '', /text\/html/);

  // Malformed asset request returns 400 Bad Request, NOT 500!
  const malformedAsset = await fetch(`${base}/assets/test%ZZ.js`);
  assert.equal(malformedAsset.status, 400);
  const assetError = await malformedAsset.json();
  assert.equal(assetError.error.code, 'static.malformed_uri');

  // Directory traversal in screen route is rejected from screen fallback and returns 404
  const traversalScreen = await fetch(`${base}/projects/%2e%2e/secret`);
  assert.equal(traversalScreen.status, 404);
});

function createMockHistory(initialEntries, initialIndex) {
  let entries = [...initialEntries];
  let states = entries.map((_, i) => ({ ruleCanvasIndex: i }));
  let currentIndex = initialIndex;

  return {
    get entries() {
      return [...entries];
    },
    get states() {
      return [...states];
    },
    get currentIndex() {
      return currentIndex;
    },
    getHistoryState: () => states[currentIndex],
    pushState: (state, title, url) => {
      // pushState truncates forward entries!
      entries = entries.slice(0, currentIndex + 1);
      states = states.slice(0, currentIndex + 1);
      entries.push(url);
      states.push(state);
      currentIndex = entries.length - 1;
    },
    replaceState: (state, title, url) => {
      if (url) entries[currentIndex] = url;
      states[currentIndex] = state;
    },
    go: (delta) => {
      const next = currentIndex + delta;
      if (next < 0 || next >= entries.length) {
        throw new Error(`Out of bounds history traversal: ${next} (entries: ${entries.length})`);
      }
      currentIndex = next;
    },
  };
}

test('guarded history controller reverts rejected popstate on Back via history.go(+1) without pushState', async () => {
  const initialStack = [
    '/projects',
    '/projects/p1',
    '/projects/p1/rules/r1',
    '/projects/p1/rules/r1?panel=test',
  ];
  // Start at index 2 (active editor for rule r1). Index 3 is forward entry.
  const mockHistory = createMockHistory(initialStack, 2);

  let isDirtyVal = true;
  let saveAttemptCount = 0;
  let saveErrorReceived = null;
  let currentNavigatedRoute = null;

  const controller = createGuardedHistoryController({
    getHistoryState: mockHistory.getHistoryState,
    pushState: mockHistory.pushState,
    replaceState: mockHistory.replaceState,
    go: mockHistory.go,
    isDirty: () => isDirtyVal,
    flushDraft: async () => {
      saveAttemptCount++;
      throw new Error('Save rejected: 500 server error');
    },
    onSaveError: (err) => {
      saveErrorReceived = err;
    },
    onNavigate: (route) => {
      currentNavigatedRoute = route;
    },
    parseRoute,
    isLeavingEditor: (route) => route.type !== 'editor' || route.ruleId !== 'r1',
  });

  assert.equal(controller.getIndex(), 2);
  assert.equal(mockHistory.currentIndex, 2);

  // User clicks browser Back: browser moves to index 1 (/projects/p1)
  mockHistory.go(-1);
  assert.equal(mockHistory.currentIndex, 1);

  // Popstate fires for index 1
  const result = await controller.handlePopState(
    mockHistory.states[1],
    '/projects/p1',
    ''
  );

  assert.equal(result.type, 'blocked');
  assert.equal(saveAttemptCount, 1);
  assert.match(saveErrorReceived.message, /Save rejected/);

  // VERIFY: Browser history index returned to 2 via history.go(+1)
  assert.equal(mockHistory.currentIndex, 2);
  assert.equal(controller.getIndex(), 2);

  // VERIFY: Forward stack was NOT truncated! All 4 entries remain!
  assert.equal(mockHistory.entries.length, 4);
  assert.equal(mockHistory.entries[3], '/projects/p1/rules/r1?panel=test');

  // VERIFY: Active route was NOT changed to the project view
  assert.equal(currentNavigatedRoute, null);

  // Revert popstate event arrives from history.go(+1)
  const revertEventResult = await controller.handlePopState(
    mockHistory.states[2],
    '/projects/p1/rules/r1',
    ''
  );
  assert.equal(revertEventResult.type, 'reverted');
  assert.equal(saveAttemptCount, 1, 'Revert popstate must not re-trigger save');
});

test('guarded history controller reverts rejected popstate on Forward via history.go(-1) without pushState', async () => {
  const initialStack = [
    '/projects',
    '/projects/p1/rules/r1',
    '/projects/p1',
  ];
  // Start at index 1 (active editor for rule r1). Index 2 is forward entry.
  const mockHistory = createMockHistory(initialStack, 1);

  let isDirtyVal = true;
  let saveErrorReceived = null;

  const controller = createGuardedHistoryController({
    getHistoryState: mockHistory.getHistoryState,
    pushState: mockHistory.pushState,
    replaceState: mockHistory.replaceState,
    go: mockHistory.go,
    isDirty: () => isDirtyVal,
    flushDraft: async () => {
      throw new Error('Save rejected: 409 conflict');
    },
    onSaveError: (err) => {
      saveErrorReceived = err;
    },
    parseRoute,
    isLeavingEditor: (route) => route.type !== 'editor' || route.ruleId !== 'r1',
  });

  assert.equal(controller.getIndex(), 1);

  // User clicks browser Forward: browser moves to index 2 (/projects/p1)
  mockHistory.go(1);
  assert.equal(mockHistory.currentIndex, 2);

  // Popstate fires for index 2
  const result = await controller.handlePopState(
    mockHistory.states[2],
    '/projects/p1',
    ''
  );

  assert.equal(result.type, 'blocked');
  assert.match(saveErrorReceived.message, /Save rejected/);

  // VERIFY: Browser history index returned to 1 via history.go(-1)
  assert.equal(mockHistory.currentIndex, 1);
  assert.equal(controller.getIndex(), 1);

  // VERIFY: Forward stack was NOT truncated!
  assert.equal(mockHistory.entries.length, 3);
  assert.equal(mockHistory.entries[2], '/projects/p1');
});

test('handles rapid Back/Forward popstates during in-flight save and preserves stack', async () => {
  const initialStack = [
    '/projects',
    '/projects/p1',
    '/projects/p1/rules/r1',
    '/projects/p1/rules/r1?panel=test',
  ];
  const mockHistory = createMockHistory(initialStack, 2);

  let resolveSave;
  let rejectSave;
  let savePromise = new Promise((res, rej) => {
    resolveSave = res;
    rejectSave = rej;
  });

  let flushCallCount = 0;
  let saveErrorReceived = null;

  const controller = createGuardedHistoryController({
    getHistoryState: mockHistory.getHistoryState,
    pushState: mockHistory.pushState,
    replaceState: mockHistory.replaceState,
    go: mockHistory.go,
    isDirty: () => true,
    flushDraft: async () => {
      flushCallCount++;
      return savePromise;
    },
    onSaveError: (err) => {
      saveErrorReceived = err;
    },
    parseRoute,
    isLeavingEditor: (route) => route.type !== 'editor' || route.ruleId !== 'r1',
  });

  // Step 1: User clicks Back -> browser moves to index 1 (/projects/p1)
  mockHistory.go(-1);
  const p1 = controller.handlePopState(mockHistory.states[1], '/projects/p1', '');

  // Step 2: While save is in flight, user rapidly clicks Forward -> browser moves back to index 2
  mockHistory.go(1);
  const p2 = controller.handlePopState(mockHistory.states[2], '/projects/p1/rules/r1', '');

  // Flush fails
  rejectSave(new Error('Network disconnected during save'));

  const [res1, res2] = await Promise.all([p1, p2]);
  assert.equal(res1.type, 'blocked');
  assert.equal(res2.type, 'blocked');
  assert.equal(flushCallCount, 1, 'Only one flush should execute for rapid transitions');

  // Since user pressed Back then Forward, browser ended up back at index 2 (origin)
  // deltaToOrigin is 2 - 2 = 0, no extra traversal needed
  assert.equal(mockHistory.currentIndex, 2);
  assert.equal(controller.getIndex(), 2);
  assert.equal(mockHistory.entries.length, 4);
});

test('subsequent navigation succeeds after rejected popstate', async () => {
  const initialStack = ['/projects', '/projects/p1/rules/r1'];
  const mockHistory = createMockHistory(initialStack, 1);

  let isDirtyVal = true;
  let shouldFail = true;
  let navigatedRoute = null;

  const controller = createGuardedHistoryController({
    getHistoryState: mockHistory.getHistoryState,
    pushState: mockHistory.pushState,
    replaceState: mockHistory.replaceState,
    go: mockHistory.go,
    isDirty: () => isDirtyVal,
    flushDraft: async () => {
      if (shouldFail) throw new Error('First save failed');
      return { ok: true };
    },
    onSaveError: () => {},
    onNavigate: (r) => {
      navigatedRoute = r;
    },
    parseRoute,
    isLeavingEditor: (route) => route.type !== 'editor' || route.ruleId !== 'r1',
  });

  // First Back attempt fails
  mockHistory.go(-1);
  const firstPop = await controller.handlePopState(mockHistory.states[0], '/projects', '');
  assert.equal(firstPop.type, 'blocked');
  assert.equal(mockHistory.currentIndex, 1);

  // Consume revert popstate
  await controller.handlePopState(mockHistory.states[1], '/projects/p1/rules/r1', '');

  // Network recovers, user initiates navigation to /projects
  shouldFail = false;
  isDirtyVal = true;
  const navResult = await controller.navigateTo({ type: 'projects' }, '/projects');
  assert.equal(navResult.allowed, true);
  assert.equal(navigatedRoute.type, 'projects');
  assert.equal(mockHistory.currentIndex, 2);
  assert.equal(mockHistory.entries[2], '/projects');
});

test('version history close destination preserves opener (overview, editor with panel, and direct URL fallback)', async () => {
  // Helper implementing the opener destination resolution logic from App.tsx
  function resolveCloseDestination(openerRoute, currentRoute, fallbackPanel = 'properties') {
    if (openerRoute) return openerRoute;
    if (currentRoute.type === 'versions') {
      return {
        type: 'editor',
        projectId: currentRoute.projectId,
        ruleId: currentRoute.ruleId,
        panel: fallbackPanel,
      };
    }
    return { type: 'projects' };
  }

  // 1. Opened from Project Overview -> returns to Project Overview
  const overviewOpener = { type: 'project', projectId: 'proj-123' };
  const versionsRouteFromOverview = { type: 'versions', projectId: 'proj-123', ruleId: 'rule-456' };
  const destFromOverview = resolveCloseDestination(overviewOpener, versionsRouteFromOverview);
  assert.deepEqual(destFromOverview, { type: 'project', projectId: 'proj-123' });
  assert.equal(buildRouteUrl(destFromOverview), '/projects/proj-123');

  // 2. Opened from Editor with panel -> returns to Editor with active panel
  const editorOpener = { type: 'editor', projectId: 'proj-123', ruleId: 'rule-456', panel: 'schema' };
  const versionsRouteFromEditor = { type: 'versions', projectId: 'proj-123', ruleId: 'rule-456' };
  const destFromEditor = resolveCloseDestination(editorOpener, versionsRouteFromEditor);
  assert.deepEqual(destFromEditor, { type: 'editor', projectId: 'proj-123', ruleId: 'rule-456', panel: 'schema' });
  assert.equal(buildRouteUrl(destFromEditor), '/projects/proj-123/rules/rule-456?panel=schema');

  // 3. Direct URL deep-link fallback (no opener recorded) -> falls back to Editor
  const directVersionsRoute = { type: 'versions', projectId: 'proj-123', ruleId: 'rule-456', versionId: 'v1' };
  const destFromDirect = resolveCloseDestination(null, directVersionsRoute, 'test');
  assert.deepEqual(destFromDirect, { type: 'editor', projectId: 'proj-123', ruleId: 'rule-456', panel: 'test' });
  assert.equal(buildRouteUrl(destFromDirect), '/projects/proj-123/rules/rule-456?panel=test');

  // 4. History controller traversal with browser Back from version modal to Project Overview
  const stack = ['/projects/proj-123', '/projects/proj-123/rules/rule-456/versions'];
  const mockHistory = createMockHistory(stack, 1);
  let activeRoute = versionsRouteFromOverview;

  const controller = createGuardedHistoryController({
    getHistoryState: mockHistory.getHistoryState,
    pushState: mockHistory.pushState,
    replaceState: mockHistory.replaceState,
    go: mockHistory.go,
    isDirty: () => false,
    onNavigate: (r) => { activeRoute = r; },
    parseRoute,
    isLeavingEditor: () => false,
  });

  // User presses browser Back while modal is open
  mockHistory.go(-1);
  const popResult = await controller.handlePopState(mockHistory.states[0], '/projects/proj-123', '');
  assert.equal(popResult.type, 'navigated');
  assert.deepEqual(activeRoute, { type: 'project', projectId: 'proj-123' });
  assert.equal(mockHistory.currentIndex, 0);
  assert.equal(controller.getIndex(), 0);
});
