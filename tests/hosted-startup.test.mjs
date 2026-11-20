import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { preparePostgresTestSchema } from './postgres-test-schema.mjs';
import { validGraph } from './fixtures.mjs';

const databaseUrl = process.env.RULECANVAS_TEST_DATABASE_URL;
const issuer = 'rulecanvas-startup-test';
const audience = 'rulecanvas';

async function startHosted(secret, databaseUrl, t, { enableTeam = false } = {}) {
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
      RULECANVAS_TEAM_MANAGEMENT: enableTeam ? '1' : '',
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
    if (process.platform !== 'win32') assert.equal(child.exitCode, 0, diagnostic || 'Expected a clean hosted shutdown.');
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

function assertion(secret, tenant, subject) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: issuer, aud: audience, sub: subject, tenant, iat: now, exp: now + 60 })}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}

test('hosted launcher enforces role-scoped releases, immutable runtime evaluation, tenant isolation, and restart persistence', {
  skip: databaseUrl ? false : 'RULECANVAS_TEST_DATABASE_URL is not set.',
  timeout: 30_000,
}, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  const tenant = `launcher-${randomUUID()}`;
  const otherTenant = `launcher-other-${randomUUID()}`;
  const secret = randomBytes(32);
  let migrated = false;
  try {
    await preparePostgresTestSchema(pool);
    migrated = true;
    const members = [
      ['author', ['author', 'reviewer']],
      ['reviewer', ['reviewer']],
      ['deployer', ['deployer']],
      ['runner', ['runner']],
      ['admin', ['admin']],
    ].map(([role, roles]) => [`${role}-${randomUUID()}`, roles]);
    const otherAuthor = `other-author-${randomUUID()}`;
    for (const [subject, roles] of members) {
      await pool.query(
        'INSERT INTO public.hosted_tenant_memberships (tenant_id, issuer, subject, roles) VALUES ($1,$2,$3,$4)',
        [tenant, issuer, subject, roles],
      );
    }
    await pool.query(
      'INSERT INTO public.hosted_tenant_memberships (tenant_id, issuer, subject, roles) VALUES ($1,$2,$3,$4)',
      [otherTenant, issuer, otherAuthor, ['author']],
    );
    const [author, reviewer, deployer, runner, admin] = members.map(([subject]) => subject);
    const first = await startHosted(secret, databaseUrl, t);
    const call = (server, path, { subject, tenantId = tenant, method = 'GET', body, credential = true, extraHeaders = {} } = {}) => {
      const headers = {
        ...(credential ? { 'x-rulecanvas-assertion': assertion(secret, tenantId, subject) } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      };
      return fetch(`${server.url}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
    };
    const unauthorized = await call(first, '/api/projects', { credential: false, extraHeaders: { 'x-forwarded-user': author }, method: 'POST', body: { name: 'Forged project' } });
    assert.equal(unauthorized.status, 401);
    const crossTenant = await call(first, '/api/projects', { subject: author, tenantId: `${tenant}-other` });
    assert.equal(crossTenant.status, 403, 'A signed identity without tenant membership must be denied.');

    const created = await call(first, '/api/projects', { subject: author, method: 'POST', body: { name: 'Launcher synthetic project' } });
    assert.equal(created.status, 201);
    const { project } = await created.json();

    const reviewerWrite = await call(first, '/api/projects', { subject: reviewer, method: 'POST', body: { name: 'Reviewer cannot write' } });
    assert.equal(reviewerWrite.status, 403, 'Reviewer membership must not grant workspace write access.');
    const otherCreated = await call(first, '/api/projects', { subject: otherAuthor, tenantId: otherTenant, method: 'POST', body: { name: 'Other tenant project' } });
    assert.equal(otherCreated.status, 201);
    const { project: otherProject } = await otherCreated.json();
    const crossTenantRead = await call(first, `/api/projects/${project.id}`, { subject: otherAuthor, tenantId: otherTenant });
    assert.equal(crossTenantRead.status, 404, 'A member in another tenant must not read this workspace.');
    const otherTenantProjects = await call(first, '/api/projects', { subject: otherAuthor, tenantId: otherTenant });
    assert.deepEqual((await otherTenantProjects.json()).projects.map((entry) => entry.id), [otherProject.id]);

    const rulesetResponse = await call(first, `/api/projects/${project.id}/rulesets`, {
      subject: author,
      method: 'POST',
      body: { name: 'Hosted release sample' },
    });
    assert.equal(rulesetResponse.status, 201);
    const { ruleset } = await rulesetResponse.json();
    const rulesetPath = `/api/rulesets/${ruleset.id}`;
    const draftResponse = await call(first, rulesetPath, {
      subject: author,
      method: 'PUT',
      body: { expectedRevision: ruleset.revision, graph: validGraph(), name: ruleset.name },
    });
    assert.equal(draftResponse.status, 200);
    const { ruleset: savedDraft } = await draftResponse.json();
    const versionResponse = await call(first, `${rulesetPath}/versions`, {
      subject: author,
      method: 'POST',
      body: { expectedRevision: savedDraft.revision },
    });
    assert.equal(versionResponse.status, 201);
    const { version } = await versionResponse.json();
    const releasesPath = `${rulesetPath}/releases`;
    const selectedVersion = { versionId: version.id, versionHash: version.graphHash };

    const unauthenticatedRelease = await call(first, releasesPath, { credential: false });
    assert.equal(unauthenticatedRelease.status, 401);
    const runnerCannotPropose = await call(first, releasesPath, {
      subject: runner,
      method: 'POST',
      body: { ...selectedVersion, action: 'propose', rationale: 'Runner must not propose.' },
    });
    assert.equal(runnerCannotPropose.status, 403, 'Runner must not access release transitions.');
    const reviewerCannotEvaluate = await call(first, `${releasesPath}/production/evaluate`, {
      subject: reviewer,
      method: 'POST',
      body: { input: { score: 8 } },
    });
    assert.equal(reviewerCannotEvaluate.status, 403, 'Reviewer without evaluator role must not evaluate production releases.');

    const reviewerCannotPropose = await call(first, releasesPath, {
      subject: reviewer,
      method: 'POST',
      body: { ...selectedVersion, action: 'propose', rationale: 'Reviewer cannot propose.' },
    });
    assert.equal(reviewerCannotPropose.status, 403);
    assert.equal((await reviewerCannotPropose.json()).error.code, 'release.unauthorized_role');

    const proposedResponse = await call(first, releasesPath, {
      subject: author,
      method: 'POST',
      body: { ...selectedVersion, action: 'propose', rationale: 'Author proposes saved version.' },
    });
    assert.equal(proposedResponse.status, 200);
    const proposed = (await proposedResponse.json()).policy.releases.find((release) => release.versionId === version.id);
    assert.equal(proposed.status, 'pending_review');
    assert.equal(proposed.proposedBy.id, author);
    assert.deepEqual(proposed.proposedBy.roles, ['author', 'reviewer']);

    const authorCannotApproveOwnRelease = await call(first, releasesPath, {
      subject: author,
      method: 'POST',
      body: { ...selectedVersion, action: 'approve', rationale: 'Author cannot self-approve.' },
    });
    assert.equal(authorCannotApproveOwnRelease.status, 403);
    assert.equal((await authorCannotApproveOwnRelease.json()).error.code, 'release.separation_of_duties');
    const deployerCannotApprove = await call(first, releasesPath, {
      subject: deployer,
      method: 'POST',
      body: { ...selectedVersion, action: 'approve', rationale: 'Deployer cannot approve.' },
    });
    assert.equal(deployerCannotApprove.status, 403);
    assert.equal((await deployerCannotApprove.json()).error.code, 'release.unauthorized_role');

    const approvedResponse = await call(first, releasesPath, {
      subject: reviewer,
      method: 'POST',
      body: { ...selectedVersion, action: 'approve', rationale: 'Reviewer independently approves.' },
    });
    assert.equal(approvedResponse.status, 200);
    const approved = (await approvedResponse.json()).policy.releases.find((release) => release.versionId === version.id);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvedBy.id, reviewer);
    assert.deepEqual(approved.approvedBy.roles, ['reviewer']);

    const reviewerCannotActivate = await call(first, releasesPath, {
      subject: reviewer,
      method: 'POST',
      body: {
        ...selectedVersion, action: 'activate', environment: 'production',
        expectedActiveVersionId: null, rationale: 'Reviewer cannot activate.',
      },
    });
    assert.equal(reviewerCannotActivate.status, 403);
    assert.equal((await reviewerCannotActivate.json()).error.code, 'release.unauthorized_role');
    const activation = await call(first, releasesPath, {
      subject: deployer,
      method: 'POST',
      body: {
        ...selectedVersion, action: 'activate', environment: 'production',
        expectedActiveVersionId: null, rationale: 'Deployer activates approved version.',
      },
    });
    assert.equal(activation.status, 200);
    assert.equal((await activation.json()).policy.deployments.find((entry) => entry.environment === 'production')?.versionId, version.id);

    const runtimePath = `${releasesPath}/production/evaluate`;
    const runtime = await call(first, runtimePath, {
      subject: runner,
      method: 'POST',
      body: { input: { score: 8 } },
    });
    assert.equal(runtime.status, 200);
    const runtimeResult = await runtime.json();
    assert.equal(runtimeResult.version.id, version.id, 'Release evaluation must pin the active immutable version.');
    assert.deepEqual(runtimeResult.result, { decision: 'eligible' });

    await first.stop();

    const second = await startHosted(secret, databaseUrl, t);
    const reopened = await call(second, `/api/projects/${project.id}`, { subject: author });
    assert.equal(reopened.status, 200);
    assert.equal((await reopened.json()).project.name, 'Launcher synthetic project');
    const persistedStateResponse = await call(second, releasesPath, { subject: reviewer });
    assert.equal(persistedStateResponse.status, 200);
    const persistedState = (await persistedStateResponse.json()).policy;
    assert.equal(persistedState.releases.find((release) => release.versionId === version.id)?.status, 'approved');
    assert.equal(persistedState.deployments.find((entry) => entry.environment === 'production')?.versionId, version.id);
    assert(persistedState.auditTrail.some((entry) => entry.action === 'propose' && entry.actorId === author && entry.actorRoles.includes('author')));
    assert(persistedState.auditTrail.some((entry) => entry.action === 'approve' && entry.actorId === reviewer && entry.actorRoles.includes('reviewer')));
    assert(persistedState.auditTrail.some((entry) => entry.action === 'activate' && entry.actorId === deployer && entry.actorRoles.includes('deployer')));
    const versionReopened = await call(second, `${rulesetPath}/versions/${version.id}`, { subject: author });
    assert.equal(versionReopened.status, 200);
    assert.equal((await versionReopened.json()).version.graphHash, version.graphHash);
    const rerun = await call(second, runtimePath, { subject: runner, method: 'POST', body: { input: { score: 8 } } });
    assert.equal(rerun.status, 200);
    const persistedRuntime = await rerun.json();
    assert.equal(persistedRuntime.version.id, version.id);
    assert.deepEqual(persistedRuntime.result, { decision: 'eligible' });
    const runsResponse = await call(second, `/api/projects/${project.id}/runs`, { subject: runner });
    assert.equal(runsResponse.status, 200);
    const runs = (await runsResponse.json()).runs;
    assert.equal(runs.length, 2);
    assert(runs.every((run) => run.versionId === version.id && run.versionNumber === version.versionNumber));
    const auditPath = `/api/projects/${project.id}/audit`;
    assert.equal((await call(second, auditPath, { subject: reviewer })).status, 403);
    const activityResponse = await call(second, auditPath, { subject: admin });
    assert.equal(activityResponse.status, 200);
    const { events } = await activityResponse.json();
    for (const type of ['project.created', 'ruleset.created', 'ruleset.draft.saved', 'ruleset.version.created']) {
      assert.equal(events.find((event) => event.type === type)?.actor, author);
    }
    assert.equal(events.find((event) => event.type === 'release.activate')?.actor, deployer);
    await second.stop();
  } finally {
    try {
      if (migrated) {
        await pool.query('DELETE FROM public.hosted_tenant_memberships WHERE tenant_id = ANY($1::varchar[])', [[tenant, otherTenant]]);
        await pool.query('DELETE FROM rulecanvas_workspaces WHERE tenant_id = ANY($1::varchar[])', [[tenant, otherTenant]]);
      }
    } finally {
      await pool.end();
    }
  }
});

test('hosted team changes take effect immediately and persist with an atomic PostgreSQL audit trail', {
  skip: databaseUrl ? false : 'RULECANVAS_TEST_DATABASE_URL is not set.',
  timeout: 30_000,
}, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  const tenant = `team-${randomUUID()}`;
  const otherTenant = `team-${randomUUID()}`;
  const secret = randomBytes(32);
  let migrated = false;
  try {
    await preparePostgresTestSchema(pool);
    migrated = true;
    await pool.query(`INSERT INTO public.hosted_tenant_memberships (tenant_id, issuer, subject, roles)
      VALUES ($1,$3,'admin-one',ARRAY['admin']), ($1,$3,'author-one',ARRAY['author']),
             ($2,$3,'admin-two',ARRAY['admin'])`, [tenant, otherTenant, issuer]);

    const first = await startHosted(secret, databaseUrl, t, { enableTeam: true });
    const teamPath = '/api/team/members';
    const send = (server, path, subject, { method = 'GET', body, tenantId = tenant, credential } = {}) => fetch(`${server.url}${path}`, {
      method,
      headers: {
        ...(subject ? { 'x-rulecanvas-assertion': credential ?? assertion(secret, tenantId, subject) } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });

    const health = await send(first, '/api/health', 'admin-one');
    assert.equal((await health.json()).teamManagement, true);
    const authorHealth = await send(first, '/api/health', 'author-one');
    assert.notEqual((await authorHealth.json()).teamManagement, true);
    assert.equal((await send(first, teamPath)).status, 401);
    assert.equal((await send(first, teamPath, 'author-one')).status, 403);

    const created = await send(first, teamPath, 'admin-one', {
      method: 'POST', body: { subject: 'synthetic-runner', roles: ['runner'], tenantId: otherTenant },
    });
    assert.equal(created.status, 201);
    const { member } = await created.json();
    assert.deepEqual(member, { subject: 'synthetic-runner', roles: ['runner'], enabled: true });
    const otherList = await send(first, teamPath, 'admin-two', { tenantId: otherTenant });
    assert.deepEqual((await otherList.json()).members.map((entry) => entry.subject), ['admin-two']);

    const credential = assertion(secret, tenant, member.subject);
    assert.equal((await send(first, '/api/projects', member.subject, { credential })).status, 200);
    const disabled = await send(first, teamPath, 'admin-one', {
      method: 'PATCH', body: { subject: member.subject, expected: { roles: member.roles, enabled: true }, enabled: false },
    });
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).member.enabled, false);
    assert.equal((await send(first, '/api/projects', member.subject, { credential })).status, 403);

    const stale = await send(first, teamPath, 'admin-one', {
      method: 'PATCH', body: { subject: member.subject, expected: { roles: member.roles, enabled: true }, roles: ['reviewer'] },
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'team.member_conflict');
    await first.stop();

    const second = await startHosted(secret, databaseUrl, t, { enableTeam: true });
    const listed = await send(second, teamPath, 'admin-one');
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).members.find((entry) => entry.subject === member.subject), { ...member, enabled: false });
    const { rows } = await pool.query(`SELECT action, actor_subject, target_subject, before_roles, before_enabled, after_roles, after_enabled
      FROM public.hosted_team_membership_audit WHERE tenant_id = $1 AND issuer = $2 ORDER BY id`, [tenant, issuer]);
    assert.deepEqual(rows, [
      { action: 'member.created', actor_subject: 'admin-one', target_subject: member.subject, before_roles: null, before_enabled: null, after_roles: ['runner'], after_enabled: true },
      { action: 'member.updated', actor_subject: 'admin-one', target_subject: member.subject, before_roles: ['runner'], before_enabled: true, after_roles: ['runner'], after_enabled: false },
    ]);
    await second.stop();
  } finally {
    try {
      if (migrated) {
        await pool.query('DELETE FROM public.hosted_team_membership_audit WHERE tenant_id = $1', [tenant]);
        await pool.query('DELETE FROM public.hosted_tenant_memberships WHERE tenant_id = ANY($1::varchar[])', [[tenant, otherTenant]]);
      }
    } finally {
      await pool.end();
    }
  }
});
