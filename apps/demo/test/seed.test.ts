import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEMO_DB_ROLE_NAME } from '../src/constants.ts';
import { APPS, DEMO_LANDSCAPES, SEED_SERVER_PORT, seedDemo, type SeedInfo } from '../src/seed.ts';
import {
  fakeFetch,
  fakeInitdb,
  fakePostgresReady,
  fakeSpawn,
  type Behaviour,
  type SpawnCall,
} from './fakes.ts';
import { DEMO_DB_ROLE } from '../../server/src/db/demo-role.ts';

const SECRETS = ['proa_at_SECRETNORDWIND', 'proa_at_SECRETSTADTWERKE'];
const OWNER_KEY = 'proa_ok_OWNERKEY';

let out: string;
beforeEach(async () => {
  out = await mkdtemp(path.join(os.tmpdir(), 'proa-demo-seed-test-'));
});
afterEach(async () => {
  await rm(out, { recursive: true, force: true });
});

function simReport(overrides: { failed?: number; stop?: string } = {}) {
  return JSON.stringify({
    stop: overrides.stop ?? 'no-work',
    totals: { failed: overrides.failed ?? 0 },
    byKind: {
      relations: { tasks: 31, proposed: 48, questions: 12, noLinks: 150 },
      placement: { tasks: 1, proposed: 20, unsure: 3 },
    },
  });
}

function behaviour(overrides: Partial<Record<string, Behaviour>> = {}) {
  return (call: SpawnCall): Behaviour => {
    const override = overrides[call.name];
    if (override) return override;
    switch (call.name) {
      case 'initdb':
        return { onStart: fakeInitdb };
      case 'postgres':
        return { long: true, onStart: fakePostgresReady };
      case 'server':
        return {
          long: true,
          // As the real server: the key exists before /health answers.
          onStart: (c) => writeFileSync(c.env['PROA_OWNER_KEY_FILE'] ?? '', `${OWNER_KEY}\n`),
        };
      case 'proa seed':
        return {
          stdout: JSON.stringify(
            DEMO_LANDSCAPES.map((project, i) => ({
              project,
              models: 30,
              relations: { accepted: 9, proposed: 33 },
              token: { secret: SECRETS[i] },
            })),
          ),
        };
      default:
        if (call.name.startsWith('proa-agent-sim')) return { stdout: simReport() };
        return {};
    }
  };
}

function routes(overrides: { queued?: boolean; noChain?: boolean; healthDown?: boolean } = {}) {
  return (_method: string, url: string) => {
    if (url === '/health')
      return overrides.healthDown ? { status: 503 } : { body: { status: 'ok' } };
    if (url.includes('/analyses?state=queued'))
      return { body: { items: overrides.queued ? [{}] : [] } };
    if (url.includes('/analyses?')) return { body: { items: [] } };
    if (url.endsWith('/value-chains/main'))
      return overrides.noChain ? { status: 404 } : { body: {} };
    return undefined;
  };
}

const logs: string[] = [];
const deps = (spawn: ReturnType<typeof fakeSpawn>['spawn'], fetch: typeof globalThis.fetch) => ({
  spawn,
  fetch,
  env: { PATH: '/usr/bin', HOME: '/home/proa', PROA_DEMO: 'readonly', SECRET_X: 'x' },
  log: (line: string) => logs.push(line),
  sleep: () => Promise.resolve(),
});

describe('proa-demo seed', () => {
  it('runs the steps in order and leaves the template and seed.json', async () => {
    logs.length = 0;
    const fake = fakeSpawn(behaviour());
    const { fetch, calls: requests } = fakeFetch(routes());
    const info = await seedDemo({ out, id: 'run-7' }, deps(fake.spawn, fetch));

    const order = fake.calls.map((c) => c.name).filter((n) => n !== 'pg_isready');
    expect(order).toEqual([
      'initdb',
      'postgres',
      'psql',
      'server',
      'proa seed',
      'proa-agent-sim nordwind-handel',
      'proa-agent-sim stadtwerke-auental',
      'demo-bootstrap',
      'psql',
    ]);
    expect(await readdir(out)).toEqual(['pgdata-template', 'seed.json']);
    expect(await readFile(path.join(out, 'pgdata-template', 'PG_VERSION'), 'utf8')).toBe('17\n');
    const written = JSON.parse(await readFile(path.join(out, 'seed.json'), 'utf8')) as SeedInfo;
    expect(written).toEqual(info);
    expect(info.id).toBe('run-7');
    expect(info.projects.map((p) => [p.project, p.agent.proposals, p.agent.placements])).toEqual([
      ['nordwind-handel', 48, 20],
      ['stadtwerke-auental', 48, 20],
    ]);
    // Both long-running processes were stopped: the server with SIGTERM, PostgreSQL fast.
    expect(fake.children.get('server')?.signals).toEqual(['SIGTERM']);
    expect(fake.children.get('postgres')?.signals).toEqual(['SIGINT']);
    // The checks used the owner key over REST.
    const auth = requests
      .filter((r) => r.path.includes('/analyses'))
      .map((r) => (r.init.headers as Record<string, string>)['authorization']);
    expect(new Set(auth)).toEqual(new Set([`Bearer ${OWNER_KEY}`]));
  });

  it('starts the seed server in local mode on loopback, and each child with a clean environment', async () => {
    const fake = fakeSpawn(behaviour());
    await seedDemo({ out }, deps(fake.spawn, fakeFetch(routes()).fetch));
    const server = fake.calls.find((c) => c.name === 'server');
    expect(server?.args).toEqual([APPS.server]);
    expect(server?.env).toMatchObject({
      PROA_HOST: '127.0.0.1',
      PROA_PORT: String(SEED_SERVER_PORT),
      PROA_MIGRATE: 'auto',
      PROA_WEB_DIST: '',
      DATABASE_URL: 'postgres://proa@127.0.0.1:5432/proa',
    });
    for (const call of fake.calls) {
      expect(call.env, call.name).not.toHaveProperty('PROA_DEMO');
      expect(call.env, call.name).not.toHaveProperty('SECRET_X');
    }
    const seed = fake.calls.find((c) => c.name === 'proa seed');
    expect(seed?.args).toEqual([
      APPS.cli,
      'seed',
      'nordwind-handel',
      'stadtwerke-auental',
      '--value-chains',
      '--issue-tokens',
      '--token-name',
      'agent-sim',
      '--json',
      '--url',
      `http://127.0.0.1:${SEED_SERVER_PORT}`,
    ]);
    const sims = fake.calls.filter((c) => c.name.startsWith('proa-agent-sim'));
    expect(sims.map((c) => c.env['PROA_TOKEN'])).toEqual(SECRETS);
    // The token travels in the environment, never on the command line.
    for (const c of sims) expect(c.args.join(' ')).not.toContain('proa_at_');
    const initdb = fake.calls.find((c) => c.name === 'initdb');
    expect(initdb?.args).toEqual(expect.arrayContaining(['-U', 'proa', '--auth=trust']));
    const postgres = fake.calls.find((c) => c.name === 'postgres');
    expect(postgres?.args).toEqual(expect.arrayContaining(['-c', 'listen_addresses=127.0.0.1']));
  });

  it('never logs a secret', async () => {
    logs.length = 0;
    const fake = fakeSpawn(behaviour());
    await seedDemo({ out }, deps(fake.spawn, fakeFetch(routes()).fetch));
    const text = logs.join('\n');
    for (const secret of [...SECRETS, OWNER_KEY]) expect(text).not.toContain(secret);
    expect(text).toContain('nordwind-handel: 30 models; agent: 48 proposals (12 with a question)');
  });

  it.each([
    [
      'a failed agent task',
      { 'proa-agent-sim nordwind-handel': { stdout: simReport({ failed: 1 }) } },
      {},
      /1 failed/,
    ],
    [
      'a failing seed',
      { 'proa seed': { exit: { code: 1, signal: null } } },
      {},
      /proa seed failed \(exit code 1\)/,
    ],
    ['an open task', {}, { queued: true }, /an analysis task is queued/],
    ['a missing chain', {}, { noChain: true }, /no value chain/],
    [
      'a crashed server',
      { server: { exit: { code: 1, signal: null } } },
      { healthDown: true },
      /server exited while waiting/,
    ],
  ] as const)(
    'fails on %s and stops what it started',
    async (_what, overrides, routeOptions, message) => {
      const fake = fakeSpawn(behaviour(overrides));
      await expect(
        seedDemo({ out }, deps(fake.spawn, fakeFetch(routes(routeOptions)).fetch)),
      ).rejects.toThrow(message);
      expect(fake.children.get('postgres')?.signals).toContain('SIGINT');
      expect(await readdir(out)).not.toContain('seed.json');
    },
  );

  it('refuses a non-empty output directory before starting anything', async () => {
    await writeFile(path.join(out, 'x'), 'x');
    const fake = fakeSpawn(behaviour());
    await expect(seedDemo({ out }, deps(fake.spawn, fakeFetch(routes()).fetch))).rejects.toThrow(
      /not empty/,
    );
    expect(fake.calls).toEqual([]);
  });

  it('uses the role the server bootstrap creates', () => {
    expect(DEMO_DB_ROLE_NAME).toBe(DEMO_DB_ROLE);
  });
});
