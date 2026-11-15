import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/storage.mjs';
import { validGraph } from './fixtures.mjs';

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
