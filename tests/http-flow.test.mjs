import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuleCanvasServer } from '../src/server.mjs';
import { JsonStore } from '../src/storage.mjs';
import { validGraph } from './fixtures.mjs';

async function startServer(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rulecanvas-test-'));
  const server = createRuleCanvasServer({ store: new JsonStore(join(directory, 'store.json')) });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${address.port}`;
}

async function jsonRequest(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
  });
  return { status: response.status, body: await response.json() };
}

test('creates and reloads a project and ruleset through the local HTTP API', async (t) => {
  const base = await startServer(t);
  const createdProject = await jsonRequest(base, '/api/projects', {
    method: 'POST', body: JSON.stringify({ name: 'Scholarship Review' }),
  });
  assert.equal(createdProject.status, 201);
  assert.equal(createdProject.body.project.slug, 'scholarship-review');

  const createdRuleset = await jsonRequest(base, `/api/projects/${createdProject.body.project.id}/rulesets`, {
    method: 'POST', body: JSON.stringify({ name: 'Eligibility' }),
  });
  assert.equal(createdRuleset.status, 201);
  assert.equal(createdRuleset.body.ruleset.revision, 1);

  const saved = await jsonRequest(base, `/api/rulesets/${createdRuleset.body.ruleset.id}`, {
    method: 'PUT', body: JSON.stringify({
      expectedRevision: 1, name: 'Eligibility', graph: validGraph(),
    }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ruleset.revision, 2);

  const validation = await jsonRequest(base, `/api/rulesets/${createdRuleset.body.ruleset.id}/validate`, {
    method: 'POST', body: JSON.stringify({}),
  });
  assert.deepEqual(validation.body, { valid: true, errors: [] });

  const evaluation = await jsonRequest(base, `/api/rulesets/${createdRuleset.body.ruleset.id}/evaluate`, {
    method: 'POST', body: JSON.stringify({ input: { score: 8, tier: 'priority' } }),
  });
  assert.equal(evaluation.body.ok, true);
  assert.deepEqual(evaluation.body.result, { decision: 'eligible' });
  assert.deepEqual(evaluation.body.trace.map((row) => row.nodeId), ['start', 'score-check', 'eligible']);

  const reloaded = await jsonRequest(base, `/api/projects/${createdProject.body.project.id}`);
  assert.equal(reloaded.body.project.rulesets[0].revision, 2);
  assert.deepEqual(reloaded.body.project.rulesets[0].graph, validGraph());
});

test('persists nested AND OR groups and replays their typed evaluation trace', async (t) => {
  const base = await startServer(t);
  const project = (await jsonRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Grouped rules' }) })).body.project;
  const ruleset = (await jsonRequest(base, `/api/projects/${project.id}/rulesets`, { method: 'POST', body: JSON.stringify({ name: 'Precedence' }) })).body.ruleset;
  const graph = {
    schema: [{ id: 'score', name: 'score', type: 'number', required: true }],
    nodes: [
      { id: 'start', type: 'start', x: 40, y: 80 },
      { id: 'logic', type: 'group', operator: 'or', terms: [
        { type: 'condition', fieldId: 'score', operator: 'gte', value: 8 },
        { type: 'group', operator: 'and', terms: [
          { type: 'condition', fieldId: 'score', operator: 'gte', value: 5 },
          { type: 'condition', fieldId: 'score', operator: 'lte', value: 7 },
        ] },
      ], x: 330, y: 80 },
      { id: 'yes', type: 'outcome', label: 'Accept', result: { decision: 'accept' }, x: 650, y: 20 },
      { id: 'no', type: 'outcome', label: 'Review', result: { decision: 'review' }, x: 650, y: 240 },
    ],
    edges: [
      { id: 'start-logic', from: 'start', fromPort: 'next', to: 'logic', toPort: 'in' },
      { id: 'logic-yes', from: 'logic', fromPort: 'true', to: 'yes', toPort: 'in' },
      { id: 'logic-no', from: 'logic', fromPort: 'false', to: 'no', toPort: 'in' },
    ],
  };
  const saved = await jsonRequest(base, `/api/rulesets/${ruleset.id}`, { method: 'PUT', body: JSON.stringify({ expectedRevision: 1, name: ruleset.name, graph }) });
  assert.equal(saved.status, 200);
  const evaluation = await jsonRequest(base, `/api/rulesets/${ruleset.id}/evaluate`, { method: 'POST', body: JSON.stringify({ input: { score: 6 } }) });
  assert.equal(evaluation.body.ok, true);
  assert.deepEqual(evaluation.body.result, { decision: 'accept' });
  assert.equal(evaluation.body.trace.find((entry) => entry.kind === 'group').terms[1].operator, 'and');
  assert.equal((await jsonRequest(base, `/api/rulesets/${ruleset.id}/evaluate`, { method: 'POST', body: JSON.stringify({ input: { score: 4 } }) })).body.result.decision, 'review');
  const version = await jsonRequest(base, `/api/rulesets/${ruleset.id}/versions`, { method: 'POST', body: JSON.stringify({ expectedRevision: 2 }) });
  assert.equal(version.status, 201);
  const reopened = await jsonRequest(base, `/api/rulesets/${ruleset.id}`);
  assert.deepEqual(reopened.body.ruleset.graph, graph);
  const replay = await jsonRequest(base, `/api/rulesets/${ruleset.id}/versions/${version.body.version.id}/evaluate`, { method: 'POST', body: JSON.stringify({ input: { score: 6 } }) });
  assert.deepEqual(replay.body.result, { decision: 'accept' });
  assert.deepEqual(replay.body.trace, evaluation.body.trace);
});

test('rejects stale draft writes instead of silently overwriting a newer revision', async (t) => {
  const base = await startServer(t);
  const project = (await jsonRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Concurrent edits' }) })).body.project;
  const ruleset = (await jsonRequest(base, `/api/projects/${project.id}/rulesets`, { method: 'POST', body: JSON.stringify({ name: 'Draft' }) })).body.ruleset;
  const firstGraph = validGraph();
  const secondGraph = validGraph();
  firstGraph.nodes.find((node) => node.id === 'score-check').value = 8;
  secondGraph.nodes.find((node) => node.id === 'score-check').value = 9;
  const [one, two] = await Promise.all([
    jsonRequest(base, `/api/rulesets/${ruleset.id}`, { method: 'PUT', body: JSON.stringify({ expectedRevision: 1, name: 'Draft', graph: firstGraph }) }),
    jsonRequest(base, `/api/rulesets/${ruleset.id}`, { method: 'PUT', body: JSON.stringify({ expectedRevision: 1, name: 'Draft', graph: secondGraph }) }),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  const winner = one.status === 200 ? one : two;
  const conflict = one.status === 409 ? one : two;
  assert.equal(winner.body.ruleset.revision, 2);
  assert.equal(conflict.body.error.code, 'ruleset.conflict');
  const persisted = await jsonRequest(base, `/api/rulesets/${ruleset.id}`);
  assert.deepEqual(persisted.body.ruleset.graph, winner.body.ruleset.graph, 'losing request must not overwrite winning graph');
});

test('creates validated immutable versions with replay and local audit evidence', async (t) => {
  const base = await startServer(t);
  const project = (await jsonRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Versioned decisions' }) })).body.project;
  const ruleset = (await jsonRequest(base, `/api/projects/${project.id}/rulesets`, { method: 'POST', body: JSON.stringify({ name: 'Eligibility' }) })).body.ruleset;
  const saved = await jsonRequest(base, `/api/rulesets/${ruleset.id}`, { method: 'PUT', body: JSON.stringify({ expectedRevision: 1, name: 'Eligibility', graph: validGraph() }) });
  assert.equal(saved.status, 200);

  const created = await jsonRequest(base, `/api/rulesets/${ruleset.id}/versions`, { method: 'POST', body: JSON.stringify({ expectedRevision: 2 }) });
  assert.equal(created.status, 201);
  const version = created.body.version;
  assert.equal(version.versionNumber, 1);
  assert.match(version.graphHash, /^[a-f0-9]{64}$/);

  const replay = await jsonRequest(base, `/api/rulesets/${ruleset.id}/versions/${version.id}/evaluate`, { method: 'POST', body: JSON.stringify({ input: { score: 8, tier: 'priority' } }) });
  assert.deepEqual(replay.body.result, { decision: 'eligible' });
  assert.equal(replay.body.version.graphHash, version.graphHash);
  const duplicate = await jsonRequest(base, `/api/rulesets/${ruleset.id}/versions`, { method: 'POST', body: JSON.stringify({ expectedRevision: 2 }) });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'version.unchanged');

  const edited = validGraph();
  edited.nodes.find((node) => node.id === 'eligible').result = { decision: 'edited draft' };
  const savedAgain = await jsonRequest(base, `/api/rulesets/${ruleset.id}`, { method: 'PUT', body: JSON.stringify({ expectedRevision: 2, name: 'Eligibility', graph: edited }) });
  assert.equal(savedAgain.status, 200);
  const oldVersion = await jsonRequest(base, `/api/rulesets/${ruleset.id}/versions/${version.id}`);
  assert.deepEqual(oldVersion.body.version.graph, validGraph());
  const oldReplay = await jsonRequest(base, `/api/rulesets/${ruleset.id}/versions/${version.id}/evaluate`, { method: 'POST', body: JSON.stringify({ input: { score: 8, tier: 'priority' } }) });
  assert.deepEqual(oldReplay.body.result, { decision: 'eligible' });
  const draftReplay = await jsonRequest(base, `/api/rulesets/${ruleset.id}/evaluate`, { method: 'POST', body: JSON.stringify({ input: { score: 8, tier: 'priority' } }) });
  assert.deepEqual(draftReplay.body.result, { decision: 'edited draft' });
  const secondVersion = await jsonRequest(base, `/api/rulesets/${ruleset.id}/versions`, { method: 'POST', body: JSON.stringify({ expectedRevision: 3 }) });
  assert.equal(secondVersion.status, 201);
  assert.equal(secondVersion.body.version.versionNumber, 2);
  const list = await jsonRequest(base, `/api/rulesets/${ruleset.id}/versions`);
  assert.equal(list.body.versions.length, 2);
  assert.deepEqual(list.body.versions.map((item) => item.versionNumber), [2, 1]);
  assert.equal('graph' in list.body.versions[0], false);

  const audit = await jsonRequest(base, `/api/projects/${project.id}/audit`);
  assert.deepEqual(audit.body.events.map((event) => event.type).sort(), ['project.created', 'ruleset.created', 'ruleset.draft.saved', 'ruleset.draft.saved', 'ruleset.version.created', 'ruleset.version.created'].sort());
  assert.ok(audit.body.events.some((event) => event.type === 'ruleset.version.created' && event.details.graphHash === version.graphHash));
});

test('refuses invalid or stale version snapshots', async (t) => {
  const base = await startServer(t);
  const project = (await jsonRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Invalid version' }) })).body.project;
  const ruleset = (await jsonRequest(base, `/api/projects/${project.id}/rulesets`, { method: 'POST', body: JSON.stringify({ name: 'Draft' }) })).body.ruleset;
  const invalid = await jsonRequest(base, `/api/rulesets/${ruleset.id}/versions`, { method: 'POST', body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, 'version.validation');
  assert.ok(invalid.body.error.details.errors.length > 0);
  const stale = await jsonRequest(base, `/api/rulesets/${ruleset.id}/versions`, { method: 'POST', body: JSON.stringify({ expectedRevision: 2 }) });
  assert.equal(stale.status, 409);
});

test('serves app assets from the public directory and blocks traversal', async (t) => {
  const base = await startServer(t);
  const index = await fetch(base);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /RuleCanvas/);
  assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(index.headers.get('content-security-policy'), /style-src 'self'/);
  const appScript = await fetch(`${base}/app.js`);
  const historyModule = await fetch(`${base}/history.js`);
  const graphEditingModule = await fetch(`${base}/graph-editing.js`);
  const conflictCopyModule = await fetch(`${base}/conflict-copy.js`);
  const transferModule = await fetch(`${base}/rule-transfer.js`);
  const typedInputModule = await fetch(`${base}/typed-input.js`);
  const saveCoordinationModule = await fetch(`${base}/save-coordination.js`);
  assert.equal(appScript.status, 200);
  assert.match(appScript.headers.get('content-type'), /javascript/);
  assert.equal(historyModule.status, 200);
  assert.match(historyModule.headers.get('content-type'), /javascript/);
  assert.equal(graphEditingModule.status, 200);
  assert.match(graphEditingModule.headers.get('content-type'), /javascript/);
  assert.equal(conflictCopyModule.status, 200);
  assert.match(conflictCopyModule.headers.get('content-type'), /javascript/);
  assert.equal(transferModule.status, 200);
  assert.match(transferModule.headers.get('content-type'), /javascript/);
  assert.equal(typedInputModule.status, 200);
  assert.match(typedInputModule.headers.get('content-type'), /javascript/);
  assert.equal(saveCoordinationModule.status, 200);
  assert.match(saveCoordinationModule.headers.get('content-type'), /javascript/);
  const traversal = await fetch(`${base}/%2e%2e/src/server.mjs`);
  assert.equal(traversal.status, 404);
});

test('returns client errors for malformed and non-object JSON request bodies', async (t) => {
  const base = await startServer(t);
  const nullBody = await jsonRequest(base, '/api/projects', { method: 'POST', body: 'null' });
  assert.equal(nullBody.status, 400);
  assert.equal(nullBody.body.error.code, 'request.shape');

  const arrayResponse = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' });
  assert.equal(arrayResponse.status, 400);
  assert.equal((await arrayResponse.json()).error.code, 'request.shape');

  const malformedResponse = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformedResponse.status, 400);
  assert.equal((await malformedResponse.json()).error.code, 'request.json');
});

test('health reports recovery after the app loads a prior local checkpoint', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rulecanvas-health-recovery-'));
  const store = new JsonStore(join(directory, 'store.json'));
  await store.createProject('First checkpoint');
  await store.createProject('Current state');
  await writeFile(join(directory, 'store.json'), '{damaged');
  const server = createRuleCanvasServer({ store });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const projects = await jsonRequest(base, '/api/projects');
  assert.equal(projects.status, 200);
  assert.deepEqual(projects.body.projects.map((project) => project.name), ['First checkpoint']);
  const health = await jsonRequest(base, '/api/health');
  assert.equal(health.body.recovered, true);
});

test('creates and evaluates an unconditional ruleset with empty schema through HTTP API', async (t) => {
  const base = await startServer(t);
  const project = (await jsonRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Unconditional Test' }) })).body.project;
  const ruleset = (await jsonRequest(base, `/api/projects/${project.id}/rulesets`, { method: 'POST', body: JSON.stringify({ name: 'Always Approve' }) })).body.ruleset;
  const graph = {
    schema: [],
    nodes: [
      { id: 'start', type: 'start', x: 100, y: 220 },
      { id: 'outcome-1', type: 'outcome', x: 710, y: 135, label: 'Approved', result: 'approved' },
    ],
    edges: [
      { id: 'e1', from: 'start', fromPort: 'next', to: 'outcome-1', toPort: 'in' },
    ],
  };
  const save = await jsonRequest(base, `/api/rulesets/${ruleset.id}`, { method: 'PUT', body: JSON.stringify({ expectedRevision: 1, name: ruleset.name, graph }) });
  assert.equal(save.status, 200);

  const validation = await jsonRequest(base, `/api/rulesets/${ruleset.id}/validate`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(validation.body.valid, true);
  assert.deepEqual(validation.body.errors, []);

  const evaluation = await jsonRequest(base, `/api/rulesets/${ruleset.id}/evaluate`, { method: 'POST', body: JSON.stringify({ input: {} }) });
  assert.equal(evaluation.body.ok, true);
  assert.equal(evaluation.body.result, 'approved');
  assert.equal(evaluation.body.outcomeId, 'outcome-1');
  assert.deepEqual(evaluation.body.trace.map((item) => item.nodeId), ['start', 'outcome-1']);
});

test('evaluates ruleset with default schema field name Input 1 through HTTP API', async (t) => {
  const base = await startServer(t);
  const project = (await jsonRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Default Field Name' }) })).body.project;
  const ruleset = (await jsonRequest(base, `/api/projects/${project.id}/rulesets`, { method: 'POST', body: JSON.stringify({ name: 'Input 1 Rule' }) })).body.ruleset;
  const graph = {
    schema: [
      { id: 'f-1', name: 'Input 1', type: 'string', required: true },
    ],
    nodes: [
      { id: 'start', type: 'start', x: 100, y: 220 },
      { id: 'cond-1', type: 'condition', x: 400, y: 220, fieldId: 'f-1', operator: 'eq', value: 'hello' },
      { id: 'outcome-yes', type: 'outcome', x: 700, y: 100, label: 'Yes', result: true },
      { id: 'outcome-no', type: 'outcome', x: 700, y: 300, label: 'No', result: false },
    ],
    edges: [
      { id: 'e1', from: 'start', fromPort: 'next', to: 'cond-1', toPort: 'in' },
      { id: 'e2', from: 'cond-1', fromPort: 'true', to: 'outcome-yes', toPort: 'in' },
      { id: 'e3', from: 'cond-1', fromPort: 'false', to: 'outcome-no', toPort: 'in' },
    ],
  };
  const save = await jsonRequest(base, `/api/rulesets/${ruleset.id}`, { method: 'PUT', body: JSON.stringify({ expectedRevision: 1, name: ruleset.name, graph }) });
  assert.equal(save.status, 200);

  const match = await jsonRequest(base, `/api/rulesets/${ruleset.id}/evaluate`, { method: 'POST', body: JSON.stringify({ input: { 'Input 1': 'hello' } }) });
  assert.equal(match.body.ok, true);
  assert.equal(match.body.result, true);

  const noMatch = await jsonRequest(base, `/api/rulesets/${ruleset.id}/evaluate`, { method: 'POST', body: JSON.stringify({ input: { 'Input 1': 'world' } }) });
  assert.equal(noMatch.body.ok, true);
  assert.equal(noMatch.body.result, false);
});
