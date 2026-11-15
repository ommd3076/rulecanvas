export function validGraph() {
  return {
    schema: [
      { id: 'field-score', name: 'score', type: 'number', required: true },
      { id: 'field-tier', name: 'tier', type: 'enum', options: ['standard', 'priority'], required: false },
    ],
    nodes: [
      { id: 'start', type: 'start', x: 60, y: 220 },
      { id: 'score-check', type: 'condition', x: 360, y: 220, fieldId: 'field-score', operator: 'gte', value: 8 },
      { id: 'eligible', type: 'outcome', x: 700, y: 140, label: 'Eligible', result: { decision: 'eligible' } },
      { id: 'review', type: 'outcome', x: 700, y: 380, label: 'Review', result: { decision: 'review' } },
    ],
    edges: [
      { id: 'start-score', from: 'start', fromPort: 'next', to: 'score-check', toPort: 'in' },
      { id: 'score-yes', from: 'score-check', fromPort: 'true', to: 'eligible', toPort: 'in' },
      { id: 'score-no', from: 'score-check', fromPort: 'false', to: 'review', toPort: 'in' },
    ],
  };
}
