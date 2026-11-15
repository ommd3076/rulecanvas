import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGraph, validateGraph } from '../src/rule-engine.mjs';
import { validGraph } from './fixtures.mjs';

function logicGraph() {
  return {
    schema: [
      { id: 'score', name: 'score', type: 'number', required: true },
      { id: 'tier', name: 'tier', type: 'enum', options: ['priority', 'standard'], required: false },
      { id: 'backlogs', name: 'backlogs', type: 'number', required: true },
    ],
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'eligibility', type: 'group', x: 240, y: 0, operator: 'and', terms: [
        { type: 'group', operator: 'or', terms: [
          { type: 'condition', fieldId: 'score', operator: 'gte', value: 8 },
          { type: 'condition', fieldId: 'tier', operator: 'eq', value: 'priority' },
        ] },
        { type: 'condition', fieldId: 'backlogs', operator: 'eq', value: 0 },
      ] },
      { id: 'eligible', type: 'outcome', x: 560, y: 0, label: 'Eligible', result: true },
      { id: 'review', type: 'outcome', x: 560, y: 220, label: 'Review', result: false },
    ],
    edges: [
      { id: 'entry', from: 'start', fromPort: 'next', to: 'eligibility', toPort: 'in' },
      { id: 'pass', from: 'eligibility', fromPort: 'true', to: 'eligible', toPort: 'in' },
      { id: 'fail', from: 'eligibility', fromPort: 'false', to: 'review', toPort: 'in' },
    ],
  };
}

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

test('reports cycles in unreachable components as well as unreachable nodes', () => {
  const graph = validGraph();
  graph.nodes.push(
    { id: 'cycle-a', type: 'condition', x: 800, y: 0, fieldId: 'score', operator: 'gte', value: 0 },
    { id: 'cycle-b', type: 'condition', x: 900, y: 0, fieldId: 'score', operator: 'gte', value: 0 },
    { id: 'cycle-end-a', type: 'outcome', x: 1000, y: 0, label: 'A', result: 'a' },
    { id: 'cycle-end-b', type: 'outcome', x: 1000, y: 100, label: 'B', result: 'b' },
  );
  graph.edges.push(
    { id: 'cycle-edge-a', from: 'cycle-a', fromPort: 'true', to: 'cycle-b', toPort: 'in' },
    { id: 'cycle-edge-b', from: 'cycle-a', fromPort: 'false', to: 'cycle-end-a', toPort: 'in' },
    { id: 'cycle-edge-c', from: 'cycle-b', fromPort: 'true', to: 'cycle-a', toPort: 'in' },
    { id: 'cycle-edge-d', from: 'cycle-b', fromPort: 'false', to: 'cycle-end-b', toPort: 'in' },
  );
  const result = validateGraph(graph);
  assert.ok(result.errors.some((error) => error.code === 'graph.cycle'));
  assert.ok(result.errors.some((error) => error.code === 'graph.unreachable' && error.nodeId === 'cycle-a'));
});

test('validates a deep graph without recursive stack overflow', () => {
  const conditionCount = 8000;
  const graph = {
    schema: [{ id: 'score', name: 'score', type: 'number', required: true }],
    nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }],
    edges: [{ id: 'start-edge', from: 'start', fromPort: 'next', to: 'condition-0', toPort: 'in' }],
  };
  for (let index = 0; index < conditionCount; index++) {
    const conditionId = `condition-${index}`;
    const falseId = `false-${index}`;
    const trueId = index + 1 === conditionCount ? 'final-true' : `condition-${index + 1}`;
    graph.nodes.push(
      { id: conditionId, type: 'condition', x: index, y: 0, fieldId: 'score', operator: 'gte', value: 0 },
      { id: falseId, type: 'outcome', x: index, y: 1, label: falseId, result: false },
    );
    graph.edges.push(
      { id: `true-edge-${index}`, from: conditionId, fromPort: 'true', to: trueId, toPort: 'in' },
      { id: `false-edge-${index}`, from: conditionId, fromPort: 'false', to: falseId, toPort: 'in' },
    );
    if (index + 1 === conditionCount) {
      graph.nodes.push({ id: trueId, type: 'outcome', x: index + 1, y: 0, label: trueId, result: true });
    }
  }
  assert.deepEqual(validateGraph(graph), { valid: true, errors: [] });
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

test('evaluates explicit nested AND/OR groups with group-first precedence and stable trace', () => {
  const graph = logicGraph();
  assert.deepEqual(validateGraph(graph), { valid: true, errors: [] });
  const scoreOnly = evaluateGraph(graph, { score: 8, backlogs: 0 });
  const tierOnly = evaluateGraph(graph, { score: 7.9, tier: 'priority', backlogs: 0 });
  const missingOptional = evaluateGraph(graph, { score: 7.9, backlogs: 0 });
  const wrongBacklogs = evaluateGraph(graph, { score: 8, backlogs: 1 });

  assert.equal(scoreOnly.result, true);
  assert.equal(tierOnly.result, true);
  assert.equal(missingOptional.result, false);
  assert.equal(wrongBacklogs.result, false);
  assert.deepEqual(evaluateGraph(graph, { score: 8, backlogs: 0 }), scoreOnly);
  assert.deepEqual(scoreOnly.trace.map((item) => item.kind), ['start', 'group', 'outcome']);
  assert.equal(scoreOnly.trace[1].operator, 'and');
  assert.equal(scoreOnly.trace[1].terms[0].operator, 'or');
  assert.deepEqual(scoreOnly.trace[1].terms.map((term) => term.matched), [true, true]);

  graph.nodes.find((node) => node.id === 'eligibility').x += 300;
  assert.deepEqual(evaluateGraph(graph, { score: 8, backlogs: 0 }), scoreOnly);
});

test('rejects malformed, untyped, oversized and deeply nested logical groups', () => {
  const graph = logicGraph();
  const group = graph.nodes.find((node) => node.id === 'eligibility');
  group.operator = 'xor';
  group.terms[0].terms[1].value = 1;
  const invalid = validateGraph(graph);
  assert.ok(invalid.errors.some((error) => error.code === 'group.operator'));
  assert.ok(invalid.errors.some((error) => error.code === 'node.value.type' || error.code === 'node.value.enum'));

  const tooFew = logicGraph();
  tooFew.nodes.find((node) => node.id === 'eligibility').terms = [{ type: 'condition', fieldId: 'score', operator: 'gte', value: 8 }];
  assert.ok(validateGraph(tooFew).errors.some((error) => error.code === 'group.terms'));

  const tooDeep = logicGraph();
  const root = tooDeep.nodes.find((node) => node.id === 'eligibility');
  let nested = root.terms[0];
  for (let depth = 0; depth < 20; depth++) {
    nested.terms = [{ type: 'condition', fieldId: 'score', operator: 'gte', value: 8 }, { type: 'group', operator: 'and', terms: [] }];
    nested = nested.terms[1];
  }
  assert.ok(validateGraph(tooDeep).errors.some((error) => error.code === 'group.depth' || error.code === 'group.terms'));
});

test('evaluates an unconditional graph with empty schema using empty input object', () => {
  const unconditionalGraph = {
    schema: [],
    nodes: [
      { id: 'start', type: 'start', x: 100, y: 220 },
      { id: 'outcome-approved', type: 'outcome', x: 710, y: 135, label: 'Approved Outcome', result: 'approved' },
    ],
    edges: [
      { id: 'start-outcome', from: 'start', fromPort: 'next', to: 'outcome-approved', toPort: 'in' },
    ],
  };
  const validation = validateGraph(unconditionalGraph);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.errors, []);
  const evaluation = evaluateGraph(unconditionalGraph, {});
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.result, 'approved');
  assert.equal(evaluation.outcomeId, 'outcome-approved');
  assert.deepEqual(evaluation.trace, [
    { nodeId: 'start', kind: 'start', label: 'Start' },
    { nodeId: 'outcome-approved', kind: 'outcome', label: 'Approved Outcome', result: 'approved' },
  ]);
});

test('evaluates graph with default schema field name containing spaces such as Input 1', () => {
  const defaultFieldGraph = {
    schema: [
      { id: 'field-1', name: 'Input 1', type: 'string', required: true },
    ],
    nodes: [
      { id: 'start', type: 'start', x: 100, y: 220 },
      { id: 'check', type: 'condition', x: 400, y: 220, fieldId: 'field-1', operator: 'eq', value: 'verified' },
      { id: 'yes', type: 'outcome', x: 700, y: 140, label: 'Passed', result: { status: 'passed' } },
      { id: 'no', type: 'outcome', x: 700, y: 320, label: 'Failed', result: { status: 'failed' } },
    ],
    edges: [
      { id: 'e1', from: 'start', fromPort: 'next', to: 'check', toPort: 'in' },
      { id: 'e2', from: 'check', fromPort: 'true', to: 'yes', toPort: 'in' },
      { id: 'e3', from: 'check', fromPort: 'false', to: 'no', toPort: 'in' },
    ],
  };
  assert.equal(validateGraph(defaultFieldGraph).valid, true);
  const match = evaluateGraph(defaultFieldGraph, { 'Input 1': 'verified' });
  assert.equal(match.ok, true);
  assert.deepEqual(match.result, { status: 'passed' });
  const noMatch = evaluateGraph(defaultFieldGraph, { 'Input 1': 'other' });
  assert.equal(noMatch.ok, true);
  assert.deepEqual(noMatch.result, { status: 'failed' });
});

test('evaluates scholarship eligibility boundary conditions accurately across the full matrix', () => {
  const scholarshipGraph = {
    schema: [
      { id: 'f-cgpa', name: 'cgpa', type: 'number', required: true },
      { id: 'f-income', name: 'familyIncome', type: 'number', required: true },
      { id: 'f-backlogs', name: 'backlogs', type: 'number', required: true },
    ],
    nodes: [
      { id: 'start', type: 'start', x: 50, y: 150 },
      {
        id: 'eligibility-group',
        type: 'group',
        operator: 'and',
        terms: [
          { type: 'condition', fieldId: 'f-cgpa', operator: 'gte', value: 8.0 },
          { type: 'condition', fieldId: 'f-income', operator: 'lte', value: 600000 },
          { type: 'condition', fieldId: 'f-backlogs', operator: 'eq', value: 0 },
        ],
        x: 350,
        y: 150,
      },
      { id: 'outcome-eligible', type: 'outcome', label: 'Eligible', result: 'ELIGIBLE', x: 700, y: 50 },
      { id: 'outcome-ineligible', type: 'outcome', label: 'Not Eligible', result: 'NOT_ELIGIBLE', x: 700, y: 250 },
    ],
    edges: [
      { id: 'e-start', from: 'start', fromPort: 'next', to: 'eligibility-group', toPort: 'in' },
      { id: 'e-true', from: 'eligibility-group', fromPort: 'true', to: 'outcome-eligible', toPort: 'in' },
      { id: 'e-false', from: 'eligibility-group', fromPort: 'false', to: 'outcome-ineligible', toPort: 'in' },
    ],
  };

  assert.equal(validateGraph(scholarshipGraph).valid, true);

  const vectors = [
    { cgpa: 7.99, familyIncome: 599999, backlogs: 0, expected: 'NOT_ELIGIBLE' },
    { cgpa: 8.00, familyIncome: 599999, backlogs: 0, expected: 'ELIGIBLE' },
    { cgpa: 8.01, familyIncome: 599999, backlogs: 0, expected: 'ELIGIBLE' },
    { cgpa: 8.00, familyIncome: 600000, backlogs: 0, expected: 'ELIGIBLE' },
    { cgpa: 8.00, familyIncome: 600001, backlogs: 0, expected: 'NOT_ELIGIBLE' },
    { cgpa: 8.00, familyIncome: 599999, backlogs: 1, expected: 'NOT_ELIGIBLE' },
    { cgpa: 7.99, familyIncome: 600001, backlogs: 1, expected: 'NOT_ELIGIBLE' },
    { cgpa: 8.01, familyIncome: 600000, backlogs: 0, expected: 'ELIGIBLE' },
  ];

  for (const v of vectors) {
    const res = evaluateGraph(scholarshipGraph, { cgpa: v.cgpa, familyIncome: v.familyIncome, backlogs: v.backlogs });
    assert.equal(res.ok, true);
    assert.equal(res.result, v.expected);
    assert.equal(res.trace.length, 3);
    assert.equal(res.trace[0].kind, 'start');
    assert.equal(res.trace[1].kind, 'group');
    assert.equal(res.trace[1].terms.length, 3);
    assert.equal(res.trace[2].kind, 'outcome');
  }

  // Verify full 3 x 3 x 2 cross product
  const cgpaValues = [7.99, 8.00, 8.01];
  const incomeValues = [599999, 600000, 600001];
  const backlogValues = [0, 1];
  for (const cgpa of cgpaValues) {
    for (const familyIncome of incomeValues) {
      for (const backlogs of backlogValues) {
        const expected = (cgpa >= 8.0 && familyIncome <= 600000 && backlogs === 0) ? 'ELIGIBLE' : 'NOT_ELIGIBLE';
        const evalRes = evaluateGraph(scholarshipGraph, { cgpa, familyIncome, backlogs });
        assert.equal(evalRes.ok, true);
        assert.equal(evalRes.result, expected);
      }
    }
  }
});
