import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRuleCanvasServer } from '../src/server.mjs';
import { createHostedMembership } from '../src/hosted-membership.mjs';
import { createHostedTeam } from '../src/hosted-team.mjs';

const secret = Buffer.alloc(32, 73);
const issuer = 'https://auth.example.test';
const audience = 'rulecanvas';
const defaultTenant = 'tenant-test-1';

function key(tenantId, iss, subject) {
  return `${tenantId}\u0000${iss}\u0000${subject}`;
}

function makePool(initialRows = []) {
  const rows = new Map(initialRows.map((row) => [key(row.tenant_id, row.issuer, row.subject), structuredClone(row)]));
  const queries = [];
  const audits = [];
  const rowLocks = new Map();
  let failAudit = false;
  let auditId = 0;
  let transactionCount = 0;

  async function acquireLock(lockKey, tx) {
    while (rowLocks.has(lockKey)) {
      const current = rowLocks.get(lockKey);
      if (current.tx === tx) return () => {};
      await current.promise;
    }
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    rowLocks.set(lockKey, { tx, promise });
    return () => {
      if (rowLocks.get(lockKey)?.tx === tx) {
        rowLocks.delete(lockKey);
        release();
      }
    };
  }

  const pool = {
    rows,
    queries,
    audits,
    setFailAudit(value) { failAudit = value; },
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      queries.push({ tx: 0, sql: normalized, params: structuredClone(params) });

      if (normalized === 'SELECT 1') {
        return { rows: [{ '?column?': 1 }] };
      }

      if (normalized.startsWith('SELECT tenant_id, issuer, subject, roles, enabled FROM public.hosted_tenant_memberships')) {
        const [tenantId, iss, subject] = params;
        const scopedRows = [...rows.values()].filter((row) =>
          row.tenant_id === tenantId && row.issuer === iss && (subject === undefined || row.subject === subject),
        );
        if (normalized.includes('ORDER BY subject')) scopedRows.sort((a, b) => a.subject.localeCompare(b.subject));
        return { rows: scopedRows.map((row) => structuredClone(row)) };
      }

      throw new Error(`Unexpected pool.query: ${normalized}`);
    },
    async connect() {
      transactionCount += 1;
      const tx = transactionCount;
      const stagedRows = new Map();
      const stagedAudits = [];
      const heldLocks = [];

      function releaseAllLocks() {
        while (heldLocks.length > 0) {
          const unlock = heldLocks.pop();
          try { unlock(); } catch {}
        }
      }

      return {
        async query(sql, params = []) {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          queries.push({ tx, sql: normalized, params: structuredClone(params) });

          if (normalized === 'BEGIN') return { rows: [] };

          if (normalized === 'COMMIT') {
            for (const [k, v] of stagedRows) {
              if (v === null) {
                rows.delete(k);
              } else {
                rows.set(k, structuredClone(v));
              }
            }
            stagedRows.clear();
            for (const a of stagedAudits) {
              audits.push(structuredClone(a));
            }
            stagedAudits.length = 0;
            releaseAllLocks();
            return { rows: [] };
          }

          if (normalized === 'ROLLBACK') {
            stagedRows.clear();
            stagedAudits.length = 0;
            releaseAllLocks();
            return { rows: [] };
          }

          if (normalized.startsWith('SELECT tenant_id, issuer, subject, roles, enabled FROM public.hosted_tenant_memberships')) {
            const [tenantId, iss, subject] = params;
            if (normalized.includes('FOR UPDATE') && subject !== undefined) {
              const lockKey = key(tenantId, iss, subject);
              const unlock = await acquireLock(lockKey, tx);
              heldLocks.push(unlock);
            }

            const currentMap = new Map(rows);
            for (const [k, v] of stagedRows) {
              if (v === null) currentMap.delete(k);
              else currentMap.set(k, structuredClone(v));
            }

            const scopedRows = [...currentMap.values()].filter((row) =>
              row.tenant_id === tenantId && row.issuer === iss && (subject === undefined || row.subject === subject),
            );
            if (normalized.includes('ORDER BY subject')) scopedRows.sort((a, b) => a.subject.localeCompare(b.subject));
            return { rows: scopedRows.map((row) => structuredClone(row)) };
          }

          if (normalized.startsWith('INSERT INTO public.hosted_tenant_memberships')) {
            const [tenantId, iss, subject, roles, enabled] = params;
            const rowKey = key(tenantId, iss, subject);
            const exists = (stagedRows.has(rowKey) && stagedRows.get(rowKey) !== null) ||
                           (!stagedRows.has(rowKey) && rows.has(rowKey));
            if (exists) return { rows: [] };
            const row = { tenant_id: tenantId, issuer: iss, subject, roles: [...roles], enabled };
            stagedRows.set(rowKey, structuredClone(row));
            return { rows: [structuredClone(row)] };
          }

          if (normalized.startsWith('UPDATE public.hosted_tenant_memberships')) {
            const [tenantId, iss, subject, roles, enabled] = params;
            const rowKey = key(tenantId, iss, subject);
            const existing = stagedRows.has(rowKey) ? stagedRows.get(rowKey) : rows.get(rowKey);
            if (!existing) return { rows: [] };
            const updated = { tenant_id: tenantId, issuer: iss, subject, roles: [...roles], enabled };
            stagedRows.set(rowKey, updated);
            return { rows: [structuredClone(updated)] };
          }

          if (normalized.startsWith('INSERT INTO public.hosted_team_membership_audit')) {
            if (failAudit) throw new Error('simulated audit insert failure');
            const [tenantId, iss, actor, target, action, beforeRoles, beforeEnabled, afterRoles, afterEnabled] = params;
            const audit = {
              id: String(++auditId),
              tenant_id: tenantId,
              issuer: iss,
              actor_subject: actor,
              target_subject: target,
              action,
              before_roles: beforeRoles ? [...beforeRoles] : null,
              before_enabled: beforeEnabled ?? null,
              after_roles: [...afterRoles],
              after_enabled: afterEnabled,
              created_at: new Date(),
            };
            stagedAudits.push(audit);
            return { rowCount: 1, rows: [] };
          }

          throw new Error(`Unexpected client.query: ${normalized}`);
        },
        release() {
          stagedRows.clear();
          stagedAudits.length = 0;
          releaseAllLocks();
        },
      };
    },
  };

  return pool;
}

function makeAssertion(tenantId, subject, { iss = issuer, aud = audience, customSecret = secret, expOffset = 300, extraClaims = {} } = {}) {
  const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iss,
    aud,
    sub: subject,
    tenant: tenantId,
    iat: now,
    exp: now + expOffset,
    ...extraClaims,
  });
  const signature = createHmac('sha256', customSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function startTestServer(t, { pool, enableTeam = true, hostedOptions = {} } = {}) {
  const membership = createHostedMembership({
    pool,
    storeForTenant: () => ({
      wasRecovered: () => false,
      listProjects: async () => [],
    }),
  });
  const team = enableTeam ? createHostedTeam({ pool }) : undefined;
  const server = createRuleCanvasServer({
    hosted: {
      assertion: { secret, issuer, audience, requireTenant: true },
      storageType: 'postgres',
      checkReadiness: async () => {},
      ...membership,
      ...(team ? { team } : {}),
      ...hostedOptions,
    },
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${port}`;
}

async function request(baseUrl, path, { method = 'GET', token, body, rawBody, headers = {} } = {}) {
  const reqHeaders = { ...headers };
  if (token && !reqHeaders['x-rulecanvas-assertion'] && !reqHeaders['X-RuleCanvas-Assertion'] && !reqHeaders['X-RULECANVAS-ASSERTION']) {
    reqHeaders['x-rulecanvas-assertion'] = token;
  }
  if (body !== undefined || rawBody !== undefined) {
    if (!reqHeaders['content-type'] && !reqHeaders['Content-Type']) {
      reqHeaders['content-type'] = 'application/json';
    }
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: reqHeaders,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, body: json, text };
}

test('no assertion (unauthenticated) requests are rejected with 401', async (t) => {
  const adminRow = {
    tenant_id: defaultTenant, issuer, subject: 'admin-user', roles: ['admin'], enabled: true,
  };
  const pool = makePool([adminRow]);
  const baseUrl = await startTestServer(t, { pool });

  const unauthGet = await request(baseUrl, '/api/team/members');
  assert.equal(unauthGet.status, 401);
  assert.equal(unauthGet.body?.error?.code, 'auth.required');
  assert.equal(unauthGet.body?.error?.message, 'Authentication required.');

  const unauthPost = await request(baseUrl, '/api/team/members', {
    method: 'POST', body: { subject: 'new-member', roles: ['author'] },
  });
  assert.equal(unauthPost.status, 401);
  assert.equal(unauthPost.body?.error?.code, 'auth.required');

  const unauthPatch = await request(baseUrl, '/api/team/members', {
    method: 'PATCH', body: { subject: 'admin-user', expected: { roles: ['admin'], enabled: true }, enabled: false },
  });
  assert.equal(unauthPatch.status, 401);
  assert.equal(unauthPatch.body?.error?.code, 'auth.required');

  const forgedToken = makeAssertion(defaultTenant, 'admin-user', { customSecret: Buffer.alloc(32, 99) });
  const forged = await request(baseUrl, '/api/team/members', { token: forgedToken });
  assert.equal(forged.status, 401);
  assert.equal(forged.body?.error?.code, 'auth.required');

  const expiredToken = makeAssertion(defaultTenant, 'admin-user', { expOffset: -60 });
  const expired = await request(baseUrl, '/api/team/members', { token: expiredToken });
  assert.equal(expired.status, 401);
  assert.equal(expired.body?.error?.code, 'auth.required');

  const noTenantToken = makeAssertion(undefined, 'admin-user');
  const noTenant = await request(baseUrl, '/api/team/members', { token: noTenantToken });
  assert.equal(noTenant.status, 401);
  assert.equal(noTenant.body?.error?.code, 'auth.required');
});

test('authorized admin can view health advertising, list, add, and update members, ignoring caller-supplied scope', async (t) => {
  const adminRow = {
    tenant_id: defaultTenant, issuer, subject: 'admin-user', roles: ['admin'], enabled: true,
  };
  const pool = makePool([adminRow]);
  const baseUrl = await startTestServer(t, { pool });
  const adminToken = makeAssertion(defaultTenant, 'admin-user');

  const health = await request(baseUrl, '/api/health', { token: adminToken });
  assert.equal(health.status, 200);
  assert.equal(health.body?.ok, true);
  assert.equal(health.body?.teamManagement, true);

  const initialList = await request(baseUrl, '/api/team/members', { token: adminToken });
  assert.equal(initialList.status, 200);
  assert.deepEqual(initialList.body, {
    members: [{ subject: 'admin-user', roles: ['admin'], enabled: true }],
  });

  const added = await request(baseUrl, '/api/team/members', {
    method: 'POST',
    token: adminToken,
    body: {
      subject: 'author-alice',
      roles: ['reviewer', 'author'],
      enabled: true,
      tenantId: 'attacker-tenant',
      issuer: 'https://attacker-sso.test',
      actor: 'attacker',
    },
  });
  assert.equal(added.status, 201);
  assert.deepEqual(added.body, {
    member: { subject: 'author-alice', roles: ['author', 'reviewer'], enabled: true },
  });

  const savedKey = key(defaultTenant, issuer, 'author-alice');
  assert.ok(pool.rows.has(savedKey), 'Member must be stored under verified signed tenant and issuer.');
  assert.ok(!pool.rows.has(key('attacker-tenant', issuer, 'author-alice')), 'Caller tenant scope must be ignored.');
  assert.ok(!pool.rows.has(key('attacker-tenant', 'https://attacker-sso.test', 'author-alice')), 'Caller issuer must be ignored.');

  const updatedList = await request(baseUrl, '/api/team/members', { token: adminToken });
  assert.equal(updatedList.status, 200);
  assert.deepEqual(updatedList.body?.members?.map((m) => m.subject), ['admin-user', 'author-alice']);

  const patched = await request(baseUrl, '/api/team/members', {
    method: 'PATCH',
    token: adminToken,
    body: {
      subject: 'author-alice',
      expected: { roles: ['author', 'reviewer'], enabled: true },
      roles: ['runner'],
      enabled: false,
      tenantId: 'attacker-tenant',
    },
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body, {
    member: { subject: 'author-alice', roles: ['runner'], enabled: false },
  });

  assert.equal(pool.audits.length, 2);
  assert.equal(pool.audits[0].action, 'member.created');
  assert.equal(pool.audits[0].target_subject, 'author-alice');
  assert.equal(pool.audits[1].action, 'member.updated');
  assert.equal(pool.audits[1].target_subject, 'author-alice');
  assert.equal(pool.audits[1].after_enabled, false);

  const idempotentPatch = await request(baseUrl, '/api/team/members', {
    method: 'PATCH',
    token: adminToken,
    body: {
      subject: 'author-alice',
      expected: { roles: ['runner'], enabled: false },
      roles: ['runner'],
      enabled: false,
    },
  });
  assert.equal(idempotentPatch.status, 200);
  assert.deepEqual(idempotentPatch.body, {
    member: { subject: 'author-alice', roles: ['runner'], enabled: false },
  });
  assert.equal(pool.audits.length, 2, 'Idempotent update must not write an additional audit row.');
});

test('non-admin principals and disabled admins are denied under existing admin route policy with 403', async (t) => {
  const adminRow = {
    tenant_id: defaultTenant, issuer, subject: 'admin-user', roles: ['admin'], enabled: true,
  };
  const authorRow = {
    tenant_id: defaultTenant, issuer, subject: 'author-user', roles: ['author', 'reviewer'], enabled: true,
  };
  const disabledAdminRow = {
    tenant_id: defaultTenant, issuer, subject: 'disabled-admin', roles: ['admin'], enabled: false,
  };
  const pool = makePool([adminRow, authorRow, disabledAdminRow]);
  const baseUrl = await startTestServer(t, { pool });

  const authorToken = makeAssertion(defaultTenant, 'author-user');

  const authorHealth = await request(baseUrl, '/api/health', { token: authorToken });
  assert.equal(authorHealth.status, 200);
  assert.notEqual(authorHealth.body?.teamManagement, true, 'Non-admin health check must not advertise teamManagement');

  const authorGet = await request(baseUrl, '/api/team/members', { token: authorToken });
  assert.equal(authorGet.status, 403);
  assert.equal(authorGet.body?.error?.code, 'auth.denied');
  assert.equal(authorGet.body?.error?.message, 'Access denied.');

  const authorPost = await request(baseUrl, '/api/team/members', {
    method: 'POST', token: authorToken, body: { subject: 'runner-1', roles: ['runner'] },
  });
  assert.equal(authorPost.status, 403);
  assert.equal(authorPost.body?.error?.code, 'auth.denied');

  const authorPatch = await request(baseUrl, '/api/team/members', {
    method: 'PATCH', token: authorToken,
    body: { subject: 'author-user', expected: { roles: ['author', 'reviewer'], enabled: true }, roles: ['runner'] },
  });
  assert.equal(authorPatch.status, 403);
  assert.equal(authorPatch.body?.error?.code, 'auth.denied');

  const disabledToken = makeAssertion(defaultTenant, 'disabled-admin');
  const disabledHealth = await request(baseUrl, '/api/health', { token: disabledToken });
  assert.equal(disabledHealth.status, 403);
  assert.equal(disabledHealth.body?.error?.code, 'auth.denied');

  const disabledGet = await request(baseUrl, '/api/team/members', { token: disabledToken });
  assert.equal(disabledGet.status, 403);
  assert.equal(disabledGet.body?.error?.code, 'auth.denied');

  const disabledPost = await request(baseUrl, '/api/team/members', {
    method: 'POST', token: disabledToken, body: { subject: 'new-user', roles: ['author'] },
  });
  assert.equal(disabledPost.status, 403);
  assert.equal(disabledPost.body?.error?.code, 'auth.denied');

  const disabledPatch = await request(baseUrl, '/api/team/members', {
    method: 'PATCH', token: disabledToken,
    body: { subject: 'author-user', expected: { roles: ['author', 'reviewer'], enabled: true }, roles: ['runner'] },
  });
  assert.equal(disabledPatch.status, 403);
  assert.equal(disabledPatch.body?.error?.code, 'auth.denied');

  const otherTenantToken = makeAssertion('other-tenant', 'admin-user');
  const otherTenantGet = await request(baseUrl, '/api/team/members', { token: otherTenantToken });
  assert.equal(otherTenantGet.status, 403);

  const otherTenantPost = await request(baseUrl, '/api/team/members', {
    method: 'POST', token: otherTenantToken, body: { subject: 'new-user', roles: ['author'] },
  });
  assert.equal(otherTenantPost.status, 403);

  const otherTenantPatch = await request(baseUrl, '/api/team/members', {
    method: 'PATCH', token: otherTenantToken,
    body: { subject: 'admin-user', expected: { roles: ['admin'], enabled: true }, enabled: false },
  });
  assert.equal(otherTenantPatch.status, 403);

  // Caller-supplied roles and scope in JWT claims are strictly ignored; verified database role governs
  const tamperedAuthorToken = makeAssertion(defaultTenant, 'author-user', {
    extraClaims: { roles: ['admin'], scope: 'admin', role: 'admin' },
  });
  const tamperedGet = await request(baseUrl, '/api/team/members', { token: tamperedAuthorToken });
  assert.equal(tamperedGet.status, 403, 'JWT claims cannot escalate non-admin to admin');
  assert.equal(tamperedGet.body?.error?.code, 'auth.denied');

  const tamperedHealth = await request(baseUrl, '/api/health', { token: tamperedAuthorToken });
  assert.equal(tamperedHealth.status, 200);
  assert.notEqual(tamperedHealth.body?.teamManagement, true, 'JWT claims must not enable teamManagement advertising');

  // Cross-tenant user: admin in tenant-1, but only author in tenant-2
  const crossUserRow1 = {
    tenant_id: 'cross-tenant-1', issuer, subject: 'cross-user', roles: ['admin'], enabled: true,
  };
  const crossUserRow2 = {
    tenant_id: 'cross-tenant-2', issuer, subject: 'cross-user', roles: ['author'], enabled: true,
  };
  const crossPool = makePool([crossUserRow1, crossUserRow2]);
  const crossBaseUrl = await startTestServer(t, { pool: crossPool });

  const crossToken1 = makeAssertion('cross-tenant-1', 'cross-user');
  const crossHealth1 = await request(crossBaseUrl, '/api/health', { token: crossToken1 });
  assert.equal(crossHealth1.status, 200);
  assert.equal(crossHealth1.body?.teamManagement, true, 'Admin in tenant-1 gets teamManagement advertising');
  const crossGet1 = await request(crossBaseUrl, '/api/team/members', { token: crossToken1 });
  assert.equal(crossGet1.status, 200, 'Admin in tenant-1 can list members');

  const crossToken2 = makeAssertion('cross-tenant-2', 'cross-user');
  const crossHealth2 = await request(crossBaseUrl, '/api/health', { token: crossToken2 });
  assert.equal(crossHealth2.status, 200);
  assert.notEqual(crossHealth2.body?.teamManagement, true, 'Author in tenant-2 must NOT get teamManagement advertising');
  const crossGet2 = await request(crossBaseUrl, '/api/team/members', { token: crossToken2 });
  assert.equal(crossGet2.status, 403, 'Author in tenant-2 must be denied team management');
  assert.equal(crossGet2.body?.error?.code, 'auth.denied');
});

test('disabled service preserves local-mode and disabled-hosted behavior with 404', async (t) => {
  const adminRow = {
    tenant_id: defaultTenant, issuer, subject: 'admin-user', roles: ['admin'], enabled: true,
  };
  const pool = makePool([adminRow]);
  const disabledHostedUrl = await startTestServer(t, { pool, enableTeam: false });
  const adminToken = makeAssertion(defaultTenant, 'admin-user');

  const healthDisabled = await request(disabledHostedUrl, '/api/health', { token: adminToken });
  assert.equal(healthDisabled.status, 200);
  assert.notEqual(healthDisabled.body?.teamManagement, true, 'Disabled hosted service must not advertise teamManagement');

  const getDisabled = await request(disabledHostedUrl, '/api/team/members', { token: adminToken });
  assert.equal(getDisabled.status, 404);
  assert.equal(getDisabled.body?.error?.code, 'api.not_found');

  const postDisabled = await request(disabledHostedUrl, '/api/team/members', {
    method: 'POST', token: adminToken, body: { subject: 'new-user', roles: ['author'] },
  });
  assert.equal(postDisabled.status, 404);
  assert.equal(postDisabled.body?.error?.code, 'api.not_found');

  const patchDisabled = await request(disabledHostedUrl, '/api/team/members', {
    method: 'PATCH', token: adminToken, body: { subject: 'admin-user', expected: { roles: ['admin'], enabled: true }, enabled: false },
  });
  assert.equal(patchDisabled.status, 404);
  assert.equal(patchDisabled.body?.error?.code, 'api.not_found');

  const localServer = createRuleCanvasServer();
  await new Promise((resolve, reject) => {
    localServer.once('error', reject);
    localServer.listen(0, '127.0.0.1', resolve);
  });
  const localPort = localServer.address().port;
  t.after(() => new Promise((resolve) => localServer.close(resolve)));
  const localUrl = `http://127.0.0.1:${localPort}`;

  const localHealth = await request(localUrl, '/api/health');
  assert.equal(localHealth.status, 200);
  assert.notEqual(localHealth.body?.teamManagement, true, 'Local mode must not advertise teamManagement');

  const localGet = await request(localUrl, '/api/team/members');
  assert.equal(localGet.status, 404);
  assert.equal(localGet.body?.error?.code, 'api.not_found');

  const localPost = await request(localUrl, '/api/team/members', {
    method: 'POST', body: { subject: 'new-user', roles: ['author'] },
  });
  assert.equal(localPost.status, 404);
  assert.equal(localPost.body?.error?.code, 'api.not_found');

  const localPatch = await request(localUrl, '/api/team/members', {
    method: 'PATCH', body: { subject: 'admin-user', expected: { roles: ['admin'], enabled: true }, enabled: false },
  });
  assert.equal(localPatch.status, 404);
  assert.equal(localPatch.body?.error?.code, 'api.not_found');
});

test('input validation rejects malformed requests and invalid parameters with structured errors', async (t) => {
  const adminRow = {
    tenant_id: defaultTenant, issuer, subject: 'admin-user', roles: ['admin'], enabled: true,
  };
  const existingMember = {
    tenant_id: defaultTenant, issuer, subject: 'existing-author', roles: ['author'], enabled: true,
  };
  const pool = makePool([adminRow, existingMember]);
  const baseUrl = await startTestServer(t, { pool });
  const adminToken = makeAssertion(defaultTenant, 'admin-user');

  const malformedJson = await request(baseUrl, '/api/team/members', {
    method: 'POST', token: adminToken, rawBody: 'not-valid-json{',
  });
  assert.equal(malformedJson.status, 400);
  assert.equal(malformedJson.body?.error?.code, 'request.json');

  const nonObjectJson = await request(baseUrl, '/api/team/members', {
    method: 'POST', token: adminToken, rawBody: '["array-body"]',
  });
  assert.equal(nonObjectJson.status, 400);
  assert.equal(nonObjectJson.body?.error?.code, 'request.shape');

  const emptySubject = await request(baseUrl, '/api/team/members', {
    method: 'POST', token: adminToken, body: { subject: '   ', roles: ['author'] },
  });
  assert.equal(emptySubject.status, 400);
  assert.equal(emptySubject.body?.error?.code, 'team.invalid_subject');

  const invalidRolesEmpty = await request(baseUrl, '/api/team/members', {
    method: 'POST', token: adminToken, body: { subject: 'valid-subject', roles: [] },
  });
  assert.equal(invalidRolesEmpty.status, 400);
  assert.equal(invalidRolesEmpty.body?.error?.code, 'team.invalid_roles');

  const invalidRoleAdmin = await request(baseUrl, '/api/team/members', {
    method: 'POST', token: adminToken, body: { subject: 'valid-subject', roles: ['admin'] },
  });
  assert.equal(invalidRoleAdmin.status, 400);
  assert.equal(invalidRoleAdmin.body?.error?.code, 'team.invalid_roles');

  const unknownRole = await request(baseUrl, '/api/team/members', {
    method: 'POST', token: adminToken, body: { subject: 'valid-subject', roles: ['superuser'] },
  });
  assert.equal(unknownRole.status, 400);
  assert.equal(unknownRole.body?.error?.code, 'team.invalid_roles');

  const invalidEnabled = await request(baseUrl, '/api/team/members', {
    method: 'POST', token: adminToken, body: { subject: 'valid-subject', roles: ['author'], enabled: 'true' },
  });
  assert.equal(invalidEnabled.status, 400);
  assert.equal(invalidEnabled.body?.error?.code, 'team.invalid_enabled');

  const duplicate = await request(baseUrl, '/api/team/members', {
    method: 'POST', token: adminToken, body: { subject: 'existing-author', roles: ['reviewer'] },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body?.error?.code, 'team.member_exists');

  const patchNoExpected = await request(baseUrl, '/api/team/members', {
    method: 'PATCH', token: adminToken, body: { subject: 'existing-author', roles: ['reviewer'] },
  });
  assert.equal(patchNoExpected.status, 400);
  assert.equal(patchNoExpected.body?.error?.code, 'team.expected_state_required');

  const patchEmptyUpdate = await request(baseUrl, '/api/team/members', {
    method: 'PATCH', token: adminToken, body: { subject: 'existing-author', expected: { roles: ['author'], enabled: true } },
  });
  assert.equal(patchEmptyUpdate.status, 400);
  assert.equal(patchEmptyUpdate.body?.error?.code, 'team.empty_update');

  const patchNotFound = await request(baseUrl, '/api/team/members', {
    method: 'PATCH', token: adminToken,
    body: { subject: 'missing-user', expected: { roles: ['author'], enabled: true }, roles: ['reviewer'] },
  });
  assert.equal(patchNotFound.status, 404);
  assert.equal(patchNotFound.body?.error?.code, 'team.member_not_found');

  const patchAdminImmutable = await request(baseUrl, '/api/team/members', {
    method: 'PATCH', token: adminToken,
    body: { subject: 'admin-user', expected: { roles: ['admin'], enabled: true }, roles: ['author'] },
  });
  assert.equal(patchAdminImmutable.status, 409);
  assert.equal(patchAdminImmutable.body?.error?.code, 'team.admin_immutable');

  const patchAdminEscalation = await request(baseUrl, '/api/team/members', {
    method: 'PATCH', token: adminToken,
    body: { subject: 'existing-author', expected: { roles: ['author'], enabled: true }, roles: ['admin'] },
  });
  assert.equal(patchAdminEscalation.status, 400);
  assert.equal(patchAdminEscalation.body?.error?.code, 'team.invalid_roles');

  const duplicateRoles = await request(baseUrl, '/api/team/members', {
    method: 'POST', token: adminToken, body: { subject: 'valid-subject-2', roles: ['author', 'author'] },
  });
  assert.equal(duplicateRoles.status, 400);
  assert.equal(duplicateRoles.body?.error?.code, 'team.invalid_roles');

  const badSubject = await request(baseUrl, '/api/team/members', {
    method: 'POST', token: adminToken, body: { subject: 'bad\nuser', roles: ['author'] },
  });
  assert.equal(badSubject.status, 400);
  assert.equal(badSubject.body?.error?.code, 'team.invalid_subject');

  const oversizedBody = 'x'.repeat(1_000_001);
  const tooLarge = await request(baseUrl, '/api/team/members', {
    method: 'POST', token: adminToken, rawBody: oversizedBody,
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body?.error?.code, 'request.too_large');
});

test('stale conflict returns 409 when expected state does not match current membership snapshot', async (t) => {
  const adminRow = {
    tenant_id: defaultTenant, issuer, subject: 'admin-user', roles: ['admin'], enabled: true,
  };
  const memberRow = {
    tenant_id: defaultTenant, issuer, subject: 'target-user', roles: ['author', 'reviewer'], enabled: true,
  };
  const pool = makePool([adminRow, memberRow]);
  const baseUrl = await startTestServer(t, { pool });
  const adminToken = makeAssertion(defaultTenant, 'admin-user');

  const rolesMismatch = await request(baseUrl, '/api/team/members', {
    method: 'PATCH',
    token: adminToken,
    body: {
      subject: 'target-user',
      expected: { roles: ['author'], enabled: true },
      roles: ['runner'],
    },
  });
  assert.equal(rolesMismatch.status, 409);
  assert.equal(rolesMismatch.body?.error?.code, 'team.member_conflict');

  const enabledMismatch = await request(baseUrl, '/api/team/members', {
    method: 'PATCH',
    token: adminToken,
    body: {
      subject: 'target-user',
      expected: { roles: ['author', 'reviewer'], enabled: false },
      enabled: false,
    },
  });
  assert.equal(enabledMismatch.status, 409);
  assert.equal(enabledMismatch.body?.error?.code, 'team.member_conflict');

  const matchUpdate = await request(baseUrl, '/api/team/members', {
    method: 'PATCH',
    token: adminToken,
    body: {
      subject: 'target-user',
      expected: { roles: ['author', 'reviewer'], enabled: true },
      roles: ['runner'],
    },
  });
  assert.equal(matchUpdate.status, 200);
  assert.deepEqual(matchUpdate.body, {
    member: { subject: 'target-user', roles: ['runner'], enabled: true },
  });

  const repeatWithOldState = await request(baseUrl, '/api/team/members', {
    method: 'PATCH',
    token: adminToken,
    body: {
      subject: 'target-user',
      expected: { roles: ['author', 'reviewer'], enabled: true },
      roles: ['deployer'],
    },
  });
  assert.equal(repeatWithOldState.status, 409);
  assert.equal(repeatWithOldState.body?.error?.code, 'team.member_conflict');
});

test('storage error or audit write failure returns 503 and rolls back mutation over HTTP', async (t) => {
  const adminRow = {
    tenant_id: defaultTenant, issuer, subject: 'admin-user', roles: ['admin'], enabled: true,
  };
  const targetRow = {
    tenant_id: defaultTenant, issuer, subject: 'update-target', roles: ['author'], enabled: true,
  };
  const pool = makePool([adminRow, targetRow]);
  pool.setFailAudit(true);
  const baseUrl = await startTestServer(t, { pool });
  const adminToken = makeAssertion(defaultTenant, 'admin-user');

  const failedAdd = await request(baseUrl, '/api/team/members', {
    method: 'POST',
    token: adminToken,
    body: { subject: 'failing-user', roles: ['author'] },
  });
  assert.equal(failedAdd.status, 503);
  assert.equal(failedAdd.body?.error?.code, 'team.storage_unavailable');
  assert.equal(pool.rows.has(key(defaultTenant, issuer, 'failing-user')), false, 'Failed audit must roll back member insertion.');

  const failedPatch = await request(baseUrl, '/api/team/members', {
    method: 'PATCH',
    token: adminToken,
    body: {
      subject: 'update-target',
      expected: { roles: ['author'], enabled: true },
      roles: ['reviewer'],
      enabled: false,
    },
  });
  assert.equal(failedPatch.status, 503);
  assert.equal(failedPatch.body?.error?.code, 'team.storage_unavailable');
  const targetAfterFailedPatch = pool.rows.get(key(defaultTenant, issuer, 'update-target'));
  assert.deepEqual(targetAfterFailedPatch.roles, ['author'], 'Failed audit must roll back member update roles.');
  assert.equal(targetAfterFailedPatch.enabled, true, 'Failed audit must roll back member update enabled status.');
  assert.equal(pool.audits.length, 0, 'No audit entries should be recorded when transaction rolls back.');

  // Corrupt row in database triggers structured 503 team.membership_invalid
  const corruptPool = makePool([
    adminRow,
    { tenant_id: defaultTenant, issuer, subject: 'corrupt-user', roles: ['malicious-role'], enabled: true },
  ]);
  const corruptUrl = await startTestServer(t, { pool: corruptPool });
  const corruptRes = await request(corruptUrl, '/api/team/members', { token: adminToken });
  assert.equal(corruptRes.status, 503);
  assert.equal(corruptRes.body?.error?.code, 'team.membership_invalid');
  assert.equal(corruptRes.body?.error?.message, 'Team membership request could not be completed.');
});

test('unexpected HTTP methods on /api/team/members are rejected under route policy', async (t) => {
  const adminRow = {
    tenant_id: defaultTenant, issuer, subject: 'admin-user', roles: ['admin'], enabled: true,
  };
  const pool = makePool([adminRow]);
  const baseUrl = await startTestServer(t, { pool });
  const adminToken = makeAssertion(defaultTenant, 'admin-user');

  const putRes = await request(baseUrl, '/api/team/members', {
    method: 'PUT',
    token: adminToken,
    body: { subject: 'any-user', roles: ['author'] },
  });
  assert.equal(putRes.status, 403, 'PUT on /api/team/members must be rejected with 403 under admin route policy');
  assert.equal(putRes.body?.error?.code, 'auth.denied');

  const deleteRes = await request(baseUrl, '/api/team/members', {
    method: 'DELETE',
    token: adminToken,
  });
  assert.equal(deleteRes.status, 403, 'DELETE on /api/team/members must be rejected with 403 under admin route policy');
  assert.equal(deleteRes.body?.error?.code, 'auth.denied');

  const headRes = await request(baseUrl, '/api/team/members', {
    method: 'HEAD',
    token: adminToken,
  });
  assert.equal(headRes.status, 403, 'HEAD on /api/team/members must be rejected with 403 under admin route policy');

  const optionsRes = await request(baseUrl, '/api/team/members', {
    method: 'OPTIONS',
    token: adminToken,
  });
  assert.equal(optionsRes.status, 403, 'OPTIONS on /api/team/members must be rejected with 403 under admin route policy');

  // Verify local mode returns 404 for unexpected methods
  const localServer = createRuleCanvasServer();
  await new Promise((resolve, reject) => {
    localServer.once('error', reject);
    localServer.listen(0, '127.0.0.1', resolve);
  });
  const localPort = localServer.address().port;
  t.after(() => new Promise((resolve) => localServer.close(resolve)));
  const localUrl = `http://127.0.0.1:${localPort}`;

  const localPut = await request(localUrl, '/api/team/members', { method: 'PUT', body: {} });
  assert.equal(localPut.status, 404);
  const localDelete = await request(localUrl, '/api/team/members', { method: 'DELETE' });
  assert.equal(localDelete.status, 404);
});

test('header casing and duplicate credentials are strictly validated', async (t) => {
  const adminRow = {
    tenant_id: defaultTenant, issuer, subject: 'admin-user', roles: ['admin'], enabled: true,
  };
  const pool = makePool([adminRow]);
  const baseUrl = await startTestServer(t, { pool });
  const token = makeAssertion(defaultTenant, 'admin-user');

  // Mixed-case header
  const mixedCaseGet = await request(baseUrl, '/api/team/members', {
    headers: { 'X-RuleCanvas-Assertion': token },
  });
  assert.equal(mixedCaseGet.status, 200, 'X-RuleCanvas-Assertion (mixed-case) must be accepted');
  assert.deepEqual(mixedCaseGet.body?.members?.map((m) => m.subject), ['admin-user']);

  // Upper-case header
  const upperCaseGet = await request(baseUrl, '/api/team/members', {
    headers: { 'X-RULECANVAS-ASSERTION': token },
  });
  assert.equal(upperCaseGet.status, 200, 'X-RULECANVAS-ASSERTION (upper-case) must be accepted');

  // Duplicate assertion header with differing casing
  const dupHeader = await fetch(`${baseUrl}/api/team/members`, {
    headers: {
      'x-rulecanvas-assertion': token,
      'X-RuleCanvas-Assertion': token,
    },
  });
  assert.equal(dupHeader.status, 401, 'Duplicate assertion headers must be rejected with 401');
  const dupJson = await dupHeader.json();
  assert.equal(dupJson.error?.code, 'auth.required');
  assert.equal(dupJson.error?.message, 'Authentication required.');
});

test('query parameters cannot override tenant scope or bypass authentication', async (t) => {
  const adminRow = {
    tenant_id: defaultTenant, issuer, subject: 'admin-user', roles: ['admin'], enabled: true,
  };
  const pool = makePool([adminRow]);
  const baseUrl = await startTestServer(t, { pool });
  const adminToken = makeAssertion(defaultTenant, 'admin-user');

  // GET with query parameters attempting to tamper with tenant
  const getTamper = await request(baseUrl, '/api/team/members?tenantId=attacker-tenant&issuer=attacker&roles=admin', {
    token: adminToken,
  });
  assert.equal(getTamper.status, 200);
  assert.deepEqual(getTamper.body?.members?.map((m) => m.subject), ['admin-user'], 'Query params must not tamper with listed members');

  // POST with query parameters attempting to inject tenant
  const postTamper = await request(baseUrl, '/api/team/members?tenantId=attacker-tenant', {
    method: 'POST',
    token: adminToken,
    body: { subject: 'new-analyst', roles: ['author'] },
  });
  assert.equal(postTamper.status, 201);
  assert.ok(pool.rows.has(key(defaultTenant, issuer, 'new-analyst')), 'Created member must be scoped to verified tenant');
  assert.ok(!pool.rows.has(key('attacker-tenant', issuer, 'new-analyst')), 'Query param tenant must be ignored');

  // PATCH with query parameters
  const patchTamper = await request(baseUrl, '/api/team/members?tenantId=attacker-tenant', {
    method: 'PATCH',
    token: adminToken,
    body: { subject: 'new-analyst', expected: { roles: ['author'], enabled: true }, roles: ['reviewer'] },
  });
  assert.equal(patchTamper.status, 200);
  assert.deepEqual(patchTamper.body?.member?.roles, ['reviewer']);
});

test('content-type header variations and JSON shape constraints are enforced', async (t) => {
  const adminRow = {
    tenant_id: defaultTenant, issuer, subject: 'admin-user', roles: ['admin'], enabled: true,
  };
  const pool = makePool([adminRow]);
  const baseUrl = await startTestServer(t, { pool });
  const adminToken = makeAssertion(defaultTenant, 'admin-user');

  // Content-Type: application/json; charset=utf-8
  const charsetPost = await request(baseUrl, '/api/team/members', {
    method: 'POST',
    token: adminToken,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: { subject: 'charset-user', roles: ['author'] },
  });
  assert.equal(charsetPost.status, 201);
  assert.equal(charsetPost.body?.member?.subject, 'charset-user');

  // Missing Content-Type with valid JSON body
  const missingContentType = await fetch(`${baseUrl}/api/team/members`, {
    method: 'POST',
    headers: { 'x-rulecanvas-assertion': adminToken },
    body: JSON.stringify({ subject: 'no-ct-user', roles: ['runner'] }),
  });
  assert.equal(missingContentType.status, 201);
  const noCtJson = await missingContentType.json();
  assert.equal(noCtJson.member?.subject, 'no-ct-user');

  // Non-object JSON shapes
  for (const invalidBody of ['123', '"plain-string"', 'true', 'null', '["array"]']) {
    const shapeRes = await request(baseUrl, '/api/team/members', {
      method: 'POST',
      token: adminToken,
      rawBody: invalidBody,
    });
    assert.equal(shapeRes.status, 400, `Body ${invalidBody} must return 400`);
    assert.equal(shapeRes.body?.error?.code, 'request.shape');
  }

  // Empty string body on POST
  const emptyBodyRes = await request(baseUrl, '/api/team/members', {
    method: 'POST',
    token: adminToken,
    rawBody: '',
  });
  assert.equal(emptyBodyRes.status, 400);
  assert.equal(emptyBodyRes.body?.error?.code, 'team.invalid_subject');

  // Empty string body on PATCH
  const emptyPatchRes = await request(baseUrl, '/api/team/members', {
    method: 'PATCH',
    token: adminToken,
    rawBody: '',
  });
  assert.equal(emptyPatchRes.status, 400);
  assert.equal(emptyPatchRes.body?.error?.code, 'team.invalid_subject');
});

test('concurrent requests handle race conditions atomically without corruption', async (t) => {
  const adminRow = {
    tenant_id: defaultTenant, issuer, subject: 'admin-user', roles: ['admin'], enabled: true,
  };
  const memberRow = {
    tenant_id: defaultTenant, issuer, subject: 'concurrent-target', roles: ['author'], enabled: true,
  };
  const pool = makePool([adminRow, memberRow]);
  const baseUrl = await startTestServer(t, { pool });
  const adminToken = makeAssertion(defaultTenant, 'admin-user');

  // 1. Concurrent POST requests for the same subject: exactly one must return 201, remainder 409
  const postResults = await Promise.all(
    Array.from({ length: 5 }, () =>
      request(baseUrl, '/api/team/members', {
        method: 'POST',
        token: adminToken,
        body: { subject: 'race-candidate', roles: ['runner'] },
      }),
    ),
  );
  const createdCount = postResults.filter((r) => r.status === 201).length;
  const conflictCount = postResults.filter((r) => r.status === 409 && r.body?.error?.code === 'team.member_exists').length;
  assert.equal(createdCount, 1, 'Exactly one concurrent POST must succeed with 201');
  assert.equal(conflictCount, 4, 'Remaining concurrent POSTs must fail with 409 team.member_exists');

  // 2. Concurrent PATCH requests with identical expected state: exactly one must return 200, remainder 409
  const patchResults = await Promise.all([
    request(baseUrl, '/api/team/members', {
      method: 'PATCH',
      token: adminToken,
      body: { subject: 'concurrent-target', expected: { roles: ['author'], enabled: true }, roles: ['reviewer'] },
    }),
    request(baseUrl, '/api/team/members', {
      method: 'PATCH',
      token: adminToken,
      body: { subject: 'concurrent-target', expected: { roles: ['author'], enabled: true }, roles: ['deployer'] },
    }),
    request(baseUrl, '/api/team/members', {
      method: 'PATCH',
      token: adminToken,
      body: { subject: 'concurrent-target', expected: { roles: ['author'], enabled: true }, roles: ['runner'] },
    }),
  ]);
  const patchSuccessCount = patchResults.filter((r) => r.status === 200).length;
  const patchConflictCount = patchResults.filter((r) => r.status === 409 && r.body?.error?.code === 'team.member_conflict').length;
  assert.equal(patchSuccessCount, 1, 'Exactly one concurrent PATCH must succeed with 200');
  assert.equal(patchConflictCount, 2, 'Remaining concurrent PATCHes must fail with 409 team.member_conflict');

  // 3. Concurrent requests where one fails and rolls back: must not corrupt the concurrent committed transaction
  const successSubject = 'tx-success-member';
  const preAuditCount = pool.audits.length;
  pool.setFailAudit(false);

  // Run a valid add concurrently with a request that fails validation
  const [validRes, invalidRes] = await Promise.all([
    request(baseUrl, '/api/team/members', {
      method: 'POST',
      token: adminToken,
      body: { subject: successSubject, roles: ['author'] },
    }),
    request(baseUrl, '/api/team/members', {
      method: 'POST',
      token: adminToken,
      body: { subject: 'failing-subject', roles: ['admin'] }, // invalid roles -> rejects before commit
    }),
  ]);
  assert.equal(validRes.status, 201);
  assert.equal(invalidRes.status, 400);
  assert.ok(pool.rows.has(key(defaultTenant, issuer, successSubject)), 'Committed member must persist despite concurrent rejection');
  assert.equal(pool.audits.length, preAuditCount + 1, 'Only one audit record should be added');
});

test('read-only and failed operations produce zero side effects or unintended mutations', async (t) => {
  const adminRow = {
    tenant_id: defaultTenant, issuer, subject: 'admin-user', roles: ['admin'], enabled: true,
  };
  const pool = makePool([adminRow]);
  const baseUrl = await startTestServer(t, { pool });
  const adminToken = makeAssertion(defaultTenant, 'admin-user');

  const initialRowCount = pool.rows.size;
  const initialAuditCount = pool.audits.length;

  // GET requests must be purely read-only
  for (let i = 0; i < 3; i++) {
    const listRes = await request(baseUrl, '/api/team/members', { token: adminToken });
    assert.equal(listRes.status, 200);
  }
  assert.equal(pool.rows.size, initialRowCount, 'GET must not mutate rows');
  assert.equal(pool.audits.length, initialAuditCount, 'GET must not create audit records');

  // Failed POST requests must produce zero mutations
  const failedPost = await request(baseUrl, '/api/team/members', {
    method: 'POST',
    token: adminToken,
    body: { subject: 'bad-roles', roles: ['nonexistent'] },
  });
  assert.equal(failedPost.status, 400);
  assert.equal(pool.rows.size, initialRowCount, 'Failed POST must not add rows');
  assert.equal(pool.audits.length, initialAuditCount, 'Failed POST must not write audits');

  // Failed PATCH requests must produce zero mutations
  const failedPatch = await request(baseUrl, '/api/team/members', {
    method: 'PATCH',
    token: adminToken,
    body: { subject: 'nonexistent-user', expected: { roles: ['author'], enabled: true }, roles: ['reviewer'] },
  });
  assert.equal(failedPatch.status, 404);
  assert.equal(pool.rows.size, initialRowCount, 'Failed PATCH must not add rows');
  assert.equal(pool.audits.length, initialAuditCount, 'Failed PATCH must not write audits');
});
