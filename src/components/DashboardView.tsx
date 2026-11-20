import React, { useMemo, useState } from 'react';
import { SearchField } from '@/components/base/search-field/search-field';
import { Button } from '@/components/base/buttons/button';
import { Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from '@/components/base/table/table';
import { RiAddLine, RiArrowRightLine, RiFolderLine, RiGitBranchLine } from '@remixicon/react';
import type { ProjectSummary } from '@/src/api';

interface DashboardViewProps {
  projects: ProjectSummary[];
  onSelectProject: (projectId: string) => void;
  onNewProject: () => void;
  onImportLegacy: () => void;
  onTryExample?: () => void;
  isTryingExample?: boolean;
}

function projectActivityTime(project: ProjectSummary): number {
  const updatedAt = Date.parse(project.updatedAt);
  if (Number.isFinite(updatedAt)) return updatedAt;
  const createdAt = Date.parse(project.createdAt);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function formatProjectDate(project: ProjectSummary): string {
  const usesUpdatedAt = Number.isFinite(Date.parse(project.updatedAt));
  const timestamp = usesUpdatedAt ? project.updatedAt : project.createdAt;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'Date unavailable';

  const dateLabel = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return usesUpdatedAt ? `Updated ${dateLabel}` : `Created ${dateLabel}`;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  projects,
  onSelectProject,
  onNewProject,
  onImportLegacy,
  onTryExample,
  isTryingExample = false,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const recentProjects = useMemo(
    () => [...projects].sort((a, b) => projectActivityTime(b) - projectActivityTime(a)),
    [projects],
  );
  const filteredProjects = useMemo(
    () => recentProjects.filter((project) => project.name.toLocaleLowerCase().includes(normalizedQuery)),
    [recentProjects, normalizedQuery],
  );
  const totalRulesets = projects.reduce((total, project) => total + (Number.isFinite(project.rulesetCount) ? project.rulesetCount : 0), 0);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-8 lg:px-10">
      <header className="flex flex-col gap-5 rounded-3xl border border-border-button-default bg-background-primary-default p-5 sm:p-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 max-w-2xl">
          <h1 className="text-title-1-semibold text-text-primary sm:text-display-2-semibold">Your decision workspace</h1>
          <p className="mt-2 text-body-regular text-text-secondary">
            Build clear rules, test real inputs, and follow each decision from start to outcome.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
          <Button variant="secondary" size="medium" onClick={onImportLegacy}>Import project</Button>
          {onTryExample && (
            <Button
              variant="secondary"
              size="medium"
              leadingIcon={RiArrowRightLine}
              onClick={onTryExample}
              disabled={isTryingExample}
              className="w-full sm:w-auto"
            >
              {isTryingExample ? 'Preparing example…' : 'Try guided example'}
            </Button>
          )}
          <Button
            variant="primary"
            size="medium"
            leadingIcon={RiAddLine}
            onClick={onNewProject}
            className="w-full sm:w-auto"
          >
            New project
          </Button>
        </div>
      </header>

      <section aria-label="Workspace summary" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex items-center gap-4 rounded-3xl border border-border-button-default bg-background-primary-default p-4 sm:p-5">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-background-secondary-default text-foreground-icon-primary">
            <RiFolderLine aria-hidden="true" className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-body-2-medium text-text-secondary">Projects</p>
            <p className="mt-0.5 text-title-2-semibold text-text-primary">{projects.length}</p>
          </div>
        </div>
        <div className="flex items-center gap-4 rounded-3xl border border-border-button-default bg-background-primary-default p-4 sm:p-5">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-background-secondary-default text-foreground-icon-primary">
            <RiGitBranchLine aria-hidden="true" className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-body-2-medium text-text-secondary">Rule sets</p>
            <p className="mt-0.5 text-title-2-semibold text-text-primary">{totalRulesets}</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="recent-projects-heading" className="overflow-hidden rounded-3xl border border-border-button-default bg-background-primary-default">
        <header className="flex flex-col gap-4 border-b border-separator-border p-4 sm:flex-row sm:items-end sm:justify-between sm:p-5">
          <h2 id="recent-projects-heading" className="text-title-3-semibold text-text-primary">Recent projects</h2>
          {projects.length > 0 && (
            <SearchField
              aria-label="Search projects"
              placeholder="Find a project"
              value={searchQuery}
              onChange={setSearchQuery}
              className="w-full sm:w-64"
            />
          )}
        </header>

        {projects.length === 0 ? (
          <div className="p-5 sm:p-8">
            <p className="text-title-3-semibold text-text-primary">See a decision flow in action</p>
            <p className="mt-2 max-w-xl text-body-regular text-text-secondary">
              Start with the guided eligibility example above, or create a project for your own decision process.
            </p>
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-body-medium text-text-primary">No matching projects</p>
            <p className="mt-1 text-body-regular text-text-secondary">Try a different project name.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label="Projects" size="sm">
              <TableHeader>
                <TableColumn isRowHeader>Project</TableColumn>
                <TableColumn>Rule sets</TableColumn>
                <TableColumn>Recent activity</TableColumn>
                <TableColumn className="text-end"><span className="sr-only">Actions</span></TableColumn>
              </TableHeader>
              <TableBody items={filteredProjects}>
                {(project) => (
                  <TableRow key={project.id}>
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-3">
                        <RiFolderLine aria-hidden="true" className="h-4 w-4 shrink-0 text-foreground-icon-secondary" />
                        <span className="truncate text-body-medium text-text-primary">{project.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-text-secondary">
                      {project.rulesetCount} {project.rulesetCount === 1 ? 'rule set' : 'rule sets'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-text-secondary">{formatProjectDate(project)}</TableCell>
                    <TableCell className="text-end">
                      <Button variant="ghost" size="small" trailingIcon={RiArrowRightLine} onClick={() => onSelectProject(project.id)}>
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </main>
  );
};
