import React, { useMemo, useState } from 'react';
import { SearchField } from '@/components/base/search-field/search-field';
import { Button } from '@/components/base/buttons/button';
import { IconButton } from '@/components/base/buttons/icon-button';
import { Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from '@/components/base/table/table';
import { RiAddLine, RiArrowRightLine, RiGitBranchLine, RiHistoryLine } from '@remixicon/react';
import type { ProjectDetail } from '@/src/api';
import { api } from '@/src/api';
import { toast } from 'sonner';

interface ProjectOverviewViewProps {
  project: ProjectDetail;
  onSelectRuleset: (rulesetId: string) => void;
  onOpenVersions: (rulesetId: string, rulesetName: string) => void;
  onNewRuleset: () => void;
  onOpenRuns: () => void;
}

export const ProjectOverviewView: React.FC<ProjectOverviewViewProps> = ({
  project,
  onSelectRuleset,
  onOpenVersions,
  onNewRuleset,
  onOpenRuns,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const rulesets = project.rulesets || [];
  const filteredRulesets = useMemo(
    () => rulesets.filter((ruleset) => ruleset.name.toLowerCase().includes(searchQuery.toLowerCase())),
    [rulesets, searchQuery],
  );

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 lg:px-10">
      <header className="mb-8 flex flex-col gap-5 border-b border-separator-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-title-1-semibold text-text-primary">{project.name}</h1>
          <p className="mt-1 text-body-regular text-text-secondary">
            {rulesets.length} rule {rulesets.length === 1 ? 'set' : 'sets'}
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          {project.hasLegacySource && <Button variant="secondary" size="medium" onClick={async () => {
            try {
              const { source } = await api.getLegacySource(project.id);
              const url = URL.createObjectURL(new Blob([JSON.stringify(source, null, 2)], { type: 'application/json' }));
              const link = document.createElement('a');
              link.href = url;
              link.download = 'rulecanvas-legacy-export.json';
              link.click();
              URL.revokeObjectURL(url);
            } catch (error) { toast.error(error instanceof Error ? error.message : 'Original export could not be downloaded.'); }
          }}>Download original export</Button>}
          <Button variant="secondary" size="medium" onClick={onOpenRuns}>Evaluation runs</Button>
          {rulesets.length > 0 && <SearchField
            aria-label="Search rule sets"
            placeholder="Find a rule set"
            value={searchQuery}
            onChange={setSearchQuery}
            className="w-full sm:w-64"
          />}
          <Button variant="primary" size="medium" leadingIcon={RiAddLine} onClick={onNewRuleset}>
            New rule set
          </Button>
        </div>
      </header>

      <section aria-label="Rule sets" className="overflow-hidden rounded-xl border border-border-button-default bg-background-primary-default">
        <Table aria-label="Rule sets" size="sm">
          <TableHeader>
            <TableColumn isRowHeader>Rule set</TableColumn>
            <TableColumn>Draft</TableColumn>
            <TableColumn>Versions</TableColumn>
            <TableColumn>Updated</TableColumn>
            <TableColumn className="text-end">Actions</TableColumn>
          </TableHeader>
          <TableBody items={filteredRulesets}>
            {(ruleset) => (
              <TableRow key={ruleset.id}>
                <TableCell>
                  <div className="flex min-w-0 items-center gap-3">
                    <RiGitBranchLine aria-hidden="true" className="h-4 w-4 shrink-0 text-foreground-icon-secondary" />
                    <span className="truncate text-body-medium text-text-primary">{ruleset.name}</span>
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap font-mono text-body-2-regular text-text-secondary">Rev {ruleset.revision}</TableCell>
                <TableCell className="text-text-secondary">{ruleset.versionCount || 0}</TableCell>
                <TableCell className="whitespace-nowrap text-text-secondary">
                  {new Date(ruleset.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                </TableCell>
                <TableCell className="text-end">
                  <div className="flex items-center justify-end gap-1">
                    <IconButton
                      size="small"
                      icon={RiHistoryLine}
                      aria-label={`Version history for ${ruleset.name}`}
                      onClick={() => onOpenVersions(ruleset.id, ruleset.name)}
                    />
                    <Button variant="secondary" size="small" trailingIcon={RiArrowRightLine} onClick={() => onSelectRuleset(ruleset.id)}>
                      Open
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {filteredRulesets.length === 0 && (
          <div className="px-4 py-12 text-center">
            <p className="text-body-medium text-text-primary">{searchQuery ? 'No matching rule sets' : 'No rule sets yet'}</p>
            <p className="mt-1 text-body-regular text-text-secondary">
              {searchQuery ? 'Try another name.' : 'Create a rule set to begin building its decision graph.'}
            </p>
          </div>
        )}
      </section>
    </main>
  );
};
