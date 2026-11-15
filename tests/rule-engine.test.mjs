import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGraph, validateGraph } from '../src/rule-engine.mjs';
import { validGraph } from './fixtures.mjs';

test('validates and deterministically evaluates a typed graph with an ordered trace', () => {
  const graph = validGraph();
  assert.deepEqual(validateGraph(graph), { valid: true, errors: [] });
  const first = evaluateGraph(graph, { score: 8, tier: 'priority' });
  const second = evaluateGraph(graph, { score: 8, tier: 'priority' });
  assert.equal(first.ok, true);
  assert.deepEqual(first, second);
  assert.deepEqual(first.result, { decision: 'eligible' });
  assert.deepEqual(first.trace.map(({ nodeId, kind, branch }) => ({ nodeId, kind, branch })), [
    { nodeId: 'start', kind: 'start', branch: undefined },
    { nodeId: 'score-check', kind: 'condition', branch: 'true' },
    { nodeId: 'eligible', kind: 'outcome', branch: undefined },
  ]);
});

test('moving nodes changes layout metadata but does not change result or trace', () => {
  const graph = validGraph();
  const before = evaluateGraph(graph, { score: 7 });
  graph.nodes.forEach((node, index) => { node.x += 190 + index; node.y += 57; });
  const after = evaluateGraph(graph, { score: 7 });
  assert.deepEqual(after, before);
});

test('rejects a condition value that does not match its declared field type', () => {
  const graph = validGraph();
  graph.nodes.find((node) => node.id === 'score-check').value = '8';
  const result = validateGraph(graph);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === 'node.value.type'));
});

test('rejects incompatible ports and incomplete branches', () => {
  const graph = validGraph();
  graph.edges[0].fromPort = 'true';
  graph.edges.pop();
  const result = validateGraph(graph);
  assert.ok(result.errors.some((error) => error.code === 'edge.port.type'));
  assert.ok(result.errors.some((error) => error.code === 'graph.condition.branch'));
});

test('reports cycles and unreachable nodes by stable node ID', () => {
  const graph = validGraph();
  graph.edges[2] = { id: 'score-no', from: 'score-check', fromPort: 'false', to: 'score-check', toPort: 'in' };
  graph.nodes.push({ id: 'orphan', type: 'outcome', x: 920, y: 560, label: 'Orphan', result: 'never' });
  const result = validateGraph(graph);
  assert.ok(result.errors.some((error) => error.code === 'graph.cycle'));
  assert.ok(result.errors.some((error) => error.code === 'graph.unreachable' && error.nodeId === 'orphan'));
});

test('rejects missing required and wrongly typed evaluation inputs', () => {
  const graph = validGraph();
  const missing = evaluateGraph(graph, { tier: 'standard' });
  const wrongType = evaluateGraph(graph, { score: '8', tier: 'standard' });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.code === 'input.required'));
  assert.equal(wrongType.ok, false);
  assert.ok(wrongType.errors.some((error) => error.code === 'input.type'));
});

test('supports inclusive and exclusive numeric boundaries without coercion', () => {
  const graph = validGraph();
  assert.equal(evaluateGraph(graph, { score: 7.99 }).result.decision, 'review');
  assert.equal(evaluateGraph(graph, { score: 8 }).result.decision, 'eligible');
  graph.nodes.find((node) => node.id === 'score-check').operator = 'gt';
  assert.equal(evaluateGraph(graph, { score: 8 }).result.decision, 'review');
  assert.equal(evaluateGraph(graph, { score: 8.01 }).result.decision, 'eligible');
});

test('enforces declared enum choices and validates calendar dates', () => {
  const graph = validGraph();
  assert.equal(evaluateGraph(graph, { score: 8, tier: 'unknown' }).ok, false);
  const dateGraph = {
    schema: [{ id: 'date', name: 'startsOn', type: 'date', required: true }],
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'check', type: 'condition', x: 250, y: 0, fieldId: 'date', operator: 'gte', value: '2026-11-01' },
      { id: 'yes', type: 'outcome', x: 550, y: 0, label: 'Current', result: true },
      { id: 'no', type: 'outcome', x: 550, y: 200, label: 'Earlier', result: false },
    ],
    edges: [
      { id: 'a', from: 'start', fromPort: 'next', to: 'check', toPort: 'in' },
      { id: 'b', from: 'check', fromPort: 'true', to: 'yes', toPort: 'in' },
      { id: 'c', from: 'check', fromPort: 'false', to: 'no', toPort: 'in' },
    ],
  };
  assert.equal(evaluateGraph(dateGraph, { startsOn: '2026-02-30' }).ok, false);
  assert.equal(evaluateGraph(dateGraph, { startsOn: '2026-11-01' }).result, true);
});
