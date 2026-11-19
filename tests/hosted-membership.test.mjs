import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedMembership } from '../src/hosted-membership.mjs';

test('resolves a scoped store using an exact, enabled tenant membership and server roles', async () => {
  const principal = { tenantId: 'team-a', issuer: 'test-proxy', subject: 'member', roles: ['admin'] };
  let row = { tenant_id: 'team-a', issuer: 'test-proxy', subject: 'member', enabled: true, roles: ['reviewer'] };
  const store = { getRuleset: async () => ({ id: 'abc' }) };
  const resolver = createHostedMembership({
    pool: { query: async (sql, params) => {
      assert.match(sql, /tenant_id = \$1 AND issuer = \$2 AND subject = \$3/);
      assert.deepEqual(params, ['team-a', 'test-proxy', 'member']);
      return { rows: row ? [row] : [] };
    } },
    storeForTenant: (id) => { assert.equal(id, 'team-a'); return store; },
  });
  const resolve = (method, pathname) => resolver.resolveAuthorizedStore({ principal, method, pathname });
  assert.equal(await resolve('GET', '/api/projects'), store);
  assert.deepEqual(await resolver.resolveReleaseRoles({ principal, store, rulesetId: 'abc' }), ['reviewer']);
  await assert.rejects(resolve('POST', '/api/projects'), { status: 403 });
  await assert.rejects(resolve('GET', '/api/projects/abc/audit'), { status: 403 });
  await assert.rejects(resolve('POST', '/api/rulesets/abc/evaluate'), { status: 403 });
  await assert.rejects(resolve('POST', '/api/unknown'), { status: 403 });
  row = { ...row, roles: ['runner'] };
  assert.equal(await resolve('POST', '/api/rulesets/abc/releases/staging/evaluate'), store);
  assert.equal(await resolve('GET', '/api/rulesets/abc/releases'), store);
  await assert.rejects(resolve('POST', '/api/rulesets/abc/releases'), { status: 403 });
  row.enabled = false;
  await assert.rejects(resolve('GET', '/api/projects'), { status: 403 });
  row = null;
  await assert.rejects(resolve('GET', '/api/projects'), { status: 403 });
});
