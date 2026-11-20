import React from 'react';
import { Button } from '@/components/base/buttons/button';
import { IconButton } from '@/components/base/buttons/icon-button';
import { Dropdown, DropdownPopover, DropdownTrigger } from '@/components/base/dropdown/dropdown';
import { Tooltip, TooltipTrigger } from '@/components/base/tooltip/tooltip';
import { BreadcrumbDropdown, type BreadcrumbDropdownItem } from '@/components/ruixen/breadcrumb-dropdown';
import {
  RiArrowGoBackLine,
  RiArrowGoForwardLine,
  RiCheckLine,
  RiDownload2Line,
  RiFileList3Line,
  RiHistoryLine,
  RiMoreLine,
  RiRefreshLine,
} from '@remixicon/react';

interface TopNavProps {
  view: 'dashboard' | 'project' | 'runs' | 'editor' | 'releases';
  releaseManagementAvailable?: boolean;
  projectName?: string;
  rulesetName?: string;
  activeRevision?: number;
  isDirty?: boolean;
  saveState?: 'saved' | 'saving' | 'unsaved' | 'error' | 'conflict';
  canUndo?: boolean;
  canRedo?: boolean;
  onNavigateDashboard: () => void;
  onNavigateHome?: () => void;
  onNavigateProject: () => void;
  onOpenReleases?: () => void;
  onOpenActivity: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onValidate?: () => void;
  onSaveVersion?: () => void;
  onSaveDraft?: () => void | Promise<any>;
  onOpenVersions?: () => void;
  onDownloadConflict?: () => void;
  onRetrySave?: () => void;
}

export const TopNav: React.FC<TopNavProps> = ({
  view,
  releaseManagementAvailable = false,
  projectName,
  rulesetName,
  activeRevision = 1,
  isDirty = false,
  saveState = 'saved',
  canUndo = false,
  canRedo = false,
  onNavigateDashboard,
  onNavigateHome,
  onNavigateProject,
  onOpenReleases,
  onOpenActivity,
  onUndo,
  onRedo,
  onValidate,
  onSaveVersion,
  onSaveDraft,
  onOpenVersions,
  onDownloadConflict,
  onRetrySave,
}) => {
  const [actionsOpen, setActionsOpen] = React.useState(false);

  function runAction(action?: () => void) {
    setActionsOpen(false);
    action?.();
  }

  const breadcrumbItems: BreadcrumbDropdownItem[] = [{ label: 'Projects', onClick: onNavigateDashboard }];
  if (projectName) breadcrumbItems.push({ label: projectName, onClick: view !== 'project' ? onNavigateProject : undefined });
  if (view === 'editor' && rulesetName) breadcrumbItems.push({ label: rulesetName });
  if (view === 'project') breadcrumbItems.push({ label: 'Rule sets' });
  if (view === 'runs') breadcrumbItems.push({ label: 'Evaluation runs' });
  if (view === 'releases' && rulesetName) breadcrumbItems.push({ label: rulesetName });
  if (view === 'releases') breadcrumbItems.push({ label: 'Releases' });

  return (
    <header className="relative z-40 flex h-14 min-h-14 w-full items-center justify-between gap-3 border-b border-separator-border bg-background-primary-default px-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onNavigateHome ?? onNavigateDashboard}
          aria-label={onNavigateHome ? 'RuleCanvas home' : 'RuleCanvas projects'}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-text-primary text-body-2-bold text-background-primary-default outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          R
        </button>
        <div className="min-w-0 max-w-[min(36vw,420px)] truncate text-body-medium text-text-secondary sm:max-w-[min(40vw,560px)]">
          <BreadcrumbDropdown items={breadcrumbItems} maxVisible={3} className="text-body-medium" />
        </div>
      </div>

      {view === 'editor' && (
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <div className="hidden items-center gap-0.5 sm:flex">
            <IconButton size="small" icon={RiArrowGoBackLine} aria-label="Undo" disabled={!canUndo} onClick={onUndo} />
            <IconButton size="small" icon={RiArrowGoForwardLine} aria-label="Redo" disabled={!canRedo} onClick={onRedo} />
          </div>
          <span className="hidden whitespace-nowrap text-caption-1-medium text-text-tertiary md:inline" aria-live="polite">
            {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed' : saveState === 'conflict' ? 'Conflict' : isDirty ? 'Unsaved changes' : `Saved · Rev ${activeRevision}`}
          </span>
          <TooltipTrigger delay={250}>
            <IconButton size="small" icon={RiHistoryLine} aria-label="Version history" onClick={onOpenVersions} />
            <Tooltip>Version history</Tooltip>
          </TooltipTrigger>
          <TooltipTrigger delay={250}>
            <IconButton size="small" icon={RiFileList3Line} aria-label="Audit log" onClick={onOpenActivity} />
            <Tooltip>Audit log</Tooltip>
          </TooltipTrigger>
          {releaseManagementAvailable && (
            <Button variant="secondary" size="small" onClick={onOpenReleases} className="hidden lg:inline-flex">Releases</Button>
          )}
          <Button variant="secondary" size="small" leadingIcon={RiCheckLine} onClick={onValidate} className="hidden md:inline-flex">
            Validate
          </Button>
          <Button variant="secondary" size="small" leadingIcon={RiHistoryLine} onClick={onSaveVersion} className="hidden lg:inline-flex">
            Save version
          </Button>
          <div className="lg:hidden">
            <Dropdown isOpen={actionsOpen} onOpenChange={setActionsOpen}>
              <DropdownTrigger aria-label="More editor actions" className="grid size-9 place-items-center rounded-md text-foreground-icon-secondary hover:bg-background-secondary-hover">
                <RiMoreLine className="size-5" aria-hidden="true" />
              </DropdownTrigger>
              <DropdownPopover aria-label="Editor actions" placement="bottom end" className="w-48">
                <Button variant="secondary" size="small" leadingIcon={RiCheckLine} onClick={() => runAction(onValidate)} className="md:hidden">Validate</Button>
                <Button variant="secondary" size="small" leadingIcon={RiHistoryLine} onClick={() => runAction(onSaveVersion)}>Save version</Button>
                {releaseManagementAvailable && <Button variant="secondary" size="small" onClick={() => runAction(onOpenReleases)}>Releases</Button>}
                <Button variant="secondary" size="small" leadingIcon={RiArrowGoBackLine} onClick={() => runAction(onUndo)} disabled={!canUndo} className="sm:hidden">Undo</Button>
                <Button variant="secondary" size="small" leadingIcon={RiArrowGoForwardLine} onClick={() => runAction(onRedo)} disabled={!canRedo} className="sm:hidden">Redo</Button>
                {saveState === 'conflict' && onDownloadConflict && (
                  <Button variant="secondary" size="small" leadingIcon={RiDownload2Line} onClick={() => runAction(onDownloadConflict)} className="md:hidden">Conflict copy</Button>
                )}
              </DropdownPopover>
            </Dropdown>
          </div>
          {saveState === 'conflict' && onDownloadConflict && (
            <Button size="small" variant="danger" leadingIcon={RiDownload2Line} onClick={onDownloadConflict} className="hidden md:inline-flex">
              Conflict copy
            </Button>
          )}
          {saveState === 'error' && onRetrySave && (
            <IconButton size="small" icon={RiRefreshLine} aria-label="Retry save" onClick={onRetrySave} />
          )}
          <Button
            size="small"
            variant={isDirty ? 'primary' : 'secondary'}
            disabled={!isDirty || saveState === 'saving'}
            onClick={onSaveDraft}
          >
            {saveState === 'saving' ? 'Saving…' : 'Save draft'}
          </Button>
        </div>
      )}
    </header>
  );
};
