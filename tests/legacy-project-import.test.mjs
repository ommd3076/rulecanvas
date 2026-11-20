import test from 'node:test';
import assert from 'node:assert/strict';
import { translateLegacyProject } from '../src/legacy-project-import.mjs';
import { evaluateGraph } from '../src/rule-engine.mjs';
import { JsonStore } from '../src/storage.mjs';
import { createRuleCanvasServer } from '../src/server.mjs';
import { once } from 'node:events';

function fixture() {
  const schema = [{ id: 'score-id', key: 'score', type: 'number', required: true }];
  const nodes = [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, nextNodeId: 'check' },
    { id: 'check', type: 'condition', position: { x: 100, y: 0 }, condition: { kind: 'condition', fieldKey: 'score', operator: 'gte', value: 8 }, trueTargetId: 'pass', falseTargetId: 'review' },
    { id: 'pass', type: 'outcome', position: { x: 200, y: 0 }, title: 'Pass', outcomeCode: 'PASS', category: 'approve', reason: 'Eligible', metadata: {} },
    { id: 'review', type: 'outcome', position: { x: 200, y: 100 }, title: 'Review', outcomeCode: 'REVIEW', category: 'review', reason: 'Needs review', metadata: {} },
  ];
  return { format: 'RuleCanvas.by.ENNORM.ProjectExport.v1', project: { name: 'Sample', schema, nodes, versions: [{ id: 'v1', versionNumber: 1, createdAt: '2026-01-01T00:00:00.000Z', snapshot: { schema, nodes } }], testScenarios: [{ id: 's1', name: 'Boundary', description: '', inputs: { score: 8 }, expectedOutcomeCode: 'PASS' }], auditLog: [] } };
}

test('translates archived graphs, scenarios, and immutable snapshots without mutating the export', () => {
  const input = fixture();
  const before = structuredClone(input);
  const result = translateLegacyProject(input);
  assert.deepEqual(input, before);
  assert.equal(result.scenarios[0].expectedOutcomeId, 'pass');
  assert.equal(evaluateGraph(result.graph, { score: 8 }).result.outcomeCode, 'PASS');
  assert.equal(evaluateGraph(result.versions[0].graph, { score: 7 }).result.outcomeCode, 'REVIEW');
  assert.deepEqual(result.source, before);
});

test('rejects legacy behavior the current rule engine cannot preserve', () => {
  const input = fixture();
  input.project.nodes[1].condition.operator = 'contains';
  assert.throws(() => translateLegacyProject(input), /Unsupported legacy operator/);
  input.project.nodes[1].condition.operator = 'gte';
  input.project.nodes[1].condition.negate = true;
  assert.throws(() => translateLegacyProject(input), /Negated legacy conditions/);
  assert.throws(() => translateLegacyProject({ project: input.project }), /ProjectExport/);
});

test('does not invent an expected outcome when the legacy scenario has no assertion', () => {
  const input = fixture();
  delete input.project.testScenarios[0].expectedOutcomeCode;
  delete input.project.nodes[2].outcomeCode;
  const result = translateLegacyProject(input);
  assert.equal(result.scenarios[0].expectedOutcomeId, null);
});

test('preserves converging branches and evaluates each route to the same outcome', () => {
  const input = fixture();
  const graph = input.project;
  graph.nodes.splice(2, 0, {
    id: 'second', type: 'condition', title: 'Second check', position: { x: 350, y: 0 },
    condition: { id: 'c2', kind: 'condition', fieldKey: 'score', operator: 'gte', value: 5 },
    trueTargetId: 'pass', falseTargetId: 'review',
  });
  graph.nodes.find((node) => node.id === 'check').falseTargetId = 'second';
  graph.versions[0].snapshot = structuredClone({ schema: graph.schema, nodes: graph.nodes });
  const result = translateLegacyProject(input);
  assert.equal(evaluateGraph(result.graph, { score: 9 }).outcomeId, 'pass');
  assert.equal(evaluateGraph(result.graph, { score: 6 }).outcomeId, 'pass');
  assert.equal(evaluateGraph(result.graph, { score: 4 }).outcomeId, 'review');
});

test('imports the complete source and translated data atomically into a scoped workspace', async () => {
  let contents = null;
  const backend = { read: async () => contents, transact: async (change) => {
    const result = await change(contents);
    contents = result.contents;
    return result.value;
  } };
  const store = new JsonStore(null, backend);
  const original = fixture();
  const { project, ruleset } = await store.importLegacyProject(original);
  const reopened = new JsonStore(null, backend);
  assert.deepEqual(await reopened.getLegacyProjectSource(project.id), original);
  assert.equal((await reopened.listVersions(ruleset.id)).length, 1);
  assert.equal((await reopened.listTestScenarios(ruleset.id))[0].expectedOutcomeId, 'pass');
  assert.equal(evaluateGraph((await reopened.getRuleset(ruleset.id)).graph, { score: 8 }).result.outcomeCode, 'PASS');
  assert.equal((await reopened.getProject(project.id)).hasLegacySource, true);
  assert.equal(Object.hasOwn((await reopened.listProjects())[0], 'legacySource'), false);
  const before = contents;
  const invalid = fixture();
  invalid.project.versions[0].snapshot.nodes[1].condition.operator = 'contains';
  await assert.rejects(store.importLegacyProject(invalid), { code: 'legacy.invalid' });
  assert.equal(contents, before);
});

test('reviews an export without writing and imports it through the HTTP entry point', async (t) => {
  let contents = null;
  const backend = { read: async () => contents, transact: async (change) => {
    const result = await change(contents);
    contents = result.contents;
    return result.value;
  } };
  const server = createRuleCanvasServer({ store: new JsonStore(null, backend) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const envelope = fixture();
  const send = (body) => fetch(`${base}/api/projects/import-legacy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const preview = await send({ envelope });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).versionCount, 1);
  assert.equal(contents, null);
  const imported = await send({ envelope, confirm: true });
  assert.equal(imported.status, 201);
  const { project, ruleset } = await imported.json();
  const source = await fetch(`${base}/api/projects/${project.id}/legacy-source`);
  assert.deepEqual((await source.json()).source, envelope);
  const versions = await fetch(`${base}/api/rulesets/${ruleset.id}/versions`);
  assert.equal((await versions.json()).versions.length, 1);
});
