import React from 'react';
import { Button } from '@/components/base/buttons/button';
import {
  RiFolderWarningLine,
  RiFileWarningLine,
  RiGitMergeLine,
  RiWifiOffLine,
  RiArrowLeftLine,
  RiRefreshLine,
  RiHome5Line,
} from '@remixicon/react';

export type RecoveryState =
  | {
      type: 'project_not_found';
      projectId: string;
      message?: string;
    }
  | {
      type: 'rule_not_found';
      projectId: string;
      ruleId: string;
      message?: string;
    }
  | {
      type: 'project_rule_mismatch';
      projectId: string;
      ruleId: string;
      actualProjectId: string;
      rulesetName: string;
    }
  | {
      type: 'network_error';
      message: string;
      onRetry: () => void;
    }
  | {
      type: 'not_found';
      path: string;
    };

interface RecoveryViewProps {
  state: RecoveryState;
  onNavigateProjects: () => void;
  onNavigateProject: (projectId: string) => void;
  onNavigateRule: (projectId: string, ruleId: string) => void;
}

export const RecoveryView: React.FC<RecoveryViewProps> = ({
  state,
  onNavigateProjects,
  onNavigateProject,
  onNavigateRule,
}) => {
  return (
    <div className="flex h-full w-full items-center justify-center p-6 bg-background-full">
      <div className="flex w-full max-w-lg flex-col items-center rounded-3xl border border-border-button-default bg-background-primary-default p-8 text-center shadow-lg">
        {state.type === 'project_not_found' && (
          <>
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-status-rose-background text-status-rose-text">
              <RiFolderWarningLine className="h-8 w-8" />
            </div>
            <h2 className="mt-4 text-title-2-medium text-text-primary">Project Not Found</h2>
            <p className="mt-2 text-body-regular text-text-secondary">
              The project <span className="font-mono font-medium text-text-primary">"{state.projectId}"</span> could not be found or has been removed from this workspace.
            </p>
            <div className="mt-6 flex gap-3">
              <Button
                variant="primary"
                size="medium"
                leadingIcon={RiArrowLeftLine}
                onClick={onNavigateProjects}
              >
                Return to Projects
              </Button>
            </div>
          </>
        )}

        {state.type === 'rule_not_found' && (
          <>
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-status-rose-background text-status-rose-text">
              <RiFileWarningLine className="h-8 w-8" />
            </div>
            <h2 className="mt-4 text-title-2-medium text-text-primary">Rule Set Not Found</h2>
            <p className="mt-2 text-body-regular text-text-secondary">
              The rule set <span className="font-mono font-medium text-text-primary">"{state.ruleId}"</span> does not exist in this project.
            </p>
            <div className="mt-6 flex gap-3">
              <Button
                variant="secondary"
                size="medium"
                leadingIcon={RiArrowLeftLine}
                onClick={() => onNavigateProject(state.projectId)}
              >
                Back to Project
              </Button>
              <Button
                variant="ghost"
                size="medium"
                leadingIcon={RiHome5Line}
                onClick={onNavigateProjects}
              >
                All Projects
              </Button>
            </div>
          </>
        )}

        {state.type === 'project_rule_mismatch' && (
          <>
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-status-amber-background text-status-amber-text">
              <RiGitMergeLine className="h-8 w-8" />
            </div>
            <h2 className="mt-4 text-title-2-medium text-text-primary">Project / Rule Mismatch</h2>
            <p className="mt-2 text-body-regular text-text-secondary">
              The rule set <span className="font-semibold text-text-primary">"{state.rulesetName}"</span> does not belong to the project in the URL. It belongs to project <span className="font-mono font-medium text-text-primary">"{state.actualProjectId}"</span>.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Button
                variant="secondary"
                size="medium"
                leadingIcon={RiArrowLeftLine}
                onClick={() => onNavigateProject(state.projectId)}
              >
                Back to URL Project
              </Button>
              <Button
                variant="primary"
                size="medium"
                onClick={() => onNavigateRule(state.actualProjectId, state.ruleId)}
              >
                Open in Owner Project
              </Button>
            </div>
          </>
        )}

        {state.type === 'network_error' && (
          <>
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-status-rose-background text-status-rose-text">
              <RiWifiOffLine className="h-8 w-8" />
            </div>
            <h2 className="mt-4 text-title-2-medium text-text-primary">Connection Error</h2>
            <p className="mt-2 text-body-regular text-text-secondary">
              {state.message}
            </p>
            <div className="mt-6 flex gap-3">
              <Button
                variant="primary"
                size="medium"
                leadingIcon={RiRefreshLine}
                onClick={state.onRetry}
              >
                Retry
              </Button>
              <Button
                variant="secondary"
                size="medium"
                onClick={onNavigateProjects}
              >
                Return to Projects
              </Button>
            </div>
          </>
        )}

        {state.type === 'not_found' && (
          <>
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-background-secondary-default text-text-tertiary">
              <RiHome5Line className="h-8 w-8" />
            </div>
            <h2 className="mt-4 text-title-2-medium text-text-primary">Page Not Found</h2>
            <p className="mt-2 text-body-regular text-text-secondary">
              The requested address <span className="font-mono font-medium text-text-primary">"{state.path}"</span> is not a recognized screen route.
            </p>
            <div className="mt-6 flex gap-3">
              <Button
                variant="primary"
                size="medium"
                leadingIcon={RiArrowLeftLine}
                onClick={onNavigateProjects}
              >
                Return to Projects
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
