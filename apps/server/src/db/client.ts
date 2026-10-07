import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;

/** A connection pool plus its Drizzle instance. */
export interface Database {
  db: Db;
  pool: pg.Pool;
  /** `SELECT 1` with a short timeout; `false` instead of throwing. */
  ping(timeoutMs?: number): Promise<boolean>;
  /** Ends the pool; idempotent. */
  close(): Promise<void>;
}

export interface DatabaseOptions {
  /** Maximum pool size (default 10). */
  max?: number;
}

/** Creates a lazily connecting pool for `url` (no I/O until the first query). */
export function createDatabase(url: string, options: DatabaseOptions = {}): Database {
  const pool = new pg.Pool({ connectionString: url, max: options.max ?? 10 });
  // An idle client losing its connection must not crash the process.
  pool.on('error', (err) => console.error('postgres pool error:', err.message));
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  let closed = false;
  return {
    db,
    pool,
    async ping(timeoutMs = 2000) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        });
        await Promise.race([pool.query('SELECT 1'), timeout]);
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}
