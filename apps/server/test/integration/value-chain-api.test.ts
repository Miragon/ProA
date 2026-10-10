/**
 * The value chain over REST (M4 S2) against PostgreSQL: create by name or
 * by document, the content with its ETag, saves with `If-Match` (428, 412,
 * `unchanged` with a stale tag), `If-None-Match: *`, dry runs that write
 * nothing, layout-only saves, renames and deletions with their impact on
 * placements, refused documents, revisions, the step drill-down (also with
 * the real libraries on the dev landscape) and agents refused with the value
 * chain `reviewUrl`. Synthetic chains and the dev landscape only.
 */
import { readFile } from 'node:fs/promises';

import type {
  Placement,
  PlacementDecisionResult,
  PostPlacementsResult,
  Project,
  Ref,
  RelationPage,
  SaveValueChainResult,
  ValueChainDetail,
  ValueChainRevisionPage,
  ValueChainStepDetail,
  ValueChainViolation,
} from '@proa/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { libraryAnalysis } from '../../src/analysis.ts';
import { createStore } from '../../src/db/store.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import { corpusFiles, importAll } from '../support/corpus.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { fakeBpmn } from '../support/fake-analysis.ts';
import {
  NORDWIND_CHAIN,
  NORDWIND_PLACEMENTS,
  chain,
  chainPath,
  relationSide,
  type StepSpec,
} from '../support/value-chain.ts';

let database: TestDatabase;
let t: TestApp;

const AUFTRAG = 'vertrieb/auftrag#P_Auftrag' as Ref;
const RECHNUNG = 'finanzen/rechnung#P_Rechnung' as Ref;
const VERSAND = 'lager/versand#P_Versand' as Ref;

const MODELS = {
  'vertrieb/auftrag': fakeBpmn({
    processes: [
      {
        id: 'P_Auftrag',
        name: 'Auftrag',
        elements: [{ kind: 'call', id: 'Call_Versand', name: 'Versand', ref: 'P_Versand' }],
      },
    ],
  }),
  'finanzen/rechnung': fakeBpmn({ processes: [{ id: 'P_Rechnung', name: 'Rechnung' }] }),
  'lager/versand': fakeBpmn({ processes: [{ id: 'P_Versand', name: 'Versand' }] }),
};

/** Steps whose names never equal a process name (rule-tier proposals stay out of the counts). */
const STEPS: StepSpec[] = [
  { id: 'step-vertrieb', name: 'Verkauf', x: 0 },
  { id: 'step-logistik', name: 'Logistik', x: 300 },
  { id: 'step-fakt', name: 'Fakturierung', x: 600 },
  { id: 'step-eingang', name: 'Eingangsbearbeitung', parent: 'step-vertrieb', x: 100, y: 100 },
  { id: 'step-pruefung', name: 'Prüfung', parent: 'step-vertrieb', x: 100, y: 200 },
];
const doc = (steps = STEPS, name = 'Testkette') =>
  chain({
    name,
    steps,
    sequence: [
      ['step-vertrieb', 'step-logistik'],
      ['step-logistik', 'step-fakt'],
    ],
    orgUnits: [{ id: 'org-vertrieb', name: 'Vertriebsteam', owns: ['step-vertrieb'] }],
  });

type Init = {
  headers?: Record<string, string>;
  body?: unknown;
  query?: string;
  raw?: string;
  type?: string;
};

async function put(project: string, init: Init = {}) {
  return t.asOwner(`${chainPath(project, '/content')}${init.query ?? ''}`, {
    method: 'PUT',
    headers: { 'content-type': init.type ?? 'application/json', ...init.headers },
    body: init.raw ?? JSON.stringify(init.body),
  });
}

async function json<T>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status, text.slice(0, 500)).toBe(status);
  return JSON.parse(text) as T;
}

async function lastSeq(project: string): Promise<number> {
  return ((await (await t.asOwner(`/api/v1/projects/${project}`)).json()) as Project).lastSeq;
}

async function events(project: string, after: number) {
  const projectId = ((await (await t.asOwner(`/api/v1/projects/${project}`)).json()) as Project).id;
  return createStore(database.db).read((tx) =>
    tx.events.list(projectId, { afterSeq: after, limit: 1000 }),
  );
}

async function setUp(key: string): Promise<Project> {
  const p = await t.createProject(key);
  for (const [modelKey, xml] of Object.entries(MODELS)) {
    expect((await t.putModel(key, modelKey, xml)).status).toBe(201);
  }
  return p;
}

async function manual(project: string, step: string, process: Ref): Promise<Placement> {
  const r = await json<PostPlacementsResult>(
    await t.asOwner(chainPath(project, '/placements'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'manual', step, process, rationale: 'Gehört dorthin.' }),
    }),
    200,
  );
  if (r.kind !== 'manual') throw new Error('not manual');
  return r.placement;
}

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database);
});

afterAll(async () => {
  await database.drop();
});

describe('create, read and delete', () => {
  it('creates an empty chain by name: 201, ETag "r1", the first revision', async () => {
    await setUp('vc-name');
    const res = await t.asOwner('/api/v1/projects/vc-name/value-chains', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'main', name: 'Wertschöpfungskette' }),
    });
    const created = await json<SaveValueChainResult>(res, 201);
    expect(res.headers.get('etag')).toBe('"r1"');
    expect(created).toMatchObject({
      dryRun: false,
      outcome: 'created',
      valueChain: { key: 'main', name: 'Wertschöpfungskette', headRev: 1, schemaVersion: 1 },
      revision: { rev: 1, baseRevisionId: null, handle: 'owner' },
      impact: { structureChanged: true, steps: { added: [], removed: [], changed: [] } },
    });
    const list = await json<{ items: { key: string }[] }>(
      await t.asOwner('/api/v1/projects/vc-name/value-chains'),
      200,
    );
    expect(list.items.map((c) => c.key)).toEqual(['main']);
  });

  it('refuses a second chain, another key, and a body with both or neither of name and content', async () => {
    const post = (body: unknown) =>
      t.asOwner('/api/v1/projects/vc-name/value-chains', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect(await json(await post({ key: 'main', name: 'Noch eine' }), 409)).toMatchObject({
      code: 'conflict',
    });
    expect(await json(await post({ key: 'zweite', name: 'X' }), 422)).toMatchObject({
      code: 'validation-failed',
      reason: 'value-chain-key',
    });
    expect(await json(await post({ key: 'main', name: 'X', content: doc() }), 422)).toMatchObject({
      code: 'validation-failed',
    });
    expect(await json(await post({ key: 'main' }), 422)).toMatchObject({
      code: 'validation-failed',
    });
    expect((await t.asOwner('/api/v1/projects/vc-name/value-chains/zweite')).status).toBe(404);
  });

  it('deletes the chain (404 afterwards), and creating it again revives the same id', async () => {
    const before = await json<ValueChainDetail>(await t.asOwner(chainPath('vc-name')), 200);
    expect((await t.asOwner(chainPath('vc-name'), { method: 'DELETE' })).status).toBe(204);
    const gone = await json<{ code: string; detail: string }>(
      await t.asOwner(chainPath('vc-name')),
      404,
    );
    expect(gone.code).toBe('not-found');
    // the detail tells an agent where a human creates the chain: the web page or the CLI
    expect(gone.detail).toContain('/projects/<project key>/value-chain');
    expect(gone.detail).toContain('proa value-chain push');
    expect((await t.asOwner(chainPath('vc-name', '/content'))).status).toBe(404);
    expect((await t.asOwner(chainPath('vc-name'), { method: 'DELETE' })).status).toBe(404);
    const revived = await json<SaveValueChainResult>(
      await put('vc-name', { headers: { 'if-none-match': '*' }, body: doc() }),
      201,
    );
    expect(revived).toMatchObject({
      outcome: 'revived',
      valueChain: { id: before.valueChain.id, headRev: 2 },
      impact: {
        steps: {
          added: expect.arrayContaining([
            { elementId: 'step-fakt', name: 'Fakturierung' },
          ]) as unknown,
        },
      },
    });
  });
});

describe('the golden dev chain by If-None-Match: *', () => {
  const text = () => readFile(NORDWIND_CHAIN, 'utf8');

  it('creates it (201), and a second create is 412 revision-conflict with the head rev', async () => {
    await t.createProject('vc-golden');
    const res = await put('vc-golden', { headers: { 'if-none-match': '*' }, raw: await text() });
    const created = await json<SaveValueChainResult>(res, 201);
    expect(res.headers.get('etag')).toBe('"r1"');
    expect(created.outcome).toBe('created');
    expect(created.impact.steps.added).toHaveLength(34);
    const again = await put('vc-golden', { headers: { 'if-none-match': '*' }, raw: await text() });
    expect(await json(again, 412)).toMatchObject({
      code: 'revision-conflict',
      headRev: 1,
      etag: '"r1"',
    });
  });

  it('serves the canonical bytes with the revision ETag; If-None-Match answers 304', async () => {
    const res = await t.asOwner(chainPath('vc-golden', '/content'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('etag')).toBe('"r1"');
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(await res.text()).toBe(await text());
    const cached = await t.asOwner(chainPath('vc-golden', '/content'), {
      headers: { 'if-none-match': '"r1"' },
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('etag')).toBe('"r1"');
    const stale = await t.asOwner(chainPath('vc-golden', '/content'), {
      headers: { 'if-none-match': 'W/"r0", "r9"' },
    });
    expect(stale.status).toBe(200);
  });

  it('derives kinds, ranks, owners and paths from the head', async () => {
    const detail = await json<ValueChainDetail>(await t.asOwner(chainPath('vc-golden')), 200);
    const expected = (
      parse(await readFile(NORDWIND_PLACEMENTS, 'utf8')) as {
        steps: { id: string; kind: string; level: number; parent?: string }[];
      }
    ).steps;
    expect(detail.steps).toHaveLength(expected.length);
    for (const e of expected) {
      expect(
        detail.steps.find((s) => s.elementId === e.id),
        e.id,
      ).toMatchObject({
        kind: e.kind,
        depth: e.level,
        parentId: e.parent ?? null,
        generation: 1,
        linkKind: 'none',
        counts: { accepted: 0, proposed: 0, held: 0 },
      });
    }
    expect(detail.steps.find((s) => s.elementId === 'step-vertrieb')).toMatchObject({
      rank: 2,
      path: ['Vertrieb'],
      owners: [{ elementId: 'org-vertrieb', name: expect.any(String) as unknown }],
      childIds: [
        'step-auftragseingang',
        'step-auftragsabwicklung',
        'step-bonitaetspruefung',
        'step-partnermanagement',
      ],
    });
    expect(detail.orgUnits).toHaveLength(12);
    expect(detail.placements).toEqual([]);
    expect(detail.valueChain).toMatchObject({ key: 'main', headRev: 1, schemaVersion: 1 });
  });
});

describe('saves with If-Match', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = (await setUp('vc-save')).id;
    await json(await put('vc-save', { headers: { 'if-none-match': '*' }, body: doc() }), 201);
  });

  it('requires If-Match (428) and refuses a stale one (412 revision-conflict with headRev)', async () => {
    expect(await json(await put('vc-save', { body: doc(STEPS, 'Neu') }), 428)).toMatchObject({
      code: 'precondition-required',
    });
    expect(
      await json(
        await put('vc-save', { headers: { 'if-match': '*' }, body: doc(STEPS, 'Neu') }),
        428,
      ),
    ).toMatchObject({ code: 'precondition-required' });
    expect(
      await json(
        await put('vc-save', { headers: { 'if-match': '"r9"' }, body: doc(STEPS, 'Neu') }),
        412,
      ),
    ).toMatchObject({ code: 'revision-conflict', headRev: 1, etag: '"r1"' });
    expect(
      await json(
        await put('vc-save', {
          headers: { 'if-match': '"r1"', 'if-none-match': '*' },
          body: doc(),
        }),
        422,
      ),
    ).toMatchObject({ code: 'validation-failed' });
  });

  it('answers unchanged content 200 unchanged even with a stale If-Match, and writes nothing', async () => {
    const seq = await lastSeq('vc-save');
    const res = await put('vc-save', { headers: { 'if-match': '"r7"' }, body: doc() });
    const same = await json<SaveValueChainResult>(res, 200);
    expect(res.headers.get('etag')).toBe('"r1"');
    expect(same).toMatchObject({
      outcome: 'unchanged',
      revision: { rev: 1 },
      impact: { structureChanged: false },
    });
    expect(await lastSeq('vc-save')).toBe(seq);
  });

  it('a dry run returns the impact and writes nothing (same last_seq, same head)', async () => {
    const accepted = await manual('vc-save', 'step-pruefung', RECHNUNG);
    const seq = await lastSeq('vc-save');
    const side = await relationSide(database.db, projectId);
    const renamed = STEPS.map((s) =>
      s.id === 'step-pruefung' ? { ...s, name: 'Bonitätsprüfung' } : s,
    );
    const res = await put('vc-save', {
      query: '?dryRun=true',
      headers: { 'if-match': '"r1"' },
      body: doc(renamed),
    });
    const dry = await json<SaveValueChainResult>(res, 200);
    expect(res.headers.get('etag')).toBe('"r1"');
    expect(dry).toMatchObject({
      dryRun: true,
      outcome: 'revised',
      revision: null,
      valueChain: { headRev: 1 },
      impact: {
        structureChanged: true,
        steps: {
          changed: [
            {
              elementId: 'step-pruefung',
              before: { name: 'Prüfung' },
              after: { name: 'Bonitätsprüfung' },
              fingerprintChanged: true,
              placements: { accepted: 1, held: 0, proposed: 0 },
            },
          ],
        },
        placements: { stranded: 0, toReconfirm: 1, proposalsWithdrawn: 0 },
      },
    });
    expect(await lastSeq('vc-save')).toBe(seq);
    expect(await relationSide(database.db, projectId)).toBe(side);
    // A stale If-Match fails the dry run as it would fail the save.
    expect(
      await json(
        await put('vc-save', {
          query: '?dryRun=true',
          headers: { 'if-match': '"r5"' },
          body: doc(renamed),
        }),
        412,
      ),
    ).toMatchObject({ code: 'revision-conflict' });
    const p = await json<Placement>(
      await t.asOwner(chainPath('vc-save', `/placements/${accepted.id}`)),
      200,
    );
    expect(p.version).toBe(accepted.version);
  });

  it('a layout-only save is a new revision with the same structure hash; placements do not move', async () => {
    const head = await json<ValueChainDetail>(await t.asOwner(chainPath('vc-save')), 200);
    const placementsBefore = head.placements;
    const moved = doc(STEPS.map((s) => ({ ...s, x: (s.x ?? 0) + 40, y: (s.y ?? 0) + 10 })));
    const seq = await lastSeq('vc-save');
    const res = await put('vc-save', { headers: { 'if-match': '"r1"' }, body: moved });
    const saved = await json<SaveValueChainResult>(res, 200);
    expect(res.headers.get('etag')).toBe('"r2"');
    expect(saved).toMatchObject({
      outcome: 'revised',
      revision: { rev: 2, baseRevisionId: head.valueChain.headRevisionId },
      valueChain: { headRev: 2, structureHash: head.valueChain.structureHash },
      impact: { structureChanged: false, steps: { added: [], removed: [], changed: [] } },
    });
    expect(saved.valueChain?.contentHash).not.toBe(head.valueChain.contentHash);
    const after = await json<ValueChainDetail>(await t.asOwner(chainPath('vc-save')), 200);
    expect(after.placements).toEqual(placementsBefore);
    const written = await events('vc-save', seq);
    expect(written.map((e) => e.type)).toEqual(['value_chain.revised']);
    expect(written[0]?.payload).toMatchObject({
      rev: 2,
      stepsAdded: 0,
      stepsRemoved: 0,
      baseRevisionId: head.valueChain.headRevisionId,
    });
  });

  it('a rename sends the accepted placement to re-confirm (changed)', async () => {
    const renamed = STEPS.map((s) =>
      s.id === 'step-pruefung' ? { ...s, name: 'Bonitätsprüfung' } : s,
    );
    const saved = await json<SaveValueChainResult>(
      await put('vc-save', { headers: { 'if-match': '"r2"' }, body: doc(renamed) }),
      200,
    );
    expect(saved.impact.placements.toReconfirm).toBe(1);
    const changed = await json<{ items: Placement[] }>(
      await t.asOwner(chainPath('vc-save', '/placements?endpointState=changed')),
      200,
    );
    expect(changed.items.map((p) => [p.elementId, p.process, p.status, p.endpoints])).toEqual([
      ['step-pruefung', RECHNUNG, 'accepted', { step: 'changed', process: 'ok' }],
    ]);
  });

  it('deleting a step strands its accepted and held placements and withdraws its proposals', async () => {
    const agentToken = await t.createToken('vc-save', ['proa:read', 'proa:propose']);
    await manual('vc-save', 'step-eingang', AUFTRAG);
    const held = await manual('vc-save', 'step-eingang', VERSAND);
    await json<PlacementDecisionResult>(
      await t.asOwner(chainPath('vc-save', `/placements/${held.id}/decision`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'hold', note: 'Klären.' }),
      }),
      200,
    );
    const proposed = await json<PostPlacementsResult>(
      await t.asToken(agentToken.secret, chainPath('vc-save', '/placements'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'propose',
          placements: [
            { step: 'step-eingang', process: RECHNUNG, confidence: 0.6, rationale: 'Vielleicht.' },
          ],
        }),
      }),
      200,
    );
    expect(proposed.kind === 'propose' && proposed.counts.applied).toBe(1);
    const without = STEPS.filter((s) => s.id !== 'step-eingang').map((s) =>
      s.id === 'step-pruefung' ? { ...s, name: 'Bonitätsprüfung' } : s,
    );
    const dry = await json<SaveValueChainResult>(
      await put('vc-save', {
        query: '?dryRun=true',
        headers: { 'if-match': '"r3"' },
        body: doc(without),
      }),
      200,
    );
    expect(dry.impact).toMatchObject({
      steps: {
        removed: [
          {
            elementId: 'step-eingang',
            generation: 1,
            name: 'Eingangsbearbeitung',
            placements: { accepted: 1, held: 1, proposed: 1 },
          },
        ],
      },
      placements: { stranded: 2, proposalsWithdrawn: 1 },
    });
    const saved = await json<SaveValueChainResult>(
      await put('vc-save', { headers: { 'if-match': '"r3"' }, body: doc(without) }),
      200,
    );
    expect(saved.impact).toEqual(dry.impact);
    const onStep = await json<{ items: Placement[] }>(
      await t.asOwner(chainPath('vc-save', '/placements?elementId=step-eingang&limit=10')),
      200,
    );
    // Natural key order: lager/… before vertrieb/….
    expect(onStep.items.map((p) => [p.process, p.status, p.endpointState, p.stepLive])).toEqual([
      [VERSAND, 'held', 'missing', false],
      [AUFTRAG, 'accepted', 'missing', false],
    ]);
    const obsolete = await json<{ items: Placement[] }>(
      await t.asOwner(chainPath('vc-save', '/placements?status=obsolete')),
      200,
    );
    expect(obsolete.items.map((p) => p.process)).toEqual([RECHNUNG]);
  });

  it('lists revisions newest first, page by page, and serves each one’s content', async () => {
    const first = await json<ValueChainRevisionPage>(
      await t.asOwner(chainPath('vc-save', '/revisions?limit=2')),
      200,
    );
    expect(first.items.map((r) => [r.rev, r.handle])).toEqual([
      [4, 'owner'],
      [3, 'owner'],
    ]);
    const rest = await json<ValueChainRevisionPage>(
      await t.asOwner(chainPath('vc-save', `/revisions?limit=2&cursor=${first.nextCursor ?? ''}`)),
      200,
    );
    expect(rest.items.map((r) => r.rev)).toEqual([2, 1]);
    expect(rest.nextCursor).toBeNull();
    const r1 = await t.asOwner(chainPath('vc-save', '/revisions/1/content'));
    expect(r1.status).toBe(200);
    expect(r1.headers.get('etag')).toBe('"r1"');
    expect(JSON.parse(await r1.text())).toMatchObject({ meta: { name: 'Testkette' } });
    expect((await t.asOwner(chainPath('vc-save', '/revisions/99/content'))).status).toBe(404);
    expect((await t.asOwner(chainPath('vc-save', '/revisions/0/content'))).status).toBe(422);
  });

  it('refuses revision numbers beyond the 9-digit tag with 422, never a database error', async () => {
    const content = (rev: string) => t.asOwner(chainPath('vc-save', `/revisions/${rev}/content`));
    expect((await content('999999999')).status).toBe(404);
    for (const rev of ['1000000000', '2147483648', '99999999999']) {
      expect(await json(await content(rev), 422), rev).toMatchObject({
        code: 'validation-failed',
      });
    }
    // A crafted cursor: an integer beyond the column, a fraction, a negative number.
    for (const key of [[2_147_483_648], [1.5], [-1]]) {
      const cursor = Buffer.from(JSON.stringify(key)).toString('base64url');
      expect(
        await json(await t.asOwner(chainPath('vc-save', `/revisions?cursor=${cursor}`)), 422),
        JSON.stringify(key),
      ).toMatchObject({ code: 'validation-failed' });
    }
  });
});

describe('refused documents and requests', () => {
  beforeAll(async () => {
    await setUp('vc-bad');
    await json(await put('vc-bad', { headers: { 'if-none-match': '*' }, body: doc() }), 201);
  });

  it('422 value-chain-invalid with the violations and the elements they name', async () => {
    const bad = doc([...STEPS, { id: '@intern', name: 'X‮y' }]);
    const problem = await json<{
      code: string;
      violations: ValueChainViolation[];
      truncated: boolean;
    }>(await put('vc-bad', { headers: { 'if-match': '"r1"' }, body: bad }), 422);
    expect(problem).toMatchObject({ code: 'value-chain-invalid', truncated: false });
    expect(problem.violations.map((v) => [v.reason, v.elementId])).toEqual([
      ['name-characters', '@intern'],
      ['reserved-id', '@intern'],
    ]);
    const notJson = await json<{ violations: ValueChainViolation[] }>(
      await put('vc-bad', { headers: { 'if-match': '"r1"' }, raw: '{"schemaVersion": 1,' }),
      422,
    );
    expect(notJson.violations.map((v) => v.reason)).toEqual(['not-json']);
    const array = await json<{ violations: ValueChainViolation[] }>(
      await put('vc-bad', { headers: { 'if-match': '"r1"' }, raw: '[]' }),
      422,
    );
    expect(array.violations.map((v) => v.reason)).toEqual(['not-an-object']);
  });

  it('422 value-chain-unsupported-version for a newer schemaVersion', async () => {
    expect(
      await json(
        await put('vc-bad', {
          headers: { 'if-match': '"r1"' },
          body: { ...doc(), schemaVersion: 2 },
        }),
        422,
      ),
    ).toMatchObject({ code: 'value-chain-unsupported-version', schemaVersion: 2, supported: 1 });
  });

  it('413 above 2 MiB and 415 for anything but JSON', async () => {
    const huge = `{"pad": "${'x'.repeat(2 * 1024 * 1024)}"}`;
    expect(
      await json(await put('vc-bad', { headers: { 'if-match': '"r1"' }, raw: huge }), 413),
    ).toMatchObject({
      code: 'payload-too-large',
    });
    expect(
      await json(
        await put('vc-bad', {
          headers: { 'if-match': '"r1"' },
          raw: JSON.stringify(doc()),
          type: 'text/plain',
        }),
        415,
      ),
    ).toMatchObject({ code: 'unsupported-media-type' });
    expect((await lastSeq('vc-bad')) > 0).toBe(true);
  });

  it('refuses agents with human-decision-required and the value chain page as reviewUrl', async () => {
    const token = await t.createToken('vc-bad', ['proa:read', 'proa:propose', 'proa:write']);
    const reviewUrl = 'http://localhost/projects/vc-bad/value-chain';
    const save = await t.asToken(token.secret, chainPath('vc-bad', '/content'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': '"r1"' },
      body: JSON.stringify(doc(STEPS, 'Agent')),
    });
    expect(await json(save, 403)).toMatchObject({ code: 'human-decision-required', reviewUrl });
    const create = await t.asToken(token.secret, '/api/v1/projects/vc-bad/value-chains', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'main', name: 'Agent' }),
    });
    expect(await json(create, 403)).toMatchObject({ code: 'human-decision-required', reviewUrl });
    const del = await t.asToken(token.secret, chainPath('vc-bad'), { method: 'DELETE' });
    expect(await json(del, 403)).toMatchObject({ code: 'human-decision-required', reviewUrl });
    // Without If-Match the policy still answers first.
    const bare = await t.asToken(token.secret, chainPath('vc-bad', '/content'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(doc()),
    });
    expect(await json(bare, 403)).toMatchObject({ code: 'human-decision-required' });
    expect((await t.asToken(token.secret, chainPath('vc-bad'))).status).toBe(200);
  });
});

describe('concurrent saves', () => {
  const status = (results: Response[]) => results.map((r) => r.status).sort((a, b) => a - b);
  const create = (project: string, name: string) =>
    t.asOwner(`/api/v1/projects/${project}/value-chains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'main', name }),
    });

  async function denseSeq(project: string): Promise<void> {
    const all = await events(project, 0);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
  }

  it('two saves on the same If-Match: one revises, the other gets 412 with the new head', async () => {
    await setUp('vc-race');
    await json(await put('vc-race', { headers: { 'if-none-match': '*' }, body: doc() }), 201);
    const seq = await lastSeq('vc-race');
    // A few rounds, so a regression that reads the head before the lock shows up as a 500.
    for (const rev of [1, 2, 3]) {
      const results = await Promise.all(
        ['Erste', 'Zweite'].map((name) =>
          put('vc-race', {
            headers: { 'if-match': `"r${rev}"` },
            body: doc(STEPS, `${name} ${rev}`),
          }),
        ),
      );
      expect(status(results), `r${rev}`).toEqual([200, 412]);
      const bodies: unknown[] = await Promise.all(results.map((r) => r.json()));
      expect(bodies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            outcome: 'revised',
            valueChain: expect.objectContaining({ headRev: rev + 1 }) as unknown,
          }),
          expect.objectContaining({
            code: 'revision-conflict',
            headRev: rev + 1,
            etag: `"r${rev + 1}"`,
          }),
        ]),
      );
    }
    const revised = (await events('vc-race', seq)).filter((e) => e.type === 'value_chain.revised');
    expect(revised.map((e) => e.payload['rev'])).toEqual([2, 3, 4]);
    await denseSeq('vc-race');
  });

  it('two creates at once: one 201, the other 412 (If-None-Match: *) or 409 (POST)', async () => {
    await setUp('vc-race-put');
    const puts = await Promise.all(
      ['Erste', 'Zweite'].map((name) =>
        put('vc-race-put', { headers: { 'if-none-match': '*' }, body: doc(STEPS, name) }),
      ),
    );
    expect(status(puts)).toEqual([201, 412]);
    const conflict = puts.find((r) => r.status === 412);
    expect(await conflict?.json()).toMatchObject({ code: 'revision-conflict', headRev: 1 });
    await denseSeq('vc-race-put');

    await setUp('vc-race-post');
    const posts = await Promise.all(
      ['Erste', 'Zweite'].map((name) => create('vc-race-post', name)),
    );
    expect(status(posts)).toEqual([201, 409]);
    expect(await posts.find((r) => r.status === 409)?.json()).toMatchObject({ code: 'conflict' });
    await denseSeq('vc-race-post');
  });
});

describe('the step drill-down', () => {
  beforeAll(async () => {
    await setUp('vc-step');
    await json(await put('vc-step', { headers: { 'if-none-match': '*' }, body: doc() }), 201);
    await manual('vc-step', 'step-vertrieb', AUFTRAG);
    await manual('vc-step', 'step-pruefung', RECHNUNG);
  });

  it('has the breadcrumb, the sub-steps, own and subtree placements and the processes reached by call', async () => {
    const top = await json<ValueChainStepDetail>(
      await t.asOwner(chainPath('vc-step', '/steps/step-vertrieb')),
      200,
    );
    expect(top.step).toMatchObject({
      elementId: 'step-vertrieb',
      kind: 'core',
      depth: 0,
      counts: { accepted: 1 },
    });
    expect(top.breadcrumb).toEqual([]);
    expect(top.children.map((c) => c.elementId)).toEqual(['step-eingang', 'step-pruefung']);
    expect(top.placements.own.map((p) => p.process)).toEqual([AUFTRAG]);
    expect(top.placements.subtree.map((p) => p.process)).toEqual([RECHNUNG]);
    // The fake rule tier accepted Auftrag's call of Versand.
    expect(top.placements.reachedByCall).toEqual([
      {
        process: VERSAND,
        name: 'Versand',
        via: [{ relationId: expect.stringMatching(/^rel_/) as unknown, caller: AUFTRAG }],
      },
    ]);
    const sub = await json<ValueChainStepDetail>(
      await t.asOwner(chainPath('vc-step', '/steps/step-pruefung')),
      200,
    );
    expect(sub.breadcrumb).toEqual([{ elementId: 'step-vertrieb', name: 'Verkauf' }]);
    expect(sub.step.path).toEqual(['Verkauf', 'Prüfung']);
    expect(sub.placements.reachedByCall).toEqual([]);
  });

  it('answers 404 for @outside and for unknown steps', async () => {
    expect((await t.asOwner(chainPath('vc-step', '/steps/%40outside'))).status).toBe(404);
    expect((await t.asOwner(chainPath('vc-step', '/steps/step-nope'))).status).toBe(404);
  });
});

describe('the dev landscape with the real libraries', () => {
  let real: TestApp;

  beforeAll(async () => {
    real = startTestApp(database, { analysis: libraryAnalysis });
    await real.createProject('vc-nordwind');
    await importAll(
      (path, init) => real.asOwner(path, init),
      'vc-nordwind',
      await corpusFiles('nordwind-handel'),
    );
    const res = await real.asOwner(chainPath('vc-nordwind', '/content'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: await readFile(NORDWIND_CHAIN, 'utf8'),
    });
    expect(res.status).toBe(201);
  });

  it('rolls up a call: the callee of a process accepted on a step is reached by call there', async () => {
    const projectId = (
      (await (await real.asOwner('/api/v1/projects/vc-nordwind')).json()) as Project
    ).id;
    const callFacts = await createStore(database.db).read((tx) =>
      tx.facts.head(projectId, { kinds: ['call'] }),
    );
    const callerOf = new Map(callFacts.map((f) => [f.ref, `${f.modelKey}#${f.processId ?? ''}`]));
    const calls = (await (
      await real.asOwner(
        '/api/v1/projects/vc-nordwind/relations?type=call&status=accepted&limit=200',
      )
    ).json()) as RelationPage;
    const expected = parse(await readFile(NORDWIND_PLACEMENTS, 'utf8')) as {
      placements: { process: string; must: string }[];
    };
    const mustOf = new Map(expected.placements.map((p) => [p.process, p.must]));
    const call = calls.items.find((r) => {
      const step = mustOf.get(callerOf.get(r.from) ?? '');
      return step !== undefined && step !== '@outside' && mustOf.get(r.to) !== step;
    });
    expect(call, 'an accepted call between processes on different steps').toBeDefined();
    if (!call) return;
    const caller = callerOf.get(call.from) as Ref;
    const step = mustOf.get(caller) ?? '';
    const placed = await real.asOwner(chainPath('vc-nordwind', '/placements'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'manual', step, process: caller, rationale: 'Golden must.' }),
    });
    expect(placed.status).toBe(200);
    const detail = await json<ValueChainStepDetail>(
      await real.asOwner(chainPath('vc-nordwind', `/steps/${step}`)),
      200,
    );
    // Accepted ones only: rule-tier proposals (equal names) may sit on the step as well.
    expect(
      detail.placements.own.filter((p) => p.status === 'accepted').map((p) => p.process),
    ).toEqual([caller]);
    expect(detail.placements.reachedByCall).toContainEqual(
      expect.objectContaining({
        process: call.to,
        via: [expect.objectContaining({ relationId: call.id, caller })],
      }),
    );
  });
});
