import React, { useMemo, useState } from 'react';
import { SearchField } from '@/components/base/search-field/search-field';
import { Button } from '@/components/base/buttons/button';
import { Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from '@/components/base/table/table';
import { RiAddLine, RiArrowRightLine, RiFolderLine } from '@remixicon/react';
import type { ProjectSummary } from '@/src/api';

interface DashboardViewProps {
  projects: ProjectSummary[];
  onSelectProject: (projectId: string) => void;
  onNewProject: () => void;
  onTryExample: () => void;
  isTryingExample: boolean;
}

export const DashboardView: React.FC<DashboardViewProps> = ({ projects, onSelectProject, onNewProject, onTryExample, isTryingExample }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const filteredProjects = useMemo(
    () => projects.filter((project) => project.name.toLowerCase().includes(searchQuery.toLowerCase())),
    [projects, searchQuery],
  );

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 lg:px-10">
      <header className="mb-8 flex flex-col gap-5 border-b border-separator-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-title-1-semibold text-text-primary">Projects</h1>
          <p className="mt-1 text-body-regular text-text-secondary">Build decision rules, test inputs, and trace each outcome.</p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          {projects.length > 0 && <SearchField
            aria-label="Search projects"
            placeholder="Find a project"
            value={searchQuery}
            onChange={setSearchQuery}
            className="w-full sm:w-64"
          />}
          <Button variant="primary" size="medium" leadingIcon={RiAddLine} onClick={onNewProject}>
            New project
          </Button>
        </div>
      </header>

      <section aria-label="Projects" className="overflow-hidden rounded-xl border border-border-button-default bg-background-primary-default">
        <Table aria-label="Projects" size="sm">
          <TableHeader>
            <TableColumn isRowHeader>Project</TableColumn>
            <TableColumn>Rule sets</TableColumn>
            <TableColumn>Created</TableColumn>
            <TableColumn className="text-end"> </TableColumn>
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
                <TableCell className="text-text-secondary">{project.rulesetCount || 0}</TableCell>
                <TableCell className="whitespace-nowrap text-text-secondary">
                  {new Date(project.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                </TableCell>
                <TableCell className="text-end">
                  <Button variant="ghost" size="small" trailingIcon={RiArrowRightLine} onClick={() => onSelectProject(project.id)}>
                    Open
                  </Button>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {filteredProjects.length === 0 && (
          <div className="px-4 py-12 text-center">
            <p className="text-body-medium text-text-primary">{searchQuery ? 'No matching projects' : 'No projects yet'}</p>
            <p className="mt-1 text-body-regular text-text-secondary">
              {searchQuery ? 'Try another name.' : 'Run a sample eligibility rule and see which branch leads to its decision.'}
            </p>
            {!searchQuery && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Button variant="primary" size="small" disabled={isTryingExample} onClick={onTryExample}>
                  {isTryingExample ? 'Preparing example…' : 'Try a guided example'}
                </Button>
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
};
