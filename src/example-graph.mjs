// Kept in a Node-compatible module so the local store creates the complete
// guided example as one atomic operation.
export function createEligibilityExampleGraph() {
  return {
    schema: [{ id: 'field-score', name: 'score', type: 'number', required: true }],
    nodes: [
      { id: 'start', type: 'start', x: 40, y: 145 },
      { id: 'score-check', type: 'condition', x: 305, y: 145, fieldId: 'field-score', operator: 'gte', value: 8 },
      { id: 'eligible', type: 'outcome', x: 570, y: 65, label: 'Eligible', result: { status: 'approved', decision: 'eligible' } },
      { id: 'review', type: 'outcome', x: 570, y: 245, label: 'Review', result: { status: 'declined', decision: 'review' } },
    ],
    edges: [
      { id: 'start-score', from: 'start', fromPort: 'next', to: 'score-check', toPort: 'in' },
      { id: 'score-yes', from: 'score-check', fromPort: 'true', to: 'eligible', toPort: 'in' },
      { id: 'score-no', from: 'score-check', fromPort: 'false', to: 'review', toPort: 'in' },
    ],
  };
}
