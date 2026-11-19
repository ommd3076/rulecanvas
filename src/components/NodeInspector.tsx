import React from 'react';
import type { RuleNode, SchemaField } from '@/src/api';
import { Input } from '@/components/base/input/input';
import { Textarea } from '@/components/base/textarea/textarea';
import { Select, SelectItem } from '@/components/base/select/select';
import { NumberField } from '@/components/base/number-field/number-field';
import { Button } from '@/components/base/buttons/button';
import { IconButton } from '@/components/base/buttons/icon-button';
import { Chip } from '@/components/base/badges/chip';
import { Accordion, AccordionItem } from '@/components/base/accordion/accordion';
import { RiAddLine, RiDeleteBinLine, RiArrowRightSLine } from '@remixicon/react';
import InlineCopyInput from '@/components/ruixen/inline-copy-input';
import { cx } from '@/utils/cx';

interface NodeInspectorProps {
  node: RuleNode;
  schema: SchemaField[];
  onUpdateNode: (updatedNode: RuleNode) => void;
}

const getAvailableOperators = (type?: string) => {
  if (type === 'number' || type === 'date') {
    return [
      { id: 'eq', label: '== (Equals)' },
      { id: 'neq', label: '!= (Not equals)' },
      { id: 'gte', label: '>= (Greater or equal)' },
      { id: 'gt', label: '> (Greater than)' },
      { id: 'lte', label: '<= (Less or equal)' },
      { id: 'lt', label: '< (Less than)' },
    ];
  }
  return [
    { id: 'eq', label: '== (Equals)' },
    { id: 'neq', label: '!= (Not equals)' },
  ];
};

function getTermSummary(term: any, schema: SchemaField[]): string {
  if (!term) return '';
  if (term.type === 'group') {
    const op = (term.operator || 'and').toUpperCase();
    const children = (Array.isArray(term.terms) ? term.terms : []).map((t: any) =>
      getTermSummary(t, schema)
    );
    return `(${children.join(` ${op} `)})`;
  }
  const field = schema.find((f) => f.id === term.fieldId);
  const name = field ? field.name : term.fieldId || 'field';
  const val = term.value !== undefined ? JSON.stringify(term.value) : '…';
  const opMap: Record<string, string> = {
    eq: '==',
    neq: '!=',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
  };
  const op = opMap[term.operator] || term.operator || '==';
  return `${name} ${op} ${val}`;
}

interface TermItemProps {
  term: any;
  index: number;
  depth: number;
  path: number[];
  schema: SchemaField[];
  onUpdate: (updatedTerm: any) => void;
  onDelete: () => void;
}

const TermItem: React.FC<TermItemProps> = ({
  term,
  index,
  depth,
  path,
  schema,
  onUpdate,
  onDelete,
}) => {
  const isGroup = term.type === 'group';

  if (isGroup) {
    const operator = term.operator || 'or';
    const terms = Array.isArray(term.terms) ? term.terms : [];
    const itemKey = `subgroup-${path.join('-')}`;

    return (
      <div className={cx('flex flex-col gap-2', depth > 0 && 'ms-1')}>
        <Accordion variant="separated" allowsMultipleExpanded defaultExpandedKeys={[itemKey]}>
          <AccordionItem
            id={itemKey}
            title={
              <div className="flex flex-wrap items-center gap-2">
                <Chip variant="bold" color="purple">
                  {operator.toUpperCase()} SUBGROUP
                </Chip>
                <span className="font-mono text-caption-2 text-text-tertiary">
                  Depth {depth + 1}
                </span>
                <span className="max-w-[220px] truncate text-caption-1-medium text-text-secondary">
                  {getTermSummary(term, schema)}
                </span>
              </div>
            }
            description={
              <span className="text-caption-1-regular text-text-tertiary">
                Level {depth + 1} · {terms.length} nested {terms.length === 1 ? 'term' : 'terms'}
              </span>
            }
          >
            <div className="flex flex-col gap-3 pt-2">
              {/* Subgroup operator toggle and delete */}
              <div className="flex items-center justify-between gap-2 border-b border-separator-border/40 pb-2">
                <div className="flex items-center gap-2">
                  <span className="text-caption-1-medium text-text-secondary">Subgroup Logic:</span>
                  <div className="flex items-center rounded-lg border border-border-button-default bg-background-secondary-default p-0.5">
                    <button
                      type="button"
                      className={cx(
                        'rounded px-2.5 py-1 text-caption-1-semibold transition-colors',
                        operator === 'and'
                          ? 'bg-background-primary-default text-text-primary shadow-xs'
                          : 'text-text-tertiary hover:text-text-secondary'
                      )}
                      onClick={() => onUpdate({ ...term, operator: 'and' })}
                    >
                      AND (All)
                    </button>
                    <button
                      type="button"
                      className={cx(
                        'rounded px-2.5 py-1 text-caption-1-semibold transition-colors',
                        operator === 'or'
                          ? 'bg-background-primary-default text-text-primary shadow-xs'
                          : 'text-text-tertiary hover:text-text-secondary'
                      )}
                      onClick={() => onUpdate({ ...term, operator: 'or' })}
                    >
                      OR (Any)
                    </button>
                  </div>
                </div>

                <Button
                  variant="danger"
                  size="xs"
                  leadingIcon={RiDeleteBinLine}
                  onClick={onDelete}
                >
                  Remove Subgroup
                </Button>
              </div>

              {/* Children terms */}
              <div className="flex flex-col gap-2.5 border-s-2 border-border-button-default/60 ps-2">
                {terms.length === 0 ? (
                  <p className="text-caption-1-regular italic text-text-tertiary">
                    Empty subgroup. Add conditions or nested groups below.
                  </p>
                ) : (
                  terms.map((childTerm: any, childIdx: number) => (
                    <TermItem
                      key={childTerm.id || `${path.join('-')}-${childIdx}`}
                      term={childTerm}
                      index={childIdx}
                      depth={depth + 1}
                      path={[...path, childIdx]}
                      schema={schema}
                      onUpdate={(updatedChild) => {
                        const nextTerms = [...terms];
                        nextTerms[childIdx] = updatedChild;
                        onUpdate({ ...term, terms: nextTerms });
                      }}
                      onDelete={() => {
                        const nextTerms = terms.filter((_: any, i: number) => i !== childIdx);
                        onUpdate({ ...term, terms: nextTerms });
                      }}
                    />
                  ))
                )}
              </div>

              {/* Subgroup Add Actions */}
              <div className="flex items-center gap-2 border-t border-separator-border/40 pt-2">
                <Button
                  variant="secondary"
                  size="xs"
                  leadingIcon={RiAddLine}
                  onClick={() => {
                    const defaultField = schema[0];
                    const newCondition = {
                      type: 'condition',
                      fieldId: defaultField?.id || '',
                      operator: 'eq',
                      value:
                        defaultField?.type === 'number'
                          ? 0
                          : defaultField?.type === 'boolean'
                          ? true
                          : defaultField?.type === 'enum'
                          ? defaultField.options?.[0] || ''
                          : defaultField?.type === 'date'
                          ? new Date().toISOString().slice(0, 10)
                          : '',
                    };
                    onUpdate({ ...term, terms: [...terms, newCondition] });
                  }}
                >
                  Add Condition
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  leadingIcon={RiAddLine}
                  onClick={() => {
                    const defaultField = schema[0];
                    const leaf = () => ({
                      type: 'condition',
                      fieldId: defaultField?.id || '',
                      operator: 'eq',
                      value:
                        defaultField?.type === 'number'
                          ? 0
                          : defaultField?.type === 'boolean'
                          ? true
                          : defaultField?.type === 'enum'
                          ? defaultField.options?.[0] || ''
                          : '',
                    });
                    const newSubgroup = {
                      type: 'group',
                      operator: 'or',
                      terms: [leaf(), leaf()],
                    };
                    onUpdate({ ...term, terms: [...terms, newSubgroup] });
                  }}
                >
                  Add Subgroup
                </Button>
              </div>
            </div>
          </AccordionItem>
        </Accordion>
      </div>
    );
  }

  // Condition Leaf
  const termField = schema.find((f) => f.id === term.fieldId);

  return (
    <div
      className={cx(
        'flex flex-col gap-2 rounded-xl border border-border-button-default bg-background-primary-default p-2.5 shadow-xs',
        depth > 0 && 'ms-1'
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono text-caption-1-medium text-text-secondary">
            Condition #{index + 1}
          </span>
          {termField && (
            <Chip variant="subtle" color="neutral">
              {termField.type}
            </Chip>
          )}
        </div>
        <IconButton
          size="small"
          icon={RiDeleteBinLine}
          aria-label={`Remove condition ${index + 1}`}
          onClick={onDelete}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Select
          aria-label={`Condition ${index + 1} field`}
          selectedKey={term.fieldId || schema[0]?.id}
          onSelectionChange={(key) => {
            const f = schema.find((field) => field.id === key);
            let defaultValue: any = '';
            if (f?.type === 'number') defaultValue = 0;
            else if (f?.type === 'boolean') defaultValue = true;
            else if (f?.type === 'enum') defaultValue = f.options?.[0] || '';
            else if (f?.type === 'date') defaultValue = new Date().toISOString().slice(0, 10);

            onUpdate({
              ...term,
              type: 'condition',
              fieldId: String(key),
              operator: 'eq',
              value: defaultValue,
            });
          }}
        >
          {schema.map((f) => (
            <SelectItem key={f.id} id={f.id}>
              {f.name} ({f.type})
            </SelectItem>
          ))}
        </Select>

        <Select
          aria-label={`Condition ${index + 1} operator`}
          selectedKey={term.operator || 'eq'}
          onSelectionChange={(key) => onUpdate({ ...term, operator: String(key) })}
        >
          {getAvailableOperators(termField?.type).map((op) => (
            <SelectItem key={op.id} id={op.id}>
              {op.label}
            </SelectItem>
          ))}
        </Select>
      </div>

      {termField?.type === 'number' ? (
        <NumberField
          aria-label={`Condition ${index + 1} value`}
          value={typeof term.value === 'number' ? term.value : 0}
          onChange={(val) => onUpdate({ ...term, value: val })}
        />
      ) : termField?.type === 'boolean' ? (
        <Select
          aria-label={`Condition ${index + 1} boolean value`}
          selectedKey={String(term.value ?? true)}
          onSelectionChange={(key) => onUpdate({ ...term, value: key === 'true' })}
        >
          <SelectItem id="true">true</SelectItem>
          <SelectItem id="false">false</SelectItem>
        </Select>
      ) : termField?.type === 'enum' ? (
        <Select
          aria-label={`Condition ${index + 1} enum value`}
          selectedKey={String(term.value || termField.options?.[0] || '')}
          onSelectionChange={(key) => onUpdate({ ...term, value: String(key) })}
        >
          {(termField.options || []).map((opt) => (
            <SelectItem key={opt} id={opt}>
              {opt}
            </SelectItem>
          ))}
        </Select>
      ) : termField?.type === 'date' ? (
        <Input
          type="date"
          aria-label={`Condition ${index + 1} date value`}
          value={String(term.value || '')}
          onChange={(val) => onUpdate({ ...term, value: val })}
        />
      ) : (
        <Input
          aria-label={`Condition ${index + 1} value`}
          placeholder="Expected string value"
          value={String(term.value ?? '')}
          onChange={(val) => onUpdate({ ...term, value: val })}
        />
      )}
    </div>
  );
};

export const NodeInspector: React.FC<NodeInspectorProps> = ({
  node,
  schema,
  onUpdateNode,
}) => {
  const selectedField = schema.find((f) => f.id === node.fieldId);

  const handleFieldChange = (fieldId: string) => {
    const field = schema.find((f) => f.id === fieldId);
    let defaultValue: any = '';
    if (field?.type === 'number') defaultValue = 0;
    else if (field?.type === 'boolean') defaultValue = true;
    else if (field?.type === 'enum') defaultValue = field.options?.[0] || '';
    else if (field?.type === 'date') defaultValue = new Date().toISOString().slice(0, 10);

    onUpdateNode({
      ...node,
      fieldId,
      operator: 'eq',
      value: defaultValue,
    });
  };

  const handleOperatorChange = (operator: string) => {
    onUpdateNode({ ...node, operator });
  };

  const handleValueChange = (value: any) => {
    onUpdateNode({ ...node, value });
  };

  const handleAddTopCondition = () => {
    const defaultField = schema[0];
    const newTerm = {
      type: 'condition',
      fieldId: defaultField?.id || '',
      operator: 'eq',
      value:
        defaultField?.type === 'number'
          ? 0
          : defaultField?.type === 'boolean'
          ? true
          : defaultField?.type === 'enum'
          ? defaultField.options?.[0] || ''
          : defaultField?.type === 'date'
          ? new Date().toISOString().slice(0, 10)
          : '',
    };
    const terms = Array.isArray(node.terms) ? [...node.terms, newTerm] : [newTerm];
    onUpdateNode({ ...node, terms });
  };

  const handleAddTopSubgroup = () => {
    const defaultField = schema[0];
    const leaf = () => ({
      type: 'condition',
      fieldId: defaultField?.id || '',
      operator: 'eq',
      value:
        defaultField?.type === 'number'
          ? 0
          : defaultField?.type === 'boolean'
          ? true
          : defaultField?.type === 'enum'
          ? defaultField.options?.[0] || ''
          : '',
    });
    const newSubgroup = {
      type: 'group',
      operator: 'or',
      terms: [leaf(), leaf()],
    };
    const terms = Array.isArray(node.terms) ? [...node.terms, newSubgroup] : [newSubgroup];
    onUpdateNode({ ...node, terms });
  };

  return (
    <div className="flex flex-col gap-5 p-1">
      {/* Node Kind & Collapsible Details (Stable ID & Coordinates) */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Chip
            variant="bold"
            color={
              node.type === 'start'
                ? 'blue'
                : node.type === 'condition'
                ? 'yellow'
                : node.type === 'group'
                ? 'purple'
                : 'lime'
            }
          >
            {node.type.toUpperCase()} NODE
          </Chip>
          <span className="text-caption-1-regular text-text-tertiary">
            x: {node.x}, y: {node.y}
          </span>
        </div>

        <details className="group rounded-xl border border-separator-border/60 bg-background-secondary-default/30 p-2 text-caption-1-medium text-text-secondary">
          <summary className="cursor-pointer select-none font-medium text-text-tertiary hover:text-text-primary">
            Node ID & Coordinates
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <InlineCopyInput value={node.id} label="Node ID" sound={false} />
            <span className="font-mono text-caption-2-regular text-text-tertiary">
              Canvas Position: x={node.x}, y={node.y}
            </span>
          </div>
        </details>
      </div>

      {/* Start Node */}
      {node.type === 'start' && (
        <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-4">
          <p className="text-body-2-regular text-text-secondary">
            This is the root starting node for ruleset execution. Evaluation flows from its output port into the first condition or outcome node.
          </p>
        </div>
      )}

      {/* Condition Node */}
      {node.type === 'condition' && (
        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-body-2-medium text-text-primary">
              Target Schema Field
            </label>
            {schema.length === 0 ? (
              <p className="text-body-2-regular text-text-error-primary">
                No schema fields declared yet. Add fields in the Input Schema tab.
              </p>
            ) : (
              <Select
                aria-label="Target schema field"
                selectedKey={node.fieldId || schema[0]?.id}
                onSelectionChange={(key) => handleFieldChange(String(key))}
              >
                {schema.map((field) => (
                  <SelectItem key={field.id} id={field.id}>
                    {field.name} ({field.type})
                  </SelectItem>
                ))}
              </Select>
            )}
          </div>

          {selectedField && (
            <>
              <div>
                <label className="mb-1 block text-body-2-medium text-text-primary">
                  Comparison Operator
                </label>
                <Select
                  aria-label="Comparison operator"
                  selectedKey={node.operator || 'eq'}
                  onSelectionChange={(key) => handleOperatorChange(String(key))}
                >
                  {getAvailableOperators(selectedField.type).map((op) => (
                    <SelectItem key={op.id} id={op.id}>
                      {op.label}
                    </SelectItem>
                  ))}
                </Select>
              </div>

              <div>
                <label className="mb-1 block text-body-2-medium text-text-primary">
                  Expected Value
                </label>
                {selectedField.type === 'number' ? (
                  <NumberField
                    aria-label="Expected numeric value"
                    value={typeof node.value === 'number' ? node.value : 0}
                    onChange={handleValueChange}
                  />
                ) : selectedField.type === 'boolean' ? (
                  <Select
                    aria-label="Expected boolean value"
                    selectedKey={String(node.value ?? true)}
                    onSelectionChange={(key) => handleValueChange(key === 'true')}
                  >
                    <SelectItem id="true">true</SelectItem>
                    <SelectItem id="false">false</SelectItem>
                  </Select>
                ) : selectedField.type === 'enum' ? (
                  <Select
                    aria-label="Expected enum value"
                    selectedKey={String(node.value || '')}
                    onSelectionChange={(key) => handleValueChange(String(key))}
                  >
                    {(selectedField.options || []).map((opt) => (
                      <SelectItem key={opt} id={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </Select>
                ) : selectedField.type === 'date' ? (
                  <Input
                    type="date"
                    aria-label="Expected date"
                    value={String(node.value || '')}
                    onChange={(val) => handleValueChange(val)}
                  />
                ) : (
                  <Input
                    aria-label="Expected string value"
                    placeholder="Enter string value"
                    value={String(node.value ?? '')}
                    onChange={(val) => handleValueChange(val)}
                  />
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Logic Group Node (Recursive Nested AND/OR support) */}
      {node.type === 'group' && (
        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-body-2-medium text-text-primary">
              Root Group Logic Operator
            </label>
            <p className="mb-2 text-caption-1-regular text-text-tertiary">
              Combine conditions. Each group applies its operator to the listed terms. Nest groups to set explicit AND/OR precedence.
            </p>
            <div className="flex items-center gap-2">
              <div className="flex items-center rounded-xl border border-border-button-default bg-background-secondary-default p-1">
                <button
                  type="button"
                  className={cx(
                    'rounded-lg px-3 py-1 text-body-2-medium transition-colors',
                    node.operator !== 'or'
                      ? 'bg-background-primary-default font-semibold text-text-primary shadow-xs'
                      : 'text-text-tertiary hover:text-text-secondary'
                  )}
                  onClick={() => onUpdateNode({ ...node, operator: 'and' })}
                >
                  ALL (AND)
                </button>
                <button
                  type="button"
                  className={cx(
                    'rounded-lg px-3 py-1 text-body-2-medium transition-colors',
                    node.operator === 'or'
                      ? 'bg-background-primary-default font-semibold text-text-primary shadow-xs'
                      : 'text-text-tertiary hover:text-text-secondary'
                  )}
                  onClick={() => onUpdateNode({ ...node, operator: 'or' })}
                >
                  ANY (OR)
                </button>
              </div>
              <span className="text-caption-1-regular text-text-tertiary">
                {node.operator === 'or'
                  ? 'Requires at least one matching term'
                  : 'Requires all terms to match'}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-separator-border pt-3">
            <span className="text-body-2-medium text-text-primary">
              Terms ({Array.isArray(node.terms) ? node.terms.length : 0})
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                variant="secondary"
                size="small"
                leadingIcon={RiAddLine}
                onClick={handleAddTopCondition}
              >
                + Condition
              </Button>
              <Button
                variant="ghost"
                size="small"
                leadingIcon={RiAddLine}
                onClick={handleAddTopSubgroup}
              >
                + Subgroup
              </Button>
            </div>
          </div>

          {!Array.isArray(node.terms) || node.terms.length === 0 ? (
            <p className="text-body-2-regular text-text-tertiary">
              No nested terms. Add at least one condition term or subgroup to this logic group.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {node.terms.map((term: any, idx: number) => (
                <TermItem
                  key={term.id || `term-${idx}`}
                  term={term}
                  index={idx}
                  depth={0}
                  path={[idx]}
                  schema={schema}
                  onUpdate={(updatedTerm) => {
                    const nextTerms = [...node.terms!];
                    nextTerms[idx] = updatedTerm;
                    onUpdateNode({ ...node, terms: nextTerms });
                  }}
                  onDelete={() => {
                    const nextTerms = node.terms!.filter((_, i) => i !== idx);
                    onUpdateNode({ ...node, terms: nextTerms });
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Outcome Node */}
      {node.type === 'outcome' && (
        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-body-2-medium text-text-primary">
              Outcome Title / Label
            </label>
            <Input
              aria-label="Outcome label"
              placeholder="e.g. Approved, Declined, Manual Review"
              value={node.label || ''}
              onChange={(val) => onUpdateNode({ ...node, label: val })}
            />
          </div>

          <div>
            <label className="mb-1 block text-body-2-medium text-text-primary">
              Result Payload (JSON or String)
            </label>
            <Textarea
              aria-label="Outcome result"
              placeholder='e.g. {"status": "approved", "reason": "meets criteria"}'
              value={
                typeof node.result === 'object' && node.result !== null
                  ? JSON.stringify(node.result, null, 2)
                  : String(node.result ?? '')
              }
              onChange={(val) => {
                let parsed: any = val;
                try {
                  parsed = JSON.parse(val);
                } catch {
                  // Keep as string if not valid JSON
                }
                onUpdateNode({ ...node, result: parsed });
              }}
              rows={4}
            />
          </div>
        </div>
      )}
    </div>
  );
};
