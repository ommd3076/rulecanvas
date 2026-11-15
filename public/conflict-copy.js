export function serializeConflictCopy({ rulesetId, name, expectedRevision, graph }) {
  return JSON.stringify({
    format: 'rulecanvas-conflict-draft',
    rulesetId,
    name,
    expectedRevision,
    exportedAt: new Date().toISOString(),
    graph,
  }, null, 2);
}
