import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGraph, validateGraph } from './rule-engine.mjs';
import { JsonStore, StoreError } from './storage.mjs';
import { HostedAuthError, verifyRequestAssertion } from './hosted-auth.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distDirectory = resolve(root, 'dist');
const publicDirectory = resolve(root, 'public');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const MAX_BODY_BYTES = 1_000_000;

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function persistEvaluationRun(store, graph, result, metadata) {
  const outcomeNode = result.outcomeId
    ? graph.nodes.find((node) => node.id === result.outcomeId && node.type === 'outcome')
    : null;
  return store.recordEvaluationRun({
    ...metadata,
    ok: result.ok === true,
    outcomeId: outcomeNode?.id ?? null,
    outcomeLabel: outcomeNode?.label ?? null,
    errorCode: result.ok === true ? null : result.errors?.[0]?.code,
  });
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new StoreError('Request body is too large.', 413, 'request.too_large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text ? JSON.parse(text) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          reject(new StoreError('Request body must be a JSON object.', 400, 'request.shape'));
          return;
        }
        resolveBody(body);
      } catch {
        reject(new StoreError('Request body must be valid JSON.', 400, 'request.json'));
      }
    });
    request.on('error', reject);
  });
}

async function serveAppShell(response) {
  const distIndex = resolve(distDirectory, 'index.html');
  try {
    const contents = await readFile(distIndex);
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    response.end(contents);
    return;
  } catch {}

  const publicIndex = resolve(publicDirectory, 'index.html');
  try {
    const contents = await readFile(publicIndex);
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    response.end(contents);
  } catch (error) {
    sendJson(response, 500, { error: { code: 'server.error', message: 'App shell not found.' } });
  }
}

function isScreenRoute(pathname, rawUrl = '') {
  if (pathname.startsWith('/api/')) return false;
  if (extname(pathname)) return false;
  // Disallow directory traversal in screen routes
  if (
    pathname.includes('..') ||
    /%2e%2e/i.test(pathname) ||
    rawUrl.includes('..') ||
    /%2e%2e/i.test(rawUrl)
  ) {
    return false;
  }
  return pathname === '/' || pathname === '/projects' || pathname.startsWith('/projects/');
}

async function serveStatic(pathname, response, rawUrl = '') {
  if (isScreenRoute(pathname, rawUrl)) {
    await serveAppShell(response);
    return;
  }
  let relative;
  try {
    relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  } catch {
    sendJson(response, 400, { error: { code: 'static.malformed_uri', message: 'Malformed URI encoding.' } });
    return;
  }
  const distFile = resolve(distDirectory, relative);
  if (distFile === distDirectory || distFile.startsWith(`${distDirectory}${sep}`)) {
    try {
      const contents = await readFile(distFile);
      response.writeHead(200, {
        'Content-Type': MIME_TYPES[extname(distFile)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      response.end(contents);
      return;
    } catch {}
  }
  const file = resolve(publicDirectory, relative);
  if (file !== publicDirectory && !file.startsWith(`${publicDirectory}${sep}`)) {
    sendJson(response, 404, { error: { code: 'static.not_found', message: 'Not found.' } });
    return;
  }
  try {
    const contents = await readFile(file);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    response.end(contents);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      sendJson(response, 404, { error: { code: 'static.not_found', message: 'Not found.' } });
      return;
    }
    throw error;
  }
}

export function createRuleCanvasServer({ store: localStore, hosted } = {}) {
  if (hosted !== undefined && (localStore || typeof hosted?.resolveAuthorizedStore !== 'function' || !hosted.assertion)) {
    throw new TypeError('Hosted mode requires assertion configuration and an authorized store resolver.');
  }
  if (hosted === undefined) localStore ??= new JsonStore();
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    let url;
    try {
      url = new URL(request.url, 'http://127.0.0.1');
    } catch {
      await serveAppShell(response);
      return;
    }
    const method = request.method;
    try {
      let store = localStore;
      if (hosted && (url.pathname === '/api' || url.pathname.startsWith('/api/'))) {
        const principal = verifyRequestAssertion(request, hosted.assertion);
        store = await hosted.resolveAuthorizedStore({ principal, method, pathname: url.pathname });
        if (!store) throw new HostedAuthError('auth.denied', 403);
      }
      if (url.pathname === '/api/health' && method === 'GET') {
        sendJson(response, 200, { ok: true, storage: 'local-json', recovered: store.wasRecovered?.() ?? false });
        return;
      }
      if (url.pathname === '/api/projects' && method === 'GET') {
        sendJson(response, 200, { projects: await store.listProjects() });
        return;
      }
      if (url.pathname === '/api/examples/eligibility' && method === 'POST') {
        const result = await store.createGuidedExample();
        sendJson(response, result.created ? 201 : 200, result);
        return;
      }
      if (url.pathname === '/api/projects' && method === 'POST') {
        const body = await readBody(request);
        sendJson(response, 201, { project: await store.createProject(body.name) });
        return;
      }
      let match = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)$/i);
      if (match && method === 'GET') {
        sendJson(response, 200, { project: await store.getProject(match[1]) });
        return;
      }
      match = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/rulesets$/i);
      if (match && method === 'POST') {
        const body = await readBody(request);
        sendJson(response, 201, { ruleset: await store.createRuleset(match[1], body.name) });
        return;
      }
      match = url.pathname.match(/^\/api\/rulesets\/([0-9a-f-]+)$/i);
      if (match && method === 'GET') {
        sendJson(response, 200, { ruleset: await store.getRuleset(match[1]) });
        return;
      }
      if (match && method === 'PUT') {
        const body = await readBody(request);
        const ruleset = await store.saveRuleset(match[1], body.expectedRevision, body.graph, body.name);
        sendJson(response, 200, { ruleset });
        return;
      }
      match = url.pathname.match(/^\/api\/rulesets\/([0-9a-f-]+)\/versions$/i);
      if (match && method === 'GET') {
        sendJson(response, 200, { versions: await store.listVersions(match[1]) });
        return;
      }
      if (match && method === 'POST') {
        const body = await readBody(request);
        sendJson(response, 201, { version: await store.createVersion(match[1], body.expectedRevision) });
        return;
      }
      match = url.pathname.match(/^\/api\/rulesets\/([0-9a-f-]+)\/versions\/([0-9a-f-]+)(?:\/(evaluate))?$/i);
      if (match && method === 'GET' && !match[3]) {
        sendJson(response, 200, { version: await store.getVersion(match[1], match[2]) });
        return;
      }
      if (match && method === 'POST' && match[3] === 'evaluate') {
        const version = await store.getVersion(match[1], match[2]);
        const body = await readBody(request);
        const result = evaluateGraph(version.graph, body.input);
        await persistEvaluationRun(store, version.graph, result, {
          projectId: version.projectId,
          rulesetId: version.rulesetId,
          revision: version.sourceRevision,
          versionId: version.id,
          versionNumber: version.versionNumber,
        });
        sendJson(response, 200, { version: { id: version.id, versionNumber: version.versionNumber, graphHash: version.graphHash }, ...result });
        return;
      }
      match = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/runs$/i);
      if (match && method === 'GET') {
        sendJson(response, 200, { runs: await store.listEvaluationRuns(match[1]) });
        return;
      }
      match = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/audit$/i);
      if (match && method === 'GET') {
        sendJson(response, 200, { events: await store.listAuditEvents(match[1]) });
        return;
      }
      match = url.pathname.match(/^\/api\/rulesets\/([0-9a-f-]+)\/(validate|evaluate)$/i);
      if (match && method === 'POST') {
        const body = await readBody(request);
        const ruleset = await store.getRuleset(match[1]);
        if (match[2] === 'validate') {
          sendJson(response, 200, validateGraph(body.graph ?? ruleset.graph));
          return;
        }
        if (body.expectedRevision !== undefined && body.expectedRevision !== ruleset.revision) {
          throw new StoreError('The saved draft changed. Reload the rule set before running the test again.', 409, 'evaluation.revision_conflict');
        }
        const result = evaluateGraph(ruleset.graph, body.input);
        await persistEvaluationRun(store, ruleset.graph, result, {
          projectId: ruleset.projectId,
          rulesetId: ruleset.id,
          revision: ruleset.revision,
        });
        sendJson(response, 200, result);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: { code: 'api.not_found', message: 'API route not found.' } });
        return;
      }
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(response, 405, { error: { code: 'method.not_allowed', message: 'Method not allowed.' } });
        return;
      }
      await serveStatic(url.pathname, response, request.url);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof HostedAuthError) {
        const status = error.status;
        const code = status === 401 ? 'auth.required' : status === 403 ? 'auth.denied' : 'server.error';
        const message = status === 401 ? 'Authentication required.' : status === 403 ? 'Access denied.' : 'The request could not be completed.';
        sendJson(response, status, { error: { code, message } });
        return;
      }
      const isMalformed = error instanceof URIError || error.code === 'ERR_INVALID_URL';
      const status = error instanceof StoreError ? error.status : (isMalformed ? 400 : 500);
      sendJson(response, status, {
        error: {
          code: error instanceof StoreError ? error.code : (isMalformed ? 'request.malformed_uri' : 'server.error'),
          message: error instanceof StoreError ? error.message : (isMalformed ? 'Malformed URI encoding.' : 'The request could not be completed.'),
          ...(error instanceof StoreError && error.details ? { details: error.details } : {}),
        },
      });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4178);
  const host = process.env.HOST ?? '127.0.0.1';
  const dataFile = process.env.RULECANVAS_DATA_FILE ?? resolve(root, 'data/rulecanvas.json');
  const server = createRuleCanvasServer({ store: new JsonStore(dataFile) });
  server.listen(port, host, () => {
    process.stdout.write(`RuleCanvas listening on http://${host}:${port}\n`);
  });
}
