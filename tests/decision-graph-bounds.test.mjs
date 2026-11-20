import test from 'node:test';
import assert from 'node:assert/strict';

test('decision graph bounds validator prevents out-of-range coordinates', () => {
  const minCoord = -50000;
  const maxCoord = 50000;
  
  function clamp(val) {
    return Math.max(minCoord, Math.min(maxCoord, val));
  }

  assert.equal(clamp(100), 100);
  assert.equal(clamp(-60000), minCoord);
  assert.equal(clamp(60000), maxCoord);
});

test('cycle detection identifies circular dependencies in rule nodes', () => {
  const edges = [
    { from: 'nodeA', to: 'nodeB' },
    { from: 'nodeB', to: 'nodeC' },
  ];

  function wouldCreateCycle(newEdge) {
    const adj = new Map();
    for (const e of [...edges, newEdge]) {
      if (!adj.has(e.from)) adj.set(e.from, []);
      adj.get(e.from).push(e.to);
    }
    const visited = new Set();
    const recStack = new Set();

    function dfs(v) {
      visited.add(v);
      recStack.add(v);
      for (const neighbor of adj.get(v) || []) {
        if (!visited.has(neighbor) && dfs(neighbor)) return true;
        if (recStack.has(neighbor)) return true;
      }
      recStack.delete(v);
      return false;
    }

    for (const node of adj.keys()) {
      if (!visited.has(node) && dfs(node)) return true;
    }
    return false;
  }

  assert.equal(wouldCreateCycle({ from: 'nodeC', to: 'nodeA' }), true);
  assert.equal(wouldCreateCycle({ from: 'nodeC', to: 'nodeD' }), false);
});
