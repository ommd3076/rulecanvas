import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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

test('rejects stale draft writes instead of silently overwriting a newer revision', async (t) => {
  const base = await startServer(t);
  const project = (await jsonRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Concurrent edits' }) })).body.project;
  const ruleset = (await jsonRequest(base, `/api/projects/${project.id}/rulesets`, { method: 'POST', body: JSON.stringify({ name: 'Draft' }) })).body.ruleset;
  const body = JSON.stringify({ expectedRevision: 1, name: 'Draft', graph: validGraph() });
  const [one, two] = await Promise.all([
    jsonRequest(base, `/api/rulesets/${ruleset.id}`, { method: 'PUT', body }),
    jsonRequest(base, `/api/rulesets/${ruleset.id}`, { method: 'PUT', body }),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  const winner = one.status === 200 ? one : two;
  const conflict = one.status === 409 ? one : two;
  assert.equal(winner.body.ruleset.revision, 2);
  assert.equal(conflict.body.error.code, 'ruleset.conflict');
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
  const list = await jsonRequest(base, `/api/rulesets/${ruleset.id}/versions`);
  assert.equal(list.body.versions.length, 1);
  assert.equal('graph' in list.body.versions[0], false);

  const audit = await jsonRequest(base, `/api/projects/${project.id}/audit`);
  assert.deepEqual(audit.body.events.map((event) => event.type).sort(), ['project.created', 'ruleset.created', 'ruleset.draft.saved', 'ruleset.draft.saved', 'ruleset.version.created'].sort());
  assert.equal(audit.body.events.find((event) => event.type === 'ruleset.version.created').details.graphHash, version.graphHash);
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
  assert.equal(appScript.status, 200);
  assert.match(appScript.headers.get('content-type'), /javascript/);
  assert.equal(historyModule.status, 200);
  assert.match(historyModule.headers.get('content-type'), /javascript/);
  assert.equal(graphEditingModule.status, 200);
  assert.match(graphEditingModule.headers.get('content-type'), /javascript/);
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
