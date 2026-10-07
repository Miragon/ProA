import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { inject } from 'vitest';

import { createDatabase, type Database } from '../../src/db/client.ts';
import { runMigrations } from '../../src/db/migrate.ts';

export interface TestDatabase extends Database {
  /** Connection URL of the fresh database. */
  url: string;
  name: string;
  /** Closes the pool and drops the database. */
  drop(): Promise<void>;
}

async function adminQuery(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: inject('adminDatabaseUrl') });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/**
 * Creates an empty database with all migrations applied, isolated from other
 * test files. Call `drop()` in `afterAll`.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `proa_test_${randomBytes(6).toString('hex')}`;
  await adminQuery(`CREATE DATABASE "${name}"`);
  const url = new URL(inject('adminDatabaseUrl'));
  url.pathname = `/${name}`;
  const database = createDatabase(url.toString(), { max: 5 });
  await runMigrations(database.db);
  return {
    ...database,
    url: url.toString(),
    name,
    async drop() {
      await database.close();
      await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
}
