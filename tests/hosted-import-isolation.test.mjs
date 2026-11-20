import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createHostedMembership } from '../src/hosted-membership.mjs';
import { createRuleCanvasServer } from '../src/server.mjs';
import { JsonStore } from '../src/storage.mjs';

test('hosted legacy imports and duplicated drafts stay within signed tenant and role boundaries', async (t) => {
  const secret = Buffer.alloc(32, 7);
  const issuer = 'test-proxy';
  const roles = new Map([['author-a', ['author']], ['admin-a', ['admin']], ['reviewer-a', ['reviewer']], ['author-b', ['author']]]);
  const tenantFor = (subject) => subject.endsWith('-a') ? 'tenant-a' : 'tenant-b';
  const contents = new Map();
  const membership = createHostedMembership({
    pool: { query: async (_sql, [tenant, actualIssuer, subject]) => ({ rows: roles.has(subject) && tenantFor(subject) === tenant && actualIssuer === issuer
      ? [{ tenant_id: tenant, issuer, subject, enabled: true, roles: roles.get(subject) }] : [] }) },
    storeForTenant: (tenant, actor) => new JsonStore(null, {
      read: async () => contents.get(tenant) ?? null,
      transact: async (change) => { const result = await change(contents.get(tenant) ?? null); contents.set(tenant, result.contents); return result.value; },
    }, { actor }),
  });
  const server = createRuleCanvasServer({ hosted: { assertion: { secret, issuer, audience: 'rulecanvas', now: 100, requireTenant: true }, ...membership } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = (subject) => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const message = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: issuer, aud: 'rulecanvas', sub: subject, tenant: tenantFor(subject), iat: 90, exp: 120 })}`;
    return `${message}.${createHmac('sha256', secret).update(message).digest('base64url')}`;
  };
  const request = (subject, path, body) => fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-rulecanvas-assertion': token(subject), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const schema = [{ id: 'score-id', key: 'score', type: 'number', required: true }];
  const nodes = [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, nextNodeId: 'pass' },
    { id: 'pass', type: 'outcome', position: { x: 100, y: 0 }, title: 'Pass', outcomeCode: 'PASS' },
  ];
  const envelope = { format: 'RuleCanvas.by.ENNORM.ProjectExport.v1', project: { name: 'Synthetic import', schema, nodes, versions: [], testScenarios: [], auditLog: [] } };
  assert.equal((await request('reviewer-a', '/api/projects/import-legacy', { envelope, confirm: true })).status, 403);
  const created = await request('author-a', '/api/projects/import-legacy', { envelope, confirm: true });
  assert.equal(created.status, 201);
  const { project, ruleset } = await created.json();
  assert.equal((await request('author-a', `/api/projects/${project.id}/legacy-source`)).status, 403);
  assert.deepEqual((await (await request('admin-a', `/api/projects/${project.id}/legacy-source`)).json()).source, envelope);
  assert.equal((await request('author-b', `/api/projects/${project.id}/legacy-source`)).status, 403);
  assert.equal((await request('reviewer-a', `/api/rulesets/${ruleset.id}/duplicate`, {})).status, 403);
  assert.equal((await request('author-b', `/api/rulesets/${ruleset.id}/duplicate`, {})).status, 404);
  const copy = await request('author-a', `/api/rulesets/${ruleset.id}/duplicate`, {});
  assert.equal(copy.status, 201);
  assert.equal((await copy.json()).ruleset.projectId, project.id);
  assert.deepEqual((await (await request('author-b', '/api/projects')).json()).projects, []);
});
