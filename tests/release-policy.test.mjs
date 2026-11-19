import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RELEASE_ERROR_CODES,
  RELEASE_ROLES,
  RELEASE_STATUS,
  ReleasePolicyError,
  activateRelease,
  approveRelease,
  computeGraphHash,
  createReleasePolicyState,
  getActiveVersionId,
  getDeployment,
  getRelease,
  listReleases,
  proposeRelease,
  rejectRelease,
  rollbackRelease,
} from '../src/release-policy.mjs';

const graphA = { schema: [], nodes: [{ id: 'start', type: 'start' }], edges: [] };
const graphB = { schema: [], nodes: [{ id: 'start', type: 'start' }, { id: 'out', type: 'outcome' }], edges: [] };
const timestamp = '2026-11-19T12:00:00.000Z';
const author = { id: 'author-1', roles: [RELEASE_ROLES.AUTHOR] };
const reviewer = { id: 'reviewer-1', roles: [RELEASE_ROLES.REVIEWER] };
const deployer = { id: 'deployer-1', roles: [RELEASE_ROLES.DEPLOYER] };
const rationale = 'Reviewed for controlled release';

function version({ id = 'version-1', rulesetId = 'ruleset-1', graph = graphA, projectId = 'project-1' } = {}) {
  return {
    id,
    rulesetId,
    projectId,
    versionNumber: 1,
    sourceRevision: 3,
    name: 'Version 1',
    graph,
    graphHash: computeGraphHash(graph),
    createdAt: timestamp,
  };
}

function propose(state, target, actor = author) {
  return proposeRelease(state, { version: target, versionHash: target.graphHash, actor, rationale, timestamp });
}

function approve(state, target, actor = reviewer) {
  return approveRelease(state, {
    rulesetId: target.rulesetId,
    versionId: target.id,
    versionHash: target.graphHash,
    actor,
    rationale,
    timestamp,
  });
}

function expectPolicyError(action, code) {
  assert.throws(action, (error) => error instanceof ReleasePolicyError && error.code === code);
}

function ready(target, initialState = createReleasePolicyState(), proposingActor = author, approvingActor = reviewer) {
  return approve(propose(initialState, target, proposingActor), target, approvingActor);
}

test('keys releases by ruleset and immutable version identity even when graph hashes match', () => {
  const state = createReleasePolicyState();
  const left = version({ id: 'version-1', rulesetId: 'ruleset-left' });
  const right = version({ id: 'version-1', rulesetId: 'ruleset-right' });
  assert.equal(left.graphHash, right.graphHash);

  const next = propose(propose(state, left), right);
  assert.equal(listReleases(next).length, 2);
  assert.equal(getRelease(next, 'ruleset-left', 'version-1').rulesetId, 'ruleset-left');
  assert.equal(getRelease(next, 'ruleset-right', 'version-1').rulesetId, 'ruleset-right');
  assert.equal(state.releases.length, 0);
});

test('derives immutable metadata from the store version and rejects hash or identity mismatches', () => {
  const target = version();
  expectPolicyError(() => proposeRelease(createReleasePolicyState(), {
    version: { ...target, graph: graphB }, versionHash: target.graphHash, actor: author, rationale, timestamp,
  }), RELEASE_ERROR_CODES.HASH_MISMATCH);
  expectPolicyError(() => proposeRelease(createReleasePolicyState(), {
    version: target, versionHash: 'a'.repeat(64), actor: author, rationale, timestamp,
  }), RELEASE_ERROR_CODES.HASH_MISMATCH);

  const state = propose(createReleasePolicyState(), target);
  expectPolicyError(() => approveRelease(state, {
    rulesetId: 'other-ruleset', versionId: target.id, versionHash: target.graphHash, actor: reviewer, rationale, timestamp,
  }), RELEASE_ERROR_CODES.INVALID_STATE);
  expectPolicyError(() => approveRelease(state, {
    rulesetId: target.rulesetId, versionId: 'other-version', versionHash: target.graphHash, actor: reviewer, rationale, timestamp,
  }), RELEASE_ERROR_CODES.INVALID_STATE);
  expectPolicyError(() => approveRelease(state, {
    rulesetId: target.rulesetId, versionId: target.id, versionHash: 'b'.repeat(64), actor: reviewer, rationale, timestamp,
  }), RELEASE_ERROR_CODES.HASH_MISMATCH);

  const stored = getRelease(state, target.rulesetId, target.id);
  assert.equal(stored.projectId, target.projectId);
  assert.equal(stored.versionNumber, target.versionNumber);
  assert.equal(stored.sourceRevision, target.sourceRevision);
  assert.equal(Object.hasOwn(stored, 'graph'), false);
});

test('requires server-provided actor roles and enforces role checks', () => {
  const target = version();
  expectPolicyError(() => proposeRelease(createReleasePolicyState(), { version: target, versionHash: target.graphHash, actor: { id: 'no-roles' }, rationale, timestamp }), RELEASE_ERROR_CODES.INVALID_ACTOR);
  expectPolicyError(() => proposeRelease(createReleasePolicyState(), { version: target, versionHash: target.graphHash, actor: { id: 'empty', roles: [] }, rationale, timestamp }), RELEASE_ERROR_CODES.INVALID_ACTOR);

  const state = propose(createReleasePolicyState(), target);
  expectPolicyError(() => approveRelease(state, {
    rulesetId: target.rulesetId, versionId: target.id, versionHash: target.graphHash,
    actor: { id: 'author-only', roles: ['author'] }, rationale, timestamp,
  }), RELEASE_ERROR_CODES.UNAUTHORIZED_ROLE);
  expectPolicyError(() => rejectRelease(state, {
    rulesetId: target.rulesetId, versionId: target.id, versionHash: target.graphHash,
    actor: { id: 'deployer-only', roles: ['deployer'] }, rationale, timestamp,
  }), RELEASE_ERROR_CODES.UNAUTHORIZED_ROLE);
});

test('preserves rejection history and rejects another proposal for the same ruleset/version', () => {
  const target = version();
  let state = propose(createReleasePolicyState(), target);
  state = rejectRelease(state, {
    rulesetId: target.rulesetId,
    versionId: target.id,
    versionHash: target.graphHash,
    actor: reviewer,
    rationale: 'Needs another review cycle',
    timestamp,
  });
  assert.equal(getRelease(state, target.rulesetId, target.id).status, RELEASE_STATUS.REJECTED);
  expectPolicyError(() => propose(state, target), RELEASE_ERROR_CODES.DUPLICATE_VERSION);
  assert.equal(state.auditTrail.at(-1).action, 'reject');
});

test('keeps deployment pointers independent by ruleset and environment and uses compare-and-swap', () => {
  const left = version({ id: 'left-v1', rulesetId: 'ruleset-left' });
  const right = version({ id: 'right-v1', rulesetId: 'ruleset-right' });
  let state = ready(left);
  state = propose(state, right);
  state = approve(state, right);
  state = activateRelease(state, {
    rulesetId: left.rulesetId, versionId: left.id, versionHash: left.graphHash,
    environment: 'staging', expectedActiveVersionId: null, actor: deployer, rationale, timestamp,
  });
  state = activateRelease(state, {
    rulesetId: left.rulesetId, versionId: left.id, versionHash: left.graphHash,
    environment: 'production', expectedActiveVersionId: null, actor: deployer, rationale, timestamp,
  });
  state = activateRelease(state, {
    rulesetId: right.rulesetId, versionId: right.id, versionHash: right.graphHash,
    environment: 'staging', expectedActiveVersionId: null, actor: deployer, rationale, timestamp,
  });
  assert.equal(getActiveVersionId(state, 'ruleset-left', 'staging'), left.id);
  assert.equal(getActiveVersionId(state, 'ruleset-left', 'production'), left.id);
  assert.equal(getActiveVersionId(state, 'ruleset-right', 'staging'), right.id);
  assert.equal(getActiveVersionId(state, 'ruleset-right', 'production'), null);
  expectPolicyError(() => activateRelease(state, {
    rulesetId: left.rulesetId, versionId: left.id, versionHash: left.graphHash,
    environment: 'staging', expectedActiveVersionId: null, actor: deployer, rationale, timestamp,
  }), RELEASE_ERROR_CODES.DEPLOYMENT_CONFLICT);
  assert.deepEqual(getDeployment(state, left.rulesetId, 'staging'), {
    rulesetId: left.rulesetId, environment: 'staging', versionId: left.id,
    versionHash: left.graphHash, updatedAt: timestamp,
    history: [{ versionId: left.id, versionHash: left.graphHash, action: 'activate', at: timestamp }],
  });
});

test('rolls back only after CAS and applies the same deploy separation rules as activation', () => {
  const first = version({ id: 'v1', graph: graphA });
  const second = version({ id: 'v2', graph: graphB });
  const neverDeployed = version({ id: 'v3', graph: { ...graphA, marker: true } });
  let state = ready(first);
  state = propose(state, second);
  state = approve(state, second);
  state = propose(state, neverDeployed);
  state = approve(state, neverDeployed);
  state = activateRelease(state, {
    rulesetId: first.rulesetId, versionId: first.id, versionHash: first.graphHash,
    environment: 'production', expectedActiveVersionId: null, actor: deployer, rationale, timestamp,
  });
  state = activateRelease(state, {
    rulesetId: second.rulesetId, versionId: second.id, versionHash: second.graphHash,
    environment: 'production', expectedActiveVersionId: first.id, actor: deployer, rationale, timestamp,
  });
  expectPolicyError(() => rollbackRelease(state, {
    rulesetId: neverDeployed.rulesetId, versionId: neverDeployed.id, versionHash: neverDeployed.graphHash,
    environment: 'production', expectedActiveVersionId: second.id, actor: deployer, rationale, timestamp,
  }), RELEASE_ERROR_CODES.ROLLBACK_TARGET_INVALID);
  expectPolicyError(() => rollbackRelease(state, {
    rulesetId: first.rulesetId, versionId: first.id, versionHash: first.graphHash,
    environment: 'production', expectedActiveVersionId: first.id, actor: deployer, rationale, timestamp,
  }), RELEASE_ERROR_CODES.DEPLOYMENT_CONFLICT);
  state = rollbackRelease(state, {
    rulesetId: first.rulesetId, versionId: first.id, versionHash: first.graphHash,
    environment: 'production', expectedActiveVersionId: second.id, actor: deployer, rationale, timestamp,
  });
  assert.equal(getActiveVersionId(state, first.rulesetId, 'production'), first.id);

  const approvedByDeployer = { id: 'review-deployer', roles: ['reviewer', 'deployer'] };
  let sodState = ready(first, createReleasePolicyState(), author, approvedByDeployer);
  sodState = activateRelease(sodState, {
    rulesetId: first.rulesetId, versionId: first.id, versionHash: first.graphHash,
    environment: 'production', expectedActiveVersionId: null, actor: deployer, rationale, timestamp,
  });
  sodState = propose(sodState, second);
  sodState = approve(sodState, second, reviewer);
  sodState = activateRelease(sodState, {
    rulesetId: second.rulesetId, versionId: second.id, versionHash: second.graphHash,
    environment: 'production', expectedActiveVersionId: first.id, actor: deployer, rationale, timestamp,
  });
  expectPolicyError(() => rollbackRelease(sodState, {
    rulesetId: first.rulesetId, versionId: first.id, versionHash: first.graphHash,
    environment: 'production', expectedActiveVersionId: second.id,
    actor: approvedByDeployer, rationale, timestamp,
  }), RELEASE_ERROR_CODES.SEPARATION_OF_DUTIES);
});

test('requires an explicit current pointer and valid ISO timestamps', () => {
  const target = version();
  const state = ready(target);
  expectPolicyError(() => activateRelease(state, {
    rulesetId: target.rulesetId, versionId: target.id, versionHash: target.graphHash,
    environment: 'staging', actor: deployer, rationale, timestamp,
  }), RELEASE_ERROR_CODES.INVALID_ARGUMENT);
  expectPolicyError(() => activateRelease(state, {
    rulesetId: target.rulesetId, versionId: target.id, versionHash: target.graphHash,
    environment: 'staging', expectedActiveVersionId: null, actor: deployer, rationale, timestamp: 'tomorrow',
  }), RELEASE_ERROR_CODES.INVALID_ARGUMENT);
});
