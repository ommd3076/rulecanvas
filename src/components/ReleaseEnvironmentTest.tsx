import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { TestRunner } from '@/src/components/TestRunner';
import { api, type ActiveReleaseEvaluationResult, type EvaluationResult, type ReleaseDeployment, type ReleaseRecord, type VersionDetail } from '@/src/api';
import { RiRefreshLine } from '@remixicon/react';

interface ReleaseEnvironmentTestProps {
  rulesetId: string;
  environment: string;
  deployment?: ReleaseDeployment;
  release?: ReleaseRecord;
  canRun: boolean;
  onRefresh: () => void;
}

type LoadStatus = 'loading' | 'ready' | 'inactive' | 'unauthorized' | 'error';

function getReadError(error: any) {
  if (error?.status === 401 || error?.status === 403 || String(error?.code || '').startsWith('auth.')) {
    return { status: 'unauthorized' as const, message: 'Your account is not authorized to load this deployed version.' };
  }
  if (error?.code === 'release.inactive' || error?.status === 404) {
    return { status: 'inactive' as const, message: 'This environment has no readable active release. Refresh deployments to confirm its state.' };
  }
  if (error?.status === 409 || String(error?.code || '').startsWith('release.integrity')) {
    return { status: 'error' as const, message: 'The deployment pointer and immutable version could not be verified. Refresh before testing.' };
  }
  return { status: 'error' as const, message: error?.message || 'Could not load the active version schema.' };
}

function getEvaluationError(error: any) {
  if (error?.code === 'release.active_version_conflict') {
    return 'The active release changed since its schema was loaded. No evaluation was recorded. Refresh deployments and reopen the test form.';
  }
  if (error?.status === 401 || error?.status === 403 || String(error?.code || '').startsWith('auth.')) {
    return 'Access to evaluate this environment was denied. Check your hosted runner permissions.';
  }
  if (error?.code === 'release.inactive' || error?.status === 404) {
    return 'This environment no longer has an active release. Refresh deployments before running another test.';
  }
  if (error?.status === 409) {
    return 'The active release changed or failed its integrity check while this test was starting. Refresh deployments before retrying.';
  }
  return error?.message || 'The deployed decision could not be evaluated.';
}

export const ReleaseEnvironmentTest: React.FC<ReleaseEnvironmentTestProps> = ({
  rulesetId,
  environment,
  deployment,
  release,
  canRun,
  onRefresh,
}) => {
  const [version, setVersion] = useState<VersionDetail | null>(null);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading');
  const [loadMessage, setLoadMessage] = useState('');
  const [runMessage, setRunMessage] = useState('');
  const [runNotice, setRunNotice] = useState('');
  const [lastRun, setLastRun] = useState<{ environment: string; version: ActiveReleaseEvaluationResult['version']; loadedVersionId: string; at: string } | null>(null);
  const [guardActive, setGuardActive] = useState(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    let current = true;
    setVersion(null);
    setLoadMessage('');
    setRunMessage('');
    setRunNotice('');
    setLastRun(null);

    if (!deployment) {
      setLoadStatus('inactive');
      setLoadMessage(`No active version is recorded for ${environment}.`);
      return () => { current = false; };
    }
    if (!release || release.status !== 'approved' || release.versionId !== deployment.versionId || release.graphHash !== deployment.versionHash) {
      setLoadStatus('error');
      setLoadMessage('The active deployment does not match an approved release record. Refresh deployments before testing.');
      return () => { current = false; };
    }

    setLoadStatus('loading');
    void api.getVersion(rulesetId, deployment.versionId).then(({ version: loaded }) => {
      if (!current) return;
      if (loaded.id !== deployment.versionId || loaded.graphHash !== deployment.versionHash || loaded.versionNumber !== release.versionNumber) {
        setLoadStatus('error');
        setLoadMessage('The active release pointer did not match its immutable version. Refresh deployments before testing.');
        return;
      }
      setVersion(loaded);
      setLoadStatus('ready');
    }).catch((error: any) => {
      if (!current) return;
      const mapped = getReadError(error);
      setLoadStatus(mapped.status);
      setLoadMessage(mapped.message);
    });

    return () => { current = false; };
  }, [deployment?.versionId, deployment?.versionHash, environment, release?.status, release?.versionNumber, release?.graphHash, rulesetId]);

  const runTest = async (input: Record<string, any>): Promise<EvaluationResult> => {
    if (!deployment || !version) throw new Error('The active release is not ready to test.');
    if (inFlightRef.current) throw new Error('A deployed decision test is already in progress.');

    inFlightRef.current = true;
    setGuardActive(true);
    setRunMessage('');
    setRunNotice('');
    try {
      const response = await api.evaluateActiveRelease(rulesetId, environment, input, version.id);
      if (!response.version?.id || !response.version?.graphHash || response.environment !== environment) {
        setRunMessage('The evaluation response did not identify the environment and immutable version. No result is shown. Refresh deployments.');
        throw new Error('The evaluation response could not be matched to this environment.');
      }
      setLastRun({ environment: response.environment, version: response.version, loadedVersionId: version.id, at: new Date().toISOString() });
      if (response.version.id !== version.id || response.version.graphHash !== version.graphHash) {
        setRunNotice(`The active deployment changed after the form loaded. This trace is for the version the server actually evaluated (Version ${response.version.versionNumber}, ${response.version.id}). Refresh deployments and inspect that version before another test.`);
      } else {
        setRunNotice(`Evaluated the active ${environment} release, Version ${response.version.versionNumber}.`);
      }
      return response;
    } catch (error: any) {
      setRunMessage((current) => current || getEvaluationError(error));
      throw error;
    } finally {
      inFlightRef.current = false;
      setGuardActive(false);
    }
  };

  const activeVersionNumber = release?.versionNumber;

  return (
    <section aria-label={`Test active ${environment} release`} className="rounded-2xl border border-border-button-default bg-background-primary-default p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-title-3-semibold text-text-primary">Test active decision</h2>
          <p className="mt-1 text-body-2-regular text-text-secondary">Evaluate the saved version currently deployed to {environment}.</p>
        </div>
        <Button variant="secondary" size="small" leadingIcon={RiRefreshLine} onClick={onRefresh} disabled={guardActive}>Refresh deployment</Button>
      </div>

      {!canRun ? (
        <p className="mt-4 rounded-xl border border-separator-border p-4 text-body-2-regular text-text-secondary">Testing deployed decisions requires the author, runner, or admin role.</p>
      ) : loadStatus === 'loading' ? (
        <p role="status" className="mt-4 rounded-xl border border-separator-border p-4 text-body-2-regular text-text-secondary">Loading the immutable active version schema…</p>
      ) : loadStatus !== 'ready' ? (
        <div role={loadStatus === 'unauthorized' ? 'alert' : 'status'} className="mt-4 rounded-xl border border-separator-border p-4">
          <p className="text-body-2-medium text-text-primary">{loadStatus === 'inactive' ? 'No active release' : loadStatus === 'unauthorized' ? 'Access denied' : 'Version could not be verified'}</p>
          <p className="mt-1 text-body-2-regular text-text-secondary">{loadMessage}</p>
        </div>
      ) : version ? (
        <div className="mt-4 flex flex-col gap-4">
          <div className="rounded-xl border border-separator-border p-4">
            <p className="text-body-medium text-text-primary">{environment} · Version {activeVersionNumber} · source Rev {release?.sourceRevision}</p>
            <p className="mt-1 break-all font-mono text-caption-1-regular text-text-tertiary">Version ID {version.id}</p>
            <p className="mt-1 break-all font-mono text-caption-1-regular text-text-tertiary">SHA-256 {version.graphHash}</p>
            <p className="mt-1 text-caption-1-regular text-text-tertiary">Schema loaded from this immutable version · deployed {deployment ? new Date(deployment.updatedAt).toLocaleString() : '—'}</p>
          </div>
          {runNotice && <p role="status" className="rounded-xl border border-separator-border p-3 text-body-2-regular text-text-secondary">{runNotice}</p>}
          {runMessage && <p role="alert" className="rounded-xl border border-border-error-default p-3 text-body-2-regular text-text-error-primary">{runMessage}</p>}
          {lastRun && <p className="text-caption-1-regular text-text-tertiary">Last response: {lastRun.environment} · Version {lastRun.version.versionNumber} · {lastRun.version.id} · {new Date(lastRun.at).toLocaleTimeString()}{lastRun.loadedVersionId !== lastRun.version.id ? ` · input form loaded for ${lastRun.loadedVersionId}` : ''}</p>}
          <fieldset disabled={guardActive} className="min-w-0 disabled:opacity-80">
            <TestRunner key={`${environment}:${version.id}:${version.graphHash}`} schema={version.graph.schema || []} onRunTest={runTest} />
          </fieldset>
        </div>
      ) : null}
    </section>
  );
};
