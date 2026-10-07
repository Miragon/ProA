/**
 * A real ProA server for the e2e tests: `node apps/server/src/main.ts` as a
 * child process on an ephemeral port, against its own fresh database, with
 * the owner key in a temporary directory.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { inject } from 'vitest';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const SERVER_MAIN = fileURLToPath(new URL('../../../server/src/main.ts', import.meta.url));

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: inject('adminDatabaseUrl') });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** A fresh, empty database; the server migrates it at startup. */
export async function createDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `proa_e2e_${randomBytes(6).toString('hex')}`;
  await admin(`CREATE DATABASE "${name}"`);
  const url = new URL(inject('adminDatabaseUrl'));
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () => admin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
  };
}

export interface RunningServer {
  url: string;
  child: ChildProcess;
  /** Everything the server wrote to stdout and stderr. */
  output: () => string;
  stop: () => Promise<void>;
}

/** Environment of a child process without the developer's PROA_* settings. */
export function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('PROA_') && k !== 'DATABASE_URL') env[k] = v;
  }
  return { ...env, ...extra };
}

export async function startServer(opts: {
  databaseUrl: string;
  ownerKeyFile: string;
}): Promise<RunningServer> {
  const child = spawn(process.execPath, [SERVER_MAIN], {
    cwd: REPO_ROOT,
    env: cleanEnv({
      DATABASE_URL: opts.databaseUrl,
      PROA_HOST: '127.0.0.1',
      PROA_PORT: '0',
      PROA_WEB_DIST: '',
      PROA_OWNER_KEY_FILE: opts.ownerKeyFile,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (c: Buffer) => (output += c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString('utf8')));

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 60_000);
    const check = () => {
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout?.on('data', check);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}:\n${output}`));
    });
  });

  return {
    url,
    child,
    output: () => output,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}
