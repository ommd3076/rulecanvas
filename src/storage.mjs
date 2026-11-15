import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createStarterGraph } from './rule-engine.mjs';

export class StoreError extends Error {
  constructor(message, status = 400, code = 'store.error') {
    super(message);
    this.status = status;
    this.code = code;
  }
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

  constructor(file = resolve('data/rulecanvas.json')) {
    this.#file = file;
  }

  async #read() {
    try {
      return JSON.parse(await readFile(this.#file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { projects: [], rulesets: [] };
      throw error;
    }
  }

  async #write(data) {
    await mkdir(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.#file);
  }

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
    return { ...project, rulesets: data.rulesets.filter((item) => item.projectId === projectId) };
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
      ruleset.updatedAt = new Date().toISOString();
      return ruleset;
    });
  }
}
