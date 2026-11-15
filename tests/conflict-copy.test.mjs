import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeConflictCopy } from '../public/conflict-copy.js';

test('conflict download retains the exact local draft graph and stale base revision', () => {
  const graph = { schema: [{ id: 'score', name: 'score', type: 'number' }], nodes: [], edges: [] };
  const copy = JSON.parse(serializeConflictCopy({ rulesetId: 'rules-1', name: 'Local edit', expectedRevision: 4, graph }));
  assert.equal(copy.format, 'rulecanvas-conflict-draft');
  assert.equal(copy.rulesetId, 'rules-1');
  assert.equal(copy.name, 'Local edit');
  assert.equal(copy.expectedRevision, 4);
  assert.deepEqual(copy.graph, graph);
  assert.ok(Number.isFinite(Date.parse(copy.exportedAt)));
});
