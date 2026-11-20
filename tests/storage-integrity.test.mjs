import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/storage.mjs';
import { validGraph } from './fixtures.mjs';

test('uses the transactional workspace backend and preserves immutable graph hashes after reopening', async () => {
  let contents = null;
  const backend = {
    read: async () => contents,
    transact: async (change) => {
      const result = await change(contents);
      contents = result.contents;
      return result.value;
    },
  };
  const initial = new JsonStore(null, backend);
  assert.deepEqual(await initial.listProjects(), []);
  const project = await initial.createProject('Hosted fixture');
  const rule = await initial.createRuleset(project.id, 'Immutable decision');
  await initial.saveRuleset(rule.id, rule.revision, validGraph(), rule.name);
  const version = await initial.createVersion(rule.id, rule.revision + 1);

  const reopened = new JsonStore(null, backend);
  assert.equal((await reopened.getVersion(rule.id, version.id)).graphHash, version.graphHash);
  const checkpoint = contents;
  await assert.rejects(reopened.saveRuleset(rule.id, rule.revision, validGraph(), rule.name), { code: 'ruleset.conflict' });
  assert.equal(contents, checkpoint);
});

test('exports only the requested project and its related records', async () => {
  let contents = null;
  const backend = {
    read: async () => contents,
    transact: async (change) => {
      const result = await change(contents);
      contents = result.contents;
      return result.value;
    },
  };
  const store = new JsonStore(null, backend);
  const first = await store.createProject('First');
  const second = await store.createProject('Second');
  const rule = await store.createRuleset(first.id, 'Decision');
  await store.createRuleset(second.id, 'Private rule');
  await store.saveRuleset(rule.id, rule.revision, validGraph(), rule.name);
  await store.createVersion(rule.id, rule.revision + 1);
  await store.createTestScenario(rule.id, { name: 'Boundary', inputs: { score: 8 }, expectedOutcomeId: 'eligible' });
  const exported = await store.exportProject(first.id);
  assert.equal(exported.format, 'RuleCanvas.ProjectExport.v1');
  assert.equal(exported.rulesets.length, 1);
  assert.equal(exported.versions.length, 1);
  assert.equal(exported.scenarios.length, 1);
  assert(!JSON.stringify(exported).includes('Private rule'));
  await assert.rejects(store.exportProject('missing'), { code: 'project.not_found' });
});

test('reopens rule-scoped test scenarios and keeps their inputs out of project activity', async () => {
  let contents = null;
  const backend = {
    read: async () => contents,
    transact: async (change) => {
      const result = await change(contents);
      contents = result.contents;
      return result.value;
    },
  };
  const store = new JsonStore(null, backend, { actor: 'fixture-author' });
  const project = await store.createProject('Saved test workspace');
  const rule = await store.createRuleset(project.id, 'Decision');
  const other = await store.createRuleset(project.id, 'Other');
  await store.saveRuleset(rule.id, rule.revision, validGraph(), rule.name);
  const draft = { name: 'Boundary', inputs: { score: 8, tier: 'synthetic-sensitive-input' }, expectedOutcomeId: 'eligible' };
  const saved = await store.createTestScenario(rule.id, draft);
  await assert.rejects(store.createTestScenario(rule.id, { ...draft, name: 'boundary' }), { code: 'scenario.name_conflict' });
  await assert.rejects(store.createTestScenario(rule.id, { ...draft, inputs: { score: [] } }), { code: 'scenario.inputs' });
  await assert.rejects(store.createTestScenario(other.id, draft), { code: 'scenario.outcome' });

  const reopened = new JsonStore(null, backend, { actor: 'fixture-admin' });
  assert.deepEqual(await reopened.listTestScenarios(rule.id), [saved]);
  assert.deepEqual(await reopened.listTestScenarios(other.id), []);
  await assert.rejects(reopened.deleteTestScenario(other.id, saved.id), { code: 'scenario.not_found' });
  await reopened.deleteTestScenario(rule.id, saved.id);
  assert.deepEqual(await store.listTestScenarios(rule.id), []);
  const events = await store.listAuditEvents(project.id, rule.id);
  assert.equal(events.find((event) => event.type === 'test.scenario.created').actor, 'fixture-author');
  assert.equal(events.find((event) => event.type === 'test.scenario.deleted').actor, 'fixture-admin');
  assert(!JSON.stringify(events).includes(draft.inputs.tier));
  assert.equal((await store.getRuleset(rule.id)).revision, rule.revision + 1);
});

test('version reads reject graph data changed without updating its content hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rulecanvas-integrity-'));
  const file = join(directory, 'store.json');
  try {
    const store = new JsonStore(file);
    const project = await store.createProject('Integrity');
    const ruleset = await store.createRuleset(project.id, 'Rules');
    await store.saveRuleset(ruleset.id, 1, validGraph(), 'Rules');
    const version = await store.createVersion(ruleset.id, 2);

    const data = JSON.parse(await readFile(file, 'utf8'));
    data.versions[0].graph.nodes.find((node) => node.id === 'eligible').result = { decision: 'altered' };
    await writeFile(file, JSON.stringify(data));

    await assert.rejects(store.getVersion(ruleset.id, version.id), (error) => error.code === 'version.integrity' && error.status === 409);
    await assert.rejects(store.listVersions(ruleset.id), (error) => error.code === 'version.integrity' && error.status === 409);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('recovers malformed store JSON from the previous checkpoint and repairs it on next write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rulecanvas-recovery-'));
  const file = join(directory, 'store.json');
  try {
    const initial = new JsonStore(file);
    await initial.createProject('Checkpoint A');
    await initial.createProject('Checkpoint B');
    await writeFile(file, '{damaged');

    const recovered = new JsonStore(file);
    assert.deepEqual((await recovered.listProjects()).map((project) => project.name), ['Checkpoint A']);
    assert.equal(recovered.wasRecovered(), true);

    await recovered.createProject('Recovered write');
    assert.equal(recovered.wasRecovered(), false);
    const preservedFile = (await readdir(directory)).find((name) => name.startsWith('store.json.corrupt-'));
    assert.ok(preservedFile);
    assert.equal(await readFile(join(directory, preservedFile), 'utf8'), '{damaged');
    await recovered.createProject('Rotate checkpoint');
    const reopened = new JsonStore(file);
    assert.deepEqual((await reopened.listProjects()).map((project) => project.name), ['Checkpoint A', 'Recovered write', 'Rotate checkpoint']);
    assert.deepEqual(JSON.parse(await readFile(`${file}.bak`, 'utf8')).projects.map((project) => project.name), ['Checkpoint A', 'Recovered write']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not overwrite an unreadable store when no recovery checkpoint exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rulecanvas-no-recovery-'));
  const file = join(directory, 'store.json');
  try {
    await writeFile(file, '{damaged');
    const store = new JsonStore(file);
    await assert.rejects(store.createProject('Must not erase data'), (error) => error.code === 'storage.corrupt' && error.status === 503);
    assert.equal(await readFile(file, 'utf8'), '{damaged');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('migrates the known legacy store shape on the next successful write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rulecanvas-migration-'));
  const file = join(directory, 'store.json');
  const legacy = {
    projects: [{ id: 'legacy-project', slug: 'legacy-project', name: 'Legacy project', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    rulesets: [],
  };
  try {
    await writeFile(file, JSON.stringify(legacy));
    const store = new JsonStore(file);
    assert.deepEqual((await store.listProjects()).map((project) => project.name), ['Legacy project']);
    await store.createProject('New project');
    const migrated = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(migrated.schemaVersion, 1);
    assert.deepEqual(migrated.projects.map((project) => project.name), ['Legacy project', 'New project']);
    assert.deepEqual(migrated.versions, []);
    assert.deepEqual(migrated.auditEvents.map((event) => event.type), ['project.created']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not downgrade or overwrite a future store schema version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rulecanvas-future-schema-'));
  const file = join(directory, 'store.json');
  const future = JSON.stringify({ schemaVersion: 99, projects: [], rulesets: [], versions: [], auditEvents: [] });
  try {
    await writeFile(file, future);
    const store = new JsonStore(file);
    await assert.rejects(store.createProject('Must not downgrade'), (error) => error.code === 'storage.version' && error.status === 503);
    assert.equal(await readFile(file, 'utf8'), future);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
