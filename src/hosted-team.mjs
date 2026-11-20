import { HostedAuthError } from './hosted-auth.mjs';

const OPERATIONAL_ROLES = new Set(['author', 'reviewer', 'deployer', 'runner']);
const ALL_ROLES = new Set([...OPERATIONAL_ROLES, 'admin']);
const MEMBERSHIP_COLUMNS = 'tenant_id, issuer, subject, roles, enabled';

export class HostedTeamError extends Error {
  constructor(code, status = 400) {
    super('Team membership request could not be completed.');
    this.name = 'HostedTeamError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) {
  throw new HostedTeamError(code, status);
}

function requireText(value, code, maxLength) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maxLength || /[\x00-\x1f\x7f]/.test(value)) {
    fail(code, 400);
  }
  return value;
}

function requirePrincipal(principal) {
  if (!principal || typeof principal !== 'object' || Array.isArray(principal)) {
    throw new HostedAuthError('auth.required', 401);
  }
  const tenantId = requireText(principal.tenantId, 'team.invalid_principal', 128);
  if (!/^[A-Za-z0-9_.-]+$/.test(tenantId)) fail('team.invalid_principal', 400);
  const issuer = requireText(principal.issuer, 'team.invalid_principal', 512);
  const subject = requireText(principal.subject, 'team.invalid_principal', 256);
  return { tenantId, issuer, subject };
}

function normalizeRoles(roles, { allowAdmin = false } = {}) {
  if (!Array.isArray(roles) || roles.length === 0 || roles.length > (allowAdmin ? ALL_ROLES.size : OPERATIONAL_ROLES.size)) {
    fail('team.invalid_roles', 400);
  }
  const allowed = allowAdmin ? ALL_ROLES : OPERATIONAL_ROLES;
  const normalized = [];
  for (const role of roles) {
    if (typeof role !== 'string' || role !== role.trim() || !allowed.has(role) || normalized.includes(role)) {
      fail('team.invalid_roles', 400);
    }
    normalized.push(role);
  }
  return normalized.sort();
}

function rowToMember(row, scope) {
  if (!row || row.tenant_id !== scope.tenantId || row.issuer !== scope.issuer ||
      typeof row.subject !== 'string' || !Array.isArray(row.roles) ||
      row.roles.length === 0 || row.roles.some((role) => typeof role !== 'string' || !ALL_ROLES.has(role)) ||
      typeof row.enabled !== 'boolean') {
    fail('team.membership_invalid', 503);
  }
  return {
    subject: row.subject,
    roles: [...row.roles].sort(),
    enabled: row.enabled,
  };
}

function requireAdminRow(rows, scope) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new HostedAuthError('auth.denied', 403);
  const row = rows[0];
  if (row.tenant_id !== scope.tenantId || row.issuer !== scope.issuer || row.subject !== scope.subject ||
      row.enabled !== true || !Array.isArray(row.roles) || !row.roles.includes('admin') ||
      row.roles.some((role) => typeof role !== 'string' || !ALL_ROLES.has(role))) {
    throw new HostedAuthError('auth.denied', 403);
  }
  return row;
}

async function inTransaction(pool, operation) {
  let client;
  let discardClient = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discardClient = true;
      }
    }
    if (error instanceof HostedTeamError || error instanceof HostedAuthError) throw error;
    throw new HostedTeamError('team.storage_unavailable', 503);
  } finally {
    client?.release(discardClient);
  }
}

async function writeMembershipAudit(client, scope, targetSubject, action, before, after) {
  const result = await client.query(
    `INSERT INTO public.hosted_team_membership_audit
       (tenant_id, issuer, actor_subject, target_subject, action, before_roles, before_enabled, after_roles, after_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      scope.tenantId,
      scope.issuer,
      scope.subject,
      targetSubject,
      action,
      before?.roles ?? null,
      before?.enabled ?? null,
      after.roles,
      after.enabled,
    ],
  );
  if (!result || result.rowCount !== 1) fail('team.audit_write_failed', 503);
}

/**
 * Creates a small admin-only team membership service over the existing SSO membership table.
 * Tenant, issuer, and acting subject are always derived from the verified principal.
 */
export function createHostedTeam({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('Hosted team management requires a PostgreSQL pool with connect().');
  }

  async function lockAdmin(client, scope) {
    const result = await client.query(
      `SELECT ${MEMBERSHIP_COLUMNS} FROM public.hosted_tenant_memberships
       WHERE tenant_id = $1 AND issuer = $2 AND subject = $3 FOR UPDATE`,
      [scope.tenantId, scope.issuer, scope.subject],
    );
    requireAdminRow(result?.rows, scope);
  }

  return Object.freeze({
    async listMembers(principal) {
      const scope = requirePrincipal(principal);
      return inTransaction(pool, async (client) => {
        await lockAdmin(client, scope);
        const result = await client.query(
          `SELECT ${MEMBERSHIP_COLUMNS} FROM public.hosted_tenant_memberships
           WHERE tenant_id = $1 AND issuer = $2 ORDER BY subject`,
          [scope.tenantId, scope.issuer],
        );
        if (!Array.isArray(result?.rows)) fail('team.membership_invalid', 503);
        return result.rows.map((row) => rowToMember(row, scope));
      });
    },

    async addMember(principal, { subject, roles, enabled = true } = {}) {
      const scope = requirePrincipal(principal);
      const targetSubject = requireText(subject, 'team.invalid_subject', 256);
      const targetRoles = normalizeRoles(roles);
      if (typeof enabled !== 'boolean') fail('team.invalid_enabled', 400);

      return inTransaction(pool, async (client) => {
        await lockAdmin(client, scope);
        const result = await client.query(
          `INSERT INTO public.hosted_tenant_memberships (tenant_id, issuer, subject, roles, enabled)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, issuer, subject) DO NOTHING
           RETURNING ${MEMBERSHIP_COLUMNS}`,
          [scope.tenantId, scope.issuer, targetSubject, targetRoles, enabled],
        );
        if (!Array.isArray(result?.rows) || result.rows.length !== 1) fail('team.member_exists', 409);
        const member = rowToMember(result.rows[0], scope);
        await writeMembershipAudit(client, scope, targetSubject, 'member.created', null, member);
        return member;
      });
    },

    async updateMember(principal, { subject, expected, roles, enabled } = {}) {
      const scope = requirePrincipal(principal);
      const targetSubject = requireText(subject, 'team.invalid_subject', 256);
      if (!expected || typeof expected !== 'object' || Array.isArray(expected) || typeof expected.enabled !== 'boolean') {
        fail('team.expected_state_required', 400);
      }
      const expectedRoles = normalizeRoles(expected.roles, { allowAdmin: true });
      const hasRoles = roles !== undefined;
      const hasEnabled = enabled !== undefined;
      if (!hasRoles && !hasEnabled) fail('team.empty_update', 400);
      const nextRoles = hasRoles ? normalizeRoles(roles) : undefined;
      if (hasEnabled && typeof enabled !== 'boolean') fail('team.invalid_enabled', 400);

      return inTransaction(pool, async (client) => {
        await lockAdmin(client, scope);
        const selected = await client.query(
          `SELECT ${MEMBERSHIP_COLUMNS} FROM public.hosted_tenant_memberships
           WHERE tenant_id = $1 AND issuer = $2 AND subject = $3 FOR UPDATE`,
          [scope.tenantId, scope.issuer, targetSubject],
        );
        if (!Array.isArray(selected?.rows) || selected.rows.length !== 1) fail('team.member_not_found', 404);
        const current = rowToMember(selected.rows[0], scope);
        if (current.roles.includes('admin')) fail('team.admin_immutable', 409);
        if (current.roles.length !== expectedRoles.length || current.roles.some((role, index) => role !== expectedRoles[index]) ||
            current.enabled !== expected.enabled) {
          fail('team.member_conflict', 409);
        }

        const next = {
          roles: nextRoles ?? current.roles,
          enabled: hasEnabled ? enabled : current.enabled,
        };
        if (sameMemberState(current, next)) return current;
        const updated = await client.query(
          `UPDATE public.hosted_tenant_memberships SET roles = $4, enabled = $5
           WHERE tenant_id = $1 AND issuer = $2 AND subject = $3 RETURNING ${MEMBERSHIP_COLUMNS}`,
          [scope.tenantId, scope.issuer, targetSubject, next.roles, next.enabled],
        );
        if (!Array.isArray(updated?.rows) || updated.rows.length !== 1) fail('team.member_conflict', 409);
        const member = rowToMember(updated.rows[0], scope);
        await writeMembershipAudit(client, scope, targetSubject, 'member.updated', current, member);
        return member;
      });
    },
  });
}

function sameMemberState(left, right) {
  return left.enabled === right.enabled && left.roles.length === right.roles.length &&
    left.roles.every((role, index) => role === right.roles[index]);
}
