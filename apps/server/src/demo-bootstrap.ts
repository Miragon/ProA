// `node apps/server/src/demo-bootstrap.ts`: prepares a seeded database for the
// read-only demo (issue #3, docker/Dockerfile.demo). Reads DATABASE_URL (a role
// that may create roles) and optionally PROA_DEMO_DB_ROLE; makes the visitor a
// viewer of every project (`grantDemoVisitor`) and creates the read-only role
// the demo server connects as (`db/demo-role.ts`). Idempotent.
import { createProaApp } from './app.ts';
import { DEFAULT_DATABASE_URL } from './config.ts';
import { createDatabase } from './db/client.ts';
import { createReadOnlyRole } from './db/demo-role.ts';

const url = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
const database = createDatabase(url, { max: 1 });
try {
  const { useCases } = createProaApp({ config: { authMode: 'local', webDist: null }, database });
  const grant = await useCases.grantDemoVisitor();
  console.log(
    `demo visitor ${grant.principalId}: viewer of ${grant.granted.length + grant.existing.length} project(s)` +
      ` (${[...grant.granted, ...grant.existing].sort().join(', ') || 'none'})`,
  );
  const client = await database.pool.connect();
  try {
    const role = await createReadOnlyRole(client, {
      ...(process.env['PROA_DEMO_DB_ROLE'] ? { name: process.env['PROA_DEMO_DB_ROLE'] } : {}),
    });
    console.log(`read-only role ${role}: SELECT on public, default_transaction_read_only = on`);
  } finally {
    client.release();
  }
} catch (err) {
  console.error(`demo-bootstrap: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await database.close();
}
