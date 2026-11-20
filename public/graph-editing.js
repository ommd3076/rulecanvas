export function removeConnection(graph, connectionId) {
  if (!graph || !Array.isArray(graph.edges)) return false;
  const index = graph.edges.findIndex((edge) => edge.id === connectionId);
  if (index < 0) return false;
  graph.edges.splice(index, 1);
  return true;
}
export function wouldCreateCycle(edges, fromNodeId, toNodeId) {
  const pending = [toNodeId];
  const visited = new Set();
  while (pending.length) {
    const nodeId = pending.pop();
    if (nodeId === fromNodeId) return true;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    for (const edge of edges) {
      if (edge.from === nodeId) pending.push(edge.to);
    }
  }
  return false;
}
