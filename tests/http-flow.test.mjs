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

test('serves app assets from the public directory and blocks traversal', async (t) => {
  const base = await startServer(t);
  const index = await fetch(base);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /RuleCanvas/);
  const traversal = await fetch(`${base}/%2e%2e/src/server.mjs`);
  assert.equal(traversal.status, 404);
});
