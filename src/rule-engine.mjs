const FIELD_TYPES = new Set(['string', 'number', 'boolean', 'date', 'enum']);
const LOGIC_OPERATORS = new Set(['and', 'or']);
const MAX_LOGIC_DEPTH = 16;
const MAX_LOGIC_TERMS = 128;
const MAX_TOTAL_LOGIC_TERMS = 2048;
const COMPARISONS = {
  string: new Set(['eq', 'neq']),
  enum: new Set(['eq', 'neq']),
  boolean: new Set(['eq', 'neq']),
  number: new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']),
  date: new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']),
};

const fail = (code, message, extra = {}) => ({ code, message, ...extra });

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function valueMatchesType(value, type) {
  if (type === 'string' || type === 'enum') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'date') return isDate(value);
  return false;
}

function validateSchema(schema) {
  const errors = [];
  if (!Array.isArray(schema)) return [fail('schema.invalid', 'Input schema must be a list.')];
  const ids = new Set();
  const names = new Set();
  for (const field of schema) {
    if (!field || typeof field !== 'object') {
      errors.push(fail('schema.field.invalid', 'Every input field must be an object.'));
      continue;
    }
    if (!field.id || typeof field.id !== 'string' || ids.has(field.id)) {
      errors.push(fail('schema.field.id', 'Input field IDs must be non-empty and unique.', { fieldId: field.id }));
    }
    ids.add(field.id);
    if (!field.name || typeof field.name !== 'string' || names.has(field.name.trim().toLowerCase())) {
      errors.push(fail('schema.field.name', 'Input field names must be non-empty and unique.', { fieldId: field.id }));
    }
    names.add(String(field.name ?? '').trim().toLowerCase());
    if (!FIELD_TYPES.has(field.type)) {
      errors.push(fail('schema.field.type', `Unsupported input type: ${String(field.type)}.`, { fieldId: field.id }));
    }
    if (field.required !== undefined && typeof field.required !== 'boolean') {
      errors.push(fail('schema.field.required', 'Required must be true or false.', { fieldId: field.id }));
    }
    if (field.type === 'enum') {
      if (!Array.isArray(field.options) || field.options.length === 0 || field.options.some((option) => typeof option !== 'string')) {
        errors.push(fail('schema.enum.options', 'Enum fields need at least one text option.', { fieldId: field.id }));
      } else if (new Set(field.options).size !== field.options.length) {
        errors.push(fail('schema.enum.duplicate', 'Enum options must be unique.', { fieldId: field.id }));
      }
    }
  }
  return errors;
}

function validateCondition(node, fieldById) {
  const errors = [];
  const field = fieldById.get(node.fieldId);
  if (!field) {
    errors.push(fail('node.field.missing', 'Condition refers to an input field that does not exist.', { nodeId: node.id, fieldId: node.fieldId }));
    return errors;
  }
  if (!COMPARISONS[field.type]?.has(node.operator)) {
    errors.push(fail('node.operator.type', `Operator ${String(node.operator)} is not valid for ${field.type}.`, { nodeId: node.id, fieldId: field.id }));
    return errors;
  }
  if (!valueMatchesType(node.value, field.type)) {
    errors.push(fail('node.value.type', `Condition value must use the ${field.type} type.`, { nodeId: node.id, fieldId: field.id }));
  } else if (field.type === 'enum' && Array.isArray(field.options) && !field.options.includes(node.value)) {
    errors.push(fail('node.value.enum', 'Condition value must be one of the field’s declared options.', { nodeId: node.id, fieldId: field.id }));
  }
  return errors;
}

function validateLogicGroup(operator, terms, fieldById, nodeId, path = '', depth = 0, budget = { count: 0, reported: false }) {
  const errors = [];
  if (depth > MAX_LOGIC_DEPTH) return [fail('group.depth', `Logic groups may be nested at most ${MAX_LOGIC_DEPTH} levels.`, { nodeId, termPath: path })];
  if (!LOGIC_OPERATORS.has(operator)) errors.push(fail('group.operator', 'Logic group operator must be AND or OR.', { nodeId, termPath: path }));
  if (!Array.isArray(terms) || terms.length < 2 || terms.length > MAX_LOGIC_TERMS) {
    errors.push(fail('group.terms', `Each logic group needs between 2 and ${MAX_LOGIC_TERMS} terms.`, { nodeId, termPath: path }));
    return errors;
  }
  for (let index = 0; index < terms.length; index++) {
    budget.count++;
    if (budget.count > MAX_TOTAL_LOGIC_TERMS) {
      if (!budget.reported) errors.push(fail('group.size', `Logic expressions may contain at most ${MAX_TOTAL_LOGIC_TERMS} terms.`, { nodeId, termPath: path }));
      budget.reported = true;
      break;
    }
    const term = terms[index];
    const termPath = path ? `${path}.${index}` : String(index);
    if (!term || typeof term !== 'object' || Array.isArray(term)) {
      errors.push(fail('group.term.invalid', 'Logic terms must be condition or nested group objects.', { nodeId, termPath }));
      continue;
    }
    if (term.type === 'group') {
      errors.push(...validateLogicGroup(term.operator, term.terms, fieldById, nodeId, termPath, depth + 1, budget));
      continue;
    }
    if (term.type !== 'condition') {
      errors.push(fail('group.term.type', 'Logic terms must be conditions or nested groups.', { nodeId, termPath }));
      continue;
    }
    errors.push(...validateCondition({ ...term, id: nodeId }, fieldById).map((error) => ({ ...error, termPath })));
  }
  return errors;
}

function sourcePortTypes(node) {
  if (node.type === 'start') return { next: 'flow' };
  if (node.type === 'condition' || node.type === 'group') return { true: 'flow:yes', false: 'flow:no' };
  return {};
}

function targetPortTypes(node) {
  if (node.type === 'condition' || node.type === 'group' || node.type === 'outcome') return { in: ['flow', 'flow:yes', 'flow:no'] };
  return {};
}

function validatePort(edge, source, target) {
  const sourceType = sourcePortTypes(source)[edge.fromPort];
  const acceptedTypes = targetPortTypes(target)[edge.toPort];
  return sourceType && acceptedTypes?.includes(sourceType);
}

export function validateGraph(graph) {
  const errors = [];
  if (!graph || typeof graph !== 'object') return { valid: false, errors: [fail('graph.invalid', 'Rule graph must be an object.')] };
  errors.push(...validateSchema(graph.schema));
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    errors.push(fail('graph.shape', 'Graph needs node and connection lists.'));
    return { valid: false, errors };
  }

  const nodeById = new Map();
  for (const node of graph.nodes) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || !node.id) {
      errors.push(fail('node.id', 'Every node needs a non-empty ID.'));
      continue;
    }
    if (nodeById.has(node.id)) errors.push(fail('node.duplicate', 'Node IDs must be unique.', { nodeId: node.id }));
    nodeById.set(node.id, node);
    if (!['start', 'condition', 'group', 'outcome'].includes(node.type)) {
      errors.push(fail('node.type', `Unsupported node type: ${String(node.type)}.`, { nodeId: node.id }));
    }
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      errors.push(fail('node.position', 'Node positions must be finite canvas coordinates.', { nodeId: node.id }));
    }
    if (node.type === 'condition') {
      const fields = Array.isArray(graph.schema) ? graph.schema.filter((field) => field && typeof field.id === 'string') : [];
      errors.push(...validateCondition(node, new Map(fields.map((field) => [field.id, field]))));
    }
    if (node.type === 'group') {
      const fields = Array.isArray(graph.schema) ? graph.schema.filter((field) => field && typeof field.id === 'string') : [];
      errors.push(...validateLogicGroup(node.operator, node.terms, new Map(fields.map((field) => [field.id, field])), node.id));
    }
    if (node.type === 'outcome' && (!node.label || typeof node.label !== 'string')) {
      errors.push(fail('node.outcome.label', 'Outcome nodes need a name.', { nodeId: node.id }));
    }
    if (node.type === 'outcome' && !Object.hasOwn(node, 'result')) {
      errors.push(fail('node.outcome.result', 'Outcome nodes need an explicit result value; null is allowed.', { nodeId: node.id }));
    }
  }

  const starts = graph.nodes.filter((node) => node?.type === 'start');
  const outcomes = graph.nodes.filter((node) => node?.type === 'outcome');
  if (starts.length !== 1) errors.push(fail('graph.start.count', 'A rule graph needs exactly one start node.'));
  if (outcomes.length === 0) errors.push(fail('graph.outcome.missing', 'Add at least one outcome node.'));

  const edgeIds = new Set();
  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of graph.edges) {
    if (!edge || typeof edge !== 'object' || typeof edge.id !== 'string' || !edge.id || edgeIds.has(edge.id)) {
      errors.push(fail('edge.id', 'Connection IDs must be non-empty and unique.', { edgeId: edge?.id }));
      continue;
    }
    edgeIds.add(edge.id);
    const source = nodeById.get(edge.from);
    const target = nodeById.get(edge.to);
    if (!source || !target) {
      errors.push(fail('edge.node.missing', 'Connection refers to a node that does not exist.', { edgeId: edge.id }));
      continue;
    }
    if (!validatePort(edge, source, target)) {
      errors.push(fail('edge.port.type', 'Connection ports are incompatible. Use a matching output and input port.', { edgeId: edge.id, fromNodeId: source.id, toNodeId: target.id }));
    }
    outgoing.set(source.id, [...(outgoing.get(source.id) ?? []), edge]);
    incoming.set(target.id, [...(incoming.get(target.id) ?? []), edge]);
  }

  for (const node of graph.nodes) {
    if (!node?.id) continue;
    const outs = outgoing.get(node.id) ?? [];
    const ins = incoming.get(node.id) ?? [];
    if (node.type === 'start' && (outs.length !== 1 || ins.length !== 0 || outs[0]?.fromPort !== 'next')) {
      errors.push(fail('graph.start.connections', 'Start must have one next connection and no incoming connections.', { nodeId: node.id }));
    }
    if (node.type === 'condition' || node.type === 'group') {
      const prefix = node.type === 'group' ? 'graph.group' : 'graph.condition';
      const label = node.type === 'group' ? 'Logic group' : 'Condition';
      if (ins.length !== 1) errors.push(fail(`${prefix}.input`, `Each ${label.toLowerCase()} needs exactly one incoming connection.`, { nodeId: node.id }));
      for (const port of ['true', 'false']) {
        if (outs.filter((edge) => edge.fromPort === port).length !== 1) {
          errors.push(fail(`${prefix}.branch`, `Each ${label.toLowerCase()} needs exactly one ${port} branch.`, { nodeId: node.id }));
        }
      }
      if (outs.some((edge) => !['true', 'false'].includes(edge.fromPort))) {
        errors.push(fail(`${prefix}.port`, `${label} outputs must use true or false ports.`, { nodeId: node.id }));
      }
    }
    if (node.type === 'outcome' && (ins.length !== 1 || outs.length !== 0)) {
      errors.push(fail('graph.outcome.connections', 'Outcome needs one incoming connection and no outgoing connections.', { nodeId: node.id }));
    }
  }

  if (starts.length === 1) {
    const reachable = new Set();
    const pendingReachable = [starts[0].id];
    while (pendingReachable.length) {
      const nodeId = pendingReachable.pop();
      if (reachable.has(nodeId)) continue;
      reachable.add(nodeId);
      for (const edge of outgoing.get(nodeId) ?? []) {
        if (nodeById.has(edge.to)) pendingReachable.push(edge.to);
      }
    }

    const complete = new Set();
    const active = new Set();
    const cycleNodes = new Set();
    for (const rootId of nodeById.keys()) {
      if (complete.has(rootId)) continue;
      const stack = [{ nodeId: rootId, leaving: false }];
      while (stack.length) {
        const frame = stack.pop();
        if (frame.leaving) {
          active.delete(frame.nodeId);
          complete.add(frame.nodeId);
          continue;
        }
        if (active.has(frame.nodeId)) {
          cycleNodes.add(frame.nodeId);
          continue;
        }
        if (complete.has(frame.nodeId)) continue;
        active.add(frame.nodeId);
        stack.push({ nodeId: frame.nodeId, leaving: true });
        const node = nodeById.get(frame.nodeId);
        if (node?.type !== 'outcome') {
          const edges = outgoing.get(frame.nodeId) ?? [];
          for (let index = edges.length - 1; index >= 0; index--) {
            const edge = edges[index];
            if (nodeById.has(edge.to)) stack.push({ nodeId: edge.to, leaving: false });
          }
        }
      }
    }
    for (const nodeId of cycleNodes) errors.push(fail('graph.cycle', 'Rule graph contains a cycle.', { nodeId }));
    for (const node of graph.nodes) {
      if (node?.id && !reachable.has(node.id)) errors.push(fail('graph.unreachable', 'Node cannot be reached from the start node.', { nodeId: node.id }));
    }
    if (reachable.size && ![...reachable].some((id) => nodeById.get(id)?.type === 'outcome')) {
      errors.push(fail('graph.terminal.missing', 'No path from the start reaches an outcome.'));
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateInput(schema, input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return [fail('input.shape', 'Evaluation input must be an object.')];
  }
  const knownNames = new Set();
  for (const field of schema) {
    knownNames.add(field.name);
    const present = Object.hasOwn(input, field.name);
    const value = input[field.name];
    if (!present || value === null || value === undefined) {
      if (field.required !== false) errors.push(fail('input.required', `Provide a value for ${field.name}.`, { fieldId: field.id }));
      continue;
    }
    if (!valueMatchesType(value, field.type)) {
      errors.push(fail('input.type', `${field.name} must be ${field.type}.`, { fieldId: field.id }));
    } else if (field.type === 'enum' && !field.options.includes(value)) {
      errors.push(fail('input.enum', `${field.name} must be one of its declared options.`, { fieldId: field.id }));
    }
  }
  for (const key of Object.keys(input)) {
    if (!knownNames.has(key)) errors.push(fail('input.unknown', `Input field ${key} is not declared in this rule schema.`));
  }
  return errors;
}

function compare(actual, operator, expected, type) {
  if (type === 'date') {
    actual = Date.parse(`${actual}T00:00:00.000Z`);
    expected = Date.parse(`${expected}T00:00:00.000Z`);
  }
  switch (operator) {
    case 'eq': return actual === expected;
    case 'neq': return actual !== expected;
    case 'gt': return actual > expected;
    case 'gte': return actual >= expected;
    case 'lt': return actual < expected;
    case 'lte': return actual <= expected;
    default: throw new Error(`Unsupported operator ${operator}`);
  }
}

function evaluateLogicGroup(operator, terms, input, schema) {
  const evaluations = terms.map((term) => {
    if (term.type === 'group') {
      const nested = evaluateLogicGroup(term.operator, term.terms, input, schema);
      return { type: 'group', operator: term.operator, matched: nested.matched, terms: nested.terms };
    }
    const field = schema.get(term.fieldId);
    const actual = input[field.name] ?? null;
    const matched = actual !== null && compare(actual, term.operator, term.value, field.type);
    return { type: 'condition', field: field.name, operator: term.operator, expected: term.value, actual, matched };
  });
  const matched = operator === 'and' ? evaluations.every((term) => term.matched) : evaluations.some((term) => term.matched);
  return { matched, terms: evaluations };
}

export function evaluateGraph(graph, input) {
  const graphResult = validateGraph(graph);
  if (!graphResult.valid) return { ok: false, errors: graphResult.errors };
  const inputErrors = validateInput(graph.schema, input);
  if (inputErrors.length) return { ok: false, errors: inputErrors };

  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = graph.edges;
  const schema = new Map(graph.schema.map((field) => [field.id, field]));
  const trace = [];
  let current = nodes.get(graph.nodes.find((node) => node.type === 'start').id);
  let steps = 0;
  while (current && steps++ <= graph.nodes.length + 1) {
    if (current.type === 'start') {
      trace.push({ nodeId: current.id, kind: 'start', label: 'Start' });
      const edge = edges.find((item) => item.from === current.id && item.fromPort === 'next');
      current = nodes.get(edge.to);
      continue;
    }
    if (current.type === 'condition') {
      const field = schema.get(current.fieldId);
      const actual = input[field.name] ?? null;
      const matched = actual !== null && compare(actual, current.operator, current.value, field.type);
      const branch = matched ? 'true' : 'false';
      trace.push({
        nodeId: current.id,
        kind: 'condition',
        field: field.name,
        operator: current.operator,
        expected: current.value,
        actual,
        branch,
      });
      const edge = edges.find((item) => item.from === current.id && item.fromPort === branch);
      current = nodes.get(edge.to);
      continue;
    }
    if (current.type === 'group') {
      const evaluation = evaluateLogicGroup(current.operator, current.terms, input, schema);
      const branch = evaluation.matched ? 'true' : 'false';
      trace.push({ nodeId: current.id, kind: 'group', operator: current.operator, terms: evaluation.terms, branch });
      const edge = edges.find((item) => item.from === current.id && item.fromPort === branch);
      current = nodes.get(edge.to);
      continue;
    }
    if (current.type === 'outcome') {
      trace.push({ nodeId: current.id, kind: 'outcome', label: current.label, result: current.result });
      return { ok: true, result: current.result, outcomeId: current.id, trace };
    }
    break;
  }
  return { ok: false, errors: [fail('evaluation.unreachable', 'Evaluation did not reach a terminal outcome.')] };
}

export function createStarterGraph() {
  return {
    schema: [],
    nodes: [
      { id: 'start', type: 'start', x: 100, y: 220 },
    ],
    edges: [],
  };
}
