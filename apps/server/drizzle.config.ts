import { defineConfig } from 'drizzle-kit';

// `pnpm --filter @proa/server db:generate` diffs src/db/schema.ts against the
// snapshots in drizzle/meta and writes the next SQL migration to drizzle/.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://proa:proa@127.0.0.1:55432/proa',
  },
});
