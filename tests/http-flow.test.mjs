import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuleCanvasServer } from '../src/server.mjs';
import { JsonStore } from '../src/storage.mjs';
import { validGraph } from './fixtures.mjs';

async function startServer(t, optionsFor = (directory) => ({ store: new JsonStore(join(directory, 'store.json')) })) {
  const directory = await mkdtemp(join(tmpdir(), 'rulecanvas-test-'));
  const server = createRuleCanvasServer(optionsFor(directory));
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

test('hosted API requires a signed identity and confines requests to the authorized store', async (t) => {
  const key = Buffer.alloc(32, 7);
  let ready = true;
  const base = await startServer(t, (directory) => {
    const stores = new Map(['alice', 'bob'].map((subject) => [subject, new JsonStore(join(directory, `${subject}.json`))]));
    return { hosted: {
      assertion: { secret: key, issuer: 'test-proxy', audience: 'rulecanvas', now: 100 },
      checkReadiness: async () => { if (!ready) throw new Error('Database unavailable'); },
      resolveAuthorizedStore: ({ principal, method }) => method === 'POST' && principal.subject === 'bob' ? null : stores.get(principal.subject),
    } };
  });
  const authorize = (subject) => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const payload = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: 'test-proxy', aud: 'rulecanvas', sub: subject, iat: 90, exp: 120 })}`;
    return { 'x-rulecanvas-assertion': `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}` };
  };

  const anonymous = await jsonRequest(base, '/api/projects', { headers: { 'x-forwarded-user': 'alice' } });
  assert.deepEqual(await jsonRequest(base, '/health/live'), { status: 200, body: { ok: true } });
  assert.deepEqual(await jsonRequest(base, '/health/ready'), { status: 200, body: { ok: true } });
  ready = false;
  assert.deepEqual(await jsonRequest(base, '/health/ready'), { status: 503, body: { ok: false } });
  assert.deepEqual(await jsonRequest(base, '/health/live'), { status: 200, body: { ok: true } });
  assert.equal(anonymous.status, 401);
  assert.equal((await jsonRequest(base, '/api/health')).status, 401);
  assert.equal((await jsonRequest(base, '/api/projects', { headers: authorize('stranger') })).status, 403);

  const newProject = { method: 'POST', body: JSON.stringify({ name: 'Alice private project' }) };
  const created = await jsonRequest(base, '/api/projects', { ...newProject, headers: authorize('alice') });
  assert.equal(created.status, 201);
  const projectPath = `/api/projects/${created.body.project.id}`;
  assert.equal((await jsonRequest(base, projectPath, { headers: authorize('alice') })).status, 200);
  assert.equal((await jsonRequest(base, projectPath, { headers: { ...authorize('bob'), 'x-forwarded-user': 'alice' } })).status, 404);
  assert.equal((await jsonRequest(base, `${projectPath}/runs`, { headers: authorize('bob') })).status, 404);
  assert.equal((await jsonRequest(base, '/api/projects', { ...newProject, headers: authorize('bob') })).status, 403);
});

async function jsonRequest(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
  });
  return { status: response.status, body: await response.json() };
}

test('hosted release actions use stored versions and server-assigned roles', async (t) => {
  const secret = Buffer.alloc(32, 9);
  const memberRoles = new Map([['author', ['author']], ['reviewer', ['reviewer']], ['deployer', ['deployer']]]);
  let releaseStoreFile;
  const base = await startServer(t, (directory) => {
    releaseStoreFile = join(directory, 'releases.json');
    const store = new JsonStore(releaseStoreFile);
    return { hosted: {
      assertion: { secret, issuer: 'test-proxy', audience: 'rulecanvas', now: 100 },
      resolveAuthorizedStore: ({ principal }) => memberRoles.has(principal.subject) ? store : null,
      resolveReleaseRoles: ({ principal }) => memberRoles.get(principal.subject),
    } };
  });
  const authorize = (subject) => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const message = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: 'test-proxy', aud: 'rulecanvas', sub: subject, iat: 90, exp: 120 })}`;
    return { 'x-rulecanvas-assertion': `${message}.${createHmac('sha256', secret).update(message).digest('base64url')}` };
  };
  const post = (path, fields, subject = 'author', method = 'POST') => jsonRequest(base, path, {
    method, body: JSON.stringify(fields), headers: authorize(subject),
  });
  const project = (await post('/api/projects', { name: 'Governed releases' })).body.project;
  const rulesetsPath = `/api/projects/${project.id}/rulesets`;
  const ruleset = (await post(rulesetsPath, { name: 'Decision' })).body.ruleset;
  const rulePath = `/api/rulesets/${ruleset.id}`;
  await post(rulePath, { expectedRevision: ruleset.revision, graph: validGraph(), name: ruleset.name }, 'author', 'PUT');
  const version = (await post(`${rulePath}/versions`, { expectedRevision: ruleset.revision + 1 })).body.version;
  const releases = `${rulePath}/releases`;
  const runtime = `${releases}/production/evaluate`;
  const selected = { versionId: version.id, versionHash: version.graphHash, rationale: 'Validated against documented sample inputs' };

  assert.equal((await post(runtime, { input: { score: 8 } })).status, 404);
  assert.equal((await post(releases, { ...selected, action: 'propose', versionId: '00000000-0000-0000-0000-000000000000' })).status, 404);
  assert.equal((await post(releases, { ...selected, action: 'propose', versionHash: 'f'.repeat(64) })).status, 409);
  assert.equal((await post(releases, { ...selected, action: 'propose' })).status, 200);
  assert.equal((await post(releases, { ...selected, action: 'approve', actor: { id: 'reviewer', roles: ['reviewer'] } })).status, 403);
  assert.equal((await post(releases, { ...selected, action: 'approve' }, 'reviewer')).status, 200);
  const activation = { ...selected, action: 'activate', environment: 'production', expectedActiveVersionId: null };
  assert.equal((await post(releases, activation, 'deployer')).status, 200);
  assert.equal((await post(releases, activation, 'deployer')).status, 409);

  const nextGraph = validGraph();
  nextGraph.nodes.find((node) => node.id === 'score-check').value = 9;
  assert.equal((await post(rulePath, { expectedRevision: ruleset.revision + 1, graph: nextGraph, name: ruleset.name }, 'author', 'PUT')).status, 200);
  const nextVersion = (await post(`${rulePath}/versions`, { expectedRevision: ruleset.revision + 2 })).body.version;
  const beforeActivation = await post(runtime, { input: { score: 8 } });
  assert.equal(beforeActivation.body.version.id, version.id);
  assert.equal(beforeActivation.body.result.decision, 'eligible');
  const next = { ...selected, versionId: nextVersion.id, versionHash: nextVersion.graphHash };
  assert.equal((await post(releases, { ...next, action: 'propose' })).status, 200);
  assert.equal((await post(releases, { ...next, action: 'approve' }, 'reviewer')).status, 200);
  assert.equal((await post(releases, { ...activation, ...next, expectedActiveVersionId: version.id }, 'deployer')).status, 200);
  const afterActivation = await post(runtime, { input: { score: 8 } });
  assert.equal(afterActivation.body.version.id, nextVersion.id);
  assert.equal(afterActivation.body.result.decision, 'review');
  assert.equal((await post(releases, { ...activation, action: 'rollback', expectedActiveVersionId: nextVersion.id }, 'deployer')).status, 200);
  const afterRollback = await post(runtime, { input: { score: 8 } });
  assert.equal(afterRollback.body.version.id, version.id);
  assert.equal(afterRollback.body.result.decision, 'eligible');
  const policy = await jsonRequest(base, releases, { headers: authorize('reviewer') });
  assert.equal(policy.status, 200);
  assert.match(JSON.stringify(policy.body.policy), new RegExp(version.id));
  const reopened = new JsonStore(releaseStoreFile);
  assert.equal((await reopened.getActiveReleaseVersion(ruleset.id, 'production')).id, version.id);
  const events = await reopened.listAuditEvents(project.id, ruleset.id);
  const rollback = events.find((event) => event.type === 'release.rollback');
  assert.equal(rollback.actor, 'deployer');
  assert.equal(rollback.details.environment, 'production');
  assert.equal(rollback.details.versionId, version.id);
  assert.equal(rollback.details.rationale, selected.rationale);
  assert.equal(events.find((event) => event.type === 'release.approve').actor, 'reviewer');
  assert.equal(events.find((event) => event.type === 'ruleset.created').actor, 'local workspace');
  const secondary = await reopened.createProject('Unrelated project');
  const secondaryEvents = await reopened.listAuditEvents(secondary.id);
  assert.deepEqual(secondaryEvents.map((event) => event.type), ['project.created']);
});

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

test('guided example creation is atomic and idempotent across concurrent requests and retries', async (t) => {
  const base = await startServer(t);
  const requests = await Promise.all(Array.from({ length: 6 }, () =>
    jsonRequest(base, '/api/examples/eligibility', { method: 'POST' })
  ));

  assert.ok(requests.every(({ status }) => status === 200 || status === 201));
  assert.equal(requests.filter(({ status }) => status === 201).length, 1);
  assert.equal(new Set(requests.map(({ body }) => body.project.id)).size, 1);
  assert.equal(new Set(requests.map(({ body }) => body.ruleset.id)).size, 1);
  assert.equal(requests.filter(({ body }) => body.created).length, 1);

  const retry = await jsonRequest(base, '/api/examples/eligibility', { method: 'POST' });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.created, false);
  assert.equal(retry.body.project.id, requests[0].body.project.id);

  const projects = await jsonRequest(base, '/api/projects');
  assert.equal(projects.body.projects.length, 1);
  assert.equal(projects.body.projects[0].rulesetCount, 1);
  const ruleset = requests[0].body.ruleset;
  assert.equal(ruleset.revision, 1);
  assert.equal((await jsonRequest(base, `/api/rulesets/${ruleset.id}/validate`, {
    method: 'POST', body: JSON.stringify({}),
  })).body.valid, true);
  const evaluation = await jsonRequest(base, `/api/rulesets/${ruleset.id}/evaluate`, {
    method: 'POST', body: JSON.stringify({ input: { score: 8 } }),
  });
  assert.equal(evaluation.body.ok, true);
  assert.equal(evaluation.body.result.decision, 'eligible');
  assert.deepEqual(evaluation.body.trace.map((step) => step.kind), ['start', 'condition', 'outcome']);

  const audit = await jsonRequest(base, `/api/projects/${requests[0].body.project.id}/audit`);
  assert.deepEqual(audit.body.events.map((event) => event.type).sort(), ['project.created', 'ruleset.created']);
});

test('records draft and immutable-version evaluations as project-scoped summaries without inputs or traces', async (t) => {
  const base = await startServer(t);
  const firstProject = (await jsonRequest(base, '/api/projects', {
    method: 'POST', body: JSON.stringify({ name: 'Run History A' }),
  })).body.project;
  const secondProject = (await jsonRequest(base, '/api/projects', {
    method: 'POST', body: JSON.stringify({ name: 'Run History B' }),
  })).body.project;
  const ruleset = (await jsonRequest(base, `/api/projects/${firstProject.id}/rulesets`, {
    method: 'POST', body: JSON.stringify({ name: 'Eligibility' }),
  })).body.ruleset;

  assert.deepEqual((await jsonRequest(base, `/api/projects/${firstProject.id}/runs`)).body.runs, []);
  const saved = await jsonRequest(base, `/api/rulesets/${ruleset.id}`, {
    method: 'PUT', body: JSON.stringify({ expectedRevision: 1, name: ruleset.name, graph: validGraph() }),
  });
  assert.equal(saved.body.ruleset.revision, 2);

  const draftRun = await jsonRequest(base, `/api/rulesets/${ruleset.id}/evaluate`, {
    method: 'POST', body: JSON.stringify({ input: { score: 8, tier: 'priority' }, expectedRevision: 2 }),
  });
  assert.equal(draftRun.body.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const failedRun = await jsonRequest(base, `/api/rulesets/${ruleset.id}/evaluate`, {
    method: 'POST', body: JSON.stringify({ input: { score: 'not-a-number' }, expectedRevision: 2 }),
  });
  assert.equal(failedRun.body.ok, false);
  const createdVersion = await jsonRequest(base, `/api/rulesets/${ruleset.id}/versions`, {
    method: 'POST', body: JSON.stringify({ expectedRevision: 2 }),
  });
  assert.equal(createdVersion.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const version = createdVersion.body.version;
  const versionRun = await jsonRequest(base, `/api/rulesets/${ruleset.id}/versions/${version.id}/evaluate`, {
    method: 'POST', body: JSON.stringify({ input: { score: 8, tier: 'priority' } }),
  });
  assert.equal(versionRun.body.ok, true);

  const runsResponse = await jsonRequest(base, `/api/projects/${firstProject.id}/runs`);
  assert.equal(runsResponse.status, 200);
  const [latest, failure, draft] = runsResponse.body.runs;
  assert.equal(runsResponse.body.runs.length, 3);
  assert.equal(latest.versionId, version.id);
  assert.equal(latest.versionNumber, version.versionNumber);
  assert.equal(latest.revision, 2);
  assert.deepEqual(failure.error, { code: 'input.type' });
  assert.equal(failure.ok, false);
  assert.equal(draft.versionId, null);
  assert.equal(draft.revision, 2);
  for (const run of runsResponse.body.runs) {
    assert.equal(run.projectId, firstProject.id);
    assert.equal(run.rulesetId, ruleset.id);
    assert.equal(typeof run.createdAt, 'string');
    assert.equal(Object.hasOwn(run, 'input'), false);
    assert.equal(Object.hasOwn(run, 'trace'), false);
    assert.equal(Object.hasOwn(run, 'result'), false);
  }
  assert.deepEqual((await jsonRequest(base, `/api/projects/${secondProject.id}/runs`)).body.runs, []);
});

test('caps each project evaluation history at the newest 500 runs', async (t) => {
  const base = await startServer(t);
  const project = (await jsonRequest(base, '/api/projects', {
    method: 'POST', body: JSON.stringify({ name: 'Bounded Runs' }),
  })).body.project;
  const ruleset = (await jsonRequest(base, `/api/projects/${project.id}/rulesets`, {
    method: 'POST', body: JSON.stringify({ name: 'Eligibility' }),
  })).body.ruleset;
  const saved = await jsonRequest(base, `/api/rulesets/${ruleset.id}`, {
    method: 'PUT', body: JSON.stringify({ expectedRevision: 1, name: ruleset.name, graph: validGraph() }),
  });
  assert.equal(saved.status, 200);
  const body = JSON.stringify({ input: { score: 8 }, expectedRevision: 2 });
  for (let index = 0; index < 501; index += 1) {
    const response = await jsonRequest(base, `/api/rulesets/${ruleset.id}/evaluate`, { method: 'POST', body });
    assert.equal(response.status, 200);
  }
  const history = await jsonRequest(base, `/api/projects/${project.id}/runs`);
  assert.equal(history.body.runs.length, 500);
  assert.ok(history.body.runs.every((run) => run.projectId === project.id));
  assert.ok(history.body.runs.every((run) => run.rulesetId === ruleset.id));
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

  const evaluate = (expectedRevision) => jsonRequest(base, `/api/rulesets/${ruleset.id}/evaluate`, {
    method: 'POST',
    body: JSON.stringify({ input: { score: 10 }, expectedRevision }),
  });
  const staleEvaluation = await evaluate(1);
  assert.equal(staleEvaluation.status, 409);
  assert.equal(staleEvaluation.body.error.code, 'evaluation.revision_conflict');
  const currentEvaluation = await evaluate(2);
  assert.equal(currentEvaluation.status, 200);
  assert.equal(currentEvaluation.body.ok, true);
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
