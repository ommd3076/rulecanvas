import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { preparePostgresTestSchema } from './postgres-test-schema.mjs';

const databaseUrl = process.env.RULECANVAS_TEST_DATABASE_URL;
const issuer = 'rulecanvas-startup-test';
const audience = 'rulecanvas';

async function startHosted(secret, databaseUrl, t) {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['src/start-hosted.mjs'], {
    env: {
      ...process.env,
      PORT: String(port),
      RULECANVAS_HOST: '127.0.0.1',
      RULECANVAS_DATABASE_URL: databaseUrl,
      RULECANVAS_ASSERTION_ISSUER: issuer,
      RULECANVAS_ASSERTION_AUDIENCE: audience,
      RULECANVAS_ASSERTION_SECRET: secret.toString('base64url'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostic = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (value) => { diagnostic += value; });
  const closed = once(child, 'close');
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    if (!await Promise.race([closed.then(() => true), delay(2000, false, { ref: false })])) {
      child.kill('SIGKILL');
      await closed;
    }
  };
  t.after(stop);

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    const response = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response?.ok) {
      assert.deepEqual(await response.json(), { ok: true });
      return { url, stop };
    }
    await response?.body?.cancel();
    await delay(100);
  }
  assert.fail(`Hosted launcher did not become ready. ${diagnostic}`);
}

function assertion(secret, tenant) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: issuer, aud: audience, sub: 'operator', tenant, iat: now, exp: now + 60 })}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}

test('hosted launcher enforces signed tenant membership and persists data across process restart', {
  skip: databaseUrl ? false : 'RULECANVAS_TEST_DATABASE_URL is not set.',
  timeout: 30_000,
}, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  const tenant = `launcher-${randomUUID()}`;
  const secret = randomBytes(32);
  let migrated = false;
  try {
    await preparePostgresTestSchema(pool);
    migrated = true;
    await pool.query('INSERT INTO public.hosted_tenant_memberships (tenant_id, issuer, subject, roles) VALUES ($1,$2,$3,$4)', [tenant, issuer, 'operator', ['author']]);
    const first = await startHosted(secret, databaseUrl, t);
    const call = (server, path, options = {}) => fetch(`${server.url}${path}`, { ...options, signal: AbortSignal.timeout(5000) });
    const headers = { 'x-rulecanvas-assertion': assertion(secret, tenant), 'content-type': 'application/json' };
    const unauthorized = await call(first, '/api/projects', { headers: { 'x-forwarded-user': 'operator' } });
    assert.equal(unauthorized.status, 401);
    const crossTenant = await call(first, '/api/projects', { headers: { 'x-rulecanvas-assertion': assertion(secret, `${tenant}-other`) } });
    assert.equal(crossTenant.status, 403);
    const created = await call(first, '/api/projects', { method: 'POST', headers, body: JSON.stringify({ name: 'Launcher synthetic project' }) });
    assert.equal(created.status, 201);
    const { project } = await created.json();
    await first.stop();

    const second = await startHosted(secret, databaseUrl, t);
    const reopened = await call(second, `/api/projects/${project.id}`, { headers });
    assert.equal(reopened.status, 200);
    assert.equal((await reopened.json()).project.name, 'Launcher synthetic project');
    await second.stop();
  } finally {
    try {
      if (migrated) {
        await pool.query('DELETE FROM public.hosted_tenant_memberships WHERE tenant_id = $1', [tenant]);
        await pool.query('DELETE FROM rulecanvas_workspaces WHERE tenant_id = $1', [tenant]);
      }
    } finally {
      await pool.end();
    }
  }
});
