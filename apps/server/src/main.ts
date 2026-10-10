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

if (!isLoopbackHost(config.host)) {
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

// Chains that predate the placement pipeline (migration 0008) get their first placement task.
try {
  const queued = await useCases.queueFirstPlacementTasks();
  if (queued > 0) console.log(`queued the first placement task of ${queued} value chain(s)`);
} catch (err) {
  console.error(
    `proa: could not queue first placement tasks: ${err instanceof Error ? err.message : String(err)}`,
  );
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  const host = info.family === 'IPv6' ? `[${info.address}]` : info.address;
  console.log(
    `ProA ${PROA_VERSION} listening on http://${host}:${info.port} (auth: ${config.authMode})`,
  );
  if (!config.webDist) console.log('web UI not built; serving API and MCP only');
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
