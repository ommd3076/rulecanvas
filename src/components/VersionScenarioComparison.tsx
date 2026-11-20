import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from '@/components/base/table/table';
import { api, type EvaluationResult, type TestScenario, type VersionDetail } from '@/src/api';

type Comparison = { scenario: TestScenario; draft: EvaluationResult; version: EvaluationResult };

function describe(result: EvaluationResult) {
  if (!result.ok) return result.errors?.map((error) => error.message).join(' ') || 'Evaluation failed';
  return JSON.stringify(result.result);
}

export function VersionScenarioComparison({ rulesetId, version }: { rulesetId: string; version: VersionDetail }) {
  const [rows, setRows] = useState<Comparison[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);

  useEffect(() => () => { sequence.current += 1; }, [rulesetId, version.id]);

  async function compare() {
    if (loading) return;
    const request = ++sequence.current;
    setLoading(true);
    setError('');
    setRows([]);
    try {
      const [{ scenarios }, { ruleset }] = await Promise.all([api.listScenarios(rulesetId), api.getRuleset(rulesetId)]);
      if (!scenarios.length) throw new Error('Save a test scenario in the editor before comparing.');
      const results: Comparison[] = [];
      for (const scenario of scenarios) {
        const draft = await api.evaluateGraph(rulesetId, scenario.inputs, ruleset.revision);
        const snapshot = await api.evaluateVersion(rulesetId, version.id, scenario.inputs);
        results.push({ scenario, draft, version: snapshot });
      }
      const latest = await api.getRuleset(rulesetId);
      if (latest.ruleset.revision !== ruleset.revision) throw new Error('The draft changed during comparison. Run it again.');
      if (request !== sequence.current) return;
      setRevision(ruleset.revision);
      setRows(results);
    } catch (caught) {
      if (request !== sequence.current) return;
      setError(caught instanceof Error ? caught.message : 'Comparison could not be completed.');
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }

  return (
    <section aria-label="Compare saved scenarios" className="flex flex-col gap-3 border-t border-separator-border pt-4">
      <div>
        <h4 className="text-body-medium text-text-primary">Compare saved scenarios</h4>
        <p className="text-body-2-regular text-text-secondary">Run saved scenarios against this version and the latest saved draft. Unsaved editor changes are excluded. Each evaluation is recorded in run history.</p>
      </div>
      <div><Button variant="secondary" size="small" onClick={() => void compare()} disabled={loading}>{loading ? 'Comparing…' : 'Compare scenarios'}</Button></div>
      {error && <p role="alert" className="text-body-2-regular text-text-error-primary">{error}</p>}
      {rows.length > 0 && <div className="overflow-x-auto">
        <p className="mb-2 text-caption-1-regular text-text-secondary">Saved draft revision {revision} and version {version.versionNumber}</p>
        <Table aria-label="Scenario comparison" size="sm">
          <TableHeader><TableColumn isRowHeader>Scenario</TableColumn><TableColumn>Saved draft</TableColumn><TableColumn>Version {version.versionNumber}</TableColumn><TableColumn>Result</TableColumn></TableHeader>
          <TableBody items={rows}>{(row) => <TableRow key={row.scenario.id}>
            <TableCell>{row.scenario.name}</TableCell>
            <TableCell>{describe(row.draft)}</TableCell>
            <TableCell>{describe(row.version)}</TableCell>
            <TableCell>{!row.draft.ok || !row.version.ok ? 'Review errors' : row.draft.outcomeId === row.version.outcomeId && JSON.stringify(row.draft.result) === JSON.stringify(row.version.result) ? 'Same' : 'Changed'}</TableCell>
          </TableRow>}</TableBody>
        </Table>
      </div>}
    </section>
  );
}
