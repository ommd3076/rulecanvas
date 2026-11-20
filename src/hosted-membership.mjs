import { HostedAuthError } from './hosted-auth.mjs';

const MEMBERSHIP_QUERY = `
  SELECT tenant_id, issuer, subject, roles, enabled
  FROM public.hosted_tenant_memberships
  WHERE tenant_id = $1 AND issuer = $2 AND subject = $3
  LIMIT 2
`;
const ALLOWED_ROLES = new Set(['author', 'reviewer', 'deployer', 'admin', 'runner']);
const WRITER_ROLES = new Set(['author', 'admin']);
const EVALUATOR_ROLES = new Set(['runner', 'author', 'admin']);
const RELEASE_ROLES = new Set(['author', 'reviewer', 'deployer', 'admin']);
const ID = '[0-9a-f-]+';

function deny() {
  throw new HostedAuthError('auth.denied', 403);
}

function routePolicy(method, pathname) {
  if (typeof pathname !== 'string') return null;
  if (method === 'GET' && pathname === '/api/health') return 'member';
  if (pathname === '/api/projects') return method === 'GET' ? 'member' : method === 'POST' ? 'write' : null;
  if (method === 'POST' && pathname === '/api/examples/eligibility') return 'write';

  let match = pathname.match(new RegExp(`^/api/projects/${ID}$`, 'i'));
  if (match) return method === 'GET' ? 'member' : null;
  match = pathname.match(new RegExp(`^/api/projects/${ID}/rulesets$`, 'i'));
  if (match) return method === 'POST' ? 'write' : null;
  match = pathname.match(new RegExp(`^/api/projects/${ID}/runs$`, 'i'));
  if (match) return method === 'GET' ? 'member' : null;
  match = pathname.match(new RegExp(`^/api/projects/${ID}/audit$`, 'i'));
  if (match) return method === 'GET' ? 'admin' : null;

  match = pathname.match(new RegExp(`^/api/rulesets/${ID}$`, 'i'));
  if (match) return method === 'GET' ? 'member' : method === 'PUT' ? 'write' : null;
  match = pathname.match(new RegExp(`^/api/rulesets/${ID}/versions$`, 'i'));
  if (match) return method === 'GET' ? 'member' : method === 'POST' ? 'write' : null;
  match = pathname.match(new RegExp(`^/api/rulesets/${ID}/versions/${ID}$`, 'i'));
  if (match) return method === 'GET' ? 'member' : null;
  match = pathname.match(new RegExp(`^/api/rulesets/${ID}/versions/${ID}/evaluate$`, 'i'));
  if (match) return method === 'POST' ? 'evaluate' : null;
  match = pathname.match(new RegExp(`^/api/rulesets/${ID}/(validate|evaluate)$`, 'i'));
  if (match) {
    if (match[1].toLowerCase() === 'validate') return method === 'POST' ? 'member' : null;
    return method === 'POST' ? 'evaluate' : null;
  }
  match = pathname.match(new RegExp(`^/api/rulesets/${ID}/releases$`, 'i'));
  if (match) return method === 'GET' ? 'member' : method === 'POST' ? 'release' : null;
  match = pathname.match(new RegExp(`^/api/rulesets/${ID}/releases/[a-z0-9-]+/evaluate$`, 'i'));
  if (match) return method === 'POST' ? 'evaluate' : null;
  return null;
}

export function createHostedMembership({ pool, storeForTenant } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof storeForTenant !== 'function') {
    throw new TypeError('Hosted membership requires a query pool and tenant store resolver.');
  }

  async function lookupMembership(principal) {
    const tenantId = typeof principal?.tenantId === 'string' ? principal.tenantId : '';
    const issuer = typeof principal?.issuer === 'string' ? principal.issuer : '';
    const subject = typeof principal?.subject === 'string' ? principal.subject : '';
    if (!tenantId || tenantId !== tenantId.trim() || !issuer || !subject) deny();

    let result;
    try {
      result = await pool.query(MEMBERSHIP_QUERY, [tenantId, issuer, subject]);
    } catch {
      throw new HostedAuthError('auth.membership_unavailable', 503);
    }
    const rows = result?.rows;
    if (!Array.isArray(rows) || rows.length !== 1) deny();
    const [row] = rows;
    if (row.enabled !== true || row.tenant_id !== tenantId || row.issuer !== issuer || row.subject !== subject ||
        !Array.isArray(row.roles) || row.roles.length === 0 ||
        row.roles.some((role) => typeof role !== 'string' || !ALLOWED_ROLES.has(role))) {
      deny();
    }
    return { tenantId, roles: [...new Set(row.roles)] };
  }

  async function resolveAuthorizedStore({ principal, method, pathname } = {}) {
    const policy = routePolicy(method, pathname);
    if (!policy) deny();
    const membership = await lookupMembership(principal);
    if (policy === 'admin' && !membership.roles.includes('admin')) deny();
    if (policy === 'write' && !membership.roles.some((role) => WRITER_ROLES.has(role))) deny();
    if (policy === 'evaluate' && !membership.roles.some((role) => EVALUATOR_ROLES.has(role))) deny();
    if (policy === 'release' && !membership.roles.some((role) => RELEASE_ROLES.has(role))) deny();

    let store;
    try { store = await storeForTenant(membership.tenantId, principal.subject); }
    catch { deny(); }
    if (!store || typeof store !== 'object') deny();
    return store;
  }

  async function resolveReleaseRoles({ principal, store, rulesetId } = {}) {
    const membership = await lookupMembership(principal);
    if (!store || typeof store.getRuleset !== 'function' || typeof rulesetId !== 'string' || !rulesetId) deny();
    try { await store.getRuleset(rulesetId); }
    catch { deny(); }
    return membership.roles;
  }

  return Object.freeze({ resolveAuthorizedStore, resolveReleaseRoles });
}
