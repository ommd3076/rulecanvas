import { validateGraph } from './rule-engine.mjs';

const FORMAT = 'RuleCanvas.by.ENNORM.ProjectExport.v1';
const OPERATORS = new Map([
  ['eq', 'eq'], ['neq', 'neq'], ['gt', 'gt'], ['gte', 'gte'], ['lt', 'lt'], ['lte', 'lte'],
  ['before', 'lt'], ['on_or_before', 'lte'], ['after', 'gt'], ['on_or_after', 'gte'],
]);

/** Translate an archived project without writing to the workspace. */
export function translateLegacyProject(envelope) {
  if (!envelope || envelope.format !== FORMAT || !envelope.project || typeof envelope.project !== 'object') {
    throw new Error('Expected a RuleCanvas ProjectExport.v1 envelope.');
  }
  const project = envelope.project;
  if (typeof project.name !== 'string' || !project.name.trim()) throw new Error('The legacy project needs a name.');

  function translateGraph(snapshot) {
    if (!Array.isArray(snapshot?.schema) || !Array.isArray(snapshot?.nodes)) throw new Error('The legacy graph needs schema and nodes arrays.');
    const fields = new Map();
    const schema = snapshot.schema.map((field) => {
      if (!field || typeof field.id !== 'string' || typeof field.key !== 'string' || typeof field.required !== 'boolean' || fields.has(field.key)) {
        throw new Error('Legacy fields need unique keys and stable IDs.');
      }
      fields.set(field.key, field);
      return { id: field.id, name: field.key, type: field.type, required: field.required, ...(field.type === 'enum' ? { options: field.enumValues } : {}) };
    });
    function condition(term) {
      const field = fields.get(term?.fieldKey);
      if (!field) throw new Error(`Unknown legacy input field: ${String(term?.fieldKey)}.`);
      if (term.negate) throw new Error('Negated legacy conditions are not supported.');
      const operator = OPERATORS.get(term.operator);
      if (!operator) throw new Error(`Unsupported legacy operator: ${String(term.operator)}.`);
      if (['before', 'on_or_before', 'after', 'on_or_after'].includes(term.operator) && field.type !== 'date') {
        throw new Error('Date comparison requires a date field.');
      }
      return { fieldId: field.id, operator, value: term.value };
    }
    function group(term, depth = 0) {
      if (depth > 16 || term?.negate || !Array.isArray(term?.children) || !['AND', 'OR'].includes(term.logicalOperator)) {
        throw new Error('Unsupported or malformed legacy logic group.');
      }
      return {
        operator: term.logicalOperator.toLowerCase(),
        terms: term.children.map((child) => {
          if (child?.kind === 'group') return { type: 'group', id: child.id, ...group(child, depth + 1) };
          if (child?.kind === 'condition') return { type: 'condition', id: child.id, ...condition(child) };
          throw new Error('Unsupported legacy logic term.');
        }),
      };
    }
    const edges = [];
    const nodes = snapshot.nodes.map((node) => {
      if (!node || typeof node.id !== 'string' || !node.id || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)) {
        throw new Error('Legacy nodes need stable IDs and numeric positions.');
      }
      const common = { id: node.id, type: node.type, x: node.position.x, y: node.position.y };
      const connect = (port, target) => {
        if (typeof target !== 'string' || !target) throw new Error(`Node ${node.id} has a missing ${port} branch.`);
        edges.push({ id: `${node.id}:${port}`, from: node.id, fromPort: port, to: target, toPort: 'in' });
      };
      if (node.type === 'start') { connect('next', node.nextNodeId); return common; }
      if (node.type === 'condition' || node.type === 'group') {
        connect('true', node.trueTargetId);
        connect('false', node.falseTargetId);
        return { ...common, ...(node.type === 'condition' ? condition(node.condition) : group(node.group)) };
      }
      if (node.type === 'outcome') {
        return { ...common, label: node.title, result: { outcomeCode: node.outcomeCode, category: node.category, reason: node.reason, metadata: node.metadata } };
      }
      throw new Error(`Unsupported legacy node type: ${String(node.type)}.`);
    });
    const graph = { schema, nodes, edges };
    const validation = validateGraph(graph);
    if (!validation.valid) throw new Error(`Legacy graph cannot be imported: ${validation.errors.map((error) => error.message).join(' ')}`);
    return graph;
  }

  const graph = translateGraph(project);
  if (!Array.isArray(project.versions) || !Array.isArray(project.testScenarios) || !Array.isArray(project.auditLog)) {
    throw new Error('The legacy project needs versions, testScenarios and auditLog arrays.');
  }
  if (project.name.trim().length > 80) throw new Error('Project names cannot exceed 80 characters.');
  const versionNumbers = new Set();
  const versions = project.versions.map((version) => {
    if (!version || !Number.isSafeInteger(version.versionNumber) || version.versionNumber < 1 || version.versionNumber >= Number.MAX_SAFE_INTEGER || versionNumbers.has(version.versionNumber) || !Number.isFinite(Date.parse(version.createdAt))) {
      throw new Error('Legacy versions need unique positive version numbers below the safe integer limit and valid creation dates.');
    }
    versionNumbers.add(version.versionNumber);
    return { ...version, graph: translateGraph(version.snapshot) };
  });
  const scenarioNames = new Set();
  const scenarios = project.testScenarios.map((scenario) => {
    if (!scenario || typeof scenario.name !== 'string' || !scenario.name.trim() || scenario.name.trim().length > 100 ||
      scenarioNames.has(scenario.name.trim().toLowerCase()) || typeof scenario.description !== 'string' || scenario.description.length > 300 ||
      !scenario.inputs || typeof scenario.inputs !== 'object' || Array.isArray(scenario.inputs) ||
      Object.values(scenario.inputs).some((value) => value !== null && typeof value !== 'string' && typeof value !== 'boolean' && !Number.isFinite(value))) {
      throw new Error('Legacy scenarios need unique names, descriptions and scalar input values.');
    }
    scenarioNames.add(scenario.name.trim().toLowerCase());
    const outcomes = typeof scenario.expectedOutcomeCode === 'string' && scenario.expectedOutcomeCode.trim()
      ? graph.nodes.filter((node) => node.type === 'outcome' && node.result.outcomeCode === scenario.expectedOutcomeCode)
      : [];
    return { ...scenario, expectedOutcomeId: outcomes.length === 1 ? outcomes[0].id : null };
  });
  if (versions.length > 100 || scenarios.length > 100) throw new Error('Import supports at most 100 versions and 100 scenarios.');
  const warnings = [
    'The original export is retained with the imported project, including field labels, defaults, descriptions, and audit entries.',
    'Legacy evaluation treated empty strings as missing, accepted numeric strings and ignored unknown input fields. Current evaluation uses strict types and rejects unknown fields.',
    'Outcome data is represented as an object containing outcomeCode, category, reason, and metadata. Review downstream integrations before use.',
    'Imported versions are assigned source revision 1 because earlier exports did not record draft revision numbers.',
  ];
  if (scenarios.some((scenario) => scenario.expectedOutcomeCode && !scenario.expectedOutcomeId)) {
    warnings.push('Some scenario outcome codes do not uniquely match a current outcome.');
  }
  return { name: project.name.trim(), graph, versions, scenarios, source: structuredClone(envelope), warnings };
}
