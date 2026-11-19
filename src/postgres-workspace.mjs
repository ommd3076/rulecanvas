/**
 * Default table name for RuleCanvas tenant workspaces.
 */
export const DEFAULT_WORKSPACE_TABLE = 'rulecanvas_workspaces';

/**
 * Regex for strictly validating tenant identifiers:
 * 1-128 alphanumeric characters, hyphens, underscores, or periods.
 * Rejects whitespace, control characters, quotes, and path/SQL metacharacters.
 */
const TENANT_ID_REGEX = /^[a-zA-Z0-9_\-\.]{1,128}$/;

/**
 * Regex for safe SQL identifiers (table names).
 */
const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/**
 * Error class for RuleCanvas PostgreSQL workspace backend operations.
 */
export class PostgresWorkspaceError extends Error {
  constructor(message, status = 400, code = 'workspace.error', details = undefined) {
    super(message);
    this.name = 'PostgresWorkspaceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Validates and normalizes a tenant identifier.
 *
 * @param {unknown} tenantId
 * @returns {string} The validated tenant identifier
 */
export function validateTenantId(tenantId) {
  if (typeof tenantId !== 'string') {
    throw new PostgresWorkspaceError(
      'Tenant ID must be a non-empty string.',
      400,
      'workspace.invalid_tenant',
      { tenantId }
    );
  }
  const trimmed = tenantId.trim();
  if (!trimmed || trimmed !== tenantId || !TENANT_ID_REGEX.test(tenantId) || /[\x00-\x1f\x7f]/.test(tenantId)) {
    throw new PostgresWorkspaceError(
      'Tenant ID must be 1 to 128 characters containing only alphanumeric characters, hyphens, underscores, or dots without leading or trailing whitespace.',
      400,
      'workspace.invalid_tenant',
      { tenantId }
    );
  }
  return trimmed;
}

/**
 * Validates an SQL table identifier.
 *
 * @param {unknown} tableName
 * @returns {string}
 */
function validateTableName(tableName) {
  if (typeof tableName !== 'string' || !SAFE_IDENTIFIER_REGEX.test(tableName)) {
    throw new PostgresWorkspaceError(
      `Table name '${String(tableName)}' is not a valid SQL identifier.`,
      400,
      'workspace.invalid_table',
      { tableName }
    );
  }
  return tableName;
}

/**
 * Creates a tenant-scoped PostgreSQL persistence backend for RuleCanvas workspaces.
 * Compatible with node-postgres (pg.Pool).
 *
 * @param {object} options
 * @param {object} options.pool - A node-postgres compatible Pool instance
 * @param {string} options.tenantId - The unique tenant identifier
 * @param {string} [options.tableName] - Optional custom table name (defaults to 'rulecanvas_workspaces')
 * @returns {{ tenantId: string, read: () => Promise<string|null>, transact: (reducer: (contents: string|null) => Promise<{ contents: string, value?: any }>) => Promise<any> }}
 */
export function createPostgresWorkspaceBackend({
  pool,
  tenantId: rawTenantId,
  tableName: rawTableName = DEFAULT_WORKSPACE_TABLE,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new PostgresWorkspaceError(
      'A valid node-postgres compatible pool with a connect() method is required.',
      500,
      'workspace.invalid_pool'
    );
  }

  const tenantId = validateTenantId(rawTenantId);
  const tableName = validateTableName(rawTableName);

  return {
    get tenantId() {
      return tenantId;
    },

    get tableName() {
      return tableName;
    },

    /**
     * Reads the serialized workspace JSON for this tenant.
     * Stored as TEXT to preserve exact byte-for-byte serialization and SHA-256 hashes.
     *
     * @returns {Promise<string|null>} Serialized JSON string, or null if the workspace row does not exist.
     */
    async read() {
      const client = await pool.connect();
      try {
        const query = `SELECT contents FROM ${tableName} WHERE tenant_id = $1`;
        const result = await client.query(query, [tenantId]);
        if (result.rows.length === 0) {
          return null;
        }
        const contents = result.rows[0].contents;
        if (typeof contents !== 'string') throw new PostgresWorkspaceError('Workspace contents have an invalid shape.', 503, 'workspace.invalid_contents');
        return contents;
      } finally {
        client.release();
      }
    },

    /**
     * Executes a transactional read-modify-write operation with row locking and UPSERT.
     *
     * @template T
     * @param {(contents: string|null) => Promise<{ contents: string, value?: T }>} reducer
     * @returns {Promise<T>} The value returned by the reducer
     */
    async transact(reducer) {
      if (typeof reducer !== 'function') {
        throw new PostgresWorkspaceError(
          'transact requires a reducer function.',
          400,
          'workspace.invalid_reducer'
        );
      }

      const client = await pool.connect();
      let discardClient = false;
      try {
        await client.query('BEGIN');

        // The first write has no row to lock. Serialize it by tenant as well.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tenantId]);

        // Lock existing row if present
        const selectQuery = `SELECT contents FROM ${tableName} WHERE tenant_id = $1 FOR UPDATE`;
        const selectResult = await client.query(selectQuery, [tenantId]);
        const currentContents = selectResult.rows.length === 0 ? null : selectResult.rows[0].contents;
        if (currentContents !== null && typeof currentContents !== 'string') {
          throw new PostgresWorkspaceError('Workspace contents have an invalid shape.', 503, 'workspace.invalid_contents');
        }

        // Run user reducer with current serialized string (or null)
        const reducerOutput = await reducer(currentContents);

        if (!reducerOutput || typeof reducerOutput !== 'object') {
          throw new PostgresWorkspaceError(
            'Reducer must return an object containing a serialized contents string.',
            422,
            'workspace.invalid_reducer_output'
          );
        }

        if (typeof reducerOutput.contents !== 'string') {
          throw new PostgresWorkspaceError(
            'Reducer output contents must be a string.',
            422,
            'workspace.invalid_contents',
            { contentsType: typeof reducerOutput.contents }
          );
        }

        // Transactional UPSERT: inserts if absent, updates if present, recording updated_at
        const upsertQuery = `
          INSERT INTO ${tableName} (tenant_id, contents, updated_at)
          VALUES ($1, $2, CURRENT_TIMESTAMP)
          ON CONFLICT (tenant_id)
          DO UPDATE SET contents = EXCLUDED.contents, updated_at = CURRENT_TIMESTAMP
        `;
        await client.query(upsertQuery, [tenantId, reducerOutput.contents]);

        await client.query('COMMIT');

        // Return the reducer's value to the caller (e.g. project, ruleset, or result)
        return reducerOutput.value !== undefined ? reducerOutput.value : reducerOutput;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discardClient = true;
        }
        throw error;
      } finally {
        client.release(discardClient);
      }
    },
  };
}
