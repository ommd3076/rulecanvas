import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { Select, SelectItem } from '@/components/base/select/select';
import { Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from '@/components/base/table/table';
import { RiRefreshLine } from '@remixicon/react';
import { LinkButton } from '@/components/base/buttons/link-button';
import { api, type EvaluationRun, type ProjectDetail } from '@/src/api';

interface RunsViewProps {
  project: ProjectDetail;
  onOpenVersion: (rulesetId: string, versionId: string) => void;
}

export const RunsView: React.FC<RunsViewProps> = ({ project, onOpenVersion }) => {
  const [runs, setRuns] = useState<EvaluationRun[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [rulesetFilter, setRulesetFilter] = useState('all');
  const requestSequence = useRef(0);

  const loadRuns = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setStatus('loading');
    setErrorMessage('');
    try {
      const result = await api.getProjectRuns(project.id);
      if (requestSequence.current !== requestId) return;
      setRuns(result.runs || []);
      setStatus('ready');
    } catch (error: any) {
      if (requestSequence.current !== requestId) return;
      setErrorMessage(error.message || 'Could not load evaluation runs.');
      setStatus('error');
    }
  }, [project.id]);

  useEffect(() => {
    void loadRuns();
    return () => { requestSequence.current += 1; };
  }, [loadRuns]);

  const rulesetNames = useMemo(() => new Map(project.rulesets.map((rule) => [rule.id, rule.name])), [project.rulesets]);
  const visibleRuns = useMemo(
    () => rulesetFilter === 'all' ? runs : runs.filter((run) => run.rulesetId === rulesetFilter),
    [runs, rulesetFilter],
  );
  const passedCount = runs.filter((run) => run.ok).length;
  const failedCount = runs.length - passedCount;
  const describeFailure = (code?: string) => {
    if (code?.startsWith('input.')) return 'Input did not satisfy the rule requirements';
    if (code?.startsWith('evaluation.')) return 'Evaluation did not reach a result';
    if (code?.startsWith('graph.') || code?.startsWith('node.') || code?.startsWith('edge.') || code?.startsWith('schema.') || code?.startsWith('group.')) return 'Rule definition needs attention';
    return 'Evaluation failed';
  };

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 lg:px-10">
      <header className="mb-8 flex flex-col gap-5 border-b border-separator-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-body-2-medium text-text-secondary">{project.name}</p>
          <h1 className="text-title-1-semibold text-text-primary">Evaluation runs</h1>
          <p className="mt-1 text-body-regular text-text-secondary">Recent saved rule evaluations for this project.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-body-2-regular text-text-secondary">{runs.length} retained · up to 500 most recent</span>
          <Button variant="secondary" size="small" leadingIcon={RiRefreshLine} onClick={() => void loadRuns()} disabled={status === 'loading'}>Refresh</Button>
        </div>
      </header>

      {status === 'ready' && runs.length > 0 && (
        <section aria-label="Run summary" className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-4">
            <p className="text-body-2-regular text-text-secondary">Retained runs</p><p className="mt-1 text-title-2-semibold text-text-primary">{runs.length}</p>
          </div>
          <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-4">
            <p className="text-body-2-regular text-text-secondary">Successful</p><p className="mt-1 text-title-2-semibold text-text-primary">{passedCount}</p>
          </div>
          <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-4">
            <p className="text-body-2-regular text-text-secondary">Failed</p><p className="mt-1 text-title-2-semibold text-text-primary">{failedCount}</p>
          </div>
        </section>
      )}

      {status === 'loading' ? (
        <div role="status" className="rounded-xl border border-border-button-default bg-background-primary-default px-4 py-12 text-center text-body-regular text-text-secondary">Loading evaluation runs…</div>
      ) : status === 'error' ? (
        <div role="alert" className="rounded-xl border border-border-error-default bg-background-primary-default px-4 py-12 text-center">
          <p className="text-body-medium text-text-primary">Runs could not be loaded</p>
          <p className="mt-1 text-body-regular text-text-secondary">{errorMessage}</p>
          <Button className="mt-4" variant="secondary" size="small" leadingIcon={RiRefreshLine} onClick={() => void loadRuns()}>Try again</Button>
        </div>
      ) : runs.length === 0 ? (
        <div className="rounded-xl border border-border-button-default bg-background-primary-default px-4 py-12 text-center">
          <p className="text-body-medium text-text-primary">No evaluation runs yet</p>
          <p className="mt-1 text-body-regular text-text-secondary">Run a draft or saved version from a rule set to see its result here.</p>
        </div>
      ) : (
        <section aria-label="Evaluation run history" className="overflow-hidden rounded-xl border border-border-button-default bg-background-primary-default">
          <div className="flex flex-col gap-3 border-b border-separator-border p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-body-medium text-text-primary">Recent evaluations</p>
            <Select aria-label="Filter by rule set" selectedKey={rulesetFilter} onSelectionChange={(key) => setRulesetFilter(String(key))} className="w-full sm:w-64" size="sm">
              <SelectItem id="all">All rule sets</SelectItem>
              {project.rulesets.map((ruleset) => <SelectItem key={ruleset.id} id={ruleset.id}>{ruleset.name}</SelectItem>)}
            </Select>
          </div>
          <Table aria-label="Evaluation runs" size="sm">
            <TableHeader>
              <TableColumn isRowHeader>When</TableColumn><TableColumn>Rule set</TableColumn><TableColumn>Source</TableColumn><TableColumn>Result</TableColumn><TableColumn>Version</TableColumn>
            </TableHeader>
            <TableBody items={visibleRuns}>
              {(run) => (
                <TableRow key={run.id}>
                  <TableCell className="whitespace-nowrap text-text-secondary">{new Date(run.createdAt).toLocaleString()}</TableCell>
                  <TableCell><span className="text-body-medium text-text-primary">{rulesetNames.get(run.rulesetId) || 'Unknown rule set'}</span></TableCell>
                  <TableCell className="text-text-secondary">{run.versionId ? `Saved version · Rev ${run.revision ?? '—'}` : `Draft · Rev ${run.revision ?? '—'}`}</TableCell>
                  <TableCell>
                    <div>
                      <span className={run.ok ? 'text-body-medium text-status-lime-text' : 'text-body-medium text-status-rose-text'}>{run.ok ? (run.outcomeLabel || 'Succeeded') : 'Failed'}</span>
                      {!run.ok && <p className="text-body-2-regular text-text-secondary">{describeFailure(run.error?.code)}</p>}
                    </div>
                  </TableCell>
                  <TableCell>
                    {run.versionId ? <LinkButton variant="primary" size="small" onClick={() => onOpenVersion(run.rulesetId, run.versionId!)}>Version {run.versionNumber ?? '—'}</LinkButton> : <span className="text-text-tertiary">—</span>}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {visibleRuns.length === 0 && <p className="px-4 py-8 text-center text-body-regular text-text-secondary">No runs for this rule set.</p>}
        </section>
      )}
    </main>
  );
};
