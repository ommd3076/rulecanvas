const MAX_DRAFT_BYTES = 1_000_000;

export function serializeRuleDraft({ rulesetId, name, revision, graph }) {
  return JSON.stringify({ format: 'rulecanvas-draft', version: 1, rulesetId, name, revision, exportedAt: new Date().toISOString(), graph }, null, 2);
}

export function parseRuleDraft(text) {
  if (typeof text !== 'string' || text.length > MAX_DRAFT_BYTES) throw new Error('Draft file is too large.');
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('Draft file must contain valid JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !['rulecanvas-draft', 'rulecanvas-conflict-draft'].includes(data.format) || data.version !== 1) {
    throw new Error('Unsupported RuleCanvas draft format.');
  }
  if (!data.graph || typeof data.graph !== 'object' || !Array.isArray(data.graph.schema) || !Array.isArray(data.graph.nodes) || !Array.isArray(data.graph.edges)) {
    throw new Error('Draft file must contain a graph with schema, node, and connection lists.');
  }
  return data;
}
