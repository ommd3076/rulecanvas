export function removeConnection(graph, connectionId) {
  if (!graph || !Array.isArray(graph.edges)) return false;
  const index = graph.edges.findIndex((edge) => edge.id === connectionId);
  if (index < 0) return false;
  graph.edges.splice(index, 1);
  return true;
}
