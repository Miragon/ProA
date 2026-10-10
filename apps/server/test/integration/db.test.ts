import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { createDatabase } from '../../src/db/client.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe('PostgreSQL (smoke)', () => {
  it('runs PostgreSQL 17', async () => {
    const result = await database.db.execute<{ server_version_num: string }>(
      sql`SHOW server_version_num`,
    );
    expect(Number(result.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(170000);
    expect(Number(result.rows[0]?.server_version_num)).toBeLessThan(180000);
  });

  it('has the migrations applied, and re-running them is a no-op', async () => {
    const count = async () => {
      const r = await database.db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`,
      );
      return Number(r.rows[0]?.n);
    };
    const before = await count();
    expect(before).toBeGreaterThanOrEqual(1);
    await runMigrations(database.db);
    expect(await count()).toBe(before);
  });

  it('reports the database in /health', async () => {
    const app = createApp({ config: { authMode: 'local', webDist: null }, database, version: '0' });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ db: 'ok' });
  });

  it('ping fails fast for an unreachable database', async () => {
    const unreachable = createDatabase('postgres://proa:proa@127.0.0.1:9/nope');
    try {
      expect(await unreachable.ping(1000)).toBe(false);
    } finally {
      await unreachable.close();
    }
  });
});
