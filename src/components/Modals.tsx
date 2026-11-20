import React, { useState, useRef } from 'react';
import {
  Modal,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from '@/components/base/modal/modal';
import { Button } from '@/components/base/buttons/button';
import { Input } from '@/components/base/input/input';
import { Textarea } from '@/components/base/textarea/textarea';
import { Chip } from '@/components/base/badges/chip';
import { Table } from '@/components/base/table/table';
import { TableHeader, Column, TableBody, Row, Cell } from 'react-aria-components';
import {
  RiAddLine,
  RiHistoryLine,
  RiShieldCheckLine,
  RiDownload2Line,
  RiUpload2Line,
  RiPlayLine,
  RiFileLine,
} from '@remixicon/react';
import type {
  VersionSummary,
  VersionDetail,
  AuditEvent,
  RuleGraph,
  EvaluationResult,
  ValidationResult,
} from '@/src/api';
import InlineCopyInput from '@/components/ruixen/inline-copy-input';
import CodeBlock from '@/components/rareui/code-block';
import { serializeRuleDraft, parseRuleDraft } from '@/public/rule-transfer';

/* ------------------------------------------------------------------ Create Project Modal */
interface CreateProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}

export const CreateProjectModal: React.FC<CreateProjectModalProps> = ({
  isOpen,
  onClose,
  onCreate,
}) => {
  const [name, setName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setIsSubmitting(true);
    try {
      await onCreate(name.trim());
      setName('');
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => !open && onClose()} size="md">
      <ModalHeader
        title="Create Rule Project"
        description="Organize decision models and rulesets under a dedicated project workspace."
        icon={RiAddLine}
      />
      <ModalBody>
        <div className="flex flex-col gap-4 py-2">
          <Input
            label="Project Name"
            placeholder="e.g. Loan Underwriting or Customs Clearance"
            value={name}
            onChange={setName}
            autoFocus
          />
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" size="medium" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="medium"
          disabled={!name.trim() || isSubmitting}
          onClick={handleSubmit}
        >
          Create Project
        </Button>
      </ModalFooter>
    </Modal>
  );
};

/* ------------------------------------------------------------------ Create Ruleset Modal */
interface CreateRulesetModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}

export const CreateRulesetModal: React.FC<CreateRulesetModalProps> = ({
  isOpen,
  onClose,
  onCreate,
}) => {
  const [name, setName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setIsSubmitting(true);
    try {
      await onCreate(name.trim());
      setName('');
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => !open && onClose()} size="md">
      <ModalHeader
        title="Create Decision Rule Set"
        description="Create a new visual graph ruleset inside this project."
        icon={RiAddLine}
      />
      <ModalBody>
        <div className="flex flex-col gap-4 py-2">
          <Input
            label="Rule Set Name"
            placeholder="e.g. Credit Eligibility or Tariff Classification"
            value={name}
            onChange={setName}
            autoFocus
          />
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" size="medium" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="medium"
          disabled={!name.trim() || isSubmitting}
          onClick={handleSubmit}
        >
          Create Rule Set
        </Button>
      </ModalFooter>
    </Modal>
  );
};

/* ------------------------------------------------------------------ Version History Modal */
interface VersionHistoryModalProps {
  isOpen: boolean;
  rulesetId?: string;
  rulesetName: string;
  versions: VersionSummary[];
  initialVersionId?: string;
  onClose: () => void;
  onInspectVersion: (versionId: string) => Promise<VersionDetail>;
  onEvaluateVersion: (versionId: string, input: Record<string, any>) => Promise<EvaluationResult>;
  onSelectVersionId?: (versionId: string) => void;
}

export const VersionHistoryModal: React.FC<VersionHistoryModalProps> = ({
  isOpen,
  rulesetId,
  rulesetName,
  versions,
  initialVersionId,
  onClose,
  onInspectVersion,
  onEvaluateVersion,
  onSelectVersionId,
}) => {
  const [selectedVersion, setSelectedVersion] = useState<VersionDetail | null>(null);
  const [evalInput, setEvalInput] = useState('{}');
  const [evalResult, setEvalResult] = useState<EvaluationResult | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);
  const inspectionRequest = useRef(0);
  const evaluationRequest = useRef(0);

  // Automatically inspect initialVersionId when modal opens or initialVersionId changes
  React.useEffect(() => {
    const requestId = ++inspectionRequest.current;
    evaluationRequest.current += 1;
    if (isOpen && initialVersionId) {
      setSelectedVersion(null);
      setEvalResult(null);
      setEvalError(null);
      onInspectVersion(initialVersionId)
        .then((detail) => {
          if (requestId !== inspectionRequest.current) return;
          setSelectedVersion(detail);
          setEvalResult(null);
        })
        .catch((error: unknown) => {
          if (requestId !== inspectionRequest.current) return;
          setEvalError(error instanceof Error ? error.message : 'Failed to load this version.');
        });
    } else if (!isOpen) {
      setSelectedVersion(null);
      setEvalResult(null);
      setEvalError(null);
    }
  }, [isOpen, initialVersionId]);

  const handleSelect = async (vId: string) => {
    const requestId = ++inspectionRequest.current;
    evaluationRequest.current += 1;
    setSelectedVersion(null);
    setEvalResult(null);
    setEvalError(null);
    try {
      const detail = await onInspectVersion(vId);
      if (requestId !== inspectionRequest.current) return;
      setSelectedVersion(detail);
      onSelectVersionId?.(vId);
    } catch (error) {
      if (requestId !== inspectionRequest.current) return;
      setEvalError(error instanceof Error ? error.message : 'Failed to load this version.');
    }
  };

  const handleRunVersionEval = async () => {
    if (!selectedVersion) return;
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(evalInput);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Input must be a JSON object.');
      }
    } catch (e: unknown) {
      setEvalResult(null);
      setEvalError(`Invalid JSON input: ${e instanceof Error ? e.message : 'Unable to parse JSON.'}`);
      return;
    }

    const requestId = ++evaluationRequest.current;
    const versionId = selectedVersion.id;
    setEvalResult(null);
    setEvalError(null);
    try {
      const res = await onEvaluateVersion(selectedVersion.id, parsed);
      if (requestId !== evaluationRequest.current) return;
      setEvalResult(res);
      if (!res.ok) {
        setEvalError(res.errors?.map((error) => error.message).filter(Boolean).join(' ') || 'The version could not evaluate this input.');
      }
    } catch (error: unknown) {
      if (requestId !== evaluationRequest.current || selectedVersion.id !== versionId) return;
      setEvalError(error instanceof Error ? error.message : 'Version evaluation failed.');
    }
  };

  const handleEvalInputChange = (value: string) => {
    evaluationRequest.current += 1;
    setEvalInput(value);
    setEvalResult(null);
    setEvalError(null);
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => !open && onClose()} size="xl">
      <ModalHeader
        title={`Version History · ${rulesetName}`}
        description="Browse immutable saved versions, verify content hashes, and inspect frozen rule graphs."
        icon={RiHistoryLine}
      />
      <ModalBody>
        <div className="flex flex-col gap-6 py-2">
          {versions.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border-button-default bg-background-primary-default p-8 text-center">
              <p className="text-body-regular text-text-secondary">
                No versions have been saved yet for this rule set.
              </p>
              <p className="mt-1 text-caption-1-regular text-text-tertiary">
                Save an immutable version from the editor toolbar to record a cryptographic snapshot.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-border-button-default">
              <Table aria-label="Versions table" size="sm">
                <TableHeader>
                  <Column isRowHeader>Version</Column>
                  <Column>Source Revision</Column>
                  <Column>Cryptographic Hash</Column>
                  <Column>Saved date</Column>
                  <Column className="text-end">Action</Column>
                </TableHeader>
                <TableBody>
                  {versions.map((ver) => (
                    <Row key={ver.id}>
                      <Cell>
                        <Chip variant="bold" color="cyan">
                          Version {ver.versionNumber}
                        </Chip>
                      </Cell>
                      <Cell>
                        <span className="font-mono text-body-2-medium text-text-secondary">
                          Rev {ver.sourceRevision}
                        </span>
                      </Cell>
                      <Cell>
                        <div className="max-w-xs">
                          <InlineCopyInput value={ver.graphHash} sound={false} />
                        </div>
                      </Cell>
                      <Cell>
                        <span className="text-caption-1-regular text-text-tertiary">
                          {new Date(ver.createdAt).toLocaleString()}
                        </span>
                      </Cell>
                      <Cell className="text-end">
                        <Button
                          variant="secondary"
                          size="small"
                          onClick={() => handleSelect(ver.id)}
                        >
                          Inspect Snapshot
                        </Button>
                      </Cell>
                    </Row>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Inspect Selected Immutable Version */}
          {selectedVersion && (
            <div className="flex flex-col gap-3 rounded-2xl border border-border-button-default bg-background-primary-default p-4 shadow-xs">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-title-3-semibold text-text-primary">
                    Immutable Version {selectedVersion.versionNumber} Snapshot
                  </h4>
                  <p className="text-caption-1-regular text-text-secondary">
                    Frozen rule graph representation (read-only)
                  </p>
                </div>
                <Chip variant="bold" color="lime">
                  Verified SHA-256
                </Chip>
              </div>

              {/* RareUI CodeBlock */}
              <div className="max-h-60 overflow-y-auto rounded-xl">
                <CodeBlock
                  code={JSON.stringify(selectedVersion.graph, null, 2)}
                  language="json"
                  filename={`version-${selectedVersion.versionNumber}.json`}
                  showCopyButton={true}
                />
              </div>

              {/* Test against this version */}
              <div className="mt-2 flex flex-col gap-2 border-t border-separator-border pt-3">
                <span className="text-caption-1-medium text-text-secondary uppercase">
                  Evaluate Input against Version {selectedVersion.versionNumber}
                </span>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <Input
                      aria-label="Test payload JSON"
                      value={evalInput}
                      onChange={handleEvalInputChange}
                      placeholder='{"amount": 150}'
                    />
                  </div>
                  <Button
                    variant="primary"
                    size="small"
                    leadingIcon={RiPlayLine}
                    onClick={handleRunVersionEval}
                  >
                    Evaluate
                  </Button>
                </div>
                {evalError && (
                  <div role="alert" className="rounded-xl bg-status-rose-background/40 p-3 text-caption-1-medium text-text-error-primary">
                    {evalError}
                  </div>
                )}
                {evalResult?.ok && (
                  <div className="rounded-xl bg-background-secondary-default p-3 font-mono text-caption-1-regular">
                    Result: {JSON.stringify(evalResult.result, null, 2)}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" size="medium" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
};

/* ------------------------------------------------------------------ Audit Log Modal */
interface AuditModalProps {
  isOpen: boolean;
  projectName: string;
  auditEvents: AuditEvent[];
  onClose: () => void;
}

export const AuditModal: React.FC<AuditModalProps> = ({
  isOpen,
  projectName,
  auditEvents,
  onClose,
}) => {
  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => !open && onClose()} size="lg">
      <ModalHeader
        title={`Audit Log · ${projectName}`}
        description="Review who created, edited, or released rules in this project."
        icon={RiShieldCheckLine}
      />
      <ModalBody>
        <div className="py-2">
          {auditEvents.length === 0 ? (
            <p className="text-body-regular text-text-tertiary">No audit events recorded yet.</p>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-border-button-default">
              <Table aria-label="Audit log table" size="sm">
                <TableHeader>
                  <Column isRowHeader>Event Type</Column>
                  <Column>Actor</Column>
                  <Column>Details</Column>
                  <Column className="text-end">Occurred</Column>
                </TableHeader>
                <TableBody>
                  {auditEvents.map((event) => (
                    <Row key={event.id}>
                      <Cell>
                        <Chip variant="caption" color="purple">
                          {event.type}
                        </Chip>
                      </Cell>
                      <Cell>
                        <span className="font-mono text-caption-1-regular text-text-secondary">
                          {event.actor}
                        </span>
                      </Cell>
                      <Cell>
                        <div className="flex min-w-0 flex-col gap-1 text-body-2-regular text-text-primary">
                          {event.details?.name && <span>{event.details.name}</span>}
                          {event.details?.slug && <span>{event.details.slug}</span>}
                          {event.details?.versionNumber && <span>Version {event.details.versionNumber} · Revision {event.details.sourceRevision}</span>}
                          {event.details?.revision && <span>Revision {event.details.revision}</span>}
                          {event.details?.environment && <span className="text-text-secondary">{event.details.environment}</span>}
                          {event.details?.rationale && <span className="wrap-anywhere text-text-secondary">{event.details.rationale}</span>}
                        </div>
                      </Cell>
                      <Cell className="text-end">
                        <span className="text-caption-1-regular text-text-tertiary">
                          {new Date(event.occurredAt).toLocaleString()}
                        </span>
                      </Cell>
                    </Row>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" size="medium" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
};

/* ------------------------------------------------------------------ Import / Export Modal */
interface ImportExportModalProps {
  isOpen: boolean;
  graph: RuleGraph;
  rulesetId: string;
  rulesetName: string;
  revision: number;
  onClose: () => void;
  onValidateImport: (graph: RuleGraph) => Promise<ValidationResult>;
  onImport: (graph: RuleGraph) => void;
}

export const ImportExportModal: React.FC<ImportExportModalProps> = ({
  isOpen,
  graph,
  rulesetId,
  rulesetName,
  revision,
  onClose,
  onValidateImport,
  onImport,
}) => {
  const [activeTab, setActiveTab] = useState<'export' | 'import'>('export');
  const [importJson, setImportJson] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Use tested serializeRuleDraft format with metadata
  const draftPayload = serializeRuleDraft({
    rulesetId,
    name: rulesetName,
    revision,
    graph,
  });

  const handleDownload = () => {
    const blob = new Blob([draftPayload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${rulesetName.toLowerCase().replace(/\s+/g, '-')}-draft.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result;
      if (typeof content === 'string') {
        setImportJson(content);
        setImportError(null);
      }
    };
    reader.onerror = () => {
      setImportError('Failed to read the selected file.');
    };
    reader.readAsText(file);
  };

  const handleApplyImport = async () => {
    try {
      setImportError(null);
      setIsValidating(true);

      let importedGraph: RuleGraph;

      // First try standard parseRuleDraft (handles rulecanvas-draft and rulecanvas-conflict-draft)
      try {
        const parsedDraft = parseRuleDraft(importJson);
        importedGraph = parsedDraft.graph;
      } catch (err: any) {
        // Fallback: check if raw graph object with schema, nodes, edges was pasted
        try {
          const raw = JSON.parse(importJson);
          if (
            raw &&
            typeof raw === 'object' &&
            Array.isArray(raw.nodes) &&
            Array.isArray(raw.edges)
          ) {
            importedGraph = {
              schema: Array.isArray(raw.schema) ? raw.schema : [],
              nodes: raw.nodes,
              edges: raw.edges,
            };
          } else {
            throw err;
          }
        } catch {
          throw err;
        }
      }

      // Validate imported graph through backend before committing
      const validation = await onValidateImport(importedGraph);
      if (!validation.valid) {
        const firstError = validation.errors[0]?.message || 'Graph structure is invalid';
        setImportError(`Cannot import invalid graph: ${firstError} (${validation.errors.length} issue(s)).`);
        return;
      }

      onImport(importedGraph);
      onClose();
    } catch (err: any) {
      setImportError(err.message || 'Failed to parse rule graph JSON.');
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => !open && onClose()} size="lg">
      <ModalHeader
        title="Import / Export Rule Graph"
        description="Export rule graph JSON for backup, or import a saved draft or conflict copy."
        icon={activeTab === 'export' ? RiDownload2Line : RiUpload2Line}
      />
      <ModalBody>
        <div className="flex flex-col gap-4 py-2">
          {/* Tabs */}
          <div className="flex items-center gap-2 border-b border-separator-border pb-2">
            <Button
              variant={activeTab === 'export' ? 'primary' : 'ghost'}
              size="small"
              onClick={() => setActiveTab('export')}
            >
              Export Draft
            </Button>
            <Button
              variant={activeTab === 'import' ? 'primary' : 'ghost'}
              size="small"
              onClick={() => setActiveTab('import')}
            >
              Import Draft
            </Button>
          </div>

          {activeTab === 'export' ? (
            <div className="flex flex-col gap-3">
              <div className="max-h-72 overflow-y-auto rounded-xl">
                <CodeBlock
                  code={draftPayload}
                  language="json"
                  filename={`${rulesetName}-draft.json`}
                  showCopyButton={true}
                />
              </div>
              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  size="small"
                  leadingIcon={RiDownload2Line}
                  onClick={handleDownload}
                >
                  Download JSON File
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {/* File upload trigger */}
              <div className="flex items-center justify-between rounded-xl border border-dashed border-border-button-default bg-background-secondary-default/50 p-3">
                <div className="flex items-center gap-2">
                  <RiFileLine className="h-5 w-5 text-text-secondary" />
                  <span className="text-body-2-regular text-text-secondary">
                    Load draft from file (.json)
                  </span>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={handleFileUpload}
                />
                <Button
                  variant="secondary"
                  size="small"
                  leadingIcon={RiUpload2Line}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Select File
                </Button>
              </div>

              <Textarea
                aria-label="Paste rule graph JSON"
                placeholder="Or paste valid RuleCanvas draft or conflict JSON here…"
                value={importJson}
                onChange={setImportJson}
                rows={7}
              />

              {importError && (
                <div className="rounded-xl bg-status-rose-background/40 p-3 text-caption-1-medium text-text-error-primary">
                  {importError}
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  variant="primary"
                  size="medium"
                  disabled={!importJson.trim() || isValidating}
                  leadingIcon={RiUpload2Line}
                  onClick={handleApplyImport}
                >
                  {isValidating ? 'Validating…' : 'Validate & Apply Import'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" size="medium" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
};
