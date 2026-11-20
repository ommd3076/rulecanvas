import React, { useRef, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/base/modal/modal';
import { RiUpload2Line } from '@remixicon/react';
import { api } from '@/src/api';

export function LegacyImportModal({ isOpen, onClose, onImported }: { isOpen: boolean; onClose: () => void; onImported: (projectId: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ name: string; warnings: string[]; versionCount: number; scenarioCount: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const envelope = useRef<unknown>(null);

  const inspect = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    setPreview(null);
    try {
      if (file.size > 900_000) throw new Error('Choose an export smaller than 900 KB.');
      const parsed = JSON.parse(await file.text());
      const result = await api.previewLegacyProject(parsed);
      envelope.current = parsed;
      setPreview(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The export could not be inspected.');
    } finally { setBusy(false); }
  };

  const importProject = async () => {
    if (!preview || !envelope.current || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.importLegacyProject(envelope.current);
      onImported(result.project.id);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The project could not be imported.');
    } finally { setBusy(false); }
  };

  return <Modal isOpen={isOpen} onOpenChange={(open) => { if (!open && !busy) onClose(); }} size="lg">
    <ModalHeader title="Import an earlier RuleCanvas project" description="Choose a ProjectExport.v1 JSON file and review its compatibility before importing." icon={RiUpload2Line} />
    <ModalBody>
      <div className="flex flex-col gap-4 py-2">
        <label className="text-body-medium text-text-primary" htmlFor="legacy-project-file">Project export JSON</label>
        <input id="legacy-project-file" type="file" accept="application/json,.json" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setError(''); envelope.current = null; }} />
        {preview && <section aria-label="Import review" className="rounded-2xl border border-border-button-default p-4">
          <h2 className="text-body-medium text-text-primary">{preview.name}</h2>
          <p className="mt-2 text-body-2-regular text-text-secondary">{preview.versionCount} versions · {preview.scenarioCount} scenarios</p>
          <ul className="mt-3 list-disc space-y-2 ps-5 text-body-2-regular text-text-secondary">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </section>}
        {error && <p role="alert" className="text-body-2-regular text-text-error-primary">{error}</p>}
      </div>
    </ModalBody>
    <ModalFooter>
      <Button variant="secondary" size="medium" onClick={onClose} disabled={busy}>Cancel</Button>
      {preview ? <Button variant="primary" size="medium" onClick={() => void importProject()} disabled={busy}>Import project</Button> :
        <Button variant="primary" size="medium" onClick={() => void inspect()} disabled={!file || busy}>Review export</Button>}
    </ModalFooter>
  </Modal>;
}
