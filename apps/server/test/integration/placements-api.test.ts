/**
 * Placements over REST (M4 S2) against PostgreSQL: every invalid reason,
 * the server-computed tiers, the live-step limit, duplicates within a
 * request; decisions (accept, reject, hold, correct) with versions and
 * `If-Match`, obsolete and removed steps; bulk decisions with every mismatch;
 * manual placements, notes, the timeline, withdrawal, filters and paging,
 * unplaced processes; a revoked token's proposals; dense, typed events; the
 * relation side untouched. Synthetic chains only.
 */
import type {
  BulkPlacementDecisionResult,
  Placement,
  PlacementAssertionList,
  PlacementDecisionResult,
  PlacementPage,
  PostPlacementsResult,
  Project,
  ProjectId,
  ProposePlacementsResult,
  Ref,
  RelationPage,
  SaveValueChainResult,
  UnplacedProcessPage,
} from '@proa/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createStore } from '../../src/db/store.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { fakeBpmn } from '../support/fake-analysis.ts';
import { chain, chainPath, relationSide, type StepSpec } from '../support/value-chain.ts';

let database: TestDatabase;
let t: TestApp;
let project: Project;
let agent: { id: string; secret: string };
let other: { id: string; secret: string };

const ANNAHME = 'vertrieb/auftragsannahme#P_Annahme' as Ref;
const MAHN = 'finanzen/mahnlauf#P_Mahn' as Ref;
const PICK = 'lager/kommission#P_Pick' as Ref;
const ALT = 'archiv/alt#P_Alt' as Ref;
const VIEL = 'x/viel#P_Viel' as Ref;
const P = 'plc';

const MODELS = {
  'vertrieb/auftragsannahme': fakeBpmn({
    processes: [
      {
        id: 'P_Annahme',
        name: 'Auftragsannahme',
        doc: `Nimmt Bestellungen aus allen Kanälen an. ${'x'.repeat(300)}`,
        lanes: ['Innendienst', 'Shop'],
        elements: [
          { kind: 'evt_start', id: 'Start_Bestellung', name: 'Bestellung eingegangen' },
          { kind: 'evt_end', id: 'End_Angenommen', name: 'Auftrag angenommen' },
          { kind: 'call', id: 'Call_Pick', name: 'Kommissionieren', ref: 'P_Pick' },
          {
            kind: 'msg_throw',
            id: 'Throw_Faellig',
            name: 'Rechnung fällig',
            ref: 'RechnungFaellig',
          },
        ],
      },
    ],
  }),
  'finanzen/mahnlauf': fakeBpmn({
    processes: [
      {
        id: 'P_Mahn',
        name: 'Mahnlauf',
        elements: [
          {
            kind: 'msg_catch',
            id: 'Catch_Faellig',
            name: 'Rechnung fällig',
            ref: 'RechnungFaellig',
          },
        ],
      },
    ],
  }),
  'lager/kommission': fakeBpmn({ processes: [{ id: 'P_Pick', name: 'Picking' }] }),
  'archiv/alt': fakeBpmn({ processes: [{ id: 'P_Alt', name: 'Altversion' }] }),
  'x/viel': fakeBpmn({ processes: [{ id: 'P_Viel', name: 'Vielzweck' }] }),
};

const STEPS: StepSpec[] = [
  { id: 'step-vertrieb', name: 'Verkauf', x: 0 },
  { id: 'step-logistik', name: 'Logistik', x: 300 },
  { id: 'step-fakt', name: 'Fakturierung', x: 600 },
  { id: 'step-eingang', name: 'Auftragseingang', parent: 'step-vertrieb', y: 100 },
  { id: 'step-kredit', name: 'Bonitätsprüfung', parent: 'step-vertrieb', y: 200 },
  { id: 'step-rechnung', name: 'Rechnungsstellung', parent: 'step-fakt', y: 100 },
  { id: 'step-mahn', name: 'Mahnwesen', parent: 'step-fakt', y: 200 },
];
const doc = (steps = STEPS) =>
  chain({
    steps,
    sequence: [
      ['step-vertrieb', 'step-logistik'],
      ['step-logistik', 'step-fakt'],
    ],
  });

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function json<T>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status, text.slice(0, 500)).toBe(status);
  return JSON.parse(text) as T;
}

async function propose(
  secret: string | null,
  placements: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): Promise<ProposePlacementsResult> {
  const init = post({ kind: 'propose', placements, ...extra });
  const res = secret
    ? await t.asToken(secret, chainPath(P, '/placements'), init)
    : await t.asOwner(chainPath(P, '/placements'), init);
  const result = await json<PostPlacementsResult>(res, 200);
  if (result.kind !== 'propose') throw new Error('not a propose result');
  return result;
}

const item = (step: string, process: Ref, extra: Record<string, unknown> = {}) => ({
  step,
  process,
  confidence: 0.7,
  rationale: 'Passt fachlich.',
  ...extra,
});

async function placement(id: string): Promise<Placement> {
  return json<Placement>(await t.asOwner(chainPath(P, `/placements/${id}`)), 200);
}

async function decide(id: string, body: unknown, headers: Record<string, string> = {}) {
  return t.asOwner(chainPath(P, `/placements/${id}/decision`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function save(steps: StepSpec[], rev: number) {
  return json<SaveValueChainResult>(
    await t.asOwner(chainPath(P, '/content'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': `"r${rev}"` },
      body: JSON.stringify(doc(steps)),
    }),
    200,
  );
}

const store = () => createStore(database.db);
const events = (after = 0) =>
  store().read((tx) => tx.events.list(project.id, { afterSeq: after, limit: 10_000 }));
const lastSeq = async () => (await events()).at(-1)?.seq ?? 0;
let side = '';

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database);
  project = await t.createProject(P);
  for (const [key, xml] of Object.entries(MODELS))
    expect((await t.putModel(P, key, xml)).status).toBe(201);
  const created = await t.asOwner(chainPath(P, '/content'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-none-match': '*' },
    body: JSON.stringify(doc()),
  });
  expect(created.status).toBe(201);
  agent = await t.createToken(P, ['proa:read', 'proa:propose']);
  other = await t.createToken(P, ['proa:read', 'proa:propose']);
  side = await relationSide(database.db, project.id);
});

afterAll(async () => {
  expect(await relationSide(database.db, project.id)).toBe(side);
  await database.drop();
});

describe('unplaced processes before any placement', () => {
  it('lists every head process with lanes, labels, documentation, neighbours, calls and hints', async () => {
    const page = await json<UnplacedProcessPage>(
      await t.asToken(agent.secret, chainPath(P, '/unplaced-processes')),
      200,
    );
    expect(page.items.map((u) => u.process)).toEqual([ALT, MAHN, PICK, ANNAHME, VIEL]);
    const annahme = page.items.find((u) => u.process === ANNAHME);
    const rels = (await (
      await t.asOwner(`/api/v1/projects/${P}/relations`)
    ).json()) as RelationPage;
    const callId = rels.items.find((r) => r.type === 'call')?.id;
    const msgId = rels.items.find((r) => r.type === 'message')?.id;
    expect(annahme).toMatchObject({
      name: 'Auftragsannahme',
      modelKey: 'vertrieb/auftragsannahme',
      lanes: ['Innendienst', 'Shop'],
      starts: ['Bestellung eingegangen'],
      ends: ['Auftrag angenommen'],
      neighbours: [
        {
          process: MAHN,
          via: [{ relationId: msgId, type: 'message', direction: 'out' }],
          steps: [],
        },
        { process: PICK, via: [{ relationId: callId, type: 'call', direction: 'out' }], steps: [] },
      ],
      calls: { out: [{ process: PICK, relationId: callId, status: 'accepted' }], in: [] },
    });
    expect(annahme?.doc).toHaveLength(200);
    expect(annahme?.hints[0]).toMatchObject({ step: 'step-eingang', name: 'Auftragseingang' });
    expect(page.items.find((u) => u.process === PICK)?.calls.in).toEqual([
      { process: ANNAHME, relationId: callId, status: 'accepted' },
    ]);
    const first = await json<UnplacedProcessPage>(
      await t.asOwner(chainPath(P, '/unplaced-processes?limit=2')),
      200,
    );
    const second = await json<UnplacedProcessPage>(
      await t.asOwner(chainPath(P, `/unplaced-processes?limit=2&cursor=${first.nextCursor ?? ''}`)),
      200,
    );
    expect([...first.items, ...second.items].map((u) => u.process)).toEqual([
      ALT,
      MAHN,
      PICK,
      ANNAHME,
    ]);
  });
});

describe('proposals', () => {
  it('answers every invalid reason per item while the valid items apply', async () => {
    const rels = (await (
      await t.asOwner(`/api/v1/projects/${P}/relations`)
    ).json()) as RelationPage;
    const relId = rels.items[0]?.id ?? '';
    const r = await propose(agent.secret, [
      item('', ANNAHME),
      item('step-eingang', 'kein ref' as Ref),
      item('step-eingang', ANNAHME, { confidence: 1.5 }),
      item('step-eingang', ANNAHME, { rationale: 'x'.repeat(1001) }),
      item('step-eingang', ANNAHME, { question: 'x'.repeat(501) }),
      item('step-eingang', ANNAHME, { evidence: Array.from({ length: 21 }, () => ANNAHME) }),
      item('step-eingang', ANNAHME, { rationale: 'a\u0007b' }),
      item('@outside', ALT, { rationale: '' }),
      item('step-nope', ANNAHME),
      item('step-eingang', 'vertrieb/auftragsannahme#Start_Bestellung'),
      item('step-eingang', ANNAHME, { evidence: ['vertrieb/weg#X'] }),
      item('step-eingang', ANNAHME, {
        evidence: [ANNAHME, 'vertrieb/auftragsannahme#Call_Pick', relId, 'step:step-vertrieb'],
        question: 'Oder Bonitätsprüfung?',
      }),
    ]);
    expect(r.items.map((i) => i.result)).toEqual([
      'invalid:malformed-step',
      'invalid:malformed-ref',
      'invalid:confidence-out-of-range',
      'invalid:rationale-too-long',
      'invalid:question-too-long',
      'invalid:too-much-evidence',
      'invalid:control-characters',
      'invalid:rationale-required',
      'invalid:unknown-step',
      'invalid:unknown-process',
      'invalid:unknown-evidence',
      'applied',
    ]);
    expect(r.counts).toEqual({ applied: 1, duplicate: 0, suppressed: 0, reopened: 0, invalid: 11 });
    expect(r.items[11]).toMatchObject({
      placementId: expect.stringMatching(/^plc_/) as unknown,
      status: 'proposed',
    });
    expect(r.items[0]).toMatchObject({ placementId: null, status: null });
  });

  it('computes the tier: lexical (stem or baseline), semantic, and semantic for @outside', async () => {
    const r = await propose(
      agent.secret,
      [
        item('step-mahn', MAHN),
        item('step-rechnung', MAHN),
        item('step-logistik', PICK),
        item('@outside', ALT, { rationale: 'Archivierte Kopie.' }),
        item('step-mahn', MAHN),
      ],
      { procedure: { id: 'proa-placements', version: '0.1.0' }, llmModel: 'test-model' },
    );
    expect(r.items.map((i) => i.result)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
      'duplicate',
    ]);
    expect(r.items[4]?.placementId).toBe(r.items[0]?.placementId);
    const tiers = await Promise.all(
      r.items.slice(0, 4).map(async (i) => (await placement(i.placementId ?? '')).tier),
    );
    expect(tiers).toEqual(['lexical', 'semantic', 'semantic', 'semantic']);
    const p = await placement(r.items[0]?.placementId ?? '');
    expect(p).toMatchObject({
      stepName: 'Mahnwesen',
      stepLive: true,
      processName: 'Mahnlauf',
      status: 'proposed',
      endpointState: 'ok',
      endpoints: { step: 'ok', process: 'ok' },
      source: 'agent',
      provenance: {
        sourceKind: 'agent',
        procedure: { id: 'proa-placements', version: '0.1.0' },
        llmModel: 'test-model',
        clientId: agent.id,
      },
    });
    const again = await propose(agent.secret, [item('step-mahn', MAHN)]);
    expect(again.items[0]?.result).toBe('duplicate');
  });

  it('records a human’s proposal with the manual tier, as a proposal', async () => {
    const r = await propose(null, [item('step-kredit', VIEL)]);
    const p = await placement(r.items[0]?.placementId ?? '');
    expect(p).toMatchObject({ tier: 'manual', status: 'proposed', source: 'human' });
  });

  it('limits a principal to three live steps per process; other principals have their own', async () => {
    const r = await propose(agent.secret, [
      item('step-vertrieb', VIEL),
      item('step-logistik', VIEL),
      item('step-fakt', VIEL),
      item('step-mahn', VIEL),
      item('step-logistik', VIEL),
    ]);
    expect(r.items.map((i) => i.result)).toEqual([
      'applied',
      'applied',
      'applied',
      'invalid:too-many-steps',
      'duplicate',
    ]);
    const mine = await propose(other.secret, [item('step-mahn', VIEL)]);
    expect(mine.items[0]?.result).toBe('applied');
  });

  it('withdraws the caller’s own live proposal; without one it is 409; others’ proposals stay', async () => {
    const shared = await propose(other.secret, [item('step-logistik', VIEL, { confidence: 0.4 })]);
    const id = shared.items[0]?.placementId ?? '';
    const res = await t.asToken(agent.secret, chainPath(P, `/placements/${id}/proposal`), {
      method: 'DELETE',
    });
    const after = await json<Placement>(res, 200);
    expect(after.status).toBe('proposed');
    expect(after.provenance?.principalId).not.toBeUndefined();
    const again = await t.asToken(agent.secret, chainPath(P, `/placements/${id}/proposal`), {
      method: 'DELETE',
    });
    expect(await json(again, 409)).toMatchObject({ code: 'conflict' });
    const timeline = await json<PlacementAssertionList>(
      await t.asOwner(chainPath(P, `/placements/${id}/assertions`)),
      200,
    );
    expect(timeline.items.map((a) => a.kind)).toEqual(['proposal', 'proposal', 'withdrawal']);
  });
});

describe('decisions', () => {
  let target: string;

  beforeAll(async () => {
    const r = await propose(agent.secret, [item('step-eingang', PICK, { confidence: 0.55 })]);
    target = r.items[0]?.placementId ?? '';
  });

  it('accepts with the seen version; a stale body version is 409, a stale If-Match 412', async () => {
    const before = await placement(target);
    expect(
      await json(await decide(target, { verdict: 'accept', version: before.version + 5 }), 409),
    ).toMatchObject({
      code: 'conflict',
      version: before.version,
    });
    expect(
      await json(await decide(target, { verdict: 'accept' }, { 'if-match': '"99"' }), 412),
    ).toMatchObject({
      code: 'precondition-failed',
      version: before.version,
    });
    const res = await decide(
      target,
      { verdict: 'accept', note: 'Passt.' },
      { 'if-match': `"${before.version}"` },
    );
    const decided = await json<PlacementDecisionResult>(res, 200);
    expect(res.headers.get('etag')).toBe(`"${decided.placement.version}"`);
    expect(decided).toMatchObject({
      placement: { status: 'accepted', source: 'human' },
      corrected: null,
    });
  });

  it('requires a reason to reject and a note to hold; holds keep question and label', async () => {
    expect(await json(await decide(target, { verdict: 'reject' }), 422)).toMatchObject({
      code: 'validation-failed',
    });
    expect(await json(await decide(target, { verdict: 'hold' }), 422)).toMatchObject({
      code: 'validation-failed',
    });
    const held = await json<PlacementDecisionResult>(
      await decide(target, {
        verdict: 'hold',
        note: 'Mit Logistik klären.',
        question: 'Wer macht das?',
        label: 'Logistik',
      }),
      200,
    );
    expect(held.placement.status).toBe('held');
    expect(held.placement.provenance).toMatchObject({
      question: 'Wer macht das?',
      label: 'Logistik',
      rationale: 'Mit Logistik klären.',
    });
  });

  it('corrects onto another step: the manual placement accepted, the original rejected, linked both ways', async () => {
    expect(
      await json(
        await decide(target, { verdict: 'correct', step: 'step-nope', note: 'Falsch.' }),
        422,
      ),
    ).toMatchObject({
      code: 'validation-failed',
      reason: 'unknown-step',
    });
    const corrected = await json<PlacementDecisionResult>(
      await decide(target, {
        verdict: 'correct',
        step: 'step-logistik',
        note: 'Gehört zur Logistik.',
      }),
      200,
    );
    expect(corrected.placement).toMatchObject({ status: 'rejected', elementId: 'step-eingang' });
    expect(corrected.corrected).toMatchObject({
      status: 'accepted',
      elementId: 'step-logistik',
      process: PICK,
      tier: 'manual',
    });
    const timeline = await json<PlacementAssertionList>(
      await t.asOwner(chainPath(P, `/placements/${target}/assertions`)),
      200,
    );
    expect(timeline.items.at(-1)).toMatchObject({
      verdict: 'reject',
      linkedPlacementId: corrected.corrected?.id,
    });
  });

  it('notes never move the version; the timeline keeps the order', async () => {
    const before = await placement(target);
    const note = await json<{ kind: string; rationale: string; handle: string }>(
      await t.asOwner(
        chainPath(P, `/placements/${target}/notes`),
        post({ text: 'Antwort der Logistik: ja.' }),
      ),
      201,
    );
    expect(note).toMatchObject({
      kind: 'note',
      rationale: 'Antwort der Logistik: ja.',
      handle: 'owner',
    });
    expect((await placement(target)).version).toBe(before.version);
    const timeline = await json<PlacementAssertionList>(
      await t.asOwner(chainPath(P, `/placements/${target}/assertions`)),
      200,
    );
    expect(timeline.items.map((a) => `${a.kind}:${a.verdict ?? ''}`)).toEqual([
      'proposal:',
      'decision:accept',
      'decision:hold',
      'decision:reject',
      'note:',
    ]);
  });

  it('refuses an obsolete placement (409) and accept or hold on a removed step (unknown-step), allows reject', async () => {
    const r = await propose(agent.secret, [item('step-kredit', ANNAHME, { confidence: 0.3 })]);
    const id = r.items[0]?.placementId ?? '';
    expect(
      (
        await t.asToken(agent.secret, chainPath(P, `/placements/${id}/proposal`), {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    expect((await placement(id)).status).toBe('obsolete');
    expect(await json(await decide(id, { verdict: 'accept' }), 409)).toMatchObject({
      code: 'conflict',
    });

    const manual = await json<PostPlacementsResult>(
      await t.asOwner(
        chainPath(P, '/placements'),
        post({ kind: 'manual', step: 'step-kredit', process: MAHN, rationale: 'Kredit.' }),
      ),
      200,
    );
    const onKredit = manual.kind === 'manual' ? manual.placement.id : '';
    const head = await json<{ valueChain: { headRev: number } }>(
      await t.asOwner(chainPath(P)),
      200,
    );
    await save(
      STEPS.filter((s) => s.id !== 'step-kredit'),
      head.valueChain.headRev,
    );
    const stranded = await placement(onKredit);
    expect(stranded).toMatchObject({
      status: 'accepted',
      endpointState: 'missing',
      stepLive: false,
      stepName: null,
    });
    expect(await json(await decide(onKredit, { verdict: 'accept' }), 422)).toMatchObject({
      reason: 'unknown-step',
    });
    expect(await json(await decide(onKredit, { verdict: 'hold', note: 'x' }), 422)).toMatchObject({
      reason: 'unknown-step',
    });
    const rejected = await json<PlacementDecisionResult>(
      await decide(onKredit, { verdict: 'reject', reason: 'Schritt entfällt.' }),
      200,
    );
    expect(rejected.placement.status).toBe('rejected');
    // Restore the step (a new generation): the old placements stay missing.
    const again = await json<{ valueChain: { headRev: number } }>(
      await t.asOwner(chainPath(P)),
      200,
    );
    await save(STEPS, again.valueChain.headRev);
    expect((await placement(onKredit)).endpointState).toBe('missing');
  });

  it('refuses agents: human-decision-required with the placement on the value chain page', async () => {
    const res = await t.asToken(
      agent.secret,
      chainPath(P, `/placements/${target}/decision`),
      post({ verdict: 'accept' }),
    );
    expect(await json(res, 403)).toMatchObject({
      code: 'human-decision-required',
      reviewUrl: `http://localhost/projects/${P}/value-chain?placement=${target}`,
    });
    const manual = await t.asToken(
      agent.secret,
      chainPath(P, '/placements'),
      post({ kind: 'manual', step: 'step-eingang', process: ANNAHME, rationale: 'x' }),
    );
    expect(await json(manual, 403)).toMatchObject({
      code: 'human-decision-required',
      reviewUrl: `http://localhost/projects/${P}/value-chain`,
    });
    const note = await t.asToken(
      agent.secret,
      chainPath(P, `/placements/${target}/notes`),
      post({ text: 'x' }),
    );
    expect(await json(note, 403)).toMatchObject({ code: 'human-decision-required' });
  });
});

describe('manual placements', () => {
  it('accepts a process on a step or @outside at once; the same acceptance again is a duplicate', async () => {
    const body = {
      kind: 'manual',
      step: '@outside',
      process: ALT,
      rationale: 'Archivkopie von x/viel.',
    };
    const first = await json<PostPlacementsResult>(
      await t.asOwner(chainPath(P, '/placements'), post(body)),
      200,
    );
    expect(first).toMatchObject({
      kind: 'manual',
      result: 'applied',
      placement: { status: 'accepted', tier: 'manual', elementId: '@outside', stepName: null },
    });
    const again = await json<PostPlacementsResult>(
      await t.asOwner(chainPath(P, '/placements'), post(body)),
      200,
    );
    expect(again).toMatchObject({ kind: 'manual', result: 'duplicate' });
    expect(
      await json(
        await t.asOwner(chainPath(P, '/placements'), post({ ...body, step: 'step-nope' })),
        422,
      ),
    ).toMatchObject({ reason: 'unknown-step' });
    expect(
      await json(
        await t.asOwner(chainPath(P, '/placements'), post({ ...body, process: 'archiv/alt#Nope' })),
        422,
      ),
    ).toMatchObject({ reason: 'unknown-process' });
  });
});

describe('bulk decisions', () => {
  let ids: string[];

  beforeAll(async () => {
    const r = await propose(other.secret, [
      item('step-eingang', ANNAHME),
      item('step-rechnung', ANNAHME, { confidence: 0.5 }),
    ]);
    ids = r.items.map((i) => i.placementId ?? '');
  });

  const bulk = (body: unknown) => t.asOwner(chainPath(P, '/placements/decisions'), post(body));

  it('refuses any mismatch with 409 and the reasons, changing nothing', async () => {
    const [a, b] = await Promise.all(ids.map(placement));
    if (!a || !b) throw new Error('setup');
    const seq = await lastSeq();
    expect(
      await json(
        await bulk({
          verdict: 'accept',
          items: [{ id: a.id, version: a.version }],
          expectedCount: 2,
        }),
        409,
      ),
    ).toMatchObject({ code: 'conflict', expectedCount: 2, received: 1 });
    const obsolete = (
      await json<PlacementPage>(await t.asOwner(chainPath(P, '/placements?status=obsolete')), 200)
    ).items[0];
    // The rejected placement on the removed generation of step-kredit (decisions above).
    const missing = (
      await json<PlacementPage>(
        await t.asOwner(chainPath(P, '/placements?endpointState=missing&status=rejected')),
        200,
      )
    ).items.find((p) => p.elementId === 'step-kredit' && !p.stepLive);
    expect(missing).toBeDefined();
    const items = [
      { id: a.id, version: a.version },
      { id: a.id, version: a.version },
      { id: 'plc_01J9Z3N4X5Q6R7S8T9V0W1X2Y3', version: 1 },
      { id: b.id, version: b.version + 1 },
      { id: obsolete?.id ?? '', version: obsolete?.version ?? 1 },
    ];
    const res = await json<{ mismatches: { id: string; reason: string }[] }>(
      await bulk({ verdict: 'accept', items, expectedCount: items.length }),
      409,
    );
    expect(res.mismatches.map((m) => m.reason)).toEqual([
      'duplicate',
      'not-found',
      'version',
      'obsolete',
    ]);
    const tier = await json<{ mismatches: { reason: string }[] }>(
      await bulk({
        verdict: 'accept',
        tier: 'lexical',
        items: [{ id: b.id, version: b.version }],
        expectedCount: 1,
      }),
      409,
    );
    expect(tier.mismatches.map((m) => m.reason)).toEqual(['tier']);
    const removed = await json<{ mismatches: { reason: string }[] }>(
      await bulk({
        verdict: 'hold',
        note: 'x',
        items: [{ id: missing?.id ?? '', version: missing?.version ?? 1 }],
        expectedCount: 1,
      }),
      409,
    );
    expect(removed.mismatches.map((m) => m.reason)).toEqual(['step-removed']);
    // Rejecting it again is no mismatch: a removed step's placement can still be rejected.
    const rejectAgain = await bulk({
      verdict: 'reject',
      reason: 'Schritt entfällt endgültig.',
      items: [{ id: missing?.id ?? '', version: missing?.version ?? 1 }],
      expectedCount: 1,
    });
    expect(rejectAgain.status).toBe(200);
    const seqAfterReject = await lastSeq();
    // Only the deliberate rejection above wrote anything.
    expect((await events(seq)).map((e) => e.type)).toEqual(['placement.decided']);
    expect(await lastSeq()).toBe(seqAfterReject);
    expect((await placement(a.id)).version).toBe(a.version);
  });

  it('decides all at once, and a bulk re-confirm re-anchors changed acceptances', async () => {
    const [a, b] = await Promise.all(ids.map(placement));
    if (!a || !b) throw new Error('setup');
    const decided = await json<BulkPlacementDecisionResult>(
      await bulk({
        verdict: 'accept',
        items: [
          { id: a.id, version: a.version },
          { id: b.id, version: b.version },
        ],
        expectedCount: 2,
      }),
      200,
    );
    expect(decided.items.map((p) => p.status)).toEqual(['accepted', 'accepted']);
    const head = await json<{ valueChain: { headRev: number } }>(
      await t.asOwner(chainPath(P)),
      200,
    );
    await save(
      STEPS.map((s) => (s.id === 'step-rechnung' ? { ...s, name: 'Rechnungslegung' } : s)),
      head.valueChain.headRev,
    );
    const changed = await json<PlacementPage>(
      await t.asOwner(chainPath(P, '/placements?endpointState=changed&status=accepted')),
      200,
    );
    expect(changed.items.map((p) => [p.elementId, p.process])).toEqual([
      ['step-rechnung', ANNAHME],
    ]);
    const reconfirmed = await json<BulkPlacementDecisionResult>(
      await bulk({
        verdict: 'accept',
        items: changed.items.map((p) => ({ id: p.id, version: p.version })),
        expectedCount: changed.items.length,
      }),
      200,
    );
    expect(reconfirmed.items.map((p) => [p.endpointState, p.endpoints.step])).toEqual([
      ['ok', 'ok'],
    ]);
  });

  it('refuses agents', async () => {
    const res = await t.asToken(
      agent.secret,
      chainPath(P, '/placements/decisions'),
      post({ verdict: 'accept', items: [{ id: ids[0], version: 1 }], expectedCount: 1 }),
    );
    expect(await json(res, 403)).toMatchObject({ code: 'human-decision-required' });
  });
});

describe('listing', () => {
  it('filters by step, process, model, status, tier and endpoint state, page by page', async () => {
    const all = await json<PlacementPage>(
      await t.asOwner(chainPath(P, '/placements?limit=200')),
      200,
    );
    expect(all.items.every((p) => p.status !== 'obsolete')).toBe(true);
    const keys = all.items.map((p) => `${p.elementId}|${p.generation}|${p.process}`);
    expect(keys).toEqual([...keys].sort());
    const byStep = await json<PlacementPage>(
      await t.asOwner(chainPath(P, '/placements?elementId=step-mahn')),
      200,
    );
    expect(byStep.items.every((p) => p.elementId === 'step-mahn')).toBe(true);
    const outside = await json<PlacementPage>(
      await t.asOwner(chainPath(P, '/placements?elementId=%40outside')),
      200,
    );
    expect(outside.items.map((p) => p.process)).toEqual([ALT]);
    const byProcess = await json<PlacementPage>(
      await t.asOwner(chainPath(P, `/placements?process=${encodeURIComponent(MAHN)}`)),
      200,
    );
    expect(byProcess.items.every((p) => p.process === MAHN)).toBe(true);
    const byModel = await json<PlacementPage>(
      await t.asOwner(chainPath(P, '/placements?modelKey=x/viel')),
      200,
    );
    expect(byModel.items.length).toBeGreaterThan(0);
    expect(byModel.items.every((p) => p.process === VIEL)).toBe(true);
    const lexical = await json<PlacementPage>(
      await t.asOwner(chainPath(P, '/placements?tier=lexical')),
      200,
    );
    expect(lexical.items.every((p) => p.tier === 'lexical')).toBe(true);
    expect(lexical.items.length).toBeGreaterThan(0);
    let cursor: string | null = null;
    const paged: string[] = [];
    do {
      const q: string = cursor ? `&cursor=${cursor}` : '';
      const page: PlacementPage = await json<PlacementPage>(
        await t.asOwner(chainPath(P, `/placements?limit=2${q}`)),
        200,
      );
      paged.push(...page.items.map((p) => p.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(paged).toEqual(all.items.map((p) => p.id));
    expect(await json(await t.asOwner(chainPath(P, '/placements?tier=rule')), 422)).toMatchObject({
      code: 'validation-failed',
    });
    // A crafted cursor whose generation the integer column cannot hold: 422, not 500.
    const crafted = Buffer.from(JSON.stringify(['step', 2_147_483_648, 'a#b'])).toString(
      'base64url',
    );
    expect(
      await json(await t.asOwner(chainPath(P, `/placements?cursor=${crafted}`)), 422),
    ).toMatchObject({ code: 'validation-failed' });
  });

  it('leaves out of the unplaced list what has a live proposal or a decision on a live step', async () => {
    const page = await json<UnplacedProcessPage>(
      await t.asOwner(chainPath(P, '/unplaced-processes')),
      200,
    );
    expect(page.items.map((u) => u.process)).toEqual([]);
  });

  it('answers 404 for a placement of another project and an unknown one', async () => {
    expect(
      (await t.asOwner(chainPath(P, '/placements/plc_01J9Z3N4X5Q6R7S8T9V0W1X2Y3'))).status,
    ).toBe(404);
  });
});

describe('token revocation', () => {
  it('withdraws exactly the revoked token’s live proposals, recorded under it and caused by the owner', async () => {
    const before = await json<PlacementPage>(
      await t.asOwner(chainPath(P, '/placements?limit=200')),
      200,
    );
    const seq = await lastSeq();
    const res = await t.asOwner(`/api/v1/projects/${P}/agent-tokens/${agent.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    const written = (await events(seq)).filter((e) => e.type.startsWith('placement.'));
    expect(written.length).toBeGreaterThan(0);
    const agentPrincipal = written.find((e) => e.type === 'placement.withdrawn')?.payload[
      'principalId'
    ];
    for (const e of written) {
      expect(['placement.withdrawn', 'placement.endpoint_changed']).toContain(e.type);
      expect(e.clientId).toBe('proa-web');
      if (e.type === 'placement.withdrawn') {
        expect(e.payload).toMatchObject({ sourceKind: 'agent', principalId: agentPrincipal });
        expect(e.principalId).not.toBe(agentPrincipal);
      }
    }
    const after = await json<PlacementPage>(
      await t.asOwner(chainPath(P, '/placements?limit=200')),
      200,
    );
    for (const p of after.items) {
      const timeline = await json<PlacementAssertionList>(
        await t.asOwner(chainPath(P, `/placements/${p.id}/assertions`)),
        200,
      );
      const liveOfAgent = timeline.items.filter((a) => a.principalId === agentPrincipal);
      if (liveOfAgent.length > 0) expect(liveOfAgent.at(-1)?.kind).not.toBe('proposal');
    }
    // Decisions and the other token's proposals stay.
    const stillOther = after.items.filter((p) => p.provenance?.clientId === other.id);
    expect(stillOther.length).toBeGreaterThan(0);
    expect(after.items.filter((p) => p.status === 'accepted').length).toBe(
      before.items.filter((p) => p.status === 'accepted').length,
    );
  });
});

describe('events', () => {
  it('are dense, and every chain and placement event is typed by its subject', async () => {
    const all = await events();
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    for (const e of all) {
      if (e.type.startsWith('placement.')) {
        expect(e.subjectRef, e.type).toMatch(/^plc_/);
        expect(e.payload).toMatchObject({
          placementId: e.subjectRef,
          valueChainId: expect.stringMatching(/^vch_/) as unknown,
        });
        expect([
          'placement.proposed',
          'placement.withdrawn',
          'placement.decided',
          'placement.noted',
          'placement.endpoint_changed',
        ]).toContain(e.type);
      }
      if (e.type.startsWith('value_chain.')) {
        expect(e.subjectRef, e.type).toMatch(/^vch_/);
        expect(['value_chain.created', 'value_chain.revised', 'value_chain.deleted']).toContain(
          e.type,
        );
      }
    }
    const projectId: ProjectId = project.id;
    expect(projectId).toMatch(/^prj_/);
  });
});
