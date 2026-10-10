/**
 * `proa-demo serve`: the demo container's entry point (docker/Dockerfile.demo).
 * Every start begins from the seed baked into the image:
 *
 * 1. the public origins: `PROA_PUBLIC_ORIGIN`, else `https://$FLY_APP_NAME.fly.dev`;
 * 2. a fresh copy of the data directory template in a run directory;
 * 3. PostgreSQL on loopback;
 * 4. the server with `PROA_DEMO=readonly`, as the read-only database role,
 *    with the operator's legal links when set (`PROA_DEMO_IMPRINT_URL`,
 *    `PROA_DEMO_PRIVACY_URL`).
 *
 * SIGTERM or SIGINT stop the server, then PostgreSQL, and exit 0. If either
 * exits on its own, the other is stopped and the supervisor exits 1, so the
 * platform restarts the container, which starts from the seed again. There is
 * no reset endpoint and no timer: a restart is the reset.
 */
import { chmod, cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { DEMO_DB_ROLE_NAME } from './constants.ts';
import { databaseUrl, startPostgres, stopPostgres, type PostgresDeps } from './postgres.ts';
import { DemoError, childEnv, stop, type Child, type Exit } from './processes.ts';
import { APPS, SEED_INFO, TEMPLATE_DIR, type SeedInfo } from './seed.ts';

/** Where the image keeps the seed (`proa-demo seed --out`). */
export const DEFAULT_SEED_DIR = '/opt/proa-demo';
/** Where each start copies it to. */
export const DEFAULT_RUN_DIR = '/tmp/proa-demo';

export interface ServeOptions {
  seedDir: string;
  runDir: string;
}

export interface ServeDeps extends PostgresDeps {
  log: (line: string) => void;
  /** Registers the stop signals; returns a function that removes them. */
  onSignal: (handler: (signal: NodeJS.Signals) => void) => () => void;
}

/**
 * The demo's public origins: `PROA_PUBLIC_ORIGIN` as given (the server checks
 * its form), else the Fly.io address derived from `FLY_APP_NAME`.
 *
 * @throws {DemoError} when neither is set
 */
export function publicOrigins(env: Record<string, string | undefined>): string {
  const explicit = env['PROA_PUBLIC_ORIGIN']?.trim();
  if (explicit) return explicit;
  const app = env['FLY_APP_NAME']?.trim();
  if (app && /^[a-z0-9-]+$/.test(app)) return `https://${app}.fly.dev`;
  throw new DemoError(
    'set PROA_PUBLIC_ORIGIN (e.g. https://proa-demo.fly.dev); on Fly.io FLY_APP_NAME is used when it is unset',
  );
}

/**
 * The operator's legal links (Impressum, privacy policy): optional, passed to
 * the server as given; the server checks them and reports them in `/health`.
 */
export const DEMO_LINK_SETTINGS = ['PROA_DEMO_IMPRINT_URL', 'PROA_DEMO_PRIVACY_URL'] as const;

/**
 * The server's environment: read-only demo, read-only role, no owner key, no
 * migrations, and each of {@link DEMO_LINK_SETTINGS} that is set.
 */
export function serverEnv(
  env: Record<string, string | undefined>,
  origins: string,
): Record<string, string> {
  const links: Record<string, string> = {};
  for (const name of DEMO_LINK_SETTINGS) {
    const value = env[name];
    if (value !== undefined) links[name] = value;
  }
  return childEnv(env, {
    ...links,
    NODE_ENV: 'production',
    PROA_DEMO: 'readonly',
    PROA_PUBLIC_ORIGIN: origins,
    PROA_HOST: env['PROA_HOST'] ?? '0.0.0.0',
    PROA_PORT: env['PROA_PORT'] ?? '8080',
    PROA_WEB_DIST: env['PROA_WEB_DIST'] ?? '',
    PROA_MIGRATE: 'off',
    PROA_OWNER_KEY_FILE: '',
    DATABASE_URL: databaseUrl(DEMO_DB_ROLE_NAME),
  });
}

function describe(exit: Exit): string {
  return exit.signal ? `signal ${exit.signal}` : `exit code ${String(exit.code)}`;
}

/**
 * Runs the demo until a stop signal or a crash (see the module comment).
 *
 * @returns the exit code: 0 after a stop signal, 1 after a crash
 * @throws {DemoError} when the start fails (processes started so far are stopped)
 */
export async function serveDemo(options: ServeOptions, deps: ServeDeps): Promise<number> {
  const origins = publicOrigins(deps.env);
  const info = JSON.parse(
    await readFile(path.join(options.seedDir, SEED_INFO), 'utf8'),
  ) as SeedInfo;
  const dataDir = path.join(options.runDir, 'pgdata');
  const socketDir = path.join(options.runDir, 'run');
  // Always from the template: a restarted container keeps its writable layer.
  await rm(options.runDir, { recursive: true, force: true });
  await mkdir(socketDir, { recursive: true });
  await cp(path.join(options.seedDir, TEMPLATE_DIR), dataDir, { recursive: true });
  await chmod(dataDir, 0o700);

  let signalled: NodeJS.Signals | null = null;
  let wake: () => void = () => undefined;
  const stopRequested = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const removeHandler = deps.onSignal((signal) => {
    if (signalled) return;
    signalled = signal;
    deps.log(`demo: ${signal}, stopping`);
    wake();
  });

  let postgres: Child | null = null;
  let server: Child | null = null;
  try {
    postgres = await startPostgres(deps, { dataDir, socketDir, settings: { autovacuum: 'off' } });
    if (signalled) return 0;
    server = deps.spawn('server', process.execPath, [APPS.server], {
      env: serverEnv(deps.env, origins),
      output: 'inherit',
    });
    deps.log(
      `demo: seed ${info.id} from ${info.createdAt} (${info.projects.map((p) => p.project).join(', ')}); public origins ${origins}`,
    );
    const ended = await Promise.race([
      stopRequested.then(() => null),
      server.exited.then((exit) => ({ who: 'server', exit })),
      postgres.exited.then((exit) => ({ who: 'postgres', exit })),
    ]);
    if (ended) {
      deps.log(`demo: ${ended.who} ended unexpectedly (${describe(ended.exit)}); stopping`);
      return 1;
    }
    return 0;
  } finally {
    removeHandler();
    if (server) await stop(server, 'SIGTERM', 10_000);
    if (postgres) await stopPostgres(postgres);
  }
}
