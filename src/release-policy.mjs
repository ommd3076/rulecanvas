import { createHash } from 'node:crypto';

export const RELEASE_ROLES = Object.freeze({ AUTHOR: 'author', REVIEWER: 'reviewer', DEPLOYER: 'deployer', ADMIN: 'admin' });
export const RELEASE_STATUS = Object.freeze({ PENDING_REVIEW: 'pending_review', APPROVED: 'approved', REJECTED: 'rejected' });
export const RELEASE_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'release.invalid_argument',
  INVALID_ACTOR: 'release.invalid_actor',
  UNAUTHORIZED_ROLE: 'release.unauthorized_role',
  SEPARATION_OF_DUTIES: 'release.separation_of_duties',
  INVALID_RATIONALE: 'release.invalid_rationale',
  INVALID_HASH: 'release.invalid_hash',
  HASH_MISMATCH: 'release.hash_mismatch',
  INVALID_STATE: 'release.invalid_state',
  INVALID_ENVIRONMENT: 'release.invalid_environment',
  VERSION_NOT_APPROVED: 'release.version_not_approved',
  DUPLICATE_VERSION: 'release.duplicate_version',
  DEPLOYMENT_CONFLICT: 'release.deployment_conflict',
  NO_ACTIVE_DEPLOYMENT: 'release.no_active_deployment',
  ROLLBACK_TARGET_INVALID: 'release.rollback_target_invalid',
});

const HASH_RE = /^[a-f0-9]{64}$/i;
const DEFAULT_ENVIRONMENTS = ['staging', 'production'];

export class ReleasePolicyError extends Error {
  constructor(code, status = 400) {
    super('Release policy rejected the requested transition.');
    this.name = 'ReleasePolicyError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) {
  throw new ReleasePolicyError(code, status);
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function copyState(state) {
  if (!state || !Array.isArray(state.releases) || !Array.isArray(state.deployments) || !Array.isArray(state.auditTrail)) {
    fail(RELEASE_ERROR_CODES.INVALID_STATE, 500);
  }
  return structuredClone(state);
}

function normalizeId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function identityKey(rulesetId, versionId) {
  return `${encodeURIComponent(rulesetId)}::${encodeURIComponent(versionId)}`;
}

function validateHash(hash) {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) fail(RELEASE_ERROR_CODES.INVALID_HASH, 400);
  return hash.toLowerCase();
}

export function computeGraphHash(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) fail(RELEASE_ERROR_CODES.INVALID_ARGUMENT, 422);
  let serialized;
  try { serialized = JSON.stringify(graph); }
  catch { fail(RELEASE_ERROR_CODES.INVALID_ARGUMENT, 422); }
  if (typeof serialized !== 'string') fail(RELEASE_ERROR_CODES.INVALID_ARGUMENT, 422);
  return createHash('sha256').update(serialized).digest('hex');
}

function validateVersion(version, suppliedHash) {
  if (!version || typeof version !== 'object' || Array.isArray(version)) fail(RELEASE_ERROR_CODES.INVALID_ARGUMENT, 422);
  const versionId = normalizeId(version.id);
  const rulesetId = normalizeId(version.rulesetId);
  const projectId = normalizeId(version.projectId);
  if (!versionId || !rulesetId || !projectId || !Number.isInteger(version.versionNumber) || version.versionNumber < 1 ||
      !Number.isInteger(version.sourceRevision) || version.sourceRevision < 1) {
    fail(RELEASE_ERROR_CODES.INVALID_ARGUMENT, 422);
  }
  const computedHash = computeGraphHash(version.graph);
  const storedHash = validateHash(version.graphHash);
  const inputHash = validateHash(suppliedHash);
  if (computedHash !== storedHash || computedHash !== inputHash) fail(RELEASE_ERROR_CODES.HASH_MISMATCH, 409);
  return Object.freeze({
    versionId,
    rulesetId,
    projectId,
    versionNumber: version.versionNumber,
    sourceRevision: version.sourceRevision,
    graphHash: computedHash,
    name: typeof version.name === 'string' ? version.name : '',
    createdAt: typeof version.createdAt === 'string' ? version.createdAt : null,
  });
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) fail(RELEASE_ERROR_CODES.INVALID_ACTOR, 401);
  const id = normalizeId(actor.id);
  if (!id || !Array.isArray(actor.roles) || actor.roles.length === 0 ||
      actor.roles.some((role) => typeof role !== 'string' || !role.trim())) {
    fail(RELEASE_ERROR_CODES.INVALID_ACTOR, 401);
  }
  return Object.freeze({
    id,
    name: typeof actor.name === 'string' && actor.name.trim() ? actor.name.trim() : id,
    roles: [...new Set(actor.roles.map((role) => role.trim().toLowerCase()))],
  });
}

function requireRole(actor, role) {
  if (!actor.roles.includes(role) && !actor.roles.includes(RELEASE_ROLES.ADMIN)) {
    fail(RELEASE_ERROR_CODES.UNAUTHORIZED_ROLE, 403);
  }
}

function validateRationale(rationale) {
  if (typeof rationale !== 'string' || rationale.trim().length < 5 || rationale.trim().length > 1000) {
    fail(RELEASE_ERROR_CODES.INVALID_RATIONALE, 422);
  }
  return rationale.trim();
}

function validateTimestamp(timestamp) {
  if (timestamp === undefined) return new Date().toISOString();
  if (typeof timestamp !== 'string') fail(RELEASE_ERROR_CODES.INVALID_ARGUMENT, 422);
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== timestamp) fail(RELEASE_ERROR_CODES.INVALID_ARGUMENT, 422);
  return timestamp;
}

function appendAudit(state, { action, actor, rationale, timestamp, release, environment = null, previousVersionId = null, nextVersionId = null }) {
  state.auditTrail.push({
    id: `audit-${state.auditTrail.length + 1}`,
    action,
    timestamp,
    actorId: actor.id,
    actorRoles: [...actor.roles],
    rationale,
    rulesetId: release?.rulesetId ?? null,
    versionId: release?.versionId ?? null,
    versionHash: release?.graphHash ?? null,
    environment,
    previousVersionId,
    nextVersionId,
  });
}

function findRelease(state, rulesetId, versionId) {
  const key = identityKey(rulesetId, versionId);
  return state.releases.find((release) => release.key === key) ?? null;
}

function requireMatchingRelease(state, rulesetId, versionId, versionHash) {
  const ruleset = normalizeId(rulesetId);
  const version = normalizeId(versionId);
  if (!ruleset || !version) fail(RELEASE_ERROR_CODES.INVALID_ARGUMENT, 400);
  const release = findRelease(state, ruleset, version);
  if (!release) fail(RELEASE_ERROR_CODES.INVALID_STATE, 404);
  if (validateHash(versionHash) !== release.graphHash) fail(RELEASE_ERROR_CODES.HASH_MISMATCH, 409);
  return release;
}

function assertSeparationOfDuties(release, actor, role) {
  if (release.proposedBy.id === actor.id) fail(RELEASE_ERROR_CODES.SEPARATION_OF_DUTIES, 403);
  if (role === RELEASE_ROLES.DEPLOYER && release.approvedBy?.id === actor.id) {
    fail(RELEASE_ERROR_CODES.SEPARATION_OF_DUTIES, 403);
  }
}

function environmentName(state, value) {
  const environment = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!environment || !state.environments.includes(environment)) fail(RELEASE_ERROR_CODES.INVALID_ENVIRONMENT, 400);
  return environment;
}

function findDeployment(state, rulesetId, environment) {
  return state.deployments.find((deployment) => deployment.rulesetId === rulesetId && deployment.environment === environment) ?? null;
}

function requireCas(params, current) {
  if (!Object.hasOwn(params, 'expectedActiveVersionId')) fail(RELEASE_ERROR_CODES.INVALID_ARGUMENT, 400);
  const actual = current?.versionId ?? null;
  if (params.expectedActiveVersionId !== actual) fail(RELEASE_ERROR_CODES.DEPLOYMENT_CONFLICT, 409);
}

function setDeployment(state, release, environment, timestamp, action) {
  const existing = findDeployment(state, release.rulesetId, environment);
  const history = [
    ...(existing?.history ?? []),
    { versionId: release.versionId, versionHash: release.graphHash, action, at: timestamp },
  ];
  const pointer = {
    rulesetId: release.rulesetId,
    environment,
    versionId: release.versionId,
    versionHash: release.graphHash,
    updatedAt: timestamp,
    history,
  };
  if (existing) Object.assign(existing, pointer);
  else state.deployments.push(pointer);
}

export function createReleasePolicyState(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail(RELEASE_ERROR_CODES.INVALID_ARGUMENT, 400);
  const environments = options.environments ?? DEFAULT_ENVIRONMENTS;
  if (!Array.isArray(environments) || environments.length === 0 || environments.some((value) => typeof value !== 'string' || !value.trim())) {
    fail(RELEASE_ERROR_CODES.INVALID_ENVIRONMENT, 400);
  }
  return freezeDeep({
    releases: [],
    deployments: [],
    auditTrail: [],
    environments: [...new Set(environments.map((value) => value.trim().toLowerCase()))],
    enforceSeparationOfDuties: options.enforceSeparationOfDuties !== false,
  });
}

/** Propose exactly the immutable store version supplied by the trusted adapter. */
export function proposeRelease(state, params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail(RELEASE_ERROR_CODES.INVALID_ARGUMENT, 400);
  const { version, versionHash, actor, rationale, timestamp } = params;
  const metadata = validateVersion(version, versionHash);
  const normalizedActor = normalizeActor(actor);
  requireRole(normalizedActor, RELEASE_ROLES.AUTHOR);
  const reason = validateRationale(rationale);
  const at = validateTimestamp(timestamp);
  const draft = copyState(state);
  const key = identityKey(metadata.rulesetId, metadata.versionId);
  if (draft.releases.some((release) => release.key === key)) fail(RELEASE_ERROR_CODES.DUPLICATE_VERSION, 409);
  const release = {
    key,
    ...metadata,
    status: RELEASE_STATUS.PENDING_REVIEW,
    proposedAt: at,
    proposedBy: normalizedActor,
    proposalRationale: reason,
    approvedAt: null,
    approvedBy: null,
    approvalRationale: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectionRationale: null,
  };
  draft.releases.push(release);
  appendAudit(draft, { action: 'propose', actor: normalizedActor, rationale: reason, timestamp: at, release });
  return freezeDeep(draft);
}

export function approveRelease(state, params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail(RELEASE_ERROR_CODES.INVALID_ARGUMENT, 400);
  const { rulesetId, versionId, versionHash, actor, rationale, timestamp } = params;
  const release = requireMatchingRelease(state, rulesetId, versionId, versionHash);
  if (release.status !== RELEASE_STATUS.PENDING_REVIEW) fail(RELEASE_ERROR_CODES.INVALID_STATE, 409);
  const normalizedActor = normalizeActor(actor);
  requireRole(normalizedActor, RELEASE_ROLES.REVIEWER);
  if (state.enforceSeparationOfDuties) assertSeparationOfDuties(release, normalizedActor, RELEASE_ROLES.REVIEWER);
  const reason = validateRationale(rationale);
  const at = validateTimestamp(timestamp);
  const draft = copyState(state);
  const target = findRelease(draft, release.rulesetId, release.versionId);
  Object.assign(target, {
    status: RELEASE_STATUS.APPROVED,
    approvedAt: at,
    approvedBy: normalizedActor,
    approvalRationale: reason,
  });
  appendAudit(draft, { action: 'approve', actor: normalizedActor, rationale: reason, timestamp: at, release: target });
  return freezeDeep(draft);
}

export function rejectRelease(state, params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail(RELEASE_ERROR_CODES.INVALID_ARGUMENT, 400);
  const { rulesetId, versionId, versionHash, actor, rationale, timestamp } = params;
  const release = requireMatchingRelease(state, rulesetId, versionId, versionHash);
  if (release.status !== RELEASE_STATUS.PENDING_REVIEW) fail(RELEASE_ERROR_CODES.INVALID_STATE, 409);
  const normalizedActor = normalizeActor(actor);
  requireRole(normalizedActor, RELEASE_ROLES.REVIEWER);
  if (state.enforceSeparationOfDuties) assertSeparationOfDuties(release, normalizedActor, RELEASE_ROLES.REVIEWER);
  const reason = validateRationale(rationale);
  const at = validateTimestamp(timestamp);
  const draft = copyState(state);
  const target = findRelease(draft, release.rulesetId, release.versionId);
  Object.assign(target, {
    status: RELEASE_STATUS.REJECTED,
    rejectedAt: at,
    rejectedBy: normalizedActor,
    rejectionRationale: reason,
  });
  appendAudit(draft, { action: 'reject', actor: normalizedActor, rationale: reason, timestamp: at, release: target });
  return freezeDeep(draft);
}

function deploy(state, params, action) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail(RELEASE_ERROR_CODES.INVALID_ARGUMENT, 400);
  const release = requireMatchingRelease(state, params.rulesetId, params.versionId, params.versionHash);
  if (release.status !== RELEASE_STATUS.APPROVED) fail(RELEASE_ERROR_CODES.VERSION_NOT_APPROVED, 422);
  const actor = normalizeActor(params.actor);
  requireRole(actor, RELEASE_ROLES.DEPLOYER);
  if (state.enforceSeparationOfDuties) assertSeparationOfDuties(release, actor, RELEASE_ROLES.DEPLOYER);
  const rationale = validateRationale(params.rationale);
  const timestamp = validateTimestamp(params.timestamp);
  const environment = environmentName(state, params.environment);
  const current = findDeployment(state, release.rulesetId, environment);

  if (action === 'rollback' && !current) fail(RELEASE_ERROR_CODES.NO_ACTIVE_DEPLOYMENT, 409);
  if (action === 'rollback' && !current.history.some((entry) => entry.versionId === release.versionId)) {
    fail(RELEASE_ERROR_CODES.ROLLBACK_TARGET_INVALID, 409);
  }
  requireCas(params, current);
  if (current?.versionId === release.versionId) fail(RELEASE_ERROR_CODES.DEPLOYMENT_CONFLICT, 409);

  const draft = copyState(state);
  const previousVersionId = current?.versionId ?? null;
  setDeployment(draft, release, environment, timestamp, action);
  appendAudit(draft, {
    action,
    actor,
    rationale,
    timestamp,
    release,
    environment,
    previousVersionId,
    nextVersionId: release.versionId,
  });
  return freezeDeep(draft);
}

export function activateRelease(state, params = {}) {
  return deploy(state, params, 'activate');
}

export function rollbackRelease(state, params = {}) {
  return deploy(state, params, 'rollback');
}

export function getRelease(state, rulesetId, versionId) {
  const release = findRelease(state, normalizeId(rulesetId), normalizeId(versionId));
  return release ? structuredClone(release) : null;
}

export function getDeployment(state, rulesetId, environment) {
  const env = typeof environment === 'string' ? environment.trim().toLowerCase() : '';
  const deployment = findDeployment(state, normalizeId(rulesetId), env);
  return deployment ? structuredClone(deployment) : null;
}

export function getActiveVersionId(state, rulesetId, environment) {
  return getDeployment(state, rulesetId, environment)?.versionId ?? null;
}

export function listReleases(state, rulesetId = null) {
  const list = rulesetId ? state.releases.filter((release) => release.rulesetId === rulesetId) : state.releases;
  return structuredClone(list);
}

export function getAuditTrail(state) {
  return structuredClone(state.auditTrail);
}
