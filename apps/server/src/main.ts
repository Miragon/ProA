// ProA server entry point: `node src/main.ts` (Node 24 strips the types).
import { serve } from '@hono/node-server';

import { createProaApp } from './app.ts';
import { loadOrCreateOwnerKey } from './auth/owner-key.ts';
import { isLoopbackHost, loadConfig } from './config.ts';
import { createDatabase } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { PROA_VERSION } from './version.ts';

let config;
let ownerKey: string | null = null;
try {
  config = loadConfig();
  if (config.ownerKeyFile) {
    const loaded = await loadOrCreateOwnerKey(config.ownerKeyFile);
    ownerKey = loaded.key;
    console.log(
      `owner key: ${config.ownerKeyFile} (${loaded.created ? 'created' : 'existing'}; the proa CLI on this machine reads it)`,
    );
  }
} catch (err) {
  console.error(`proa: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (config.demo) {
  console.log(
    `read-only demo (PROA_DEMO=readonly): public origins ${config.demo.publicOrigins.join(', ')}; ` +
      'every write answers 403 demo-readonly, MCP is off, sessions are viewers',
  );
} else if (!isLoopbackHost(config.host)) {
  console.warn(
    `WARNING: local mode listens on ${config.host} (PROA_ALLOW_NON_LOOPBACK=1). Anyone who reaches ` +
      'this port can act as the owner; publish it on 127.0.0.1 only (e.g. -p 127.0.0.1:7400:7400).',
  );
}

const database = createDatabase(config.databaseUrl);

if (config.migrateOnStart) {
  await runMigrations(database.db);
}

const { app, useCases } = createProaApp({ config, database, ownerKey });

if (config.demo) {
  // The demo's database is read-only (the third write barrier): nothing is
  // queued, the role must be read-only by default, and the visitor must exist.
  try {
    const { rows } = await database.pool.query<{ default_transaction_read_only: string }>(
      'SHOW default_transaction_read_only',
    );
    if (rows[0]?.default_transaction_read_only !== 'on') {
      throw new Error(
        'PROA_DEMO=readonly needs a read-only database role (default_transaction_read_only = on); ' +
          'connect as the role apps/server/src/demo-bootstrap.ts creates',
      );
    }
    await useCases.demoVisitorActor('proa-web');
  } catch (err) {
    console.error(`proa: ${err instanceof Error ? err.message : String(err)}`);
    await database.close();
    process.exit(1);
  }
} else {
  // Chains that predate the placement pipeline (migration 0008) get their first placement task.
  try {
    const queued = await useCases.queueFirstPlacementTasks();
    if (queued > 0) console.log(`queued the first placement task of ${queued} value chain(s)`);
  } catch (err) {
    console.error(
      `proa: could not queue first placement tasks: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  const host = info.family === 'IPv6' ? `[${info.address}]` : info.address;
  console.log(
    `ProA ${PROA_VERSION} listening on http://${host}:${info.port} (auth: ${config.authMode}${config.demo ? ', read-only demo' : ''})`,
  );
  if (!config.webDist) {
    console.log(`web UI not built; serving ${config.demo ? 'the API' : 'API and MCP'} only`);
  }
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  // Waiting long-polls answer at once instead of holding the shutdown up.
  void database.notifier.close();
  server.close(() => {
    void database.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
