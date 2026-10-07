import type { Database, Db } from '../../src/db/client.ts';

/** A database stand-in for unit tests: `ping` answers `up`, everything else is absent. */
export function fakeDatabase(up = true): Database {
  return {
    db: undefined as unknown as Db,
    pool: undefined as unknown as Database['pool'],
    ping: () => Promise.resolve(up),
    close: () => Promise.resolve(),
  };
}
