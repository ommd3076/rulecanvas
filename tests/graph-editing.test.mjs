import test from 'node:test';
import assert from 'node:assert/strict';
import { removeConnection } from '../src/graph-editing.mjs';

test('removes only the selected connection while preserving endpoint nodes and other branches', () => {
  const graph = {
    nodes: [{ id: 'start' }, { id: 'condition' }, { id: 'yes' }, { id: 'no' }],
    edges: [
      { id: 'entry', from: 'start', to: 'condition' },
      { id: 'yes-branch', from: 'condition', fromPort: 'true', to: 'yes' },
      { id: 'no-branch', from: 'condition', fromPort: 'false', to: 'no' },
    ],
  };

  assert.equal(removeConnection(graph, 'yes-branch'), true);
  assert.deepEqual(graph.nodes.map((node) => node.id), ['start', 'condition', 'yes', 'no']);
  assert.deepEqual(graph.edges.map((edge) => edge.id), ['entry', 'no-branch']);
  assert.equal(removeConnection(graph, 'missing'), false);
});
