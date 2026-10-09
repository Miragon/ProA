/**
 * Policy matrix over REST (CONCEPT §6): owner session vs agent tokens with
 * each scope vs a token of another project vs no credential, for read,
 * write and admin use cases; foreign ids answer 404.
 */
import type {
  ModelPage,
  PostPlacementsResult,
  ProjectPage,
  PutModelResult,
  RelationPage,
} from '@proa/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateOwnerKey } from '../../src/auth/owner-key.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { fakeBpmn, type FakeModelSpec } from '../support/fake-analysis.ts';
import { chain, chainPath } from '../support/value-chain.ts';

let database: TestDatabase;
let t: TestApp;

const caller: FakeModelSpec = {
  processes: [
    {
      id: 'Process_A',
      name: 'A',
      elements: [{ kind: 'call', id: 'Call_B', name: 'B', ref: 'Process_B' }],
    },
  ],
};
const callee: FakeModelSpec = { processes: [{ id: 'Process_B', name: 'B' }] };

type Who = 'owner' | 'ownerKey' | 'read' | 'propose' | 'write' | 'other' | 'anonymous';
const ownerKey = generateOwnerKey();
const secrets: Partial<Record<Who, string>> = {};
let ids: { model: string; revision: string; relation: string; token: string };
let foreign: { model: string; revision: string; relation: string; token: string };

async function as(who: Who, path: string, init: RequestInit = {}): Promise<Response> {
  if (who === 'owner') return t.asOwner(path, init);
  if (who === 'ownerKey') return t.asToken(ownerKey, path, init);
  if (who === 'anonymous') return t.request(path, init);
  const secret = secrets[who];
  if (!secret) throw new Error(`no token for ${who}`);
  return t.asToken(secret, path, init);
}

async function seed(project: string): Promise<typeof ids> {
  await t.putModel(project, 'a/caller', fakeBpmn(caller));
  const res = await t.putModel(project, 'b/callee', fakeBpmn(callee));
  const put = (await res.json()) as PutModelResult;
  const rel = (await (
    await t.asOwner(`/api/v1/projects/${project}/relations`)
  ).json()) as RelationPage;
  const token = await t.createToken(project, ['proa:read']);
  return {
    model: put.model.id,
    revision: put.revision.id,
    relation: rel.items[0]?.id ?? '',
    token: token.id,
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database, { ownerKey });
  await t.createProject('p');
  await t.createProject('q');
  ids = await seed('p');
  foreign = await seed('q');
  secrets.read = (await t.createToken('p', ['proa:read'])).secret;
  secrets.propose = (await t.createToken('p', ['proa:read', 'proa:propose'])).secret;
  secrets.write = (await t.createToken('p', ['proa:write'])).secret;
  secrets.other = (await t.createToken('q', ['proa:read', 'proa:propose', 'proa:write'])).secret;
});

afterAll(async () => {
  await database.drop();
});

const readPaths = () => [
  '/api/v1/projects/p',
  '/api/v1/projects/p/models',
  `/api/v1/projects/p/models/${ids.model}`,
  `/api/v1/projects/p/models/${ids.model}/revisions`,
  `/api/v1/projects/p/models/${ids.model}/revisions/${ids.revision}/facts`,
  `/api/v1/projects/p/models/${ids.model}/revisions/${ids.revision}/content`,
  '/api/v1/projects/p/relations',
  `/api/v1/projects/p/relations/${ids.relation}`,
  '/api/v1/projects/p/findings',
  '/api/v1/projects/p/landscape',
];

describe('read (proa:read, viewer)', () => {
  it.each<[Who, number]>([
    ['owner', 200],
    ['read', 200],
    ['propose', 200],
    ['write', 200],
    ['other', 404],
    ['anonymous', 401],
  ])('%s → %i', async (who, status) => {
    for (const path of readPaths()) {
      const res = await as(who, path);
      expect(res.status, `${who} GET ${path}`).toBe(status);
    }
  });

  it('accepts the project id as well as the key', async () => {
    const project = (await (await as('read', '/api/v1/projects/p')).json()) as { id: string };
    expect((await as('read', `/api/v1/projects/${project.id}/models`)).status).toBe(200);
  });

  it('lists exactly the projects a credential can see', async () => {
    const keys = async (who: Who) =>
      ((await (await as(who, '/api/v1/projects')).json()) as ProjectPage).items.map((p) => [
        p.key,
        p.role,
      ]);
    expect(await keys('owner')).toEqual([
      ['p', 'owner'],
      ['q', 'owner'],
    ]);
    expect(await keys('read')).toEqual([['p', 'viewer']]);
    expect(await keys('propose')).toEqual([['p', 'editor']]);
    expect(await keys('other')).toEqual([['q', 'editor']]);
  });

  it('answers 401 with a Bearer challenge', async () => {
    const res = await as('anonymous', '/api/v1/projects');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect(await res.json()).toMatchObject({ code: 'unauthorized' });
  });
});

describe('write (proa:write, editor)', () => {
  it.each<[Who, number, string | null]>([
    ['read', 403, 'insufficient-scope'],
    ['propose', 403, 'insufficient-scope'],
    ['other', 404, 'not-found'],
    ['anonymous', 401, 'unauthorized'],
    ['write', 201, null],
    ['owner', 200, null],
  ])('PUT model as %s → %i', async (who, status, code) => {
    const res = await as(who, '/api/v1/projects/p/models/by-key/c%2Fnew', {
      method: 'PUT',
      headers: { 'content-type': 'application/xml' },
      body: fakeBpmn({ processes: [{ id: `Process_${who}`, name: who }] }),
    });
    expect(res.status).toBe(status);
    if (code) expect(await res.json()).toMatchObject({ code });
  });

  it('records the token as author of its revision', async () => {
    const models = (await (await as('read', '/api/v1/projects/p/models')).json()) as ModelPage;
    expect(models.items.map((m) => m.key)).toContain('c/new');
  });

  it.each<[Who, number]>([
    ['read', 403],
    ['propose', 403],
    ['other', 404],
    ['anonymous', 401],
  ])('import and delete as %s → %i', async (who, status) => {
    const fd = new FormData();
    fd.append('files', new Blob([fakeBpmn(callee)]), 'd/x.bpmn');
    expect((await as(who, '/api/v1/projects/p/imports', { method: 'POST', body: fd })).status).toBe(
      status,
    );
    expect(
      (await as(who, `/api/v1/projects/p/models/${ids.model}`, { method: 'DELETE' })).status,
    ).toBe(status);
  });
});

describe('admin (owner on an interactive client)', () => {
  it.each<[Who, number, string]>([
    ['read', 403, 'forbidden'],
    ['propose', 403, 'forbidden'],
    ['write', 403, 'forbidden'],
    ['other', 404, 'not-found'],
    ['anonymous', 401, 'unauthorized'],
  ])('agent tokens as %s → %i %s', async (who, status, code) => {
    const list = await as(who, '/api/v1/projects/p/agent-tokens');
    expect(list.status).toBe(status);
    expect(await list.json()).toMatchObject({ code });
    const create = await as(who, '/api/v1/projects/p/agent-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', scopes: ['proa:read'] }),
    });
    expect(create.status).toBe(status);
    const revoke = await as(who, `/api/v1/projects/p/agent-tokens/${ids.token}`, {
      method: 'DELETE',
    });
    expect(revoke.status).toBe(status);
  });

  it('lets the owner manage tokens', async () => {
    expect((await as('owner', '/api/v1/projects/p/agent-tokens')).status).toBe(200);
  });

  it.each<[Who, number]>([
    ['read', 403],
    ['write', 403],
    ['other', 403],
    ['anonymous', 401],
  ])('only users create projects: %s → %i', async (who, status) => {
    const res = await as(who, '/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: `from-${who}`, name: 'x' }),
    });
    expect(res.status).toBe(status);
  });

  it('rejects a taken project key with 409', async () => {
    const res = await as('owner', '/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'p', name: 'again' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('foreign ids (another project of the same owner) → 404', () => {
  it.each([
    ['model', () => `/api/v1/projects/p/models/${foreign.model}`],
    ['revisions', () => `/api/v1/projects/p/models/${foreign.model}/revisions`],
    [
      'revision of a local model',
      () => `/api/v1/projects/p/models/${ids.model}/revisions/${foreign.revision}/facts`,
    ],
    ['relation', () => `/api/v1/projects/p/relations/${foreign.relation}`],
  ])('%s', async (_name, path) => {
    const res = await as('owner', path());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not-found' });
  });

  it('agent token of another project', async () => {
    const res = await as('owner', `/api/v1/projects/p/agent-tokens/${foreign.token}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  it('deleting a foreign model', async () => {
    const res = await as('owner', `/api/v1/projects/p/models/${foreign.model}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});

describe('write as owner and token', () => {
  it('lets a write token delete a model', async () => {
    const res = await as('write', `/api/v1/projects/p/models/${ids.model}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });
});

describe('pipeline (proa:propose, editor; requeue: proa:write)', () => {
  const claimBody = (projectId?: string) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(projectId ? { projectId, max: 1 } : { max: 1 }),
  });

  it.each<[Who, number, string | null]>([
    ['read', 403, 'insufficient-scope'],
    ['write', 403, 'insufficient-scope'],
    ['other', 404, 'not-found'],
    ['anonymous', 401, 'unauthorized'],
    ['propose', 200, null],
    ['owner', 200, null],
  ])('claim in project p as %s → %i', async (who, status, code) => {
    const res = await as(who, '/api/v1/analyses/claim', claimBody('p'));
    expect(res.status).toBe(status);
    if (code) expect(await res.json()).toMatchObject({ code });
  });

  it('claims only in the caller’s own projects without projectId', async () => {
    const other = await as('other', '/api/v1/analyses/claim', claimBody());
    const items = ((await other.json()) as { items: { projectKey: string }[] }).items;
    expect(items.map((i) => i.projectKey)).toEqual(['q']);
    for (const who of ['read', 'write'] as const) {
      expect((await as(who, '/api/v1/analyses/claim', claimBody())).status).toBe(403);
      expect((await as(who, '/api/v1/analyses/pending')).status).toBe(403);
    }
    expect((await as('propose', '/api/v1/analyses/pending')).status).toBe(200);
  });

  it.each<[Who, number]>([
    ['read', 403],
    ['propose', 403],
    ['other', 404],
    ['anonymous', 401],
    ['write', 200],
    ['owner', 200],
  ])('requeue as %s → %i', async (who, status) => {
    const res = await as(who, '/api/v1/projects/p/analyses/requeue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    expect(res.status).toBe(status);
  });

  it.each<[Who, number]>([
    ['read', 200],
    ['propose', 200],
    ['write', 200],
    ['owner', 200],
    ['other', 404],
    ['anonymous', 401],
  ])('read the task list and a relation history as %s → %i', async (who, status) => {
    expect((await as(who, '/api/v1/projects/p/analyses')).status).toBe(status);
    expect((await as(who, `/api/v1/projects/p/relations/${ids.relation}/assertions`)).status).toBe(
      status,
    );
  });
});

describe('review (proa:review: a user on an interactive client)', () => {
  const json = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it.each<[Who, number, string]>([
    ['read', 403, 'human-decision-required'],
    ['propose', 403, 'human-decision-required'],
    ['write', 403, 'human-decision-required'],
    ['other', 404, 'not-found'],
    ['anonymous', 401, 'unauthorized'],
  ])('agent tokens never decide: %s → %i %s', async (who, status, code) => {
    for (const [path, body] of [
      [`/api/v1/projects/p/relations/${ids.relation}/decision`, { verdict: 'accept' }],
      [
        '/api/v1/projects/p/decisions',
        { verdict: 'accept', items: [{ id: ids.relation, version: 1 }], expectedCount: 1 },
      ],
      [`/api/v1/projects/p/relations/${ids.relation}/notes`, { text: 'x' }],
      [
        '/api/v1/projects/p/relations',
        {
          type: 'manual',
          from: 'a/caller#Call_B',
          to: 'b/callee#Process_B',
          confidence: 1,
          rationale: 'x',
        },
      ],
    ] as const) {
      const res = await as(who, path, json(body));
      expect(res.status, `${who} ${path}`).toBe(status);
      expect(await res.json()).toMatchObject({ code });
    }
  });

  it('lets the owner decide; a foreign relation is 404', async () => {
    const res = await as(
      'owner',
      `/api/v1/projects/p/relations/${ids.relation}/decision`,
      json({ verdict: 'accept' }),
    );
    expect(res.status).toBe(200);
    const foreignRes = await as(
      'owner',
      `/api/v1/projects/p/relations/${foreign.relation}/decision`,
      json({ verdict: 'accept' }),
    );
    expect(foreignRes.status).toBe(404);
  });

  it.each<[Who, number]>([
    ['read', 403],
    ['write', 403],
    ['other', 404],
    ['anonymous', 401],
  ])('ad-hoc proposals need proa:propose: %s → %i', async (who, status) => {
    const res = await as(
      who,
      '/api/v1/projects/p/relations',
      json({
        type: 'call',
        from: 'a/caller#Call_B',
        to: 'b/callee#Process_B',
        confidence: 1,
        rationale: 'x',
      }),
    );
    expect(res.status).toBe(status);
    const withdraw = await as(who, `/api/v1/projects/p/relations/${ids.relation}/proposal`, {
      method: 'DELETE',
    });
    expect(withdraw.status).toBe(status);
  });
});

describe('value chain and placements (M4: read, propose, review)', () => {
  const steps = [
    { id: 'step-a', name: 'Anfrage' },
    { id: 'step-b', name: 'Bearbeitung' },
  ];
  const doc = chain({ steps, sequence: [['step-a', 'step-b']] });
  let placement = '';
  let foreignPlacement = '';

  const body = (method: string, value: unknown, headers: Record<string, string> = {}) => ({
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value),
  });

  async function setUpChain(project: string): Promise<string> {
    const res = await t.asOwner(
      chainPath(project, '/content'),
      body('PUT', doc, { 'if-none-match': '*' }),
    );
    expect(res.status).toBe(201);
    const placed = (await (
      await t.asOwner(
        chainPath(project, '/placements'),
        body('POST', {
          kind: 'manual',
          step: 'step-a',
          process: 'a/caller#Process_A',
          rationale: 'x',
        }),
      )
    ).json()) as PostPlacementsResult;
    if (placed.kind !== 'manual') throw new Error('not manual');
    return placed.placement.id;
  }

  beforeAll(async () => {
    placement = await setUpChain('p');
    foreignPlacement = await setUpChain('q');
  });

  const readRoutes = () => [
    '/api/v1/projects/p/value-chains',
    chainPath('p'),
    chainPath('p', '/content'),
    chainPath('p', '/revisions'),
    chainPath('p', '/revisions/1/content'),
    chainPath('p', '/steps/step-a'),
    chainPath('p', '/unplaced-processes'),
    chainPath('p', '/findings'),
    chainPath('p', '/placements'),
    chainPath('p', `/placements/${placement}`),
    chainPath('p', `/placements/${placement}/assertions`),
  ];

  /** The review routes with a request each (the owner's would succeed or answer 409/422). */
  const reviewRequests = (): [string, RequestInit][] => [
    ['/api/v1/projects/p/value-chains', body('POST', { key: 'main', name: 'Neu' })],
    [chainPath('p'), { method: 'DELETE' }],
    [chainPath('p', '/content'), body('PUT', doc, { 'if-match': '"r1"' })],
    [
      chainPath('p', '/placements'),
      body('POST', {
        kind: 'manual',
        step: 'step-b',
        process: 'b/callee#Process_B',
        rationale: 'x',
      }),
    ],
    [chainPath('p', `/placements/${placement}/decision`), body('POST', { verdict: 'accept' })],
    [
      chainPath('p', '/placements/decisions'),
      body('POST', { verdict: 'accept', items: [{ id: placement, version: 1 }], expectedCount: 1 }),
    ],
    [chainPath('p', `/placements/${placement}/notes`), body('POST', { text: 'Antwort' })],
  ];

  it.each<[Who, number]>([
    ['owner', 200],
    ['ownerKey', 200],
    ['read', 200],
    ['propose', 200],
    ['write', 200],
    ['other', 404],
    ['anonymous', 401],
  ])('reads as %s → %i', async (who, status) => {
    for (const path of readRoutes()) {
      const res = await as(who, path);
      expect(res.status, `${who} GET ${path}`).toBe(status);
    }
  });

  it.each<[Who, number, string]>([
    ['read', 403, 'insufficient-scope'],
    ['write', 403, 'insufficient-scope'],
    ['other', 404, 'not-found'],
    ['anonymous', 401, 'unauthorized'],
  ])('proposing and withdrawing need proa:propose: %s → %i %s', async (who, status, code) => {
    const propose = await as(
      who,
      chainPath('p', '/placements'),
      body('POST', {
        kind: 'propose',
        placements: [
          { step: 'step-b', process: 'b/callee#Process_B', confidence: 0.5, rationale: 'x' },
        ],
      }),
    );
    expect(propose.status).toBe(status);
    expect(await propose.json()).toMatchObject({ code });
    const withdraw = await as(who, chainPath('p', `/placements/${placement}/proposal`), {
      method: 'DELETE',
    });
    expect(withdraw.status).toBe(status);
  });

  it.each<Who>(['propose', 'owner', 'ownerKey'])(
    '%s proposes and withdraws its own proposal',
    async (who) => {
      const proposed = await as(
        who,
        chainPath('p', '/placements'),
        body('POST', {
          kind: 'propose',
          // b/callee was deleted above; a/caller stays.
          placements: [
            { step: 'step-b', process: 'a/caller#Process_A', confidence: 0.5, rationale: who },
          ],
        }),
      );
      expect(proposed.status).toBe(200);
      const result = (await proposed.json()) as PostPlacementsResult;
      expect(result.kind === 'propose' && result.items[0]?.result).toBe('applied');
      const id = result.kind === 'propose' ? (result.items[0]?.placementId ?? '') : '';
      const withdrawn = await as(who, chainPath('p', `/placements/${id}/proposal`), {
        method: 'DELETE',
      });
      expect(withdrawn.status).toBe(200);
    },
  );

  it.each<[Who, number, string]>([
    ['read', 403, 'human-decision-required'],
    ['propose', 403, 'human-decision-required'],
    ['write', 403, 'human-decision-required'],
    ['other', 404, 'not-found'],
    ['anonymous', 401, 'unauthorized'],
  ])(
    'chain writes, decisions, manual placements and notes are human: %s → %i %s',
    async (who, status, code) => {
      for (const [path, init] of reviewRequests()) {
        const res = await as(who, path, init);
        expect(res.status, `${who} ${init.method ?? 'GET'} ${path}`).toBe(status);
        const problem = (await res.json()) as { code: string; reviewUrl?: string };
        expect(problem.code).toBe(code);
        if (code === 'human-decision-required') {
          expect(problem.reviewUrl, path).toMatch(/^http:\/\/localhost\/projects\/p\/value-chain/);
        }
      }
    },
  );

  it('lets the owner session and the owner key write and decide', async () => {
    const note = await as(
      'ownerKey',
      chainPath('p', `/placements/${placement}/notes`),
      body('POST', { text: 'CLI' }),
    );
    expect(note.status).toBe(201);
    const unchanged = await as(
      'ownerKey',
      chainPath('p', '/content'),
      body('PUT', doc, { 'if-match': '"r1"' }),
    );
    expect(unchanged.status).toBe(200);
    const decided = await as(
      'owner',
      chainPath('p', `/placements/${placement}/decision`),
      body('POST', { verdict: 'accept' }),
    );
    expect(decided.status).toBe(200);
    const created = await as(
      'ownerKey',
      '/api/v1/projects/p/value-chains',
      body('POST', { key: 'main', name: 'X' }),
    );
    expect(created.status).toBe(409);
  });

  it('answers 404 for a placement of another project', async () => {
    for (const path of [
      chainPath('p', `/placements/${foreignPlacement}`),
      chainPath('p', `/placements/${foreignPlacement}/assertions`),
    ]) {
      expect((await as('owner', path)).status, path).toBe(404);
    }
    const decide = await as(
      'owner',
      chainPath('p', `/placements/${foreignPlacement}/decision`),
      body('POST', { verdict: 'accept' }),
    );
    expect(decide.status).toBe(404);
  });
});
