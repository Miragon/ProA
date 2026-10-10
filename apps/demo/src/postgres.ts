/**
 * The demo's own PostgreSQL 17 inside its container (docker/Dockerfile.demo):
 * created with `initdb` at image build time, started on loopback at run time
 * from a copy of the seeded data directory. Binaries come from `PATH`
 * (`/usr/lib/postgresql/17/bin` in the image).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Child, Spawn } from './processes.ts';
import { childEnv, run, stop, waitFor } from './processes.ts';

/** The superuser `initdb` creates; owns the database and seeds it. */
export const PG_SUPERUSER = 'proa';
/** The database the server uses. */
export const PG_DATABASE = 'proa';
/** Loopback only: nothing outside the container reaches PostgreSQL. */
export const PG_HOST = '127.0.0.1';
export const PG_PORT = 5432;

export interface PostgresOptions {
  dataDir: string;
  /** Directory of the Unix socket (and lock file); not the system default, which needs root. */
  socketDir: string;
  port?: number;
  /** Extra `-c name=value` settings. */
  settings?: Record<string, string>;
}

/**
 * Settings of the demo's PostgreSQL: loopback only, small (Fly's 1 GB VM
 * runs Node next to it), and no durability, since the data is a throwaway
 * copy of the seed (the seed is written once, with a clean shutdown).
 */
export function baseSettings(options: PostgresOptions): Record<string, string> {
  return {
    listen_addresses: PG_HOST,
    port: String(options.port ?? PG_PORT),
    unix_socket_directories: options.socketDir,
    fsync: 'off',
    synchronous_commit: 'off',
    full_page_writes: 'off',
    // A Docker build step has a small /dev/shm.
    dynamic_shared_memory_type: 'mmap',
    shared_buffers: '64MB',
    max_connections: '30',
    ...options.settings,
  };
}

/** `postgres://<user>@127.0.0.1:<port>/proa` (trust on loopback inside the container). */
export function databaseUrl(user: string, port = PG_PORT): string {
  return `postgres://${user}@${PG_HOST}:${port}/${PG_DATABASE}`;
}

export interface PostgresDeps {
  spawn: Spawn;
  env: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** `initdb` of an empty cluster owned by {@link PG_SUPERUSER}, trusting local connections. */
export async function initdb(deps: PostgresDeps, dataDir: string): Promise<void> {
  await run(
    deps.spawn,
    'initdb',
    'initdb',
    [
      '-D',
      dataDir,
      '-U',
      PG_SUPERUSER,
      '--auth=trust',
      '--encoding=UTF8',
      '--locale=en_US.utf8',
      '--no-instructions',
    ],
    { env: childEnv(deps.env, {}), output: 'inherit' },
  );
}

/** The status line of `postmaster.pid` (its eighth) reads `ready`. */
export async function postmasterReady(dataDir: string): Promise<boolean> {
  try {
    const lines = (await readFile(path.join(dataDir, 'postmaster.pid'), 'utf8')).split('\n');
    return lines[7]?.trim() === 'ready';
  } catch {
    return false;
  }
}

/** Starts `postgres` in the foreground (the supervisor owns the process) and waits until it accepts connections. */
export async function startPostgres(deps: PostgresDeps, options: PostgresOptions): Promise<Child> {
  const settings = baseSettings(options);
  const args = ['-D', options.dataDir];
  for (const [name, value] of Object.entries(settings)) args.push('-c', `${name}=${value}`);
  const child = deps.spawn('postgres', 'postgres', args, {
    env: childEnv(deps.env, {}),
    output: 'inherit',
  });
  const port = settings['port'] ?? String(PG_PORT);
  await waitFor(
    'PostgreSQL',
    async () => {
      // `postmaster.pid` says `ready` once connections are accepted; probing
      // earlier would log a FATAL "starting up" line on every start.
      if (!(await postmasterReady(options.dataDir))) return false;
      const probe = deps.spawn(
        'pg_isready',
        'pg_isready',
        ['-q', '-h', PG_HOST, '-p', port, '-U', PG_SUPERUSER, '-d', 'postgres'],
        { env: childEnv(deps.env, {}), output: 'inherit' },
      );
      return (await probe.exited).code === 0;
    },
    {
      timeoutMs: 60_000,
      intervalMs: 250,
      child,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    },
  );
  return child;
}

/** Runs SQL as the superuser through `psql` (stops at the first error). */
export async function psql(
  deps: PostgresDeps,
  sql: string,
  database = PG_DATABASE,
  port = PG_PORT,
): Promise<void> {
  await run(
    deps.spawn,
    'psql',
    'psql',
    [
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      PG_HOST,
      '-p',
      String(port),
      '-U',
      PG_SUPERUSER,
      '-d',
      database,
      '-c',
      sql,
    ],
    { env: childEnv(deps.env, {}), output: 'inherit' },
  );
}

/** Stops PostgreSQL with a fast shutdown (SIGINT): open sessions end, the data is written cleanly. */
export async function stopPostgres(child: Child): Promise<void> {
  await stop(child, 'SIGINT', 20_000);
}
