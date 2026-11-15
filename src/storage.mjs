import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createStarterGraph, validateGraph } from './rule-engine.mjs';

export class StoreError extends Error {
  constructor(message, status = 400, code = 'store.error', details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function addAuditEvent(data, { projectId, rulesetId = null, type, details = {} }) {
  data.auditEvents.push({
    id: randomUUID(), projectId, rulesetId, actor: 'local workspace', type,
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
  for (const key of ['projects', 'rulesets', 'versions', 'auditEvents']) {
    if (stored[key] !== undefined && !Array.isArray(stored[key])) {
      throw new StoreError(`Local workspace ${key} data has an invalid shape.`, 503, 'storage.corrupt');
    }
  }
  return {
    projects: stored.projects ?? [],
    rulesets: stored.rulesets ?? [],
    versions: stored.versions ?? [],
    auditEvents: stored.auditEvents ?? [],
  };
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
  #tail = Promise.resolve();
  #recovered = false;
  #corruptOriginal = null;

  constructor(file = resolve('data/rulecanvas.json')) {
    this.#file = file;
  }

  async #read() {
    let contents;
    try {
      contents = await readFile(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { projects: [], rulesets: [], versions: [], auditEvents: [] };
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
      addAuditEvent(data, { projectId: project.id, type: 'project.created', details: { slug: project.slug } });
      return project;
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
      addAuditEvent(data, { projectId, rulesetId: ruleset.id, type: 'ruleset.created', details: { name: normalizedName } });
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
      addAuditEvent(data, { projectId: ruleset.projectId, rulesetId, type: 'ruleset.draft.saved', details: { revision: ruleset.revision } });
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
      addAuditEvent(data, { projectId: ruleset.projectId, rulesetId, type: 'ruleset.version.created', details: { versionNumber: version.versionNumber, sourceRevision: version.sourceRevision, graphHash } });
      return version;
    });
  }

  async listAuditEvents(projectId, rulesetId = null) {
    const data = await this.#read();
    if (!data.projects.some((item) => item.id === projectId)) throw new StoreError('Project not found.', 404, 'project.not_found');
    return data.auditEvents
      .filter((event) => event.projectId === projectId && (!rulesetId || event.rulesetId === rulesetId))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }
}
