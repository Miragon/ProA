/**
 * Review over REST against real PostgreSQL (CONCEPT §2 "Status", §3 "Review
 * workflow", M2 items 5–6): accept, reject, hold and correct; notes;
 * bulk decisions with versions and expectedCount; decision memory across
 * re-uploads (unchanged fingerprints → suppressed, changed → reopened);
 * held items and the stage waiting_for_clarification; the claim input with
 * decisions and notes; findings an agent's relation answers; the timeline;
 * ad-hoc proposals; agents never decide; the model engine.
 */
import type {
  BulkDecisionResult,
  ClaimedAnalysis,
  DecisionResult,
  FindingList,
  Landscape,
  ModelPage,
  ProposeRelationResult,
  Relation,
  RelationAssertionList,
  RelationPage,
} from '@proa/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApp, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { fakeBpmn, type FakeModelSpec } from '../support/fake-analysis.ts';
import {
  asAgent,
  claim,
  item,
  post,
  problemOf,
  submission,
  submit,
  type Caller,
} from '../support/pipeline.ts';

const ORDER = 'vertrieb/auftrag';
const BILLING = 'finanzen/rechnung';
const PAYMENT = 'finanzen/zahlung';
const O = (id: string) => `${ORDER}#${id}`;
const B = (id: string) => `${BILLING}#${id}`;
const P = (id: string) => `${PAYMENT}#${id}`;

function orderSpec(extra: FakeModelSpec['processes'][number]['elements'] = []): FakeModelSpec {
  return {
    engine: 'c7',
    processes: [
      {
        id: 'Process_Order',
        name: 'Auftragsabwicklung',
        elements: [
          {
            kind: 'msg_throw',
            id: 'Event_Shipped',
            name: 'Ware versandbereit',
            ref: 'WareVersandbereit',
          },
          { kind: 'evt_end', id: 'End_Done', name: 'Auftrag erledigt' },
          { kind: 'task', id: 'Task_Pack', name: 'Ware verpacken' },
          ...extra,
        ],
      },
    ],
  };
}
function billingSpec(paidLabel = 'Zahlung eingegangen'): FakeModelSpec {
  return {
    engine: 'c8',
    processes: [
      {
        id: 'Process_Billing',
        name: 'Rechnungsstellung',
        elements: [
          {
            kind: 'msg_catch',
            id: 'Start_Shipped',
            name: 'Ware versandbereit',
            ref: 'WareVersandbereit',
            elementType: 'bpmn:StartEvent',
          },
          { kind: 'msg_catch', id: 'Event_Paid', name: paidLabel, ref: 'ZahlungEingegangen' },
          { kind: 'evt_start', id: 'Start_Manual', name: 'Auftrag erledigt' },
        ],
      },
    ],
  };
}
const payment: FakeModelSpec = {
  processes: [
    {
      id: 'Process_Payment',
      name: 'Payment',
      elements: [
        {
          kind: 'msg_throw',
          id: 'Event_Received',
          name: 'Payment received',
          ref: 'PaymentReceived',
        },
      ],
    },
  ],
};

let database: TestDatabase;
let t: TestApp;
let agent: Caller;
const owner: Caller = (path, init) => t.asOwner(path, init);

async function relations(project = 'review', query = '?limit=200'): Promise<Relation[]> {
  const res = await t.asOwner(`/api/v1/projects/${project}/relations${query}`);
  return ((await res.json()) as RelationPage).items;
}

async function find(from: string, to: string, project = 'review'): Promise<Relation> {
  const r = (await relations(project, '?limit=200&status=obsolete')).concat(
    await relations(project),
  );
  const found = r.find((x) => x.from === from && x.to === to);
  if (!found) throw new Error(`no relation ${from} → ${to}`);
  return found;
}

async function decide(relation: Relation, body: unknown, headers: Record<string, string> = {}) {
  return t.asOwner(`/api/v1/projects/review/relations/${relation.id}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function stages(project = 'review'): Promise<Record<string, string>> {
  const page = (await (await t.asOwner(`/api/v1/projects/${project}/models`)).json()) as ModelPage;
  return Object.fromEntries(page.items.map((m) => [m.key, m.stage]));
}

async function timeline(relation: Relation): Promise<RelationAssertionList['items']> {
  const res = await t.asOwner(`/api/v1/projects/review/relations/${relation.id}/assertions`);
  return ((await res.json()) as RelationAssertionList).items;
}

/** Claims the task of `modelKey` and submits `items` for it. */
async function analyse(modelKey: string, items: ReturnType<typeof item>[]) {
  const [c] = await claim(agent, { modelKey });
  if (!c) throw new Error(`no task for ${modelKey}`);
  return { claimed: c, result: await submit(agent, c.taskId, submission(c, items)) };
}

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database);
  await t.createProject('review');
  await t.putModel('review', ORDER, fakeBpmn(orderSpec()));
  await t.putModel('review', BILLING, fakeBpmn(billingSpec()));
  await t.putModel('review', PAYMENT, fakeBpmn(payment));
  agent = asAgent(t, (await t.createToken('review', ['proa:read', 'proa:propose'])).secret);
  await analyse(ORDER, [
    item('message', O('Event_Shipped'), B('Event_Paid'), { confidence: 0.4 }),
    item('trigger', O('End_Done'), B('Start_Manual'), {
      question: 'Wirklich erst nach Abschluss?',
    }),
  ]);
  await analyse(PAYMENT, [
    item('message', P('Event_Received'), B('Event_Paid'), { confidence: 0.9 }),
  ]);
});

afterAll(async () => {
  await database.drop();
});

describe('the model engine', () => {
  it('comes with every model and revision', async () => {
    const page = (await (await t.asOwner('/api/v1/projects/review/models')).json()) as ModelPage;
    expect(Object.fromEntries(page.items.map((m) => [m.key, m.engine]))).toEqual({
      [ORDER]: 'c7',
      [BILLING]: 'c8',
      [PAYMENT]: null,
    });
  });
});

describe('findings', () => {
  it('hides dangling-throw and unmatched-catch once a live relation connects the endpoint', async () => {
    const f = (await (await t.asOwner('/api/v1/projects/review/findings')).json()) as FindingList;
    const refs = f.items.map((x) => `${x.kind} ${x.refs.join(',')}`);
    expect(refs).not.toContain(`dangling-throw ${P('Event_Received')}`);
    expect(refs).not.toContain(`unmatched-catch ${B('Event_Paid')}`);
    const landscape = (await (
      await t.asOwner('/api/v1/projects/review/landscape')
    ).json()) as Landscape;
    expect(landscape.findings).toEqual(f.items);
  });
});

describe('decisions', () => {
  it('accepts, with the owner as provenance and a new version', async () => {
    const trigger = await find(O('End_Done'), B('Start_Manual'));
    const res = await decide(trigger, {
      verdict: 'accept',
      note: 'passt',
      version: trigger.version,
    });
    expect(res.status).toBe(200);
    const { relation, corrected } = (await res.json()) as DecisionResult;
    expect(corrected).toBeNull();
    expect(relation).toMatchObject({
      status: 'accepted',
      version: trigger.version + 1,
      source: 'human',
      provenance: {
        kind: 'decision',
        verdict: 'accept',
        sourceKind: 'human',
        handle: 'owner',
        clientId: 'proa-web',
        rationale: 'passt',
      },
    });
    expect(res.headers.get('etag')).toBe(`"${relation.version}"`);
    expect(Date.parse(relation.updatedAt)).toBeGreaterThanOrEqual(Date.parse(trigger.updatedAt));
  });

  it('is conditional: a stale body version is 409, a stale If-Match 412', async () => {
    const trigger = await find(O('End_Done'), B('Start_Manual'));
    const stale = await decide(trigger, { verdict: 'reject', reason: 'x', version: 1 });
    expect(stale.status).toBe(409);
    expect(await problemOf(stale)).toMatchObject({ code: 'conflict', version: trigger.version });
    const ifMatch = await decide(
      trigger,
      { verdict: 'reject', reason: 'x' },
      { 'if-match': '"1"' },
    );
    expect(ifMatch.status).toBe(412);
    const garbage = await decide(trigger, { verdict: 'reject', reason: 'x' }, { 'if-match': 'v' });
    expect(garbage.status).toBe(412);
    const etag = (await t.asOwner(`/api/v1/projects/review/relations/${trigger.id}`)).headers.get(
      'etag',
    );
    expect(etag).toBe(`"${trigger.version}"`);
    expect((await find(O('End_Done'), B('Start_Manual'))).status).toBe('accepted');
  });

  it('validates verdicts: reject needs a reason, hold a note', async () => {
    const trigger = await find(O('End_Done'), B('Start_Manual'));
    for (const body of [
      { verdict: 'reject' },
      { verdict: 'reject', reason: '   ' },
      { verdict: 'hold' },
      { verdict: 'maybe' },
      { verdict: 'hold', note: 'x', label: 'y'.repeat(101) },
    ]) {
      expect((await decide(trigger, body)).status, JSON.stringify(body)).toBe(422);
    }
  });

  it('holds with a note, question and label: held, an open item, stage waiting_for_clarification', async () => {
    const paid = await find(P('Event_Received'), B('Event_Paid'));
    const res = await decide(paid, {
      verdict: 'hold',
      note: 'Fachbereich fragen',
      question: 'Kommt die Zahlung immer vom Payment-Provider?',
      label: 'mit Fachbereich Finanzen klären',
    });
    expect(res.status).toBe(200);
    const { relation } = (await res.json()) as DecisionResult;
    expect(relation).toMatchObject({
      status: 'held',
      provenance: {
        verdict: 'hold',
        rationale: 'Fachbereich fragen',
        question: 'Kommt die Zahlung immer vom Payment-Provider?',
        label: 'mit Fachbereich Finanzen klären',
      },
    });
    // The payment model's only open item is held now.
    expect((await stages())[PAYMENT]).toBe('waiting_for_clarification');
    const page = (await (
      await t.asOwner('/api/v1/projects/review/models?stage=waiting_for_clarification')
    ).json()) as ModelPage;
    expect(page.items.map((m) => [m.key, m.openItems])).toEqual([[PAYMENT, 1]]);
    // Held relations still connect their endpoints: the findings stay hidden.
    const f = (await (await t.asOwner('/api/v1/projects/review/findings')).json()) as FindingList;
    expect(f.items.flatMap((x) => x.refs)).not.toContain(P('Event_Received'));
  });

  it('records answers as notes, which never change the status', async () => {
    const paid = await find(P('Event_Received'), B('Event_Paid'));
    const res = await post(owner, `/api/v1/projects/review/relations/${paid.id}/notes`, {
      text: 'Ja, immer über den Provider.',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      kind: 'note',
      sourceKind: 'human',
      rationale: 'Ja, immer über den Provider.',
    });
    expect((await find(P('Event_Received'), B('Event_Paid'))).status).toBe('held');
    expect((await timeline(paid)).map((a) => [a.kind, a.verdict])).toEqual([
      ['proposal', null],
      ['decision', 'hold'],
      ['note', null],
    ]);
  });

  it('corrects: rejects the proposal and accepts another pair as a manual relation linked to it', async () => {
    const wrong = await find(O('Event_Shipped'), B('Event_Paid'));
    const same = await decide(wrong, {
      verdict: 'correct',
      from: O('Event_Shipped'),
      to: B('Event_Paid'),
      note: 'x',
    });
    expect(same.status).toBe(422);
    const unknown = await decide(wrong, {
      verdict: 'correct',
      from: O('Nope'),
      to: B('Start_Shipped'),
      note: 'x',
    });
    expect(await problemOf(unknown)).toMatchObject({
      code: 'validation-failed',
      reason: 'unknown-ref',
    });
    const sameProcess = await decide(wrong, {
      verdict: 'correct',
      from: O('Event_Shipped'),
      to: O('Task_Pack'),
      note: 'x',
    });
    expect(await problemOf(sameProcess)).toMatchObject({ reason: 'same-process' });

    const res = await decide(wrong, {
      verdict: 'correct',
      from: O('Task_Pack'),
      to: B('Start_Shipped'),
      note: 'Das Verpacken löst die Rechnung aus, nicht die Zahlung.',
    });
    expect(res.status).toBe(200);
    const { relation, corrected } = (await res.json()) as DecisionResult;
    expect(relation).toMatchObject({ status: 'rejected', provenance: { verdict: 'reject' } });
    expect(corrected).toMatchObject({
      type: 'manual',
      from: O('Task_Pack'),
      to: B('Start_Shipped'),
      status: 'accepted',
      tier: 'manual',
      source: 'human',
    });
    const rejection = (await timeline(relation)).at(-1);
    const acceptance = corrected ? (await timeline(corrected)).at(-1) : undefined;
    expect(rejection?.linkedRelationId).toBe(corrected?.id);
    expect(acceptance?.linkedRelationId).toBe(relation.id);
  });

  it('cannot decide an obsolete or unknown relation', async () => {
    const res = await t.asOwner(
      '/api/v1/projects/review/relations/rel_01J9Z3N4X5Q6R7S8T9V0W1X2Y3/decision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'accept' }),
      },
    );
    expect(res.status).toBe(404);
  });
});

describe('the claim input shows decisions, questions and notes', () => {
  it('to the next agent run of a model', async () => {
    await post(owner, '/api/v1/projects/review/analyses/requeue', { modelKeys: [BILLING] });
    const items = await claim(agent, { modelKey: BILLING });
    const input = (items[0] as ClaimedAnalysis).input;
    const held = input.relations.find((r) => r.from === P('Event_Received'));
    expect(held).toMatchObject({
      status: 'held',
      decision: {
        verdict: 'hold',
        note: 'Fachbereich fragen',
        question: 'Kommt die Zahlung immer vom Payment-Provider?',
        label: 'mit Fachbereich Finanzen klären',
      },
      notes: [{ text: 'Ja, immer über den Provider.' }],
    });
    const rejected = input.relations.find(
      (r) => r.from === O('Event_Shipped') && r.to === B('Event_Paid'),
    );
    expect(rejected).toMatchObject({
      status: 'rejected',
      decision: {
        verdict: 'reject',
        note: 'Das Verpacken löst die Rechnung aus, nicht die Zahlung.',
      },
    });
    expect(input.relations.find((r) => r.type === 'manual')).toMatchObject({
      status: 'accepted',
      source: 'human',
    });
    // Hand it back for the memory tests.
    await post(agent, `/api/v1/analyses/${items[0]?.taskId}/release`, {
      leaseToken: items[0]?.leaseToken,
    });
  });
});

describe('decision memory across re-uploads', () => {
  it('suppresses a re-proposal of a rejection while the endpoints are unchanged', async () => {
    // A new revision of the order model with other facts; the rejected endpoints stay the same.
    const res = await t.putModel(
      'review',
      ORDER,
      fakeBpmn(orderSpec([{ kind: 'task', id: 'Task_Label', name: 'Etikett drucken' }])),
    );
    expect(res.status).toBe(200);
    const { result } = await analyse(ORDER, [
      item('message', O('Event_Shipped'), B('Event_Paid'), { confidence: 0.5 }),
      item('trigger', O('End_Done'), B('Start_Manual')),
    ]);
    expect(result.items.map((i) => [i.result, i.status])).toEqual([
      ['suppressed', 'rejected'],
      ['suppressed', 'accepted'],
    ]);
    expect((await find(O('Event_Shipped'), B('Event_Paid'))).status).toBe('rejected');
  });

  it('suppresses a re-proposal of a held item while the endpoints are unchanged', async () => {
    await post(owner, '/api/v1/projects/review/analyses/requeue', { modelKeys: [PAYMENT] });
    const { result } = await analyse(PAYMENT, [
      item('message', P('Event_Received'), B('Event_Paid'), { confidence: 0.95 }),
    ]);
    expect(result.items.map((i) => [i.result, i.status])).toEqual([['suppressed', 'held']]);
    expect(result.withdrawn).toBe(0);
  });

  it('marks the rejection changed when an endpoint changes, and reopens it on a re-proposal', async () => {
    const res = await t.putModel('review', BILLING, fakeBpmn(billingSpec('Zahlung erhalten')));
    expect(res.status).toBe(200);
    const before = await find(O('Event_Shipped'), B('Event_Paid'));
    expect(before).toMatchObject({ status: 'rejected', endpointState: 'changed' });
    const { result } = await analyse(BILLING, [
      item('message', O('Event_Shipped'), B('Event_Paid'), { confidence: 0.5 }),
    ]);
    expect(result.items.map((i) => [i.result, i.status])).toEqual([['reopened', 'proposed']]);
    const after = await find(O('Event_Shipped'), B('Event_Paid'));
    expect(after).toMatchObject({ status: 'proposed', endpointState: 'ok', source: 'agent' });
    expect((await stages())[BILLING]).toBe('waiting_for_review');
  });

  it('records a re-proposal of a held item after an endpoint changed, and the hold stays', async () => {
    const held = await find(P('Event_Received'), B('Event_Paid'));
    expect(held).toMatchObject({ status: 'held', endpointState: 'changed' });
    await post(owner, '/api/v1/projects/review/analyses/requeue', { modelKeys: [PAYMENT] });
    const { result } = await analyse(PAYMENT, [
      item('message', P('Event_Received'), B('Event_Paid'), { confidence: 0.95 }),
    ]);
    // New information for the reviewer, but only a human ends a hold.
    expect(result.items.map((i) => [i.result, i.status])).toEqual([['applied', 'held']]);
    // The billing re-analysis did not repeat this proposal, which touches the billing
    // model, so it withdrew it (CONCEPT §2 supersession); the hold kept the status.
    const history = await timeline(held);
    expect(history.map((a) => [a.kind, a.sourceKind])).toEqual([
      ['proposal', 'agent'],
      ['decision', 'human'],
      ['note', 'human'],
      ['withdrawal', 'agent'],
      ['proposal', 'agent'],
    ]);
    expect(history[3]?.rationale).toMatch(/^superseded by submission /);
  });
});

describe('bulk decisions', () => {
  let keyTier: Relation[];

  beforeAll(async () => {
    keyTier = (await relations('review', '?tier=key&status=proposed')).filter(
      (r) => r.type === 'message',
    );
    expect(keyTier.length).toBeGreaterThan(0);
  });

  const bulk = (body: unknown) => post(owner, '/api/v1/projects/review/decisions', body);
  const items = () => keyTier.map((r) => ({ id: r.id, version: r.version }));

  it('fails as a whole on a count mismatch (409) and changes nothing', async () => {
    const res = await bulk({
      verdict: 'accept',
      tier: 'key',
      items: items(),
      expectedCount: keyTier.length + 1,
    });
    expect(res.status).toBe(409);
    expect(await problemOf(res)).toMatchObject({
      code: 'conflict',
      expectedCount: keyTier.length + 1,
    });
    for (const r of keyTier) expect((await find(r.from, r.to)).status).toBe('proposed');
  });

  it('fails on a stale version, a wrong tier or an unknown id, naming each mismatch', async () => {
    const stale = items().map((x, i) => (i === 0 ? { ...x, version: x.version + 7 } : x));
    const res = await bulk({ verdict: 'accept', items: stale, expectedCount: stale.length });
    expect(res.status).toBe(409);
    expect((await problemOf(res))['mismatches']).toEqual([
      { id: keyTier[0]?.id, reason: 'version', version: keyTier[0]?.version },
    ]);
    const tier = await bulk({
      verdict: 'accept',
      tier: 'semantic',
      items: items(),
      expectedCount: keyTier.length,
    });
    expect(((await problemOf(tier))['mismatches'] as unknown[]).length).toBe(keyTier.length);
    const unknown = await bulk({
      verdict: 'accept',
      items: [{ id: 'rel_01J9Z3N4X5Q6R7S8T9V0W1X2Y3', version: 1 }],
      expectedCount: 1,
    });
    expect(await problemOf(unknown)).toMatchObject({ mismatches: [{ reason: 'not-found' }] });
    const twice = [...items(), ...items().slice(0, 1)];
    const duplicate = await bulk({ verdict: 'accept', items: twice, expectedCount: twice.length });
    expect(await problemOf(duplicate)).toMatchObject({
      mismatches: [{ id: keyTier[0]?.id, reason: 'duplicate' }],
    });
    const reject = await bulk({ verdict: 'reject', items: items(), expectedCount: keyTier.length });
    expect(reject.status).toBe(422);
  });

  it('accepts a tier in one go with ids, versions and expectedCount', async () => {
    const res = await bulk({
      verdict: 'accept',
      tier: 'key',
      items: items(),
      expectedCount: keyTier.length,
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as BulkDecisionResult;
    expect(result.items.map((r) => [r.id, r.status, r.source])).toEqual(
      keyTier.map((r) => [r.id, 'accepted', 'human']),
    );
    // Replaying the same request now fails: the versions moved on.
    const again = await bulk({
      verdict: 'accept',
      tier: 'key',
      items: items(),
      expectedCount: keyTier.length,
    });
    expect(again.status).toBe(409);
  });
});

describe('ad-hoc proposals', () => {
  const propose = (caller: Caller, body: Record<string, unknown>) =>
    post(caller, '/api/v1/projects/review/relations', body);

  it('records an agent proposal with a server-computed tier; repeating it is a duplicate', async () => {
    const body = {
      type: 'trigger',
      from: O('End_Done'),
      to: B('Start_Shipped'),
      confidence: 0.3,
      rationale: 'vielleicht',
      llmModel: 'sim-1',
    };
    const first = await propose(agent, body);
    expect(first.status).toBe(422);
    expect(await problemOf(first)).toMatchObject({
      code: 'validation-failed',
      reason: 'type-mismatch',
    });
    const ok = await propose(agent, {
      ...body,
      type: 'message',
      from: O('Event_Shipped'),
      to: B('Start_Shipped'),
    });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as ProposeRelationResult;
    // The key tier is accepted by now (bulk above): a proposal adds nothing.
    expect(okBody.result).toBe('suppressed');
    const fresh = await propose(agent, {
      ...body,
      type: 'trigger',
      from: O('End_Done'),
      to: B('Start_Manual'),
    });
    expect(((await fresh.json()) as ProposeRelationResult).result).toBe('suppressed');
    const payment = await propose(agent, {
      type: 'message',
      from: P('Event_Received'),
      to: B('Start_Shipped'),
      confidence: 0.2,
      rationale: 'unsicher',
    });
    const p = (await payment.json()) as ProposeRelationResult;
    expect(p).toMatchObject({
      result: 'applied',
      relation: { status: 'proposed', source: 'agent' },
    });
    expect(['lexical', 'semantic']).toContain(p.relation.tier);
    const again = await propose(agent, {
      type: 'message',
      from: P('Event_Received'),
      to: B('Start_Shipped'),
      confidence: 0.2,
      rationale: 'unsicher',
    });
    expect(((await again.json()) as ProposeRelationResult).result).toBe('duplicate');
  });

  it('withdraws only the caller’s own live proposal', async () => {
    const r = await find(P('Event_Received'), B('Start_Shipped'));
    const res = await t.asToken(
      (await t.createToken('review', ['proa:propose'])).secret,
      `/api/v1/projects/review/relations/${r.id}/proposal`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(409);
    const own = await agent(`/api/v1/projects/review/relations/${r.id}/proposal`, {
      method: 'DELETE',
    });
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ status: 'obsolete' });
    const twice = await agent(`/api/v1/projects/review/relations/${r.id}/proposal`, {
      method: 'DELETE',
    });
    expect(twice.status).toBe(409);
  });

  it('lets humans add an accepted manual relation (rationale required); agents cannot', async () => {
    const body = {
      type: 'manual',
      from: O('Task_Pack'),
      to: P('Event_Received'),
      confidence: 1,
      rationale: 'Verpacken stößt die Zahlung an',
    };
    const res = await propose(owner, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      result: 'applied',
      relation: { type: 'manual', status: 'accepted', tier: 'manual', source: 'human' },
    });
    expect(((await (await propose(owner, body)).json()) as ProposeRelationResult).result).toBe(
      'duplicate',
    );
    expect((await propose(owner, { ...body, from: O('End_Done'), rationale: ' ' })).status).toBe(
      422,
    );
    const byAgent = await propose(agent, body);
    expect(byAgent.status).toBe(403);
    expect(await problemOf(byAgent)).toMatchObject({ code: 'human-decision-required' });
  });
});

describe('agents never decide', () => {
  it('get 403 human-decision-required with the review URL, for every decision route', async () => {
    const r = await find(O('Event_Shipped'), B('Event_Paid'));
    const attempts = [
      post(agent, `/api/v1/projects/review/relations/${r.id}/decision`, { verdict: 'accept' }),
      post(agent, '/api/v1/projects/review/decisions', {
        verdict: 'accept',
        items: [{ id: r.id, version: r.version }],
        expectedCount: 1,
      }),
      post(agent, `/api/v1/projects/review/relations/${r.id}/notes`, { text: 'agent note' }),
    ];
    const [single, many, note] = await Promise.all(attempts);
    for (const res of [single, many, note]) {
      expect(res?.status).toBe(403);
    }
    expect(await problemOf(single as Response)).toMatchObject({
      code: 'human-decision-required',
      reviewUrl: `http://localhost/projects/review/review/${r.id}`,
    });
    expect(await problemOf(many as Response)).toMatchObject({
      reviewUrl: 'http://localhost/projects/review/review',
    });
    expect((await find(O('Event_Shipped'), B('Event_Paid'))).status).toBe('proposed');
    // Proposals and withdrawals (supersession records those under the proposer) only.
    const kinds = (await timeline(r)).map((a) => [a.kind, a.sourceKind]);
    expect(
      kinds.filter(
        ([kind, source]) => (kind === 'decision' || kind === 'note') && source === 'agent',
      ),
    ).toEqual([]);
  });
});

describe('events', () => {
  it('records every pipeline and review change, densely numbered', async () => {
    const r = await database.db.execute<{ type: string; seq: string }>(
      sql`SELECT e.type, e.seq FROM event e JOIN project p ON p.id = e.project_id
          WHERE p.key = 'review' ORDER BY e.seq`,
    );
    const types = new Set(r.rows.map((x) => x.type));
    for (const type of [
      'model.revised',
      'analysis.queued',
      'analysis.claimed',
      'analysis.released',
      'analysis.done',
      'analysis.cancelled',
      'relation.proposed',
      'relation.withdrawn',
      'relation.decided',
      'relation.noted',
      'relation.endpoint_changed',
    ]) {
      expect(types, type).toContain(type);
    }
    expect(r.rows.map((x) => Number(x.seq))).toEqual(r.rows.map((_, i) => i + 1));
  });
});

describe('a human who decided and later proposes the same relation', () => {
  it('keeps the decision in force: the own proposal and its supersession never end it', async () => {
    await t.createProject('human-proposes');
    await t.putModel('human-proposes', ORDER, fakeBpmn(orderSpec()));
    await t.putModel('human-proposes', BILLING, fakeBpmn(billingSpec()));
    const bot = asAgent(
      t,
      (await t.createToken('human-proposes', ['proa:read', 'proa:propose'])).secret,
    );
    const pipelineOf = async (
      caller: Caller,
      modelKey: string,
      items: ReturnType<typeof item>[],
    ) => {
      const [c] = await claim(caller, { projectId: 'human-proposes', modelKey });
      if (!c) throw new Error(`no task for ${modelKey}`);
      return submit(caller, c.taskId, submission(c, items));
    };
    const pair = () => find(O('End_Done'), B('Start_Manual'), 'human-proposes');

    // An agent proposes, the owner accepts.
    await pipelineOf(bot, ORDER, [item('trigger', O('End_Done'), B('Start_Manual'))]);
    const proposed = await pair();
    const accepted = await t.asOwner(
      `/api/v1/projects/human-proposes/relations/${proposed.id}/decision`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'accept' }),
      },
    );
    expect(accepted.status).toBe(200);

    // The endpoint changes: still accepted, an open item.
    const relabelled = billingSpec();
    const start = relabelled.processes[0]?.elements?.find((e) => e.id === 'Start_Manual');
    if (start) start.name = 'Auftrag vollständig erledigt';
    expect((await t.putModel('human-proposes', BILLING, fakeBpmn(relabelled))).status).toBe(200);
    expect(await pair()).toMatchObject({ status: 'accepted', endpointState: 'changed' });

    // The owner works the billing task and proposes the pair again: recorded, still accepted.
    // Judge each pair once: the submission withdraws the agent's proposal, which rests on the
    // old billing model (before 0.2.0 the agent's later re-analysis withdrew both).
    const own = await pipelineOf(owner, BILLING, [
      item('trigger', O('End_Done'), B('Start_Manual')),
    ]);
    expect(own.items.map((i) => [i.result, i.status])).toEqual([['applied', 'accepted']]);
    expect(own.withdrawn).toBe(1);
    expect((await pair()).provenance).toMatchObject({ kind: 'decision', verdict: 'accept' });

    // An agent re-analyses the unchanged billing model without the pair: the owner's current
    // judgement stays, and so does the owner's acceptance.
    await post(owner, '/api/v1/projects/human-proposes/analyses/requeue', {
      modelKeys: [BILLING],
    });
    const again = await pipelineOf(bot, BILLING, []);
    expect(again.withdrawn).toBe(0);
    expect(await pair()).toMatchObject({ status: 'accepted', endpointState: 'changed' });
    const history = (
      (await (
        await t.asOwner(`/api/v1/projects/human-proposes/relations/${proposed.id}/assertions`)
      ).json()) as RelationAssertionList
    ).items;
    expect(history.map((a) => [a.kind, a.verdict, a.sourceKind])).toEqual([
      ['proposal', null, 'agent'],
      ['decision', 'accept', 'human'],
      ['proposal', null, 'human'],
      ['withdrawal', null, 'agent'],
    ]);
  });
});

describe('free text with control characters', () => {
  it('is refused (422) in decisions, bulk decisions, notes and ad-hoc proposals', async () => {
    const target = (await relations()).find((r) => r.status !== 'obsolete');
    if (!target) throw new Error('no relation to decide');
    const nul = 'a\u0000b';
    for (const body of [
      { verdict: 'reject', reason: nul },
      { verdict: 'hold', note: nul },
      { verdict: 'hold', note: 'ok', question: `Frage ${nul}` },
      { verdict: 'hold', note: 'ok', label: '\u0007' },
      { verdict: 'accept', note: nul },
    ]) {
      const res = await decide(target, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(await problemOf(res)).toMatchObject({ code: 'validation-failed' });
    }
    const bulk = await post(owner, '/api/v1/projects/review/decisions', {
      verdict: 'reject',
      reason: nul,
      items: [{ id: target.id, version: target.version }],
      expectedCount: 1,
    });
    expect(bulk.status).toBe(422);
    const note = await post(owner, `/api/v1/projects/review/relations/${target.id}/notes`, {
      text: nul,
    });
    expect(note.status).toBe(422);
    for (const extra of [
      { rationale: nul },
      { rationale: 'ok', question: nul },
      { rationale: 'ok', evidence: [nul] },
      { rationale: 'ok', llmModel: nul },
      { rationale: 'ok', procedure: { id: 'proa-relations', version: '0.0.1\n' } },
    ]) {
      const res = await post(agent, '/api/v1/projects/review/relations', {
        type: 'message',
        from: P('Event_Received'),
        to: B('Start_Shipped'),
        confidence: 0.5,
        ...extra,
      });
      expect(res.status, JSON.stringify(extra)).toBe(422);
    }
    // Tabs and line breaks are fine.
    const fine = await post(owner, `/api/v1/projects/review/relations/${target.id}/notes`, {
      text: 'Zeile 1\nZeile 2\tmit Tab\r\n',
    });
    expect(fine.status).toBe(201);
  });
});
