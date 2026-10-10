// `pnpm db:migrate`: applies pending migrations to DATABASE_URL and exits.
import { loadConfig } from '../config.ts';
import { createDatabase } from './client.ts';
import { runMigrations } from './migrate.ts';

const config = loadConfig();
const database = createDatabase(config.databaseUrl, { max: 1 });
try {
  await runMigrations(database.db);
  console.log('migrations applied');
} finally {
  await database.close();
}
