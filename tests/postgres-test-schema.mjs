import { readFile } from 'node:fs/promises';

export async function preparePostgresTestSchema(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [810423]);
    for (const migration of ['001-workspaces.sql', '002-memberships.sql']) {
      await client.query(await readFile(new URL(`../db/${migration}`, import.meta.url), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
