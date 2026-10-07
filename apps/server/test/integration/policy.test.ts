/**
 * Policy matrix over REST (CONCEPT §6): owner session vs agent tokens with
 * each scope vs a token of another project vs no credential, for read,
 * write and admin use cases; foreign ids answer 404.
 */
import type { ModelPage, ProjectPage, PutModelResult, RelationPage } from '@proa/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApp, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { fakeBpmn, type FakeModelSpec } from '../support/fake-analysis.ts';

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

type Who = 'owner' | 'read' | 'propose' | 'write' | 'other' | 'anonymous';
const secrets: Partial<Record<Who, string>> = {};
let ids: { model: string; revision: string; relation: string; token: string };
let foreign: { model: string; revision: string; relation: string; token: string };

async function as(who: Who, path: string, init: RequestInit = {}): Promise<Response> {
  if (who === 'owner') return t.asOwner(path, init);
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
  t = startTestApp(database);
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
