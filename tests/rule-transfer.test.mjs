import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeConflictCopy } from '../public/conflict-copy.js';
import { parseRuleDraft, serializeRuleDraft } from '../public/rule-transfer.js';

test('exports and imports graph drafts without losing graph or base revision metadata', () => {
  const graph = { schema: [{ id: 'score', name: 'score', type: 'number' }], nodes: [{ id: 'start', type: 'start', x: 1, y: 2 }], edges: [] };
  const text = serializeRuleDraft({ rulesetId: 'rules-1', name: 'Eligibility', revision: 5, graph });
  const parsed = parseRuleDraft(text);
  assert.equal(parsed.rulesetId, 'rules-1');
  assert.equal(parsed.name, 'Eligibility');
  assert.equal(parsed.revision, 5);
  assert.deepEqual(parsed.graph, graph);
});

test('imports a downloaded conflict draft and rejects malformed, oversized, or unsupported files', () => {
  const graph = { schema: [], nodes: [], edges: [] };
  const conflict = serializeConflictCopy({ rulesetId: 'rules-2', name: 'Recovered', expectedRevision: 3, graph });
  assert.equal(parseRuleDraft(conflict).format, 'rulecanvas-conflict-draft');
  assert.throws(() => parseRuleDraft('{'), /valid JSON/);
  assert.throws(() => parseRuleDraft(' '.repeat(1_000_001)), /too large/);
  assert.throws(() => parseRuleDraft(JSON.stringify({ format: 'unknown', version: 1, graph })), /Unsupported/);
  assert.throws(() => parseRuleDraft(JSON.stringify({ format: 'rulecanvas-draft', version: 1, graph: {} })), /schema, node, and connection/);
});
