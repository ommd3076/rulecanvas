export interface SchemaField {
  id: string;
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum';
  required?: boolean;
  options?: string[];
}

export interface RuleNode {
  id: string;
  type: 'start' | 'condition' | 'group' | 'outcome';
  x: number;
  y: number;
  fieldId?: string;
  operator?: string;
  value?: any;
  terms?: any[];
  label?: string;
  result?: any;
}

export interface RuleEdge {
  id: string;
  from: string;
  fromPort: 'next' | 'true' | 'false';
  to: string;
  toPort: 'in';
}

export interface RuleGraph {
  schema: SchemaField[];
  nodes: RuleNode[];
  edges: RuleEdge[];
}

export interface RulesetSummary {
  id: string;
  projectId: string;
  name: string;
  status: 'draft' | 'versioned';
  revision: number;
  latestVersionNumber: number;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RulesetDetail extends RulesetSummary {
  graph: RuleGraph;
}

export interface ProjectSummary {
  id: string;
  name: string;
  rulesetCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail {
  id: string;
  name: string;
  rulesets: RulesetSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface VersionSummary {
  id: string;
  versionNumber: number;
  sourceRevision: number;
  graphHash: string;
  createdAt: string;
}

export interface VersionDetail extends VersionSummary {
  graph: RuleGraph;
}

export interface AuditEvent {
  id: string;
  projectId: string;
  rulesetId?: string | null;
  actor: string;
  type: string;
  details?: Record<string, any>;
  occurredAt: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<{
    code: string;
    message: string;
    nodeId?: string;
    termPath?: string;
  }>;
}

export interface EvaluationTraceEntry {
  nodeId: string;
  kind: 'start' | 'condition' | 'group' | 'outcome';
  label?: string;
  field?: string;
  operator?: string;
  expected?: any;
  actual?: any;
  branch?: 'true' | 'false';
  terms?: any[];
  result?: any;
}

export interface EvaluationResult {
  ok: boolean;
  result?: any;
  outcomeId?: string;
  trace?: EvaluationTraceEntry[];
  errors?: Array<{ code: string; message: string }>;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...options.headers,
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error?.message || `HTTP ${res.status}: ${res.statusText}`);
    (error as any).status = res.status;
    (error as any).code = data.error?.code;
    (error as any).details = data.error?.details;
    throw error;
  }
  return data as T;
}

export const api = {
  getHealth: () => request<{ ok: boolean; storage: string; recovered: boolean }>('/api/health'),

  getProjects: () => request<{ projects: ProjectSummary[] }>('/api/projects'),
  createGuidedExample: () => request<{ project: ProjectDetail; ruleset: RulesetDetail; created: boolean }>('/api/examples/eligibility', {
    method: 'POST',
  }),
  createProject: (name: string) => request<{ project: ProjectDetail }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }),
  getProject: (id: string) => request<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(id)}`),

  createRuleset: (projectId: string, name: string) => request<{ ruleset: RulesetDetail }>(`/api/projects/${encodeURIComponent(projectId)}/rulesets`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  }),
  getRuleset: (id: string) => request<{ ruleset: RulesetDetail }>(`/api/rulesets/${encodeURIComponent(id)}`),
  saveRuleset: (id: string, expectedRevision: number, graph: RuleGraph, name: string) => request<{ ruleset: RulesetDetail }>(`/api/rulesets/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ expectedRevision, graph, name }),
  }),

  validateGraph: (rulesetId: string, graph?: RuleGraph) => request<ValidationResult>(`/api/rulesets/${encodeURIComponent(rulesetId)}/validate`, {
    method: 'POST',
    body: JSON.stringify({ graph }),
  }),
  evaluateGraph: (rulesetId: string, input: Record<string, any>, expectedRevision?: number) => request<EvaluationResult>(`/api/rulesets/${encodeURIComponent(rulesetId)}/evaluate`, {
    method: 'POST',
    body: JSON.stringify({ input, expectedRevision }),
  }),

  getVersions: (rulesetId: string) => request<{ versions: VersionSummary[] }>(`/api/rulesets/${encodeURIComponent(rulesetId)}/versions`),
  createVersion: (rulesetId: string, expectedRevision: number) => request<{ version: VersionDetail }>(`/api/rulesets/${encodeURIComponent(rulesetId)}/versions`, {
    method: 'POST',
    body: JSON.stringify({ expectedRevision }),
  }),
  getVersion: (rulesetId: string, versionId: string) => request<{ version: VersionDetail }>(`/api/rulesets/${encodeURIComponent(rulesetId)}/versions/${encodeURIComponent(versionId)}`),
  evaluateVersion: (rulesetId: string, versionId: string, input: Record<string, any>) => request<EvaluationResult>(`/api/rulesets/${encodeURIComponent(rulesetId)}/versions/${encodeURIComponent(versionId)}/evaluate`, {
    method: 'POST',
    body: JSON.stringify({ input }),
  }),

  getAudit: (projectId: string) => request<{ events: AuditEvent[] }>(`/api/projects/${encodeURIComponent(projectId)}/audit`),
};
