import test from 'node:test';
import assert from 'node:assert/strict';
import { HostedAuthError } from '../src/hosted-auth.mjs';
import { createHostedTeam, HostedTeamError } from '../src/hosted-team.mjs';

const adminPrincipal = { tenantId: 'tenant-a', issuer: 'https://sso.example.test', subject: 'admin-a' };

function key(tenantId, issuer, subject) {
  return `${tenantId}\u0000${issuer}\u0000${subject}`;
}

function makePool(initialRows = []) {
  const rows = new Map(initialRows.map((row) => [key(row.tenant_id, row.issuer, row.subject), structuredClone(row)]));
  const queries = [];
  const audits = [];
  let failAudit = false;
  let auditId = 0;
  let transactionCount = 0;
  const pool = {
    rows,
    queries,
    audits,
    setFailAudit(value) { failAudit = value; },
    async connect() {
      transactionCount += 1;
      const tx = transactionCount;
      const startingRows = structuredClone(rows);
      const startingAuditCount = audits.length;
      return {
        async query(sql, params = []) {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          queries.push({ tx, sql: normalized, params: structuredClone(params) });
          if (normalized === 'BEGIN' || normalized === 'COMMIT') return { rows: [] };
          if (normalized === 'ROLLBACK') {
            rows.clear();
            for (const [rowKey, row] of startingRows) rows.set(rowKey, structuredClone(row));
            audits.length = startingAuditCount;
            return { rows: [] };
          }

          if (normalized.startsWith('SELECT tenant_id, issuer, subject, roles, enabled FROM public.hosted_tenant_memberships')) {
            const [tenantId, issuer, subject] = params;
            const scopedRows = [...rows.values()].filter((row) => row.tenant_id === tenantId && row.issuer === issuer &&
              (subject === undefined || row.subject === subject));
            if (normalized.includes('ORDER BY subject')) scopedRows.sort((a, b) => a.subject.localeCompare(b.subject));
            return { rows: scopedRows.map((row) => structuredClone(row)) };
          }

          if (normalized.startsWith('INSERT INTO public.hosted_tenant_memberships')) {
            const [tenantId, issuer, subject, roles, enabled] = params;
            const rowKey = key(tenantId, issuer, subject);
            if (rows.has(rowKey)) return { rows: [] };
            const row = { tenant_id: tenantId, issuer, subject, roles: [...roles], enabled };
            rows.set(rowKey, row);
            return { rows: [structuredClone(row)] };
          }

          if (normalized.startsWith('UPDATE public.hosted_tenant_memberships')) {
            const [tenantId, issuer, subject, roles, enabled] = params;
            const rowKey = key(tenantId, issuer, subject);
            const row = rows.get(rowKey);
            if (!row) return { rows: [] };
            row.roles = [...roles];
            row.enabled = enabled;
            return { rows: [structuredClone(row)] };
          }

          if (normalized.startsWith('INSERT INTO public.hosted_team_membership_audit')) {
            if (failAudit) throw new Error('simulated audit insert failure');
            const [tenantId, issuer, actor, target, action, beforeRoles, beforeEnabled, afterRoles, afterEnabled] = params;
            const audit = {
              id: String(++auditId), tenant_id: tenantId, issuer, actor_subject: actor,
              target_subject: target, action, before_roles: beforeRoles, before_enabled: beforeEnabled,
              after_roles: [...afterRoles], after_enabled: afterEnabled, created_at: new Date('2026-11-20T00:00:00.000Z'),
            };
            audits.push(audit);
            return { rowCount: 1, rows: [] };
          }

          throw new Error(`Unexpected query: ${normalized}`);
        },
        release() {},
      };
    },
  };
  return pool;
}

const adminRow = {
  tenant_id: 'tenant-a', issuer: adminPrincipal.issuer, subject: adminPrincipal.subject,
  roles: ['admin'], enabled: true,
};

test('denies non-admin membership and checks admin inside the same mutation transaction', async () => {
  const memberPrincipal = { tenantId: 'tenant-a', issuer: adminPrincipal.issuer, subject: 'regular-user', roles: ['admin'] };
  const pool = makePool([{ ...adminRow, subject: memberPrincipal.subject, roles: ['author'] }]);
  const team = createHostedTeam({ pool });

  await assert.rejects(
    team.addMember(memberPrincipal, { subject: 'new-user', roles: ['author'] }),
    (error) => error instanceof HostedAuthError && error.status === 403,
  );

  assert.equal(pool.queries.some(({ sql }) => sql.startsWith('INSERT INTO')), false);
  assert.equal(pool.queries[0].sql, 'BEGIN');
  assert.match(pool.queries[1].sql, /subject = \$3 FOR UPDATE$/);
  assert.equal(pool.queries.at(-1).sql, 'ROLLBACK');
  assert.ok(pool.queries.every(({ tx }) => tx === 1));
});
test('adds an operational membership using only the authenticated tenant and issuer', async () => {
  const pool = makePool([adminRow]);
  const team = createHostedTeam({ pool });

  const created = await team.addMember(adminPrincipal, {
    subject: 'analyst-1',
    roles: ['reviewer', 'author'],
    enabled: true,
    tenantId: 'attacker-tenant',
    issuer: 'attacker-issuer',
    actor: 'attacker-actor',
  });

  assert.deepEqual(created, { subject: 'analyst-1', roles: ['author', 'reviewer'], enabled: true });
  const insert = pool.queries.find(({ sql }) => sql.startsWith('INSERT INTO'));
  assert.deepEqual(insert.params, ['tenant-a', adminPrincipal.issuer, 'analyst-1', ['author', 'reviewer'], true]);
  assert.deepEqual(pool.audits[0], {
    id: '1', tenant_id: 'tenant-a', issuer: adminPrincipal.issuer, actor_subject: adminPrincipal.subject,
    target_subject: 'analyst-1', action: 'member.created', before_roles: null, before_enabled: null,
    after_roles: ['author', 'reviewer'], after_enabled: true, created_at: new Date('2026-11-20T00:00:00.000Z'),
  });
  const auditQuery = pool.queries.find(({ sql }) => sql.startsWith('INSERT INTO public.hosted_team_membership_audit'));
  assert.equal(auditQuery.tx, insert.tx);
  assert.deepEqual(auditQuery.params.slice(0, 5), ['tenant-a', adminPrincipal.issuer, adminPrincipal.subject, 'analyst-1', 'member.created']);
});

test('add conflict is explicit and never overwrites existing membership roles', async () => {
  const existing = { tenant_id: 'tenant-a', issuer: adminPrincipal.issuer, subject: 'analyst-1', roles: ['runner'], enabled: false };
  const pool = makePool([adminRow, existing]);
  const team = createHostedTeam({ pool });

  await assert.rejects(
    team.addMember(adminPrincipal, { subject: 'analyst-1', roles: ['author'] }),
    (error) => error instanceof HostedTeamError && error.code === 'team.member_exists' && error.status === 409,
  );
  assert.deepEqual(pool.rows.get(key('tenant-a', adminPrincipal.issuer, 'analyst-1')), existing);
});

test('lists only rows scoped to the authenticated tenant and issuer', async () => {
  const pool = makePool([
    adminRow,
    { tenant_id: 'tenant-a', issuer: adminPrincipal.issuer, subject: 'user-a', roles: ['author'], enabled: true },
    { tenant_id: 'tenant-b', issuer: adminPrincipal.issuer, subject: 'user-b', roles: ['deployer'], enabled: true },
    { tenant_id: 'tenant-a', issuer: 'https://other.example.test', subject: 'user-c', roles: ['runner'], enabled: true },
  ]);
  const team = createHostedTeam({ pool });

  const listed = await team.listMembers(adminPrincipal);
  assert.deepEqual(listed.map(({ subject }) => subject), ['admin-a', 'user-a']);
  const listQuery = pool.queries.find(({ sql }) => sql.includes('ORDER BY subject'));
  assert.deepEqual(listQuery.params, ['tenant-a', adminPrincipal.issuer]);
});

test('updates roles/status only when the locked current snapshot matches', async () => {
  const target = { tenant_id: 'tenant-a', issuer: adminPrincipal.issuer, subject: 'analyst-1', roles: ['author'], enabled: true };
  const pool = makePool([adminRow, target]);
  const team = createHostedTeam({ pool });

  await assert.rejects(
    team.updateMember(adminPrincipal, {
      subject: 'analyst-1',
      expected: { roles: ['runner'], enabled: true },
      roles: ['reviewer'],
    }),
    (error) => error instanceof HostedTeamError && error.code === 'team.member_conflict' && error.status === 409,
  );
  assert.deepEqual(pool.rows.get(key('tenant-a', adminPrincipal.issuer, 'analyst-1')), target);
  assert.equal(pool.audits.length, 0);

  const updated = await team.updateMember(adminPrincipal, {
    subject: 'analyst-1',
    expected: { roles: ['author'], enabled: true },
    roles: ['reviewer', 'deployer'],
    enabled: false,
  });
  assert.deepEqual(updated, { subject: 'analyst-1', roles: ['deployer', 'reviewer'], enabled: false });
  const updateQuery = pool.queries.find(({ sql }) => sql.startsWith('UPDATE public.hosted_tenant_memberships'));
  const adminCheck = pool.queries.find(({ sql, tx }) => tx === updateQuery.tx && sql.includes('subject = $3 FOR UPDATE'));
  assert.equal(updateQuery.tx, adminCheck.tx);
  assert.deepEqual(updateQuery.params.slice(0, 3), ['tenant-a', adminPrincipal.issuer, 'analyst-1']);
  const updateAudit = pool.audits[0];
  assert.equal(updateAudit.action, 'member.updated');
  assert.deepEqual([updateAudit.before_roles, updateAudit.before_enabled], [['author'], true]);
  assert.deepEqual([updateAudit.after_roles, updateAudit.after_enabled], [['deployer', 'reviewer'], false]);
  const auditQuery = pool.queries.find(({ sql }) => sql.startsWith('INSERT INTO public.hosted_team_membership_audit'));
  assert.equal(auditQuery.tx, updateQuery.tx);
  assert.deepEqual(auditQuery.params.slice(0, 5), ['tenant-a', adminPrincipal.issuer, adminPrincipal.subject, 'analyst-1', 'member.updated']);
});

test('audit write failure rolls back the membership mutation', async () => {
  const pool = makePool([adminRow]);
  pool.setFailAudit(true);
  const team = createHostedTeam({ pool });

  await assert.rejects(
    team.addMember(adminPrincipal, { subject: 'analyst-1', roles: ['author'] }),
    (error) => error instanceof HostedTeamError && error.code === 'team.storage_unavailable' && error.status === 503,
  );
  assert.equal(pool.rows.has(key('tenant-a', adminPrincipal.issuer, 'analyst-1')), false);
  assert.equal(pool.audits.length, 0);
  assert.ok(pool.queries.some(({ sql }) => sql === 'ROLLBACK'));
});

test('audit write failure rolls an update back to its committed old membership state', async () => {
  const target = { tenant_id: 'tenant-a', issuer: adminPrincipal.issuer, subject: 'analyst-1', roles: ['author'], enabled: true };
  const pool = makePool([adminRow, target]);
  pool.setFailAudit(true);
  const team = createHostedTeam({ pool });

  await assert.rejects(
    team.updateMember(adminPrincipal, {
      subject: target.subject,
      expected: { roles: target.roles, enabled: target.enabled },
      roles: ['reviewer'],
      enabled: false,
    }),
    (error) => error instanceof HostedTeamError && error.code === 'team.storage_unavailable' && error.status === 503,
  );
  assert.deepEqual(pool.rows.get(key('tenant-a', adminPrincipal.issuer, target.subject)), target);
  assert.equal(pool.audits.length, 0);
});

test('nonchanging update is idempotent and does not write audit event', async () => {
  const target = { tenant_id: 'tenant-a', issuer: adminPrincipal.issuer, subject: 'analyst-1', roles: ['author'], enabled: true };
  const pool = makePool([adminRow, target]);
  const team = createHostedTeam({ pool });

  const returned = await team.updateMember(adminPrincipal, {
    subject: 'analyst-1', expected: { roles: ['author'], enabled: true }, roles: ['author'], enabled: true,
  });
  assert.deepEqual(returned, { subject: 'analyst-1', roles: ['author'], enabled: true });
  assert.equal(pool.queries.some(({ sql }) => sql.startsWith('UPDATE public.hosted_tenant_memberships')), false);
  assert.equal(pool.audits.length, 0);
});

test('refuses admin role creation and protects existing admin memberships from updates', async () => {
  const targetAdmin = { ...adminRow, subject: 'other-admin' };
  const pool = makePool([adminRow, targetAdmin]);
  const team = createHostedTeam({ pool });

  await assert.rejects(
    team.addMember(adminPrincipal, { subject: 'new-admin', roles: ['admin'] }),
    (error) => error instanceof HostedTeamError && error.code === 'team.invalid_roles' && error.status === 400,
  );
  await assert.rejects(
    team.updateMember(adminPrincipal, {
      subject: 'other-admin',
      expected: { roles: ['admin'], enabled: true },
      enabled: false,
    }),
    (error) => error instanceof HostedTeamError && error.code === 'team.admin_immutable' && error.status === 409,
  );
  assert.deepEqual(pool.rows.get(key('tenant-a', adminPrincipal.issuer, 'other-admin')), targetAdmin);
});

test('validates required snapshot and rejects unsupported member role inputs', async () => {
  const pool = makePool([adminRow]);
  const team = createHostedTeam({ pool });

  await assert.rejects(
    team.updateMember(adminPrincipal, { subject: 'missing-snapshot', roles: ['author'] }),
    (error) => error instanceof HostedTeamError && error.code === 'team.expected_state_required',
  );
  await assert.rejects(
    team.addMember(adminPrincipal, { subject: 'new-user', roles: ['admin', 'author'] }),
    (error) => error instanceof HostedTeamError && error.code === 'team.invalid_roles',
  );
  await assert.rejects(
    team.addMember(adminPrincipal, { subject: 'bad\nsubject', roles: ['author'] }),
    (error) => error instanceof HostedTeamError && error.code === 'team.invalid_subject',
  );
});
