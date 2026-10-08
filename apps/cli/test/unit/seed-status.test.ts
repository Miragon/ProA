import { rm } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CORPUS, findLandscapes, landscapeName } from '../../src/commands/seed.ts';
import { runCli } from '../../src/program.ts';
import { OWNER_KEY, fakeApi, json, ownerKeyFile, problem, tempDir, testIo } from '../support/io.ts';

let dir: string;
let keyFile: string;

beforeAll(async () => {
  dir = await tempDir();
  keyFile = await ownerKeyFile(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PROJECT = {
  id: 'prj_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
  key: 'nordwind-handel',
  name: 'Nordwind Handel GmbH',
  role: 'owner',
  lastSeq: 120,
  createdAt: '2026-10-07T00:00:00.000Z',
};

function relation(status: string, endpointState = 'ok') {
  return {
    id: 'rel_x',
    type: 'call',
    from: 'a/b#C',
    to: 'c/d#P',
    status,
    endpointState,
    tier: 'rule',
    confidence: 1,
    version: 1,
    attrs: {},
    updatedAt: '',
  };
}

const LANDSCAPE = {
  projectId: PROJECT.id,
  seq: 120,
  models: [
    { id: 'mdl_1', key: 'a/b', name: null, stage: 'waiting_for_agent', processes: [] },
    { id: 'mdl_2', key: 'c/d', name: null, stage: 'incorporated', processes: [] },
  ],
  relations: [relation('accepted'), relation('accepted', 'missing'), relation('proposed')],
  findings: [
    { kind: 'unresolved-call', refs: ['a/b#X'], detail: '' },
    { kind: 'dangling-throw', refs: ['a/b#Y'], detail: '' },
  ],
};

describe('seed landscapes', () => {
  it('seeds every scored landscape of the corpus by default (not _sample)', async () => {
    const all = await findLandscapes(DEFAULT_CORPUS, []);
    expect(all.map((l) => [l.key, l.name])).toEqual([
      ['nordwind-handel', 'Nordwind Handel GmbH'],
      ['stadtwerke-auental', 'Stadtwerke Auental'],
    ]);
    const [sample] = await findLandscapes(DEFAULT_CORPUS, ['_sample']);
    expect(sample?.key).toBe('sample');
    await expect(findLandscapes(DEFAULT_CORPUS, ['atlantis'])).rejects.toThrow(/no models/);
    await expect(findLandscapes(`${dir}/none`, [])).rejects.toThrow(/not a directory/);
  });

  it('names a project after the first clause of the landscape description', () => {
    expect(landscapeName('x', 'description: >-\n  Acme AG, a fictional company.\n')).toBe(
      'Acme AG',
    );
    expect(landscapeName('x', 'name: x\n')).toBe('x');
    expect(landscapeName('x', null)).toBe('x');
    expect(landscapeName('x', 'description: [unclosed')).toBe('x');
    // Commas inside parentheses do not end the clause; long clauses fall back to the key.
    expect(landscapeName('x', 'description: Acme (north, south) GmbH, a company')).toBe(
      'Acme (north, south) GmbH',
    );
    expect(
      landscapeName(
        'sample',
        'description: Tiny landscape (a, b, c) that exercises the spec format and the validator.',
      ),
    ).toBe('sample');
  });
});

describe('proa seed', () => {
  it('creates the project, imports every model and prints a summary', async () => {
    const created: string[] = [];
    const api = fakeApi({
      'GET /api/v1/projects/nordwind-handel': () => problem(404, 'not-found', 'no such project'),
      'POST /api/v1/projects': async (req) => {
        const body = (await req.json()) as { key: string; name: string };
        created.push(`${body.key}: ${body.name}`);
        return json({ ...PROJECT, ...body }, 201);
      },
      'POST /api/v1/projects/nordwind-handel/imports': async (req) => {
        const files = (await req.formData()).getAll('files') as File[];
        return json({
          files: files.map((f) => ({
            path: f.name,
            modelKey: f.name.replace(/\.bpmn$/, ''),
            outcome: 'created',
            problem: null,
          })),
        });
      },
      'GET /api/v1/projects/nordwind-handel/landscape': () => json(LANDSCAPE),
    });
    const t = testIo({ PROA_OWNER_KEY_FILE: keyFile }, api.fetch);
    expect(await runCli(['seed', 'nordwind-handel'], t.io)).toBe(0);
    expect(t.err()).toBe('');
    expect(created).toEqual(['nordwind-handel: Nordwind Handel GmbH']);
    expect(api.seen.every((s) => s.authorization === `Bearer ${OWNER_KEY}`)).toBe(true);
    expect(t.out()).toContain('nordwind-handel (Nordwind Handel GmbH): project created');
    expect(t.out()).toContain('31 files: 31 created, 0 revised, 0 unchanged, 0 failed');
    expect(t.out()).toContain('2 models, relations: 2 accepted, 1 proposed, 2 findings');
    expect(t.out()).toContain('proa token create --project nordwind-handel');
  });

  it('reuses an existing project and can issue an agent token', async () => {
    const tokenNames: string[] = [];
    const api = fakeApi({
      'GET /api/v1/projects/nordwind-handel': () => json(PROJECT),
      'POST /api/v1/projects/nordwind-handel/imports': async (req) => {
        const files = (await req.formData()).getAll('files') as File[];
        return json({
          files: files.map((f) => ({
            path: f.name,
            modelKey: null,
            outcome: 'unchanged',
            problem: null,
          })),
        });
      },
      'GET /api/v1/projects/nordwind-handel/landscape': () => json(LANDSCAPE),
      'POST /api/v1/projects/nordwind-handel/agent-tokens': async (req) => {
        tokenNames.push(((await req.json()) as { name: string }).name);
        return json(
          {
            id: 'agt_1',
            name: 'seed',
            prefix: 'aaaaaaaa',
            scopes: ['proa:read', 'proa:propose'],
            expiresAt: '',
            revokedAt: null,
            lastUsedAt: null,
            createdAt: '',
            secret: `proa_at_${'a'.repeat(49)}`,
          },
          201,
        );
      },
    });
    const t = testIo({ PROA_OWNER_KEY_FILE: keyFile }, api.fetch);
    expect(await runCli(['seed', 'nordwind-handel', '--issue-tokens', '--json'], t.io)).toBe(0);
    expect(tokenNames).toEqual(['seed']);
    const [result] = JSON.parse(t.out()) as [
      { created: boolean; import: { counts: Record<string, number> }; token: { secret: string } },
    ];
    expect(result.created).toBe(false);
    expect(result.import.counts).toEqual({ created: 0, revised: 0, unchanged: 31, failed: 0 });
    expect(result.token.secret).toMatch(/^proa_at_/);
    expect(api.seen.filter((s) => s.method === 'POST' && s.path === '/api/v1/projects')).toEqual(
      [],
    );
  });

  it('--project seeds one landscape into a project of that key; --token-name names the token', async () => {
    const created: unknown[] = [];
    const tokens: unknown[] = [];
    const run = 'nordwind-handel-claude-desktop-1';
    const api = fakeApi({
      [`GET /api/v1/projects/${run}`]: () => problem(404, 'not-found', 'no such project'),
      'POST /api/v1/projects': async (req) => {
        const body = (await req.json()) as { key: string; name: string };
        created.push(body);
        return json({ ...PROJECT, ...body }, 201);
      },
      [`POST /api/v1/projects/${run}/imports`]: async (req) => {
        const files = (await req.formData()).getAll('files') as File[];
        return json({
          files: files.map((f) => ({
            path: f.name,
            modelKey: null,
            outcome: 'created',
            problem: null,
          })),
        });
      },
      [`GET /api/v1/projects/${run}/landscape`]: () => json(LANDSCAPE),
      [`POST /api/v1/projects/${run}/agent-tokens`]: async (req) => {
        const body = (await req.json()) as { name: string };
        tokens.push(body);
        return json(
          {
            id: 'agt_2',
            name: body.name,
            prefix: 'bbbbbbbb',
            scopes: ['proa:read', 'proa:propose'],
            expiresAt: '',
            revokedAt: null,
            lastUsedAt: null,
            createdAt: '',
            secret: `proa_at_${'b'.repeat(49)}`,
          },
          201,
        );
      },
    });
    const argv = ['seed', 'nordwind-handel', '--project', run, '--issue-tokens'];
    const t = testIo({ PROA_OWNER_KEY_FILE: keyFile }, api.fetch);
    expect(await runCli([...argv, '--token-name', 'claude-desktop-1', '--json'], t.io)).toBe(0);
    expect(t.err()).toBe('');
    expect(created).toEqual([{ key: run, name: `Nordwind Handel GmbH (${run})` }]);
    expect(tokens).toEqual([
      { name: 'claude-desktop-1', scopes: ['proa:read', 'proa:propose'], expiresInDays: 90 },
    ]);
    const [result] = JSON.parse(t.out()) as [Record<string, unknown>];
    expect(result).toMatchObject({
      project: run,
      landscape: 'nordwind-handel',
      created: true,
      token: { name: 'claude-desktop-1' },
    });
    // Nothing but the named project was touched.
    expect(api.seen.every((s) => s.path === '/api/v1/projects' || s.path.includes(run))).toBe(true);

    const text = testIo({ PROA_OWNER_KEY_FILE: keyFile }, api.fetch);
    expect(await runCli(argv, text.io)).toBe(0);
    expect(text.out()).toContain(`${run} (landscape nordwind-handel): project created`);
    expect(text.out()).toContain('Agent token "seed"');
  });

  it('refuses an existing --project before importing or issuing a token', async () => {
    const imported: string[] = [];
    const api = fakeApi({
      'GET /api/v1/projects/run-1': () => json({ ...PROJECT, key: 'run-1' }),
      // Served, so a missing guard would import new models and issue a token.
      'POST /api/v1/projects/run-1/imports': async (req) => {
        const files = (await req.formData()).getAll('files') as File[];
        imported.push(...files.map((f) => f.name));
        return json({
          files: files.map((f) => ({
            path: f.name,
            modelKey: null,
            outcome: 'created',
            problem: null,
          })),
        });
      },
      'GET /api/v1/projects/run-1/landscape': () => json(LANDSCAPE),
      'POST /api/v1/projects/run-1/agent-tokens': () => json({}, 201),
    });
    const t = testIo({ PROA_OWNER_KEY_FILE: keyFile }, api.fetch);
    const argv = ['seed', 'nordwind-handel', '--project', 'run-1', '--issue-tokens', '--json'];
    expect(await runCli([...argv, '--token-name', 'claude-code-1'], t.io)).toBe(1);
    expect(t.err()).toContain(
      'project run-1 already exists; a live run needs a fresh project: pick another key (nothing was imported, no token was issued)',
    );
    expect(t.out()).toBe('');
    expect(imported).toEqual([]);
    expect(api.seen.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /api/v1/projects/run-1']);
  });

  it('refuses --project and --token-name misuse before touching the server', async () => {
    const cases: [string[], RegExp][] = [
      [['seed', '--project', 'run-1'], /--project seeds exactly one landscape/],
      [['seed', 'nordwind-handel', '_sample', '--project', 'run-1'], /exactly one landscape/],
      [
        ['seed', 'nordwind-handel', '--project', 'Run_1'],
        /invalid project key "Run_1": must be a lowercase slug/,
      ],
      [['seed', 'nordwind-handel', '--project', 'x'.repeat(65)], /invalid project key/],
      [
        ['seed', 'nordwind-handel', '--token-name', 'claude-1'],
        /--token-name needs --issue-tokens/,
      ],
      [
        ['seed', 'nordwind-handel', '--issue-tokens', '--token-name', 'a\u0007b'],
        /invalid token name/,
      ],
      [['seed', 'nordwind-handel', '--issue-tokens', '--token-name', ''], /invalid token name/],
    ];
    for (const [argv, message] of cases) {
      const api = fakeApi({});
      const t = testIo({ PROA_OWNER_KEY_FILE: keyFile }, api.fetch);
      expect(await runCli(argv, t.io), argv.join(' ')).toBe(1);
      expect(t.err()).toMatch(message);
      expect(api.seen).toEqual([]);
    }
  });

  it('documents --project and --token-name in seed --help', async () => {
    const t = testIo();
    expect(await runCli(['seed', '--help'], t.io)).toBe(0);
    expect(t.out()).toContain('-p, --project <key>');
    expect(t.out()).toContain('--token-name <name>');
    expect(t.out()).toContain('(default seed)');
  });
});

describe('proa status', () => {
  it('shows health, caller and per-project counts', async () => {
    const api = fakeApi({
      'GET /health': () => json({ status: 'ok', version: '2.0.0-alpha.0', db: 'ok' }),
      'GET /api/v1/me': () =>
        json({
          principalId: 'prn_1',
          kind: 'user',
          handle: 'owner',
          authMode: 'local',
          clientId: 'proa-cli',
        }),
      'GET /api/v1/projects': () => json({ items: [PROJECT], nextCursor: null }),
      'GET /api/v1/projects/nordwind-handel/landscape': () => json(LANDSCAPE),
    });
    const t = testIo({ PROA_OWNER_KEY_FILE: keyFile }, api.fetch);
    expect(await runCli(['status'], t.io)).toBe(0);
    const out = t.out();
    expect(out).toContain('ProA 2.0.0-alpha.0 at http://127.0.0.1:7400: ok, database ok');
    expect(out).toContain(`as owner (user, client proa-cli) via owner key ${keyFile}`);
    expect(out).toContain('nordwind-handel  Nordwind Handel GmbH  (role owner, seq 120)');
    expect(out).toContain('models     2 (1 incorporated, 1 waiting for agent)');
    expect(out).toContain('relations  2 accepted, 1 proposed');
    expect(out).toContain('endpoints  1 accepted relations with a changed or missing endpoint');
    expect(out).toContain('findings   1 dangling-throw, 1 unresolved-call');
    expect(out).not.toContain(OWNER_KEY);

    const j = testIo({ PROA_OWNER_KEY_FILE: keyFile }, api.fetch);
    expect(await runCli(['status', '--json', '-p', 'nordwind-handel'], j.io)).toBe(0);
    expect(JSON.parse(j.out())).toMatchObject({
      projects: [{ key: 'nordwind-handel', models: 2, endpointIssues: 1 }],
    });
  });

  it('reports the server without credentials, and fails for a degraded server', async () => {
    const api = fakeApi({
      'GET /health': () => json({ status: 'degraded', version: '2', db: 'down' }, 503),
    });
    const t = testIo({ PROA_OWNER_KEY_FILE: keyFile }, api.fetch);
    expect(await runCli(['status'], t.io)).toBe(1);
    expect(t.out()).toContain('degraded, database down');
    expect(t.out()).toContain('the database is down, so no projects');
    expect(t.err()).toContain('not healthy');
    expect(api.seen.map((s) => s.path)).toEqual(['/health']);

    const ok = fakeApi({ 'GET /health': () => json({ status: 'ok', version: '2', db: 'ok' }) });
    const anonymous = testIo({ PROA_OWNER_KEY_FILE: `${dir}/missing` }, ok.fetch);
    expect(await runCli(['status'], anonymous.io)).toBe(0);
    expect(anonymous.out()).toContain('no credentials, so no projects: no owner key at');
  });

  it('reports the server only when it rejects the owner key at the default location', async () => {
    const stateHome = await tempDir();
    const defaultKey = await ownerKeyFile(stateHome); // <XDG_STATE_HOME>/proa/owner-key
    const rejecting = fakeApi({
      'GET /health': () => json({ status: 'ok', version: '2', db: 'ok' }),
      'GET /api/v1/me': () => problem(401, 'unauthorized', 'invalid owner key'),
    });
    try {
      // Default location (XDG_STATE_HOME): a stale key from another instance.
      const t = testIo({ XDG_STATE_HOME: stateHome }, rejecting.fetch);
      expect(await runCli(['status'], t.io)).toBe(0);
      expect(t.out()).toContain('ok, database ok');
      expect(t.out()).toContain(`does not accept the owner key at ${defaultKey}`);
      expect(t.out()).toContain('exec proa proa status');
      expect(t.out()).not.toContain('via owner key');
      expect(rejecting.seen.map((s) => s.path)).toEqual(['/health', '/api/v1/me']);

      // An explicit key file the server rejects is an error.
      const explicit = testIo({ PROA_OWNER_KEY_FILE: keyFile }, rejecting.fetch);
      expect(await runCli(['status'], explicit.io)).toBe(1);
      expect(explicit.err()).toContain('who am I failed (401');
    } finally {
      await rm(stateHome, { recursive: true, force: true });
    }
  });
});
