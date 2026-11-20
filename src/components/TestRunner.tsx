import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SchemaField, EvaluationResult, EvaluationTraceEntry, TestScenario } from '@/src/api';
import { api } from '@/src/api';
import { toast } from 'sonner';
import { Input } from '@/components/base/input/input';
import { Select, SelectItem } from '@/components/base/select/select';
import { NumberField } from '@/components/base/number-field/number-field';
import { Chip } from '@/components/base/badges/chip';
import { Button } from '@/components/base/buttons/button';
import { AlertDialog } from '@/components/base/modal/modal';
import { Accordion, AccordionItem } from '@/components/base/accordion/accordion';
import {
  RiCheckLine,
  RiAlertLine,
  RiSparklingLine,
  RiDeleteBinLine,
  RiInformationLine,
  RiSaveLine,
  RiFolderOpenLine,
} from '@remixicon/react';
import ProgressButton from '@/components/ruixen/progress-button';
import StepPlayer, { type StepPlayerStep } from '@/components/rareui/step-player';
import { shouldIncludeTypedValue } from '@/public/typed-input.js';

interface TestRunnerProps {
  schema: SchemaField[];
  onRunTest: (inputs: Record<string, any>) => Promise<EvaluationResult>;
  onHighlightNode?: (nodeId: string | null) => void;
  initialInputValues?: Record<string, any>;
  guideText?: string;
  scenarioRulesetId?: string;
  scenarioOutcomes?: Array<{ id: string; label: string }>;
  onBeforeCreateScenario?: () => Promise<unknown>;
}

function buildCleanPayload(schema: SchemaField[], inputValues: Record<string, any>) {
  const cleanPayload: Record<string, any> = {};
  for (const field of schema) {
    const hasExplicitKey = Object.hasOwn(inputValues, field.name);
    const rawVal = hasExplicitKey ? inputValues[field.name] : undefined;
    if (rawVal !== undefined && rawVal !== null) {
      if (shouldIncludeTypedValue(field, rawVal)) {
        if (field.type === 'number') {
          const parsed = Number(rawVal);
          if (!isNaN(parsed)) cleanPayload[field.name] = parsed;
        } else if (field.type === 'boolean') {
          cleanPayload[field.name] = rawVal === true || rawVal === 'true';
        } else {
          cleanPayload[field.name] = rawVal;
        }
      }
    } else if (field.type === 'string' && shouldIncludeTypedValue(field, '')) {
      cleanPayload[field.name] = '';
    }
  }
  return cleanPayload;
}

/**
 * Format inline summary of a group term tree:
 * e.g. "AND (tier eq 'gold' [actual: 'gold'] (pass) · OR(gpa gte 3.8 [actual: 3.9] (pass)) [MATCH])"
 */
const formatGroupTermSummary = (term: any): string => {
  if (!term) return '';
  if (term.type === 'group') {
    const subTerms = Array.isArray(term.terms)
      ? term.terms.map(formatGroupTermSummary).join(' · ')
      : '';
    return `${(term.operator || 'OR').toUpperCase()}(${subTerms}) [${
      term.matched ? 'MATCH' : 'FAIL'
    }]`;
  }
  const actualStr =
    term.actual !== null && term.actual !== undefined
      ? JSON.stringify(term.actual)
      : 'blank';
  return `${term.field} ${term.operator} ${String(term.expected)} [actual: ${actualStr}] (${
    term.matched ? 'pass' : 'fail'
  })`;
};

/**
 * Recursive renderer for group evaluation terms using BoardUI Accordion
 */
const TraceGroupTerms: React.FC<{ terms: any[]; depth?: number; parentKey?: string }> = ({
  terms,
  depth = 0,
  parentKey = 'root',
}) => {
  if (!Array.isArray(terms) || terms.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 pt-1">
      {terms.map((term, i) => {
        const itemKey = `${parentKey}-${depth}-${i}`;

        if (term.type === 'group') {
          return (
            <Accordion key={itemKey} variant="separated" defaultExpandedKeys={[itemKey]} className="my-1">
              <AccordionItem
                id={itemKey}
                title={
                  <div className="flex items-center justify-between gap-2 pe-3">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-caption-1-medium text-text-primary">
                        Nested {(term.operator || 'OR').toUpperCase()} Subgroup
                      </span>
                      <span className="text-caption-2 text-text-tertiary">
                        ({term.terms?.length || 0} nested {term.terms?.length === 1 ? 'term' : 'terms'})
                      </span>
                    </div>
                    <Chip variant="bold" color={term.matched ? 'lime' : 'rose'}>
                      {term.matched ? 'MATCHED' : 'FAILED'}
                    </Chip>
                  </div>
                }
                description={
                  <span className="text-caption-2 text-text-secondary truncate">
                    Subgroup rule: {term.operator === 'and' ? 'All conditions must match' : 'At least one condition must match'}
                  </span>
                }
              >
                <div className="p-2.5">
                  <TraceGroupTerms terms={term.terms} depth={depth + 1} parentKey={itemKey} />
                </div>
              </AccordionItem>
            </Accordion>
          );
        }

        // Condition Leaf with explicit expected vs actual and match explanation
        const actualStr =
          term.actual !== null && term.actual !== undefined
            ? JSON.stringify(term.actual)
            : '(blank / not provided)';

        return (
          <div
            key={itemKey}
            className={`flex items-start justify-between gap-3 rounded-xl border p-2.5 text-caption-1-regular transition-all ${
              term.matched
                ? 'border-status-lime-text/30 bg-status-lime-background/30'
                : 'border-status-rose-text/30 bg-status-rose-background/30'
            }`}
          >
            <div className="flex flex-col gap-0.5 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-semibold text-text-primary">
                  {term.field}
                </span>
                <span className="font-mono text-caption-2 text-text-secondary">
                  {term.operator} {JSON.stringify(term.expected)}
                </span>
              </div>
              <div className="flex items-center gap-2 text-caption-2 text-text-secondary">
                <span>
                  Expected: <strong className="text-text-primary">{term.operator} {String(term.expected ?? '')}</strong>
                </span>
                <span>·</span>
                <span>
                  Actual: <strong className="text-text-primary font-mono">{actualStr}</strong>
                </span>
              </div>
              <span className="text-caption-2 text-text-tertiary">
                {term.matched
                  ? `Condition satisfied: actual ${actualStr} matched ${term.operator} ${term.expected}`
                  : `Condition not satisfied: actual ${actualStr} did not match ${term.operator} ${term.expected}`}
              </span>
            </div>
            <Chip variant="bold" color={term.matched ? 'lime' : 'rose'}>
              {term.matched ? 'PASS' : 'FAIL'}
            </Chip>
          </div>
        );
      })}
    </div>
  );
};

export const TestRunner: React.FC<TestRunnerProps> = ({
  schema,
  onRunTest,
  onHighlightNode,
  initialInputValues,
  guideText,
  scenarioRulesetId,
  scenarioOutcomes = [],
  onBeforeCreateScenario,
}) => {
  const [inputValues, setInputValues] = useState<Record<string, any>>(() => initialInputValues || {});
  const [evaluation, setEvaluation] = useState<EvaluationResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [scenarios, setScenarios] = useState<TestScenario[]>([]);
  const [scenariosCanEdit, setScenariosCanEdit] = useState(false);
  const [scenariosLoading, setScenariosLoading] = useState(false);
  const [scenariosError, setScenariosError] = useState('');
  const [scenarioName, setScenarioName] = useState('');
  const [scenarioDescription, setScenarioDescription] = useState('');
  const [scenarioExpectedOutcomeId, setScenarioExpectedOutcomeId] = useState('');
  const [scenarioSaving, setScenarioSaving] = useState(false);
  const [scenarioSaveError, setScenarioSaveError] = useState('');
  const [scenarioDeleting, setScenarioDeleting] = useState(false);
  const [deleteScenario, setDeleteScenario] = useState<TestScenario | null>(null);
  const [loadedScenario, setLoadedScenario] = useState<TestScenario | null>(null);
  const evaluationRequestRef = useRef(0);
  const scenarioRequestRef = useRef(0);
  const inputGenerationRef = useRef(0);

  const loadScenarios = useCallback(async () => {
    if (!scenarioRulesetId) return;
    const requestId = ++scenarioRequestRef.current;
    setScenariosLoading(true);
    setScenariosCanEdit(false);
    setScenariosError('');
    try {
      const result = await api.listScenarios(scenarioRulesetId);
      if (requestId !== scenarioRequestRef.current) return;
      setScenarios(result.scenarios);
      setScenariosCanEdit(result.canEdit);
    } catch (error: any) {
      if (requestId !== scenarioRequestRef.current) return;
      if (error?.status === 401 || error?.status === 403) {
        setScenarios([]);
        setLoadedScenario(null);
      }
      setScenariosError(error?.message || 'Saved scenarios could not be loaded.');
    } finally {
      if (requestId === scenarioRequestRef.current) setScenariosLoading(false);
    }
  }, [scenarioRulesetId]);

  useEffect(() => {
    if (scenarioRulesetId) void loadScenarios();
    else {
      scenarioRequestRef.current += 1;
      setScenarios([]);
      setScenariosCanEdit(false);
      setLoadedScenario(null);
    }
    return () => { scenarioRequestRef.current += 1; };
  }, [scenarioRulesetId, loadScenarios]);

  const outcomeLabel = useMemo(() => new Map(scenarioOutcomes.map(({ id, label }) => [id, label])), [scenarioOutcomes]);

  const handleInputChange = (fieldName: string, value: any) => {
    inputGenerationRef.current += 1;
    evaluationRequestRef.current += 1;
    setEvaluation(null);
    setIsRunning(false);
    setLoadedScenario(null);
    setInputValues((prev) => {
      const next = { ...prev };
      if (value === undefined || value === null) {
        delete next[fieldName];
      } else {
        next[fieldName] = value;
      }
      return next;
    });
  };

  const handleFillSampleInputs = () => {
    inputGenerationRef.current += 1;
    evaluationRequestRef.current += 1;
    setEvaluation(null);
    setIsRunning(false);
    setLoadedScenario(null);
    const samples: Record<string, any> = {};
    for (const field of schema) {
      if (field.type === 'number') samples[field.name] = 100;
      else if (field.type === 'boolean') samples[field.name] = true;
      else if (field.type === 'date') samples[field.name] = '2026-05-01';
      else if (field.type === 'enum') samples[field.name] = field.options?.[0] || 'active';
      else samples[field.name] = 'ValidValue';
    }
    setInputValues(samples);
    toast.info('Sample test inputs populated.');
  };

  const handleClearInputs = () => {
    inputGenerationRef.current += 1;
    evaluationRequestRef.current += 1;
    setEvaluation(null);
    setIsRunning(false);
    setInputValues({});
    setLoadedScenario(null);
    toast.info('Inputs cleared.');
  };

  const handleLoadScenario = (scenario: TestScenario) => {
    inputGenerationRef.current += 1;
    evaluationRequestRef.current += 1;
    setEvaluation(null);
    setIsRunning(false);
    setInputValues({ ...scenario.inputs });
    setLoadedScenario(scenario);
    setActiveStepIndex(0);
    onHighlightNode?.(null);
    toast.info(`Loaded scenario “${scenario.name}”.`);
  };

  const handleSaveScenario = async () => {
    if (!scenarioRulesetId || !scenarioName.trim() || !scenariosCanEdit || scenarioSaving) return;
    const inputGeneration = inputGenerationRef.current;
    const inputs = buildCleanPayload(schema, inputValues);
    setScenarioSaving(true);
    setScenarioSaveError('');
    try {
      await onBeforeCreateScenario?.();
      const result = await api.createScenario(scenarioRulesetId, {
        name: scenarioName.trim(),
        description: scenarioDescription.trim(),
        inputs,
        expectedOutcomeId: scenarioExpectedOutcomeId || null,
      });
      setScenarios((current) => [result.scenario, ...current.filter((item) => item.id !== result.scenario.id)]);
      setScenarioName('');
      setScenarioDescription('');
      setScenarioExpectedOutcomeId('');
      if (inputGenerationRef.current === inputGeneration) setLoadedScenario(result.scenario);
      setScenariosError('');
      toast.success('Test scenario saved.');
    } catch (error: any) {
      if (error?.status === 401 || error?.status === 403) {
        setScenarios([]);
        setScenariosCanEdit(false);
        setLoadedScenario(null);
      }
      setScenarioSaveError(error?.message || 'Scenario could not be saved. Try again.');
    } finally {
      setScenarioSaving(false);
    }
  };

  const handleConfirmDeleteScenario = async () => {
    if (!scenarioRulesetId || !deleteScenario || !scenariosCanEdit || scenarioDeleting) return;
    setScenarioDeleting(true);
    try {
      await api.deleteScenario(scenarioRulesetId, deleteScenario.id);
      setScenarios((current) => current.filter((item) => item.id !== deleteScenario.id));
      if (loadedScenario?.id === deleteScenario.id) setLoadedScenario(null);
      setDeleteScenario(null);
      toast.success('Test scenario deleted.');
    } catch (error: any) {
      if (error?.status === 401 || error?.status === 403) {
        setScenarios([]);
        setScenariosCanEdit(false);
        setLoadedScenario(null);
      }
      setScenariosError(error?.message || 'Scenario could not be deleted. Try again.');
      throw error;
    } finally {
      setScenarioDeleting(false);
    }
  };

  const handleExecute = async () => {
    const requestId = ++evaluationRequestRef.current;
    setEvaluation(null);
    setIsRunning(true);
    try {
      const cleanPayload = buildCleanPayload(schema, inputValues);

      const res = await onRunTest(cleanPayload);
      if (requestId !== evaluationRequestRef.current) return;
      setEvaluation(res);
      setActiveStepIndex(0);
      if (res.trace && res.trace.length > 0 && onHighlightNode) {
        onHighlightNode(res.trace[0].nodeId);
      }
    } catch (err: any) {
      if (requestId === evaluationRequestRef.current) {
        toast.error(`Evaluation failed: ${err.message || 'error'}`);
      }
    } finally {
      if (requestId === evaluationRequestRef.current) setIsRunning(false);
    }
  };

  const handleStepChange = (index: number) => {
    setActiveStepIndex(index);
    if (evaluation?.trace && evaluation.trace[index] && onHighlightNode) {
      onHighlightNode(evaluation.trace[index].nodeId);
    }
  };

  const stepsForPlayer: StepPlayerStep[] = (evaluation?.trace || []).map((entry, idx) => ({
    label: `Step ${idx + 1}: ${entry.kind.toUpperCase()}`,
  }));

  const getTraceStepTitle = (entry: EvaluationTraceEntry, idx: number) => {
    if (entry.kind === 'start') {
      return `Step ${idx + 1}: Start`;
    }
    if (entry.kind === 'condition') {
      const branchText = entry.branch === 'true' ? 'True (Yes)' : 'False (No)';
      return `Step ${idx + 1}: Condition · ${entry.field || 'field'} ${entry.operator || '=='} ${
        entry.expected !== undefined ? String(entry.expected) : ''
      } → ${branchText}`;
    }
    if (entry.kind === 'group') {
      const branchText = entry.branch === 'true' ? 'True (Yes)' : 'False (No)';
      return `Step ${idx + 1}: Group (${(entry.operator || 'AND').toUpperCase()}) → ${branchText}`;
    }
    if (entry.kind === 'outcome') {
      return `Step ${idx + 1}: Outcome · ${entry.label || 'Result'}`;
    }
    return `Step ${idx + 1}: Step Evaluation`;
  };

  return (
    <div className="flex flex-col gap-5 p-1">
      <div>
        <h3 className="text-title-3-semibold text-text-primary">Run Test Evaluation</h3>
        <p className="text-body-2-regular text-text-secondary">
          Enter test payload parameters and step through deterministic execution traces.
        </p>
        {guideText && <p className="mt-2 text-body-2-medium text-text-secondary">{guideText}</p>}
      </div>

      {/* Input parameters form */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border-button-default bg-background-primary-default p-4 shadow-xs">
        <div className="flex items-center justify-between border-b border-separator-border pb-2">
          <span className="text-caption-1-medium text-text-secondary uppercase tracking-wider">
            Input Payload Parameters
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              leadingIcon={RiSparklingLine}
              onClick={handleFillSampleInputs}
              title="Populate typed sample values for all schema fields"
            >
              Fill samples
            </Button>
            <Button
              variant="ghost"
              size="xs"
              leadingIcon={RiDeleteBinLine}
              onClick={handleClearInputs}
              title="Clear all input fields"
            >
              Clear
            </Button>
          </div>
        </div>

        {schema.length === 0 ? (
          <p className="text-body-2-regular text-text-tertiary">
            No schema fields required. Evaluation will run with an empty payload.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {schema.map((field) => (
              <div key={field.id} className="flex flex-col gap-1">
                <label className="text-body-2-medium text-text-primary flex items-center justify-between">
                  <div>
                    {field.name}
                    {field.required && <span className="ms-1 text-red-500">*</span>}
                    <span className="ms-1 text-caption-1-regular text-text-tertiary">
                      ({field.type}{field.required === false ? ', optional' : ''})
                    </span>
                  </div>
                  {inputValues[field.name] === undefined && (
                    <span className="text-caption-2 text-text-tertiary italic">
                      {field.required === false ? 'Unprovided (optional)' : 'Required'}
                    </span>
                  )}
                </label>

                {field.type === 'number' ? (
                  <NumberField
                    aria-label={field.name}
                    placeholder="Enter number (e.g. 150)"
                    value={
                      inputValues[field.name] !== undefined
                        ? Number(inputValues[field.name])
                        : undefined
                    }
                    onChange={(val) => handleInputChange(field.name, val)}
                  />
                ) : field.type === 'boolean' ? (
                  <Select
                    aria-label={field.name}
                    placeholder="Choose boolean value…"
                    selectedKey={
                      inputValues[field.name] !== undefined
                        ? String(inputValues[field.name])
                        : ''
                    }
                    onSelectionChange={(key) => {
                      if (key === 'true') handleInputChange(field.name, true);
                      else if (key === 'false') handleInputChange(field.name, false);
                      else handleInputChange(field.name, undefined);
                    }}
                  >
                    <SelectItem id="">-- Choose boolean (unselected) --</SelectItem>
                    <SelectItem id="true">true</SelectItem>
                    <SelectItem id="false">false</SelectItem>
                  </Select>
                ) : field.type === 'enum' ? (
                  <Select
                    aria-label={field.name}
                    placeholder="Choose enum option…"
                    selectedKey={
                      inputValues[field.name] !== undefined
                        ? String(inputValues[field.name])
                        : ''
                    }
                    onSelectionChange={(key) => {
                      if (key && String(key).length > 0) {
                        handleInputChange(field.name, String(key));
                      } else {
                        handleInputChange(field.name, undefined);
                      }
                    }}
                  >
                    <SelectItem id="">-- Choose enum option (unselected) --</SelectItem>
                    {(field.options || []).map((opt) => (
                      <SelectItem key={opt} id={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </Select>
                ) : field.type === 'date' ? (
                  <Input
                    type="date"
                    aria-label={field.name}
                    value={inputValues[field.name] || ''}
                    onChange={(val) => handleInputChange(field.name, val || undefined)}
                  />
                ) : (
                  <Input
                    aria-label={field.name}
                    placeholder={
                      field.required !== false
                        ? `Enter ${field.name} (required)`
                        : `Enter ${field.name} (optional)`
                    }
                    value={inputValues[field.name] ?? ''}
                    onChange={(val) => handleInputChange(field.name, val)}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mt-2 flex justify-end">
          <ProgressButton
            label="Run test"
            loadingLabel="Evaluating…"
            doneLabel="Evaluated"
            disabled={isRunning}
            onClick={handleExecute}
          />
        </div>
      </div>

      {scenarioRulesetId && (
        <section data-testid="saved-scenarios-panel" aria-labelledby="saved-scenarios-heading" className="flex flex-col gap-4 rounded-2xl border border-border-button-default bg-background-primary-default p-4 shadow-xs">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 id="saved-scenarios-heading" className="text-body-medium font-semibold text-text-primary">Saved test scenarios</h4>
              <p className="mt-1 text-body-2-regular text-text-secondary">Save and reuse typed test payloads for this rule set. Saved scenario inputs are stored with this rule set.</p>
            </div>
            <Button variant="secondary" size="small" leadingIcon={RiFolderOpenLine} onClick={() => void loadScenarios()} disabled={scenariosLoading}>
              {scenariosLoading ? 'Refreshing…' : 'Refresh scenarios'}
            </Button>
          </div>

          {scenariosLoading && scenarios.length === 0 && <p role="status" className="text-body-2-regular text-text-secondary">Loading saved scenarios…</p>}
          {scenariosError && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-error-default p-3">
              <p className="text-body-2-regular text-text-error-primary">{scenariosError}</p>
              <Button variant="secondary" size="small" onClick={() => void loadScenarios()}>Try again</Button>
            </div>
          )}

          {scenariosCanEdit && (
            <div data-testid="saved-scenario-create-form" className="flex flex-col gap-3 rounded-xl bg-background-secondary-default p-4">
              <h5 className="text-body-2-medium text-text-primary">Save current payload</h5>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label="Scenario name"
                  value={scenarioName}
                  onChange={setScenarioName}
                  placeholder="e.g. Eligible applicant"
                  maxLength={120}
                  isRequired
                />
                <Input
                  label="Description (optional)"
                  value={scenarioDescription}
                  onChange={setScenarioDescription}
                  placeholder="What this scenario checks"
                  maxLength={500}
                />
              </div>
              {scenarioOutcomes.length > 0 && (
                <Select
                  aria-label="Expected outcome (optional)"
                  placeholder="No expected outcome"
                  selectedKey={scenarioExpectedOutcomeId}
                  onSelectionChange={(key) => setScenarioExpectedOutcomeId(key ? String(key) : '')}
                >
                  <SelectItem id="">No expected outcome</SelectItem>
                  {scenarioOutcomes.map((outcome) => <SelectItem key={outcome.id} id={outcome.id}>{outcome.label}</SelectItem>)}
                </Select>
              )}
              {scenarioSaveError && <p role="alert" className="text-body-2-regular text-text-error-primary">{scenarioSaveError}</p>}
              <div>
                <Button
                  variant="primary"
                  size="small"
                  leadingIcon={RiSaveLine}
                  data-testid="save-scenario"
                  onClick={() => void handleSaveScenario()}
                  disabled={scenarioSaving || scenariosLoading || !scenarioName.trim()}
                >
                  {scenarioSaving ? 'Saving…' : 'Save scenario'}
                </Button>
              </div>
            </div>
          )}

          {!scenariosLoading && scenarios.length === 0 && !scenariosError && (
            <p className="rounded-xl border border-dashed border-border-button-default p-4 text-body-2-regular text-text-secondary">
              {scenariosCanEdit ? 'No saved scenarios yet. Save the current payload above to make a reusable test.' : 'No saved scenarios are available for this rule set.'}
            </p>
          )}

          {scenarios.length > 0 && (
            <ul data-testid="saved-scenario-list" aria-label="Saved test scenarios" className="flex flex-col divide-y divide-separator-border">
              {scenarios.map((scenario) => (
                <li key={scenario.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-body-2-medium text-text-primary">{scenario.name}</span>
                      {loadedScenario?.id === scenario.id && <Chip variant="caption" color="blue">Loaded</Chip>}
                    </div>
                    {scenario.description && <p className="mt-1 text-caption-1-regular text-text-secondary">{scenario.description}</p>}
                    <p className="mt-1 text-caption-2 text-text-tertiary">
                      {Object.keys(scenario.inputs).length} input {Object.keys(scenario.inputs).length === 1 ? 'field' : 'fields'}
                      {scenario.expectedOutcomeId ? ` · Expects ${outcomeLabel.get(scenario.expectedOutcomeId) || scenario.expectedOutcomeId}` : ' · No expected outcome'}
                      {scenario.createdAt && ` · Saved ${new Date(scenario.createdAt).toLocaleDateString()}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button variant="secondary" size="small" leadingIcon={RiFolderOpenLine} aria-label={`Load scenario ${scenario.name}`} onClick={() => handleLoadScenario(scenario)}>Load</Button>
                    {scenariosCanEdit && <Button variant="danger" size="small" leadingIcon={RiDeleteBinLine} aria-label={`Delete scenario ${scenario.name}`} onClick={() => setDeleteScenario(scenario)}>Delete</Button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Evaluation Results */}
      {evaluation && (
        <div className="flex flex-col gap-4">
          {/* Outcome Summary Banner */}
          {evaluation.ok ? (
            <div className="flex flex-col gap-2 rounded-2xl border border-status-lime-text/20 bg-status-lime-background/40 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="rounded-full bg-status-lime-background p-1 text-status-lime-text">
                    <RiCheckLine className="h-5 w-5" />
                  </div>
                  <span className="text-body-medium font-semibold text-text-primary">
                    Evaluation Complete
                  </span>
                </div>
                <Chip
                  variant="bold"
                  color={
                    typeof evaluation.result === 'object' &&
                    evaluation.result?.status === 'declined'
                      ? 'rose'
                      : 'lime'
                  }
                >
                  {typeof evaluation.result === 'object' && evaluation.result?.status
                    ? String(evaluation.result.status).toUpperCase()
                    : 'COMPLETED'}
                </Chip>
              </div>

              <div className="mt-1 rounded-xl bg-background-primary-default p-2.5 font-mono text-body-2-regular text-text-primary shadow-xs">
                {JSON.stringify(evaluation.result, null, 2)}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2 rounded-2xl border border-status-rose-text/20 bg-status-rose-background/40 p-4">
              <div className="flex items-center gap-2">
                <div className="rounded-full bg-status-rose-background p-1 text-status-rose-text">
                  <RiAlertLine className="h-5 w-5" />
                </div>
                <span className="text-body-medium font-semibold text-text-primary">
                  Evaluation Errors
                </span>
              </div>
              <ul className="list-inside list-disc text-body-2-regular text-text-error-primary">
                {(evaluation.errors || []).map((err, i) => (
                  <li key={i}>{err.message}</li>
                ))}
              </ul>
            </div>
          )}

          {loadedScenario && (
            <div
              data-testid="scenario-outcome-comparison"
              role="status"
              className={`flex flex-col gap-2 rounded-2xl border p-4 ${
                loadedScenario.expectedOutcomeId === null
                  ? 'border-border-button-default bg-background-secondary-default'
                  : !evaluation.ok
                    ? 'border-border-button-default bg-background-secondary-default'
                    : evaluation.outcomeId === loadedScenario.expectedOutcomeId
                    ? 'border-status-lime-text/20 bg-status-lime-background/40'
                    : 'border-status-rose-text/20 bg-status-rose-background/40'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-body-medium font-semibold text-text-primary">Scenario: {loadedScenario.name}</span>
                {loadedScenario.expectedOutcomeId === null ? (
                  <Chip variant="caption" color="blue">No assertion</Chip>
                ) : !evaluation.ok ? (
                  <Chip variant="caption" color="yellow">Not evaluated</Chip>
                ) : (
                  <Chip variant="bold" color={evaluation.ok && evaluation.outcomeId === loadedScenario.expectedOutcomeId ? 'lime' : 'rose'}>
                    {evaluation.ok && evaluation.outcomeId === loadedScenario.expectedOutcomeId ? 'PASS' : 'FAIL'}
                  </Chip>
                )}
              </div>
              <div className="grid gap-1 text-body-2-regular text-text-secondary sm:grid-cols-2">
                <p>Expected outcome: {loadedScenario.expectedOutcomeId ? outcomeLabel.get(loadedScenario.expectedOutcomeId) || loadedScenario.expectedOutcomeId : 'None saved'}</p>
                <p>Actual outcome: {evaluation.ok ? (evaluation.outcomeId ? outcomeLabel.get(evaluation.outcomeId) || evaluation.outcomeId : 'None resolved') : 'Unavailable (evaluation failed)'}</p>
              </div>
              {loadedScenario.expectedOutcomeId && evaluation.ok && evaluation.outcomeId !== loadedScenario.expectedOutcomeId && (
                <p className="text-caption-1-regular text-text-error-primary">The actual outcome does not match this scenario’s expected outcome.</p>
              )}
            </div>
          )}

          {/* Trace Playback with RareUI StepPlayer */}
          {evaluation.trace && evaluation.trace.length > 0 && (
            <div className="flex flex-col gap-3 rounded-2xl border border-border-button-default bg-background-primary-default p-4 shadow-xs">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-body-medium font-semibold text-text-primary">
                    Decision Trace Playback
                  </h4>
                  <p className="text-caption-1-regular text-text-secondary">
                    Step {activeStepIndex + 1} of {evaluation.trace.length}
                  </p>
                </div>
              </div>

              {/* RareUI StepPlayer component */}
              <div className="my-2 flex justify-center">
                <StepPlayer
                  steps={stepsForPlayer}
                  value={activeStepIndex}
                  onValueChange={handleStepChange}
                  showControl={true}
                  size={20}
                />
              </div>

              {/* Detailed Numbered Steps List */}
              <div className="flex flex-col gap-2 border-t border-separator-border pt-3">
                <span className="text-caption-1-medium text-text-secondary uppercase tracking-wider">
                  Trace Execution Log
                </span>
                <div className="flex flex-col gap-2 max-h-96 overflow-y-auto pe-1">
                  {evaluation.trace.map((entry, idx) => {
                    const isActive = idx === activeStepIndex;

                    return (
                      <div
                        key={idx}
                        onClick={() => handleStepChange(idx)}
                        className={`cursor-pointer rounded-xl border p-3 transition-all break-words whitespace-normal ${
                          isActive
                            ? 'border-emerald-500 bg-emerald-50/40 shadow-xs ring-1 ring-emerald-500'
                            : 'border-border-button-default bg-background-primary-default hover:bg-background-secondary-default/60'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-body-2-medium font-semibold text-text-primary break-words">
                            {getTraceStepTitle(entry, idx)}
                          </span>
                          <Chip
                            variant="caption"
                            color={
                              entry.kind === 'start'
                                ? 'blue'
                                : entry.kind === 'condition'
                                ? 'yellow'
                                : entry.kind === 'group'
                                ? 'purple'
                                : 'lime'
                            }
                          >
                            {entry.kind}
                          </Chip>
                        </div>

                        {/* Condition matched reason */}
                        {entry.kind === 'condition' && (
                          <div className="mt-1 flex items-center justify-between text-caption-1-regular text-text-secondary">
                            <span>
                              Evaluated {entry.field}: expected {entry.operator} {String(entry.expected)}, actual{' '}
                              <strong className="text-text-primary font-mono">
                                {entry.actual !== null && entry.actual !== undefined
                                  ? String(entry.actual)
                                  : '(blank)'}
                              </strong>
                            </span>
                          </div>
                        )}

                        {/* Group recursive matched reasons using BoardUI Accordion */}
                        {entry.kind === 'group' && Array.isArray(entry.terms) && (
                          <div className="mt-2.5 flex flex-col gap-2">
                            {/* Full nested expression summary line */}
                            <div className="rounded-lg bg-background-secondary-default p-2 text-caption-2 font-mono text-text-secondary">
                              <span className="text-text-tertiary">Expression: </span>
                              <span className="text-text-primary">
                                {(entry.operator || 'AND').toUpperCase()} (
                                {entry.terms.map(formatGroupTermSummary).join(' · ')}
                              </span>
                              ) → <strong className={entry.branch === 'true' ? 'text-status-lime-text' : 'text-status-rose-text'}>
                                {entry.branch === 'true' ? 'Matched (Yes)' : 'Failed (No)'}
                              </strong>
                            </div>

                            {/* BoardUI Accordion for detailed recursive expansion */}
                            <Accordion
                              variant="separated"
                              defaultExpandedKeys={[`group-breakdown-${idx}`]}
                            >
                              <AccordionItem
                                id={`group-breakdown-${idx}`}
                                title={
                                  <div className="flex items-center justify-between gap-2 pe-3">
                                    <span className="text-caption-1-medium text-text-primary">
                                      Group Evaluation Terms Breakdown ({entry.terms.length} {entry.terms.length === 1 ? 'term' : 'terms'})
                                    </span>
                                    <Chip
                                      variant="bold"
                                      color={entry.branch === 'true' ? 'lime' : 'rose'}
                                    >
                                      {entry.branch === 'true' ? 'MATCHED' : 'FAILED'}
                                    </Chip>
                                  </div>
                                }
                                description={
                                  <span className="text-caption-2 text-text-secondary">
                                    Expand to inspect expected vs. actual values for each nested condition and subgroup
                                  </span>
                                }
                              >
                                <div className="p-1">
                                  <TraceGroupTerms
                                    terms={entry.terms}
                                    depth={0}
                                    parentKey={`trace-${idx}`}
                                  />
                                </div>
                              </AccordionItem>
                            </Accordion>
                          </div>
                        )}

                        {/* Outcome Details */}
                        {entry.kind === 'outcome' && (
                          <p className="mt-1 text-caption-1-regular text-text-secondary break-words">
                            Resolved terminal outcome: {JSON.stringify(entry.result ?? null)}
                          </p>
                        )}

                        {/* Step ID in non-crowding collapsible detail */}
                        <div className="mt-2.5 flex items-center justify-between pt-1.5 border-t border-separator-border/40">
                          <details className="text-caption-2 text-text-tertiary">
                            <summary className="cursor-pointer hover:text-text-secondary">
                              Step Node ID details
                            </summary>
                            <span className="font-mono text-caption-2 text-text-tertiary select-all">
                              {entry.nodeId}
                            </span>
                          </details>
                          {entry.branch && (
                            <span
                              className={`text-caption-1-medium ${
                                entry.branch === 'true'
                                  ? 'text-status-lime-text font-semibold'
                                  : 'text-status-rose-text font-semibold'
                              }`}
                            >
                              Branch: {entry.branch === 'true' ? 'Yes (True)' : 'No (False)'}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <AlertDialog
        isOpen={deleteScenario !== null}
        onOpenChange={(isOpen) => { if (!isOpen && !scenarioDeleting) setDeleteScenario(null); }}
        title="Delete saved scenario?"
        description={deleteScenario ? `“${deleteScenario.name}” will be removed from this rule set.` : undefined}
        confirmLabel="Delete scenario"
        pendingLabel="Deleting…"
        onConfirm={handleConfirmDeleteScenario}
      />
    </div>
  );
};
