import pg from 'pg';
import { isIP } from 'node:net';
import { createRuleCanvasServer } from './server.mjs';
import { JsonStore } from './storage.mjs';
import { createHostedMembership } from './hosted-membership.mjs';
import { createPostgresWorkspaceBackend } from './postgres-workspace.mjs';
import { createHostedTeam } from './hosted-team.mjs';

function readConfig(env) {
  const databaseUrl = env.RULECANVAS_DATABASE_URL;
  const issuer = env.RULECANVAS_ASSERTION_ISSUER;
  const audience = env.RULECANVAS_ASSERTION_AUDIENCE;
  const encodedSecret = env.RULECANVAS_ASSERTION_SECRET;
  if (!databaseUrl || !issuer?.trim() || !audience?.trim() || !encodedSecret) {
    throw new Error('Database URL, assertion issuer, audience, and secret are required.');
  }
  const secret = Buffer.from(encodedSecret, 'base64url');
  if (secret.length < 32 || secret.toString('base64url') !== encodedSecret) {
    throw new Error('Assertion secret must be an unpadded base64url key of at least 32 bytes.');
  }
  const port = Number(env.PORT ?? 4178);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const host = env.RULECANVAS_HOST ?? '127.0.0.1';
  if (!isIP(host)) throw new Error('RULECANVAS_HOST must be an IPv4 or IPv6 address.');
  const teamManagement = env.RULECANVAS_TEAM_MANAGEMENT === '1';
  return { databaseUrl, host, port, assertion: { secret, issuer, audience, requireTenant: true }, teamManagement };
}

let pool;
let startupStage = 'configuration';
try {
  const { databaseUrl, host, port, assertion, teamManagement } = readConfig(process.env);
  startupStage = 'database and schema';
  pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 15_000,
  });
  pool.on('error', () => process.stderr.write('RuleCanvas database connection lost.\n'));
  const schemaQuery = teamManagement
    ? "SELECT to_regclass('rulecanvas_workspaces') AS workspaces, to_regclass('public.hosted_tenant_memberships') AS memberships, to_regclass('public.hosted_team_membership_audit') AS audits"
    : "SELECT to_regclass('rulecanvas_workspaces') AS workspaces, to_regclass('public.hosted_tenant_memberships') AS memberships";
  const { rows: [schema] } = await pool.query(schemaQuery);
  if (!schema?.workspaces || !schema?.memberships || (teamManagement && !schema?.audits)) throw new Error('Hosted schema migrations are required.');
  const membership = createHostedMembership({
    pool,
    storeForTenant: (tenantId, actor) => new JsonStore(null, createPostgresWorkspaceBackend({ pool, tenantId }), { actor }),
  });
  const team = teamManagement ? createHostedTeam({ pool }) : undefined;
  const checkReadiness = async () => { await pool.query({ text: 'SELECT 1', query_timeout: 2000 }); };
  const server = createRuleCanvasServer({ hosted: { assertion, storageType: 'postgres', checkReadiness, ...membership, ...(team ? { team } : {}) } });
  startupStage = 'listener';
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  process.stdout.write(`RuleCanvas hosted API listening on ${host}, port ${port}\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.stderr.write('RuleCanvas hosted shutdown exceeded its grace period.\n');
      process.exit(1);
    }, 8000).unref();
    server.close(async () => {
      try {
        await pool.end();
      } catch {
        process.stderr.write('RuleCanvas could not close its database pool cleanly.\n');
        process.exitCode = 1;
      } finally {
        clearTimeout(deadline);
      }
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch {
  // Connection errors may contain deployment details. Print configuration guidance only.
  process.stderr.write(`RuleCanvas hosted startup failed during ${startupStage}.\n`);
  if (pool) await pool.end();
  process.exitCode = 1;
}
