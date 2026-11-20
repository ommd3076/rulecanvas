import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createStarterGraph, validateGraph } from './rule-engine.mjs';
import { createEligibilityExampleGraph } from './example-graph.mjs';
import { activateRelease, approveRelease, createReleasePolicyState, getDeployment, getRelease, proposeRelease, rejectRelease, rollbackRelease } from './release-policy.mjs';

const STORE_SCHEMA_VERSION = 1;
const GUIDED_EXAMPLE_KEY = 'eligibility-v1';
const MAX_EVALUATION_RUNS_PER_PROJECT = 500;
const releaseTransitions = new Map([
  ['propose', proposeRelease],
  ['approve', approveRelease],
  ['reject', rejectRelease],
  ['activate', activateRelease],
  ['rollback', rollbackRelease],
]);

export class StoreError extends Error {
  constructor(message, status = 400, code = 'store.error', details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function addAuditEvent(data, actor, { projectId, rulesetId = null, type, details = {} }) {
  data.auditEvents.push({
    id: randomUUID(), projectId, rulesetId, actor, type,
    details, occurredAt: new Date().toISOString(),
  });
}

function assertVersionIntegrity(version) {
  const actualHash = createHash('sha256').update(JSON.stringify(version.graph)).digest('hex');
  if (actualHash !== version.graphHash) {
    throw new StoreError('Saved version content does not match its recorded hash.', 409, 'version.integrity');
  }
}

function parseStoreContents(contents) {
  let stored;
  try { stored = JSON.parse(contents); }
  catch { throw new StoreError('Local workspace JSON is malformed.', 503, 'storage.corrupt'); }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new StoreError('Local workspace data has an invalid shape.', 503, 'storage.corrupt');
  }
  const sourceVersion = Object.hasOwn(stored, 'schemaVersion') ? stored.schemaVersion : 0;
  if (!Number.isInteger(sourceVersion) || sourceVersion < 0 || sourceVersion > STORE_SCHEMA_VERSION) {
    throw new StoreError(`Local workspace schema version ${String(sourceVersion)} is not supported. The file was left untouched.`, 503, 'storage.version');
  }
  const keys = ['projects', 'rulesets', 'versions', 'auditEvents', 'evaluationRuns', 'releasePolicies'];
  const requiredKeys = sourceVersion === 0 ? ['projects', 'rulesets'] : ['projects', 'rulesets', 'versions', 'auditEvents'];
  for (const key of keys) {
    if (requiredKeys.includes(key) ? !Array.isArray(stored[key]) : stored[key] !== undefined && !Array.isArray(stored[key])) {
      throw new StoreError(`Local workspace ${key} data has an invalid shape.`, 503, 'storage.corrupt');
    }
  }
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    projects: stored.projects ?? [],
    rulesets: stored.rulesets ?? [],
    versions: stored.versions ?? [],
    auditEvents: stored.auditEvents ?? [],
    evaluationRuns: stored.evaluationRuns ?? [],
    releasePolicies: stored.releasePolicies ?? [],
  };
}

function parseWorkspace(contents) {
  if (contents !== null) return parseStoreContents(contents);
  return { schemaVersion: STORE_SCHEMA_VERSION, projects: [], rulesets: [], versions: [], auditEvents: [], evaluationRuns: [], releasePolicies: [] };
}

function slugify(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

export class JsonStore {
  #file;
  #backend;
  #actor;
  #tail = Promise.resolve();
  #recovered = false;
  #corruptOriginal = null;

  constructor(file = resolve('data/rulecanvas.json'), backend = null, { actor = 'local workspace' } = {}) {
    if (backend !== null && (typeof backend.read !== 'function' || typeof backend.transact !== 'function')) {
      throw new TypeError('Workspace storage requires a read and transact backend.');
    }
    this.#file = file;
    this.#backend = backend;
    this.#actor = actor;
  }

  async #read() {
    if (this.#backend) return parseWorkspace(await this.#backend.read());
    let contents;
    try {
      contents = await readFile(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return parseWorkspace(null);
      throw error;
    }
    try {
      return parseStoreContents(contents);
    } catch (error) {
      if (!(error instanceof StoreError) || error.code !== 'storage.corrupt') throw error;
      try {
        const backup = await readFile(`${this.#file}.bak`, 'utf8');
        const restored = parseStoreContents(backup);
        this.#recovered = true;
        this.#corruptOriginal = contents;
        return restored;
      } catch (backupError) {
        if (backupError.code === 'ENOENT') {
          throw new StoreError('Local workspace JSON is damaged and no recovery checkpoint exists. The files were left untouched.', 503, 'storage.corrupt');
        }
        if (backupError instanceof StoreError && backupError.code === 'storage.corrupt') {
          throw new StoreError('Local workspace JSON and its recovery checkpoint are damaged. The files were left untouched.', 503, 'storage.corrupt');
        }
        throw backupError;
      }
    }
  }

  async #write(data) {
    await mkdir(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
    if (this.#recovered && this.#corruptOriginal !== null) {
      const preserved = `${this.#file}.corrupt-${Date.now()}-${randomUUID()}`;
      try {
        await writeFile(preserved, this.#corruptOriginal, { flag: 'wx' });
      } catch {
        throw new StoreError('Could not preserve the damaged workspace file; recovery was not written.', 503, 'storage.preserve_failed');
      }
    }
    if (!this.#recovered) {
      try {
        const previous = await readFile(this.#file);
        const backupTemporary = `${this.#file}.${process.pid}.${randomUUID()}.bak.tmp`;
        await writeFile(backupTemporary, previous, { flag: 'wx' });
        await rename(backupTemporary, `${this.#file}.bak`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await rename(temporary, this.#file);
    this.#recovered = false;
    this.#corruptOriginal = null;
  }

  wasRecovered() { return this.#recovered; }

  async #transact(operation) {
    if (this.#backend) {
      return this.#backend.transact(async (contents) => {
        const data = parseWorkspace(contents);
        const value = await operation(data);
        return { contents: JSON.stringify(data), value };
      });
    }
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolveTail) => { release = resolveTail; });
    await previous;
    try {
      const data = await this.#read();
      const result = await operation(data);
      await this.#write(data);
      return result;
    } finally {
      release();
    }
  }

  async listProjects() {
    const data = await this.#read();
    return data.projects.map((project) => ({
      ...project,
      rulesetCount: data.rulesets.filter((ruleset) => ruleset.projectId === project.id).length,
    }));
  }

  async getProject(projectId) {
    const data = await this.#read();
    const project = data.projects.find((item) => item.id === projectId);
    if (!project) throw new StoreError('Project not found.', 404, 'project.not_found');
    const rulesets = data.rulesets.filter((item) => item.projectId === projectId).map((ruleset) => {
      const versions = data.versions.filter((version) => version.rulesetId === ruleset.id).sort((a, b) => b.versionNumber - a.versionNumber);
      return { ...ruleset, versionCount: versions.length, latestVersionNumber: versions[0]?.versionNumber ?? null };
    });
    return { ...project, rulesets };
  }

  async createProject(name) {
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    if (!normalizedName || normalizedName.length > 80) {
      throw new StoreError('Project name must be between 1 and 80 characters.', 422, 'project.name');
    }
    return this.#transact((data) => {
      const baseSlug = slugify(normalizedName);
      if (!baseSlug) throw new StoreError('Project name needs at least one letter or number.', 422, 'project.slug');
      let slug = baseSlug;
      let suffix = 2;
      while (data.projects.some((project) => project.slug === slug)) slug = `${baseSlug}-${suffix++}`;
      const project = {
        id: randomUUID(),
        slug,
        name: normalizedName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      data.projects.push(project);
      addAuditEvent(data, this.#actor, { projectId: project.id, type: 'project.created', details: { slug: project.slug } });
      return project;
    });
  }

  async createGuidedExample() {
    return this.#transact((data) => {
      const existingEvent = data.auditEvents.find((event) =>
        event.type === 'project.created' && event.details?.exampleKey === GUIDED_EXAMPLE_KEY
      );
      if (existingEvent) {
        const project = data.projects.find((item) => item.id === existingEvent.projectId);
        const ruleset = data.rulesets.find((item) => item.projectId === existingEvent.projectId);
        if (project && ruleset) return { project, ruleset, created: false };
        throw new StoreError('The saved guided example is incomplete.', 503, 'example.incomplete');
      }

      const projectName = 'Eligibility Example';
      const baseSlug = slugify(projectName);
      let slug = baseSlug;
      let suffix = 2;
      while (data.projects.some((project) => project.slug === slug)) slug = `${baseSlug}-${suffix++}`;
      const now = new Date().toISOString();
      const project = {
        id: randomUUID(),
        slug,
        name: projectName,
        createdAt: now,
        updatedAt: now,
      };
      const graph = createEligibilityExampleGraph();
      const validation = validateGraph(graph);
      if (!validation.valid) {
        throw new StoreError('The built-in guided example is invalid.', 500, 'example.invalid', { errors: validation.errors });
      }
      const ruleset = {
        id: randomUUID(),
        projectId: project.id,
        name: 'Score eligibility',
        revision: 1,
        status: 'draft',
        graph,
        createdAt: now,
        updatedAt: now,
      };
      data.projects.push(project);
      data.rulesets.push(ruleset);
      addAuditEvent(data, this.#actor, { projectId: project.id, type: 'project.created', details: { slug, exampleKey: GUIDED_EXAMPLE_KEY } });
      addAuditEvent(data, this.#actor, { projectId: project.id, rulesetId: ruleset.id, type: 'ruleset.created', details: { name: ruleset.name, exampleKey: GUIDED_EXAMPLE_KEY } });
      return { project, ruleset, created: true };
    });
  }

  async getRuleset(rulesetId) {
    const data = await this.#read();
    const ruleset = data.rulesets.find((item) => item.id === rulesetId);
    if (!ruleset) throw new StoreError('Ruleset not found.', 404, 'ruleset.not_found');
    return ruleset;
  }

  async createRuleset(projectId, name) {
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    if (!normalizedName || normalizedName.length > 80) {
      throw new StoreError('Ruleset name must be between 1 and 80 characters.', 422, 'ruleset.name');
    }
    return this.#transact((data) => {
      if (!data.projects.some((project) => project.id === projectId)) {
        throw new StoreError('Project not found.', 404, 'project.not_found');
      }
      const ruleset = {
        id: randomUUID(),
        projectId,
        name: normalizedName,
        revision: 1,
        status: 'draft',
        graph: createStarterGraph(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      data.rulesets.push(ruleset);
      const project = data.projects.find((item) => item.id === projectId);
      project.updatedAt = new Date().toISOString();
      addAuditEvent(data, this.#actor, { projectId, rulesetId: ruleset.id, type: 'ruleset.created', details: { name: normalizedName } });
      return ruleset;
    });
  }

  async saveRuleset(rulesetId, expectedRevision, graph, name) {
    return this.#transact((data) => {
      const ruleset = data.rulesets.find((item) => item.id === rulesetId);
      if (!ruleset) throw new StoreError('Ruleset not found.', 404, 'ruleset.not_found');
      if (expectedRevision !== ruleset.revision) {
        throw new StoreError('This draft changed elsewhere. Reload it before saving again.', 409, 'ruleset.conflict');
      }
      if (!graph || typeof graph !== 'object' || !Array.isArray(graph.schema) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        throw new StoreError('Draft graph must include schema, nodes, and edges lists.', 422, 'ruleset.graph');
      }
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
        throw new StoreError('Ruleset name must be between 1 and 80 characters.', 422, 'ruleset.name');
      }
      ruleset.graph = structuredClone(graph);
      ruleset.name = name.trim();
      ruleset.revision++;
      ruleset.status = 'draft';
      ruleset.updatedAt = new Date().toISOString();
      const project = data.projects.find((item) => item.id === ruleset.projectId);
      if (project) project.updatedAt = ruleset.updatedAt;
      addAuditEvent(data, this.#actor, { projectId: ruleset.projectId, rulesetId, type: 'ruleset.draft.saved', details: { revision: ruleset.revision } });
      return ruleset;
    });
  }

  async listVersions(rulesetId) {
    const data = await this.#read();
    if (!data.rulesets.some((item) => item.id === rulesetId)) throw new StoreError('Ruleset not found.', 404, 'ruleset.not_found');
    const versions = data.versions
      .filter((version) => version.rulesetId === rulesetId)
      .sort((a, b) => b.versionNumber - a.versionNumber);
    versions.forEach(assertVersionIntegrity);
    return versions.map(({ graph, ...summary }) => summary);
  }

  async getVersion(rulesetId, versionId) {
    const data = await this.#read();
    const version = data.versions.find((item) => item.rulesetId === rulesetId && item.id === versionId);
    if (!version) throw new StoreError('Published version not found.', 404, 'version.not_found');
    assertVersionIntegrity(version);
    return version;
  }

  async createVersion(rulesetId, expectedRevision) {
    return this.#transact((data) => {
      const ruleset = data.rulesets.find((item) => item.id === rulesetId);
      if (!ruleset) throw new StoreError('Ruleset not found.', 404, 'ruleset.not_found');
      if (expectedRevision !== ruleset.revision) {
        throw new StoreError('This draft changed elsewhere. Reload it before creating a version.', 409, 'ruleset.conflict');
      }
      const validation = validateGraph(ruleset.graph);
      if (!validation.valid) {
        throw new StoreError('Only a valid graph can be saved as an immutable version.', 422, 'version.validation', { errors: validation.errors });
      }
      const graphJson = JSON.stringify(ruleset.graph);
      const graphHash = createHash('sha256').update(graphJson).digest('hex');
      const existing = data.versions.filter((version) => version.rulesetId === rulesetId).sort((a, b) => b.versionNumber - a.versionNumber)[0];
      if (existing?.graphHash === graphHash) {
        throw new StoreError('This graph is already the latest saved version.', 409, 'version.unchanged');
      }
      const version = {
        id: randomUUID(),
        rulesetId,
        projectId: ruleset.projectId,
        versionNumber: (existing?.versionNumber ?? 0) + 1,
        sourceRevision: ruleset.revision,
        name: ruleset.name,
        graph: structuredClone(ruleset.graph),
        graphHash,
        createdAt: new Date().toISOString(),
      };
      data.versions.push(version);
      ruleset.status = 'versioned';
      ruleset.latestVersionId = version.id;
      ruleset.updatedAt = version.createdAt;
      const project = data.projects.find((item) => item.id === ruleset.projectId);
      if (project) project.updatedAt = version.createdAt;
      addAuditEvent(data, this.#actor, { projectId: ruleset.projectId, rulesetId, type: 'ruleset.version.created', details: { versionNumber: version.versionNumber, sourceRevision: version.sourceRevision, graphHash } });
      return version;
    });
  }

  async listAuditEvents(projectId, rulesetId = null) {
    const data = await this.#read();
    if (!data.projects.some((item) => item.id === projectId)) throw new StoreError('Project not found.', 404, 'project.not_found');
    const projectRules = new Map(data.rulesets
      .filter((rule) => rule.projectId === projectId && (!rulesetId || rule.id === rulesetId))
      .map((rule) => [rule.id, rule]));
    const releaseEvents = [];
    for (const policy of data.releasePolicies) {
      const rule = projectRules.get(policy.rulesetId);
      if (!rule) continue;
      for (const event of policy.state.auditTrail) {
        releaseEvents.push({
          id: `release-${rule.id}-${event.id}`,
          projectId,
          rulesetId: rule.id,
          actor: event.actorId,
          type: `release.${event.action}`,
          occurredAt: event.timestamp,
          details: {
            name: rule.name,
            environment: event.environment,
            versionId: event.versionId,
            rationale: event.rationale,
          },
        });
      }
    }
    const projectEvents = data.auditEvents.filter((event) =>
      event.projectId === projectId && (!rulesetId || event.rulesetId === rulesetId));
    return [...projectEvents, ...releaseEvents].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }

  async getReleasePolicy(rulesetId) {
    const data = await this.#read();
    if (!data.rulesets.some((item) => item.id === rulesetId)) throw new StoreError('Ruleset not found.', 404, 'ruleset.not_found');
    return data.releasePolicies.find((item) => item.rulesetId === rulesetId)?.state ?? createReleasePolicyState();
  }

  async getActiveReleaseVersion(rulesetId, environment) {
    const data = await this.#read();
    const ruleset = data.rulesets.find((item) => item.id === rulesetId);
    if (!ruleset) throw new StoreError('Ruleset not found.', 404, 'ruleset.not_found');
    const state = data.releasePolicies.find((item) => item.rulesetId === rulesetId)?.state ?? createReleasePolicyState();
    const deployment = getDeployment(state, rulesetId, environment);
    if (!deployment) throw new StoreError('No version is active in this environment.', 404, 'release.inactive');
    const version = data.versions.find((item) => item.id === deployment.versionId && item.rulesetId === rulesetId && item.projectId === ruleset.projectId);
    const release = getRelease(state, rulesetId, deployment.versionId);
    if (!version || release?.status !== 'approved' || release.graphHash !== version.graphHash || deployment.versionHash !== version.graphHash) {
      throw new StoreError('Active version record could not be verified.', 409, 'release.integrity');
    }
    assertVersionIntegrity(version);
    return version;
  }

  async transitionReleasePolicy({ action, rulesetId, versionId, versionHash, environment, expectedActiveVersionId, rationale, actor }) {
    const transition = releaseTransitions.get(action);
    if (!transition) throw new StoreError('Unknown release action.', 422, 'release.action');

    return this.#transact((data) => {
      const ruleset = data.rulesets.find((item) => item.id === rulesetId);
      if (!ruleset) throw new StoreError('Ruleset not found.', 404, 'ruleset.not_found');
      const version = data.versions.find((item) => item.id === versionId && item.rulesetId === rulesetId && item.projectId === ruleset.projectId);
      if (!version) throw new StoreError('Saved version not found.', 404, 'version.not_found');
      assertVersionIntegrity(version);
      if (versionHash !== version.graphHash) throw new StoreError('The saved version hash does not match the requested release.', 409, 'release.hash_mismatch');

      const existing = data.releasePolicies.find((item) => item.rulesetId === rulesetId);
      const state = transition(existing?.state ?? createReleasePolicyState(), {
        version, rulesetId, versionId, versionHash, environment, expectedActiveVersionId, rationale, actor,
        timestamp: new Date().toISOString(),
      });
      if (existing) existing.state = state;
      else data.releasePolicies.push({ rulesetId, state });
      return state;
    });
  }

  async recordEvaluationRun({ projectId, rulesetId, revision, versionId = null, versionNumber = null, ok, outcomeId = null, outcomeLabel = null, errorCode = null }) {
    return this.#transact((data) => {
      const ruleset = data.rulesets.find((item) => item.id === rulesetId && item.projectId === projectId);
      if (!ruleset) throw new StoreError('Ruleset not found in this project.', 404, 'ruleset.not_found');
      if (!Number.isInteger(revision) || revision < 1 || typeof ok !== 'boolean') {
        throw new StoreError('Evaluation run metadata is invalid.', 422, 'evaluation.run_shape');
      }
      if (versionId !== null) {
        const version = data.versions.find((item) => item.id === versionId && item.rulesetId === rulesetId && item.projectId === projectId);
        if (!version || version.versionNumber !== versionNumber || version.sourceRevision !== revision) {
          throw new StoreError('Evaluation version metadata is inconsistent.', 409, 'evaluation.version_mismatch');
        }
      } else if (versionNumber !== null) {
        throw new StoreError('Draft runs cannot include a version number.', 422, 'evaluation.run_shape');
      }

      const run = {
        id: randomUUID(),
        projectId,
        rulesetId,
        revision,
        versionId,
        versionNumber,
        ok,
        ...(ok
          ? { ...(outcomeId ? { outcomeId } : {}), ...(outcomeLabel ? { outcomeLabel } : {}) }
          : { error: { code: typeof errorCode === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(errorCode) ? errorCode : 'evaluation.failed' } }),
        createdAt: new Date().toISOString(),
      };
      data.evaluationRuns.push(run);
      const projectRuns = data.evaluationRuns
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.projectId === projectId)
        .sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt) || b.index - a.index);
      const retainedIds = new Set(projectRuns.slice(0, MAX_EVALUATION_RUNS_PER_PROJECT).map(({ item }) => item.id));
      data.evaluationRuns = data.evaluationRuns.filter((item) => item.projectId !== projectId || retainedIds.has(item.id));
      return run;
    });
  }

  async listEvaluationRuns(projectId) {
    const data = await this.#read();
    if (!data.projects.some((item) => item.id === projectId)) throw new StoreError('Project not found.', 404, 'project.not_found');
    return data.evaluationRuns
      .map((run, index) => ({ run, index }))
      .filter(({ run }) => run.projectId === projectId)
      .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt) || b.index - a.index)
      .slice(0, MAX_EVALUATION_RUNS_PER_PROJECT)
      .map(({ run }) => run);
  }
}
