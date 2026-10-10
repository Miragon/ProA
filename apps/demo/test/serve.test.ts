import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { APPS } from '../src/seed.ts';
import { publicOrigins, serveDemo, serverEnv } from '../src/serve.ts';
import { fakePostgresReady, fakeSpawn, type Behaviour, type SpawnCall } from './fakes.ts';

let root: string;
let seedDir: string;
let runDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'proa-demo-serve-test-'));
  seedDir = path.join(root, 'seed');
  runDir = path.join(root, 'run');
  await mkdir(path.join(seedDir, 'pgdata-template'), { recursive: true });
  await writeFile(path.join(seedDir, 'pgdata-template', 'PG_VERSION'), '17\n');
  await writeFile(
    path.join(seedDir, 'seed.json'),
    JSON.stringify({
      id: 'run-7',
      createdAt: '2026-10-10T09:00:00.000Z',
      projects: [{ project: 'nordwind-handel' }],
    }),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function behaviour(overrides: Partial<Record<string, Behaviour>> = {}) {
  return (call: SpawnCall): Behaviour =>
    overrides[call.name] ??
    (call.name === 'postgres'
      ? { long: true, onStart: fakePostgresReady }
      : call.name === 'server'
        ? { long: true }
        : {});
}

function setup(env: Record<string, string> = { FLY_APP_NAME: 'proa-demo' }, overrides = {}) {
  const fake = fakeSpawn(behaviour(overrides));
  let handler: ((signal: NodeJS.Signals) => void) | null = null;
  let removed = false;
  const logs: string[] = [];
  const deps = {
    spawn: fake.spawn,
    env: { PATH: '/usr/bin', PROA_WEB_DIST: '/app/apps/web/dist', OTHER: 'x', ...env },
    log: (line: string) => logs.push(line),
    sleep: () => Promise.resolve(),
    onSignal: (h: (signal: NodeJS.Signals) => void) => {
      handler = h;
      return () => {
        removed = true;
      };
    },
  };
  return {
    fake,
    logs,
    deps,
    signal: (s: NodeJS.Signals) => handler?.(s),
    removed: () => removed,
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

describe('proa-demo serve', () => {
  it('starts from a fresh copy of the seed and stops server, then PostgreSQL, on SIGTERM', async () => {
    // A restarted container keeps its writable layer: whatever the last run left goes.
    await mkdir(path.join(runDir, 'pgdata'), { recursive: true });
    await writeFile(path.join(runDir, 'pgdata', 'left-over'), 'x');
    const t = setup();
    const done = serveDemo({ seedDir, runDir }, t.deps);
    await until(() => t.fake.calls.some((c) => c.name === 'server'));
    const files = await readdir(path.join(runDir, 'pgdata'));
    expect(files).toContain('PG_VERSION');
    expect(files).not.toContain('left-over');
    expect((await stat(path.join(runDir, 'pgdata'))).mode & 0o777).toBe(0o700);
    t.signal('SIGTERM');
    expect(await done).toBe(0);
    expect(t.fake.kills).toEqual(['server SIGTERM', 'postgres SIGINT']);
    expect(t.removed()).toBe(true);
    expect(t.logs.join('\n')).toContain(
      'demo: seed run-7 from 2026-10-10T09:00:00.000Z (nordwind-handel); public origins https://proa-demo.fly.dev',
    );
    // The template itself is untouched.
    expect(await readFile(path.join(seedDir, 'pgdata-template', 'PG_VERSION'), 'utf8')).toBe(
      '17\n',
    );
  });

  it('runs PostgreSQL on loopback without autovacuum and the server as the read-only demo', async () => {
    const t = setup({ FLY_APP_NAME: 'proa-demo', PROA_OWNER_KEY_FILE: '/var/lib/proa/owner-key' });
    const done = serveDemo({ seedDir, runDir }, t.deps);
    await until(() => t.fake.calls.some((c) => c.name === 'server'));
    t.signal('SIGINT');
    await done;
    const postgres = t.fake.calls.find((c) => c.name === 'postgres');
    expect(postgres?.args).toEqual(
      expect.arrayContaining([
        '-D',
        path.join(runDir, 'pgdata'),
        '-c',
        'listen_addresses=127.0.0.1',
        '-c',
        'autovacuum=off',
      ]),
    );
    const server = t.fake.calls.find((c) => c.name === 'server');
    expect(server?.args).toEqual([APPS.server]);
    expect(server?.env).toEqual({
      PATH: '/usr/bin',
      NODE_ENV: 'production',
      PROA_DEMO: 'readonly',
      PROA_PUBLIC_ORIGIN: 'https://proa-demo.fly.dev',
      PROA_HOST: '0.0.0.0',
      PROA_PORT: '8080',
      PROA_WEB_DIST: '/app/apps/web/dist',
      PROA_MIGRATE: 'off',
      PROA_OWNER_KEY_FILE: '',
      DATABASE_URL: 'postgres://proa_demo@127.0.0.1:5432/proa',
    });
  });

  it.each(['server', 'postgres'] as const)(
    'exits 1 when the %s ends on its own, stopping the other',
    async (who) => {
      const t = setup();
      const done = serveDemo({ seedDir, runDir }, t.deps);
      await until(() => t.fake.calls.some((c) => c.name === 'server'));
      t.fake.children.get(who)?.exit({ code: 1, signal: null });
      expect(await done).toBe(1);
      const other = who === 'server' ? 'postgres SIGINT' : 'server SIGTERM';
      expect(t.fake.kills).toContain(other);
      expect(t.logs.join('\n')).toContain(`${who} ended unexpectedly (exit code 1)`);
    },
  );

  it('fails before starting anything without a public origin', async () => {
    const t = setup({});
    await expect(serveDemo({ seedDir, runDir }, t.deps)).rejects.toThrow(/PROA_PUBLIC_ORIGIN/);
    expect(t.fake.calls).toEqual([]);
  });
});

describe('public origins', () => {
  it('takes PROA_PUBLIC_ORIGIN, else the Fly.io address of FLY_APP_NAME', () => {
    expect(
      publicOrigins({ PROA_PUBLIC_ORIGIN: 'https://proa.example.org', FLY_APP_NAME: 'x' }),
    ).toBe('https://proa.example.org');
    expect(publicOrigins({ FLY_APP_NAME: 'proa-demo' })).toBe('https://proa-demo.fly.dev');
    expect(() => publicOrigins({ FLY_APP_NAME: 'Bad Name' })).toThrow();
    expect(() => publicOrigins({})).toThrow();
  });

  it('passes nothing of the environment to the server but its own settings', () => {
    expect(
      serverEnv(
        { PATH: '/bin', PROA_ALLOW_NON_LOOPBACK: '1', DATABASE_URL: 'postgres://proa@x/y' },
        'https://a.example',
      ),
    ).toMatchObject({
      PROA_DEMO: 'readonly',
      DATABASE_URL: 'postgres://proa_demo@127.0.0.1:5432/proa',
    });
    expect(serverEnv({ PROA_ALLOW_NON_LOOPBACK: '1' }, 'https://a.example')).not.toHaveProperty(
      'PROA_ALLOW_NON_LOOPBACK',
    );
  });

  it('passes the operator’s legal links through as given, and only those that are set', () => {
    const links = {
      PROA_DEMO_IMPRINT_URL: 'https://example.org/impressum',
      PROA_DEMO_PRIVACY_URL: 'https://example.org/datenschutz/',
    };
    expect(serverEnv({ PATH: '/bin', ...links }, 'https://a.example')).toMatchObject(links);
    const privacyOnly = serverEnv(
      { PROA_DEMO_PRIVACY_URL: links.PROA_DEMO_PRIVACY_URL },
      'https://a.example',
    );
    expect(privacyOnly['PROA_DEMO_PRIVACY_URL']).toBe(links.PROA_DEMO_PRIVACY_URL);
    expect(privacyOnly).not.toHaveProperty('PROA_DEMO_IMPRINT_URL');
    // A malformed value reaches the server, which refuses to start and names it.
    expect(serverEnv({ PROA_DEMO_IMPRINT_URL: 'http://x' }, 'https://a.example')).toMatchObject({
      PROA_DEMO_IMPRINT_URL: 'http://x',
    });
    // Never instead of the supervisor's own settings.
    expect(serverEnv(links, 'https://a.example')).toMatchObject({
      PROA_DEMO: 'readonly',
      PROA_OWNER_KEY_FILE: '',
    });
  });
});
