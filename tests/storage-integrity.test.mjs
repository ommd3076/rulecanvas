import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
