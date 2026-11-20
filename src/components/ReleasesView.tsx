import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { Select, SelectItem } from '@/components/base/select/select';
import { Textarea } from '@/components/base/textarea/textarea';
import { api, type ProjectDetail, type ReleaseAction, type ReleasePolicyState, type ReleaseRecord, type ReleaseStateResponse, type RulesetDetail, type VersionSummary } from '@/src/api';
import { RiRefreshLine } from '@remixicon/react';
import { ReleaseEnvironmentTest } from './ReleaseEnvironmentTest';

interface ReleasesViewProps {
  project: ProjectDetail;
  ruleset: RulesetDetail;
  isAvailable: boolean | null;
  onBackToEditor: () => void;
}

function hasRole(roles: string[], role: string) {
  return roles.includes('admin') || roles.includes(role);
}

function when(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export const ReleasesView: React.FC<ReleasesViewProps> = ({ project, ruleset, isAvailable, onBackToEditor }) => {
  const [policy, setPolicy] = useState<ReleasePolicyState | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [selectedEnvironment, setSelectedEnvironment] = useState('');
  const [testEnvironment, setTestEnvironment] = useState('');
  const [rationale, setRationale] = useState('');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    if (isAvailable === null) {
      setStatus('loading');
      return;
    }
    if (!isAvailable) {
      setPolicy(null);
      setStatus('ready');
      return;
    }
    const requestId = ++requestSequence.current;
    setStatus('loading');
    setErrorMessage('');
    try {
      const [releaseState, versionState] = await Promise.all([
        api.getReleaseState(ruleset.id),
        api.getVersions(ruleset.id),
      ]);
      if (requestSequence.current !== requestId) return;
      setPolicy(releaseState.policy);
      setRoles(releaseState.roles || []);
      setVersions(versionState.versions || []);
      setSelectedEnvironment((current) => current || releaseState.policy.environments[0] || '');
      setTestEnvironment((current) => current && releaseState.policy.environments.includes(current) ? current : releaseState.policy.environments[0] || '');
      setSelectedVersionId((current) => current || versionState.versions[0]?.id || '');
      setStatus('ready');
    } catch (error: any) {
      if (requestSequence.current !== requestId) return;
      setErrorMessage(error.status === 404
        ? 'Hosted Releases are not available for this ruleset in this workspace.'
        : error.status === 403
        ? 'Your account is not authorized to view releases for this ruleset.'
        : error.message || 'Could not load release state.');
      setStatus('error');
    }
  }, [isAvailable, ruleset.id]);

  useEffect(() => {
    void load();
    return () => { requestSequence.current += 1; };
  }, [load]);

  const releaseByVersion = useMemo(() => new Map((policy?.releases || []).map((release) => [release.versionId, release])), [policy]);
  const availableVersions = versions.filter((version) => !releaseByVersion.has(version.id));
  const selectedVersion = versions.find((version) => version.id === selectedVersionId);
  const deploymentByEnvironment = useMemo(() => new Map((policy?.deployments || []).map((deployment) => [deployment.environment, deployment])), [policy]);

  const runAction = async (action: ReleaseAction, release: ReleaseRecord | VersionSummary, environment?: string) => {
    if (!policy || !rationale.trim()) return;
    const versionHash = 'graphHash' in release ? release.graphHash : '';
    const versionId = 'versionId' in release ? release.versionId : release.id;
    const busyKey = `${action}:${versionId}:${environment || ''}`;
    setPendingAction(busyKey);
    setActionError('');
    setActionNotice('');
    try {
      const active = environment ? deploymentByEnvironment.get(environment) : undefined;
      const result: ReleaseStateResponse = await api.transitionRelease(ruleset.id, {
        action,
        versionId,
        versionHash,
        ...(environment ? { environment, expectedActiveVersionId: active?.versionId ?? null } : {}),
        rationale,
      });
      setPolicy(result.policy);
      setRoles(result.roles || roles);
      setActionNotice(`Release ${action} completed.`);
      setRationale('');
    } catch (error: any) {
      if (error.status === 409) {
        await load();
        setActionError('The release state changed. Review the refreshed state before trying again.');
      } else {
        setActionError(error.message || `Could not ${action} this release.`);
      }
    } finally {
      setPendingAction(null);
    }
  };

  const propose = async () => {
    if (!selectedVersion || !policy || !rationale.trim()) return;
    setPendingAction(`propose:${selectedVersion.id}`);
    setActionError('');
    setActionNotice('');
    try {
      const result = await api.transitionRelease(ruleset.id, {
        action: 'propose', versionId: selectedVersion.id, versionHash: selectedVersion.graphHash, rationale,
      });
      setPolicy(result.policy);
      setRoles(result.roles || roles);
      setSelectedVersionId('');
      setRationale('');
      setActionNotice('Version proposed for review.');
    } catch (error: any) {
      setActionError(error.message || 'Could not propose this version.');
    } finally {
      setPendingAction(null);
    }
  };

  const canAuthor = hasRole(roles, 'author');
  const canReview = hasRole(roles, 'reviewer');
  const canDeploy = hasRole(roles, 'deployer');
  const canRun = hasRole(roles, 'runner') || hasRole(roles, 'author');
  const rationaleReady = rationale.trim().length >= 5;
  const needsRationale = (canAuthor && availableVersions.length > 0) ||
    (canReview && policy?.releases.some((release) => release.status === 'pending_review')) ||
    (canDeploy && policy?.releases.some((release) => release.status === 'approved'));

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 lg:px-10">
      <header className="mb-8 flex flex-col gap-4 border-b border-separator-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-body-2-medium text-text-secondary">{project.name} / {ruleset.name}</p>
          <h1 className="text-title-1-semibold text-text-primary">Releases</h1>
          <p className="mt-1 text-body-regular text-text-secondary">Review immutable saved versions and manage environment deployments.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-body-2-regular text-text-secondary">Your roles: {roles.length ? roles.join(', ') : 'loading'}</span>
          <Button variant="secondary" size="small" onClick={onBackToEditor}>Back to rule set</Button>
        </div>
      </header>

      {isAvailable === null ? (
        <div role="status" className="rounded-xl border border-border-button-default bg-background-primary-default px-4 py-12 text-center text-body-regular text-text-secondary">Checking hosted release availability…</div>
      ) : !isAvailable ? (
        <section className="rounded-2xl border border-border-button-default bg-background-primary-default p-6">
          <h2 className="text-title-3-semibold text-text-primary">Hosted Releases unavailable</h2>
          <p className="mt-2 text-body-regular text-text-secondary">Release management is enabled only in hosted workspaces configured for release roles.</p>
        </section>
      ) : status === 'loading' ? (
        <div role="status" className="rounded-xl border border-border-button-default bg-background-primary-default px-4 py-12 text-center text-body-regular text-text-secondary">Loading release state…</div>
      ) : status === 'error' ? (
        <div role="alert" className="rounded-xl border border-border-error-default bg-background-primary-default px-4 py-12 text-center">
          <p className="text-body-medium text-text-primary">Releases could not be loaded</p>
          <p className="mt-1 text-body-regular text-text-secondary">{errorMessage}</p>
          <Button className="mt-4" variant="secondary" size="small" leadingIcon={RiRefreshLine} onClick={() => void load()}>Try again</Button>
        </div>
      ) : policy ? (
        <div className="flex flex-col gap-6">
          <section aria-label="Release capabilities" className="rounded-2xl border border-border-button-default bg-background-primary-default p-4">
            <p className="text-body-medium text-text-primary">Server-enforced release policy</p>
            <p className="mt-1 text-body-2-regular text-text-secondary">
              Environments: {policy.environments.join(', ') || 'none'} · Separation of duties {policy.enforceSeparationOfDuties ? 'enforced' : 'not required'}. The server checks roles and approval rules for every action.
            </p>
          </section>

          <section aria-label="Propose a saved version" className="rounded-2xl border border-border-button-default bg-background-primary-default p-4 sm:p-6">
            <h2 className="text-title-3-semibold text-text-primary">Propose a saved version</h2>
            {versions.length === 0 ? (
              <p className="mt-2 text-body-regular text-text-secondary">Save an immutable version from the editor before proposing a release.</p>
            ) : availableVersions.length === 0 ? (
              <p className="mt-2 text-body-regular text-text-secondary">Every saved version already has a release record.</p>
            ) : canAuthor ? (
              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                <Select aria-label="Saved version to propose" selectedKey={selectedVersionId} onSelectionChange={(key) => setSelectedVersionId(String(key))}>
                  {availableVersions.map((version) => <SelectItem key={version.id} id={version.id}>Version {version.versionNumber} · Rev {version.sourceRevision} · {when(version.createdAt)}</SelectItem>)}
                </Select>
                <Button variant="primary" onClick={() => void propose()} disabled={!selectedVersion || !rationaleReady || pendingAction !== null}>
                  {pendingAction?.startsWith('propose:') ? 'Proposing…' : 'Propose release'}
                </Button>
              </div>
            ) : (
              <p className="mt-2 text-body-regular text-text-secondary">Your assigned roles do not include author.</p>
            )}
            {needsRationale && (
              <Textarea label="Rationale" value={rationale} onChange={setRationale} rows={3} maxLength={1000} showCount hint="At least 5 characters. Required for every release action." className="mt-4" />
            )}
            {actionError && <p role="alert" className="mt-3 text-body-2-regular text-text-error-primary">{actionError}</p>}
            {actionNotice && <p role="status" className="mt-3 text-body-2-regular text-text-secondary">{actionNotice}</p>}
          </section>

          <section aria-label="Environments" className="rounded-2xl border border-border-button-default bg-background-primary-default p-4 sm:p-6">
            <h2 className="text-title-3-semibold text-text-primary">Environment deployments</h2>
            {policy.environments.length === 0 ? <p className="mt-2 text-body-regular text-text-secondary">No environments are configured.</p> : (
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {policy.environments.map((environment) => {
                  const deployment = deploymentByEnvironment.get(environment);
                  const activeRelease = policy.releases.find((release) => release.versionId === deployment?.versionId);
                  return <article key={environment} className="rounded-xl border border-separator-border p-4">
                    <h3 className="text-body-medium text-text-primary">{environment}</h3>
                    <p className="mt-1 break-all text-body-2-regular text-text-secondary">Active: {activeRelease ? `Version ${activeRelease.versionNumber}` : 'None'}</p>
                    <p className="mt-1 text-caption-1-regular text-text-tertiary">Updated {when(deployment?.updatedAt)}</p>
                    <p className="mt-1 text-caption-1-regular text-text-tertiary">{deployment?.history.length || 0} deployment records</p>
                  </article>;
                })}
              </div>
            )}
          </section>

          <section aria-label="Test an active deployment" className="rounded-2xl border border-border-button-default bg-background-primary-default p-4 sm:p-6">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-title-3-semibold text-text-primary">Test a deployed decision</h2>
                <p className="mt-1 text-body-2-regular text-text-secondary">Run a real typed evaluation against an immutable version currently active in an environment.</p>
              </div>
              {policy.environments.length > 0 && <Select aria-label="Environment to test" selectedKey={testEnvironment} onSelectionChange={(key) => setTestEnvironment(String(key))} className="w-full sm:w-64">
                {policy.environments.map((environment) => <SelectItem key={environment} id={environment}>{environment}</SelectItem>)}
              </Select>}
            </div>
            {testEnvironment ? (
              <ReleaseEnvironmentTest
                key={`${ruleset.id}:${testEnvironment}:${deploymentByEnvironment.get(testEnvironment)?.versionId || 'inactive'}`}
                rulesetId={ruleset.id}
                environment={testEnvironment}
                deployment={deploymentByEnvironment.get(testEnvironment)}
                release={policy.releases.find((item) => item.versionId === deploymentByEnvironment.get(testEnvironment)?.versionId)}
                canRun={canRun}
                onRefresh={() => void load()}
              />
            ) : <p className="text-body-2-regular text-text-secondary">No environment is configured for deployment tests.</p>}
          </section>

          <section aria-label="Release records" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h2 className="text-title-3-semibold text-text-primary">Release records</h2>
              <p className="text-body-2-regular text-text-secondary">{policy.releases.length} immutable version {policy.releases.length === 1 ? 'record' : 'records'}</p>
            </div>
            {policy.releases.length === 0 ? (
              <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-6 text-body-regular text-text-secondary">No releases have been proposed.</div>
            ) : policy.releases.slice().reverse().map((release) => {
              const busy = pendingAction?.includes(release.versionId) || false;
              const isPending = release.status === 'pending_review';
              const isApproved = release.status === 'approved';
              return <article key={release.key} className="rounded-2xl border border-border-button-default bg-background-primary-default p-4 sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-body-medium text-text-primary">{release.name || `Version ${release.versionNumber}`}</h3>
                      <span className="rounded-full bg-background-secondary-default px-2 py-1 text-caption-1-semibold text-text-secondary">{release.status.replace('_', ' ')}</span>
                    </div>
                    <p className="mt-1 text-body-2-regular text-text-secondary">Version {release.versionNumber} · source Rev {release.sourceRevision} · proposed {when(release.proposedAt)} by {release.proposedBy.name}</p>
                    <p className="mt-2 break-all font-mono text-caption-1-regular text-text-tertiary">SHA-256 {release.graphHash}</p>
                    <p className="mt-2 text-body-2-regular text-text-secondary">Proposal: {release.proposalRationale}</p>
                    {release.approvalRationale && <p className="mt-1 text-body-2-regular text-text-secondary">Review: {release.approvalRationale}</p>}
                    {release.rejectionRationale && <p className="mt-1 text-body-2-regular text-text-secondary">Rejection: {release.rejectionRationale}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2 sm:justify-end">
                    {isPending && canReview && <>
                      <Button variant="primary" size="small" onClick={() => void runAction('approve', release)} disabled={!rationaleReady || !!pendingAction}>{busy ? 'Working…' : 'Approve'}</Button>
                      <Button variant="danger" size="small" onClick={() => void runAction('reject', release)} disabled={!rationaleReady || !!pendingAction}>Reject</Button>
                    </>}
                    {isPending && !canReview && <span className="text-body-2-regular text-text-tertiary">Reviewer role required</span>}
                  </div>
                </div>

                {isApproved && (
                  <div className="mt-4 flex flex-col gap-3 border-t border-separator-border pt-4">
                    <Select aria-label={`Deployment environment for version ${release.versionNumber}`} selectedKey={selectedEnvironment} onSelectionChange={(key) => setSelectedEnvironment(String(key))} className="w-full sm:max-w-64">
                      {policy.environments.map((environment) => <SelectItem key={environment} id={environment}>{environment}</SelectItem>)}
                    </Select>
                    <div className="flex flex-wrap gap-2">
                      {canDeploy ? <>
                        <Button variant="primary" size="small" onClick={() => void runAction('activate', release, selectedEnvironment)} disabled={!selectedEnvironment || !rationaleReady || !!pendingAction || deploymentByEnvironment.get(selectedEnvironment)?.versionId === release.versionId}>Activate</Button>
                        {deploymentByEnvironment.get(selectedEnvironment)?.history.some((entry) => entry.versionId === release.versionId) && deploymentByEnvironment.get(selectedEnvironment)?.versionId !== release.versionId && (
                          <Button variant="secondary" size="small" onClick={() => void runAction('rollback', release, selectedEnvironment)} disabled={!selectedEnvironment || !rationaleReady || !!pendingAction}>Rollback to this version</Button>
                        )}
                      </> : <span className="text-body-2-regular text-text-tertiary">Deployer role required</span>}
                    </div>
                  </div>
                )}
              </article>;
            })}
          </section>

          <details className="rounded-2xl border border-border-button-default bg-background-primary-default p-4 sm:p-6">
            <summary className="cursor-pointer text-body-medium text-text-primary">Release audit trail ({policy.auditTrail.length})</summary>
            {policy.auditTrail.length ? <ol className="mt-4 flex flex-col gap-3">
              {policy.auditTrail.slice().reverse().map((entry) => <li key={entry.id} className="border-s-2 border-separator-border ps-3">
                <p className="text-body-2-medium text-text-primary">{entry.action} · {entry.environment || 'release'} · {when(entry.timestamp)}</p>
                <p className="mt-1 text-body-2-regular text-text-secondary">{entry.actorId} ({entry.actorRoles.join(', ')}) · {entry.rationale}</p>
                {entry.previousVersionId && <p className="mt-1 text-caption-1-regular text-text-tertiary">Previous {entry.previousVersionId} → next {entry.nextVersionId}</p>}
              </li>)}
            </ol> : <p className="mt-3 text-body-2-regular text-text-secondary">No actions recorded.</p>}
          </details>
          <p className="text-caption-1-regular text-text-tertiary">On narrow screens, release records and actions wrap into stacked cards; audit details stay collapsed until opened.</p>
        </div>
      ) : null}
    </main>
  );
};
