import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createPostgresWorkspaceBackend,
  validateTenantId,
  PostgresWorkspaceError,
  DEFAULT_WORKSPACE_TABLE,
} from '../src/postgres-workspace.mjs';
import { JsonStore } from '../src/storage.mjs';
import { createHostedMembership } from '../src/hosted-membership.mjs';
import { preparePostgresTestSchema } from './postgres-test-schema.mjs';

/**
 * Creates an in-memory mock node-postgres Pool for comprehensive unit testing
 * with connection lifecycle and query tracking.
 */
function createMockPool(initialRows = new Map()) {
  const store = new Map(initialRows);
  let acquiredCount = 0;
  let releasedCount = 0;
  const queryLog = [];

  class MockClient {
    constructor() {
      this.inTransaction = false;
      this.released = false;
    }

    async query(sql, params = []) {
      if (this.released) {
        throw new Error('Cannot execute query on released client.');
      }
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();
      queryLog.push({ sql: normalizedSql, params });

      if (normalizedSql === 'BEGIN') {
        this.inTransaction = true;
        return { rows: [], rowCount: 0 };
      }

      if (normalizedSql === 'COMMIT') {
        if (!this.inTransaction) throw new Error('COMMIT without transaction');
        this.inTransaction = false;
        return { rows: [], rowCount: 0 };
      }

      if (normalizedSql === 'ROLLBACK') {
        this.inTransaction = false;
        return { rows: [], rowCount: 0 };
      }

      if (normalizedSql.startsWith('SELECT pg_advisory_xact_lock')) {
        return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
      }

      // SELECT contents FROM table WHERE tenant_id = $1 [FOR UPDATE]
      if (normalizedSql.startsWith('SELECT contents FROM')) {
        const tenantId = params[0];
        const row = store.get(tenantId);
        if (!row) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ contents: row.contents }], rowCount: 1 };
      }

      // INSERT INTO table (tenant_id, contents, updated_at) VALUES ($1, $2, ...) ON CONFLICT ...
      if (normalizedSql.startsWith('INSERT INTO')) {
        const [tenantId, contents] = params;
        store.set(tenantId, {
          tenant_id: tenantId,
          contents,
          updated_at: new Date().toISOString(),
        });
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unhandled mock SQL query: ${normalizedSql}`);
    }

    release() {
      if (!this.released) {
        this.released = true;
        releasedCount += 1;
      }
    }
  }

  return {
    async connect() {
      acquiredCount += 1;
      return new MockClient();
    },
    get acquiredCount() {
      return acquiredCount;
    },
    get releasedCount() {
      return releasedCount;
    },
    get activeClients() {
      return acquiredCount - releasedCount;
    },
    get queryLog() {
      return [...queryLog];
    },
    getStore() {
      return store;
    },
    clearLog() {
      queryLog.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. TENANT ID VALIDATION TESTS
// ---------------------------------------------------------------------------

test('validateTenantId: accepts valid tenant identifiers', () => {
  const validIds = [
    'tenant-123',
    'tenant_abc',
    'tenant.finance.corp',
    'AcmeCorp-2026',
    'a',
    '12345',
    randomUUID(),
  ];

  for (const id of validIds) {
    assert.equal(validateTenantId(id), id);
  }
});

test('validateTenantId: rejects invalid or dangerous tenant identifiers', () => {
  const invalidCases = [
    null,
    undefined,
    123,
    {},
    [],
    '',
    '   ',
    ' tenant ',
    'tenant/subpath',
    '../escape',
    'tenant; DROP TABLE workspaces;',
    'tenant"name',
    'tenant\x00nullbyte',
    'x'.repeat(129),
  ];

  for (const bad of invalidCases) {
    assert.throws(
      () => validateTenantId(bad),
      (err) => {
        assert.ok(err instanceof PostgresWorkspaceError);
        assert.equal(err.code, 'workspace.invalid_tenant');
        assert.equal(err.status, 400);
        return true;
      }
    );
  }
});

test('createPostgresWorkspaceBackend: validates pool and tenantId arguments', () => {
  assert.throws(
    () => createPostgresWorkspaceBackend({ pool: null, tenantId: 'tenant-1' }),
    (err) => {
      assert.ok(err instanceof PostgresWorkspaceError);
      assert.equal(err.code, 'workspace.invalid_pool');
      return true;
    }
  );

  assert.throws(
    () => createPostgresWorkspaceBackend({ pool: {}, tenantId: 'tenant-1' }),
    (err) => {
      assert.ok(err instanceof PostgresWorkspaceError);
      assert.equal(err.code, 'workspace.invalid_pool');
      return true;
    }
  );

  assert.throws(
    () => createPostgresWorkspaceBackend({ pool: { connect: () => {} }, tenantId: '' }),
    (err) => {
      assert.ok(err instanceof PostgresWorkspaceError);
      assert.equal(err.code, 'workspace.invalid_tenant');
      return true;
    }
  );

  assert.throws(
    () => createPostgresWorkspaceBackend({ pool: { connect: () => {} }, tenantId: 't1', tableName: 'bad;table' }),
    (err) => {
      assert.ok(err instanceof PostgresWorkspaceError);
      assert.equal(err.code, 'workspace.invalid_table');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 2. READ OPERATIONS AND CONNECTION RELEASING
// ---------------------------------------------------------------------------

test('read(): returns null when tenant workspace row does not exist', async () => {
  const pool = createMockPool();
  const backend = createPostgresWorkspaceBackend({ pool, tenantId: 'tenant-empty' });

  const result = await backend.read();
  assert.equal(result, null);

  assert.equal(pool.acquiredCount, 1);
  assert.equal(pool.releasedCount, 1);
  assert.equal(pool.activeClients, 0);

  const [query] = pool.queryLog;
  assert.match(query.sql, /SELECT contents FROM rulecanvas_workspaces WHERE tenant_id = \$1/);
  assert.deepEqual(query.params, ['tenant-empty']);
});

test('read(): returns exact serialized JSON string when row exists', async () => {
  const existingJson = '{"schemaVersion":1,"projects":[{"id":"p1","name":"Alpha"}]}';
  const pool = createMockPool(new Map([['tenant-alpha', { contents: existingJson }]]));
  const backend = createPostgresWorkspaceBackend({ pool, tenantId: 'tenant-alpha' });

  const result = await backend.read();
  assert.equal(result, existingJson);

  assert.equal(pool.acquiredCount, 1);
  assert.equal(pool.releasedCount, 1);
  assert.equal(pool.activeClients, 0);
});

test('read(): always releases client connection even if query fails', async () => {
  let released = false;
  const failingPool = {
    async connect() {
      return {
        async query() {
          throw new Error('Database connection reset');
        },
        release() {
          released = true;
        },
      };
    },
  };

  const backend = createPostgresWorkspaceBackend({ pool: failingPool, tenantId: 'tenant-failing' });

  await assert.rejects(backend.read(), /Database connection reset/);
  assert.equal(released, true);
});

// ---------------------------------------------------------------------------
// 3. TRANSACTIONAL UPSERT, ROW LOCKING, AND REDUCER
// ---------------------------------------------------------------------------

test('transact(): initial write on empty workspace passes null to reducer and inserts row', async () => {
  const pool = createMockPool();
  const backend = createPostgresWorkspaceBackend({ pool, tenantId: 'tenant-new' });

  const newWorkspaceJson = '{"schemaVersion":1,"projects":[{"id":"p100","name":"Initial"}]}';
  const reducerValue = { projectId: 'p100', status: 'created' };

  let receivedContents = undefined;
  const transactResult = await backend.transact(async (contents) => {
    receivedContents = contents;
    return {
      contents: newWorkspaceJson,
      value: reducerValue,
    };
  });

  assert.equal(receivedContents, null);
  assert.deepEqual(transactResult, reducerValue);

  // Verify DB state
  const stored = pool.getStore().get('tenant-new');
  assert.ok(stored);
  assert.equal(stored.contents, newWorkspaceJson);

  // Verify connection release
  assert.equal(pool.acquiredCount, 1);
  assert.equal(pool.releasedCount, 1);
  assert.equal(pool.activeClients, 0);

  // Verify query sequencing: BEGIN -> advisory lock -> SELECT FOR UPDATE -> INSERT ON CONFLICT -> COMMIT
  const sqlSequence = pool.queryLog.map((q) => q.sql);
  assert.equal(sqlSequence[0], 'BEGIN');
  assert.ok(sqlSequence.some((sql) => sql.includes('FOR UPDATE')));
  assert.ok(sqlSequence.some((sql) => sql.includes('ON CONFLICT (tenant_id) DO UPDATE')));
  assert.equal(sqlSequence[sqlSequence.length - 1], 'COMMIT');
});

test('transact(): update passes current contents to reducer and updates existing row', async () => {
  const initialJson = '{"schemaVersion":1,"projects":[{"id":"p1"}]}';
  const pool = createMockPool(new Map([['tenant-update', { contents: initialJson }]]));
  const backend = createPostgresWorkspaceBackend({ pool, tenantId: 'tenant-update' });

  let seenContents = null;
  const result = await backend.transact(async (contents) => {
    seenContents = contents;
    const parsed = JSON.parse(contents);
    parsed.projects.push({ id: 'p2' });
    return {
      contents: JSON.stringify(parsed),
      value: { count: parsed.projects.length },
    };
  });

  assert.equal(seenContents, initialJson);
  assert.deepEqual(result, { count: 2 });

  const updatedStored = pool.getStore().get('tenant-update');
  assert.equal(updatedStored.contents, '{"schemaVersion":1,"projects":[{"id":"p1"},{"id":"p2"}]}');
  assert.equal(pool.activeClients, 0);
});

test('transact(): rolls back and releases client when reducer throws', async () => {
  const pool = createMockPool();
  const backend = createPostgresWorkspaceBackend({ pool, tenantId: 'tenant-err' });

  await assert.rejects(
    backend.transact(async () => {
      throw new Error('Reducer business logic failure');
    }),
    /Reducer business logic failure/
  );

  assert.equal(pool.getStore().has('tenant-err'), false);
  assert.equal(pool.acquiredCount, 1);
  assert.equal(pool.releasedCount, 1);
  assert.equal(pool.activeClients, 0);

  const lastQuery = pool.queryLog[pool.queryLog.length - 1];
  assert.equal(lastQuery.sql, 'ROLLBACK');
});

test('transact(): rejects reducer that returns invalid shape or non-string contents', async () => {
  const pool = createMockPool();
  const backend = createPostgresWorkspaceBackend({ pool, tenantId: 'tenant-invalid-output' });

  // 1. Reducer returns non-object
  await assert.rejects(
    backend.transact(async () => 'just-a-string'),
    (err) => err instanceof PostgresWorkspaceError && err.code === 'workspace.invalid_reducer_output'
  );

  // 2. Reducer returns object without contents or with non-string contents
  await assert.rejects(
    backend.transact(async () => ({ contents: 12345 })),
    (err) => err instanceof PostgresWorkspaceError && err.code === 'workspace.invalid_contents'
  );

  await assert.rejects(
    backend.transact(async () => ({ value: 'missing-contents' })),
    (err) => err instanceof PostgresWorkspaceError && err.code === 'workspace.invalid_contents'
  );

  assert.equal(pool.activeClients, 0);
});

// ---------------------------------------------------------------------------
// 4. SHA-256 HASH PRESERVATION (TEXT VS JSONB)
// ---------------------------------------------------------------------------

test('preserves exact byte-for-byte serialization and SHA-256 graph hashes in TEXT column', async () => {
  const pool = createMockPool();
  const backend = createPostgresWorkspaceBackend({ pool, tenantId: 'tenant-hash-test' });

  // Object with intentionally non-alphabetical keys
  // In JSONB, PostgreSQL would reorder keys: {"a": 2, "z": 1}
  // With TEXT storage, exact key ordering is guaranteed byte-for-byte.
  const rawGraphJson = '{"zebraNode":999,"alphaNode":111,"details":{"z":true,"a":false}}';
  const expectedHash = createHash('sha256').update(rawGraphJson).digest('hex');

  await backend.transact(async () => {
    return {
      contents: rawGraphJson,
      value: { expectedHash },
    };
  });

  const readBack = await backend.read();
  assert.equal(readBack, rawGraphJson);

  const actualHash = createHash('sha256').update(readBack).digest('hex');
  assert.equal(actualHash, expectedHash);
});

// ---------------------------------------------------------------------------
// 5. TENANT ISOLATION
// ---------------------------------------------------------------------------

test('tenant isolation: distinct tenants never observe or overwrite each other', async () => {
  const pool = createMockPool();
  const backendA = createPostgresWorkspaceBackend({ pool, tenantId: 'tenant-alpha' });
  const backendB = createPostgresWorkspaceBackend({ pool, tenantId: 'tenant-beta' });

  // Write tenant A
  await backendA.transact(async () => ({
    contents: '{"tenant":"alpha","secret":100}',
    value: 'alpha-saved',
  }));

  // Tenant B reads and sees null
  const bInitial = await backendB.read();
  assert.equal(bInitial, null);

  // Write tenant B
  await backendB.transact(async () => ({
    contents: '{"tenant":"beta","secret":200}',
    value: 'beta-saved',
  }));

  // Both read their own exact data
  assert.equal(await backendA.read(), '{"tenant":"alpha","secret":100}');
  assert.equal(await backendB.read(), '{"tenant":"beta","secret":200}');
  assert.equal(pool.activeClients, 0);
});

// ---------------------------------------------------------------------------
// 6. INTEGRATION WITH JSONSTORE
// ---------------------------------------------------------------------------

test('integration: JsonStore operates seamlessly on top of Postgres workspace backend', async () => {
  const pool = createMockPool();
  const backend = createPostgresWorkspaceBackend({ pool, tenantId: 'tenant-store-test' });

  // Initialize JsonStore using our Postgres backend
  const store = new JsonStore(null, backend);

  // 1. Initially empty
  const initialProjects = await store.listProjects();
  assert.deepEqual(initialProjects, []);

  // 2. Create project
  const project = await store.createProject('Postgres Backed Project');
  assert.ok(project.id);
  assert.equal(project.name, 'Postgres Backed Project');

  // 3. Create ruleset inside project
  const ruleset = await store.createRuleset(project.id, 'Eligibility Rules');
  assert.ok(ruleset.id);
  assert.equal(ruleset.name, 'Eligibility Rules');
  assert.equal(ruleset.status, 'draft');

  // 4. Verify projects listing from backend
  const projects = await store.listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'Postgres Backed Project');

  // 5. Raw workspace in mock pool reflects the serialized JsonStore structure
  const rawContents = await backend.read();
  assert.ok(rawContents);
  const parsed = JSON.parse(rawContents);
  assert.equal(parsed.projects.length, 1);
  assert.equal(parsed.rulesets.length, 1);

  // Connection was always released
  assert.equal(pool.activeClients, 0);
});

// ---------------------------------------------------------------------------
// 7. SCHEMA MIGRATION SCRIPT VERIFICATION
// ---------------------------------------------------------------------------

test('schema file db/001-workspaces.sql exists and declares required DDL with TEXT column', async () => {
  const sqlPath = resolve('db/001-workspaces.sql');
  const sqlContent = await readFile(sqlPath, 'utf8');

  assert.ok(sqlContent.includes('CREATE TABLE IF NOT EXISTS rulecanvas_workspaces'));
  assert.ok(sqlContent.includes('tenant_id VARCHAR'));
  assert.match(sqlContent, /contents\s+TEXT/i);
  assert.doesNotMatch(sqlContent, /contents\s+JSONB/i);
});

// ---------------------------------------------------------------------------
// 8. OPTIONAL REAL POSTGRES TEST
// ---------------------------------------------------------------------------

test('real PostgreSQL integration against an explicitly configured test database', async (t) => {
  const dbUrl = process.env.RULECANVAS_TEST_DATABASE_URL;
  if (!dbUrl) {
    t.skip('RULECANVAS_TEST_DATABASE_URL is not set.');
    return;
  }

  let pg;
  try {
    pg = await import('pg');
  } catch {
    t.skip('Skipped real-Postgres test: pg package is not available.');
    return;
  }

  const Pool = pg.default?.Pool ?? pg.Pool;
  const pool = new Pool({ connectionString: dbUrl, connectionTimeoutMillis: 5000 });
  const testTenant = `real-test-${Date.now()}-${process.pid}`;
  const memberTenant = `${testTenant}-member`;
  let schemaReady = false;

  try {
    // 1. Verify connection and apply DDL
    await preparePostgresTestSchema(pool);
    schemaReady = true;

    const backend = createPostgresWorkspaceBackend({ pool, tenantId: testTenant });

    // 2. Read empty
    assert.equal(await backend.read(), null);

    // 3. Transact initial
    const initial = await backend.transact(async (contents) => {
      assert.equal(contents, null);
      return {
        contents: '{"schemaVersion":1,"test":true}',
        value: { created: true },
      };
    });
    assert.deepEqual(initial, { created: true });

    // 4. Read back
    const contents = await backend.read();
    assert.equal(contents, '{"schemaVersion":1,"test":true}');

    await Promise.all(Array.from({ length: 12 }, () => backend.transact(async (text) => {
      const state = JSON.parse(text);
      state.count = (state.count ?? 0) + 1;
      return { contents: JSON.stringify(state), value: state.count };
    })));
    assert.equal(JSON.parse(await backend.read()).count, 12);

    const principal = { tenantId: memberTenant, issuer: 'rulecanvas-test', subject: 'fixture-member' };
    const insert = 'INSERT INTO public.hosted_tenant_memberships (tenant_id, issuer, subject, roles) VALUES ($1,$2,$3,$4)';
    await pool.query(insert, [memberTenant, principal.issuer, principal.subject, ['author']]);
    const { resolveAuthorizedStore } = createHostedMembership({
      pool,
      storeForTenant: (tenantId) => new JsonStore(null, createPostgresWorkspaceBackend({ pool, tenantId })),
    });
    const request = { principal, method: 'POST', pathname: '/api/projects' };
    const store = await resolveAuthorizedStore(request);
    const project = await store.createProject('Database membership fixture');
    const otherStore = await resolveAuthorizedStore({ ...request, method: 'GET' });
    assert.equal((await otherStore.getProject(project.id)).id, project.id);
    await assert.rejects(resolveAuthorizedStore({ ...request, principal: { ...principal, tenantId: testTenant } }), { status: 403 });
    assert.equal(JSON.parse(await backend.read()).count, 12);
    await pool.query('UPDATE public.hosted_tenant_memberships SET enabled = false WHERE tenant_id = $1 AND issuer = $2 AND subject = $3', [memberTenant, principal.issuer, principal.subject]);
    await assert.rejects(resolveAuthorizedStore(request), { status: 403 });
  } finally {
    try {
      if (schemaReady) await pool.query('DELETE FROM public.hosted_tenant_memberships WHERE tenant_id = $1', [memberTenant]);
      if (schemaReady) await pool.query('DELETE FROM rulecanvas_workspaces WHERE tenant_id = ANY($1::text[])', [[testTenant, memberTenant]]);
    } finally {
      await pool.end();
    }
  }
});
