/**
 * The analysis pipeline over REST against real PostgreSQL (CONCEPT §3, M2
 * items 1–3): claim with a hashed lease token, the claim input, per-item
 * validation and results, provenance, verbatim storage, replay and the 409
 * rules, release, lease expiry and failure after three lost leases, late
 * submits, cancellation by a new revision, supersession, requeue, the task
 * list and the events.
 */
import { createHash } from 'node:crypto';

import type {
  AnalysisSubmission,
  AnalysisTaskPage,
  ClaimedAnalysis,
  ModelPage,
  PendingAnalyses,
  Relation,
  RelationPage,
  RequeueResult,
} from '@proa/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApp, testClock, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { fakeAnalysis, fakeBpmn, type FakeModelSpec } from '../support/fake-analysis.ts';
import {
  asAgent,
  claim,
  item,
  post,
  problemOf,
  release,
  submission,
  submit,
  submitRaw,
  type Caller,
} from '../support/pipeline.ts';

const MINUTE = 60_000;
const ORDER = 'vertrieb/auftrag';
const BILLING = 'finanzen/rechnung';
const PAYMENT = 'finanzen/zahlung';
const O = (id: string) => `${ORDER}#${id}`;
const B = (id: string) => `${BILLING}#${id}`;
const P = (id: string) => `${PAYMENT}#${id}`;

const order: FakeModelSpec = {
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
      ],
    },
  ],
};
const billing: FakeModelSpec = {
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
        {
          kind: 'msg_catch',
          id: 'Event_Paid',
          name: 'Zahlung eingegangen',
          ref: 'ZahlungEingegangen',
        },
        { kind: 'evt_start', id: 'Start_Manual', name: 'Auftrag erledigt' },
      ],
    },
  ],
};
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
const clock = testClock(new Date('2026-10-08T08:00:00.000Z'));
const tokens = { a: '', b: '', read: '', write: '' };
let agentA: Caller;
let agentB: Caller;

async function rows<T>(query: string): Promise<T[]> {
  return (await database.db.execute(sql.raw(query))).rows as T[];
}

async function events(projectKey: string, prefix: string): Promise<string[]> {
  const r = await rows<{ type: string }>(
    `SELECT e.type FROM event e JOIN project p ON p.id = e.project_id
     WHERE p.key = '${projectKey}' AND e.type LIKE '${prefix}%' ORDER BY e.seq`,
  );
  return r.map((x) => x.type);
}

async function stageOf(project: string, key: string): Promise<string | undefined> {
  const res = await t.asOwner(`/api/v1/projects/${project}/models`);
  return ((await res.json()) as ModelPage).items.find((m) => m.key === key)?.stage;
}

async function relation(project: string, from: string, to: string): Promise<Relation | undefined> {
  const res = await t.asOwner(`/api/v1/projects/${project}/relations?limit=200`);
  return ((await res.json()) as RelationPage).items.find((r) => r.from === from && r.to === to);
}

async function setUp(project: string): Promise<void> {
  await t.createProject(project);
  for (const [key, spec] of [
    [ORDER, order],
    [BILLING, billing],
    [PAYMENT, payment],
  ] as const) {
    const res = await t.putModel(project, key, fakeBpmn(spec));
    expect(res.status).toBe(201);
    clock.advance(1000);
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database, { clock });
  await setUp('pipe');
  tokens.a = (await t.createToken('pipe', ['proa:read', 'proa:propose'])).secret;
  tokens.b = (await t.createToken('pipe', ['proa:read', 'proa:propose'])).secret;
  tokens.read = (await t.createToken('pipe', ['proa:read'])).secret;
  tokens.write = (await t.createToken('pipe', ['proa:write'])).secret;
  agentA = asAgent(t, tokens.a);
  agentB = asAgent(t, tokens.b);
});

afterAll(async () => {
  await database.drop();
});

describe('claim', () => {
  let claimed: ClaimedAnalysis;

  it('lists the queued tasks and counts them as pending', async () => {
    const res = await t.asOwner('/api/v1/projects/pipe/analyses');
    const page = (await res.json()) as AnalysisTaskPage;
    expect(page.items.map((x) => [x.modelKey, x.state, x.attempts])).toEqual([
      [PAYMENT, 'queued', 0],
      [BILLING, 'queued', 0],
      [ORDER, 'queued', 0],
    ]);
    const pending = (await (await agentA('/api/v1/analyses/pending')).json()) as PendingAnalyses;
    expect(pending).toMatchObject({ total: 3, items: [{ projectKey: 'pipe', pending: 3 }] });
  });

  it('claims the oldest task with a lease token bound to the task and the caller', async () => {
    const items = await claim(agentA);
    expect(items).toHaveLength(1);
    claimed = items[0] as ClaimedAnalysis;
    expect(claimed).toMatchObject({
      projectKey: 'pipe',
      modelKey: ORDER,
      attempt: 1,
      leaseUntil: new Date(clock.now().getTime() + 15 * MINUTE).toISOString(),
      procedure: { id: 'proa-relations', version: '0.0.1' },
    });
    expect(claimed.leaseToken).toMatch(/^proa_lt_[A-Za-z0-9_-]{43}$/);

    // Stored only as sha256(taskId|principal|token): never the token or its plain hash.
    const [task] = await rows<{ lease_token_hash: string; claimed_by: string; state: string }>(
      `SELECT lease_token_hash, claimed_by, state FROM analysis_task WHERE id = '${claimed.taskId}'`,
    );
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(task?.state).toBe('claimed');
    expect(task?.lease_token_hash).toBe(
      sha(`${claimed.taskId}|${task?.claimed_by}|${claimed.leaseToken}`),
    );
    expect(task?.lease_token_hash).not.toBe(sha(claimed.leaseToken));
    const dump = JSON.stringify(await rows('SELECT * FROM analysis_task'));
    expect(dump).not.toContain(claimed.leaseToken.slice(8));
    expect(await stageOf('pipe', ORDER)).toBe('agent_working');
  });

  it('renders the claim input: facts, candidate tuples, partners and relations', () => {
    const input = claimed.input;
    expect(input.format).toBe('proa-claim/1');
    expect(input.model).toMatchObject({
      key: ORDER,
      rev: 1,
      engine: 'c7',
      name: 'Auftragsabwicklung',
    });
    expect(input.facts).toContainEqual({
      ref: O('Event_Shipped'),
      kind: 'msg_throw',
      eventDef: 'message',
      label: 'Ware versandbereit',
      key: 'WareVersandbereit',
      process: 'Process_Order',
    });
    // `key` is left out when it equals the label, `scope` when it is `process`.
    expect(input.facts).toContainEqual({
      ref: O('End_Done'),
      kind: 'evt_end',
      eventDef: 'none',
      label: 'Auftrag erledigt',
      process: 'Process_Order',
    });
    expect(input.candidates).toContainEqual([
      'message',
      O('Event_Shipped'),
      B('Start_Shipped'),
      'key',
      1,
    ]);
    expect(
      input.candidates.some(
        ([type, from, to]) =>
          type === 'trigger' && from === O('End_Done') && to === B('Start_Manual'),
      ),
    ).toBe(true);
    expect(input.partners[B('Start_Shipped')]).toMatchObject({
      kind: 'msg_catch',
      label: 'Ware versandbereit',
      process: B('Process_Billing'),
      processName: 'Rechnungsstellung',
    });
    expect(input.partnerProcesses?.[B('Process_Billing')]).toEqual({ name: 'Rechnungsstellung' });
    expect(Object.keys(input.partnerProcesses ?? {}).sort()).toEqual(
      [...new Set(Object.values(input.partners).map((p) => p.process))].sort(),
    );
    // The key proposal answers the throw: no finding touches the model.
    expect(input.findings).toBeUndefined();
    // The rule tier's key proposal touches the model.
    expect(input.relations).toEqual([
      expect.objectContaining({
        type: 'message',
        from: O('Event_Shipped'),
        to: B('Start_Shipped'),
        status: 'proposed',
        tier: 'key',
        source: 'rule',
      }),
    ]);
  });

  it('never hands out a claimed task twice, and stops at max', async () => {
    const rest = await claim(agentB, { max: 5 });
    expect(rest.map((c) => c.modelKey)).toEqual([BILLING, PAYMENT]);
    // Each input carries the project's findings touching its model.
    expect(rest.map((c) => c.input.findings?.map((f) => [f.kind, ...f.refs]))).toEqual([
      [['unmatched-catch', B('Event_Paid')]],
      [['dangling-throw', P('Event_Received')]],
    ]);
    expect(await claim(agentA, { max: 5 })).toEqual([]);
    const pending = (await (await agentA('/api/v1/analyses/pending')).json()) as PendingAnalyses;
    expect(pending.total).toBe(0);
    // Hand them back for the release test below.
    for (const c of rest) expect((await release(agentB, c.taskId, c.leaseToken)).status).toBe(200);
  });

  it('validates the claim body: max is 1–5', async () => {
    for (const max of [0, 6]) {
      const res = await post(agentA, '/api/v1/analyses/claim', { max });
      expect(res.status).toBe(422);
    }
  });

  it('narrows by project and model', async () => {
    expect(await claim(agentA, { modelKey: 'nope/nope' })).toEqual([]);
    const res = await post(agentA, '/api/v1/analyses/claim', { projectId: 'elsewhere' });
    expect(res.status).toBe(404);
  });

  describe('submit', () => {
    const long = (n: number) => 'x'.repeat(n);
    const body = () =>
      submission(
        claimed,
        [
          item('message', O('Event_Shipped'), B('Start_Shipped'), { confidence: 0.95 }),
          item('trigger', O('End_Done'), B('Start_Manual'), {
            question: 'Startet die Rechnung wirklich erst nach Auftragsende?',
            evidence: [O('End_Done'), B('Start_Manual')],
          }),
          item('trigger', O('End_Done'), B('Start_Manual')),
          item('message', O('Event_Shipped'), B('Event_Paid'), { confidence: 0.3 }),
          item('message', O('Event_Nope'), B('Start_Shipped')),
          item('message', P('Event_Received'), B('Event_Paid')),
          item('message', B('Start_Shipped'), O('Event_Shipped')),
          item('message', O('Event_Shipped'), B('Event_Paid'), { confidence: 1.5 }),
          item('message', O('Event_Shipped'), B('Event_Paid'), { rationale: long(1001) }),
          item('message', O('Event_Shipped'), B('Event_Paid'), { question: long(501) }),
          item('message', 'not a ref', B('Event_Paid')),
          item('manual', O('Task_Pack'), B('Event_Paid')),
          item('message', O('Event_Shipped'), B('Event_Paid'), {
            evidence: Array.from({ length: 21 }, (_, i) => `e${i}`),
          }),
        ],
        {
          noLinks: [
            { from: O('Event_Shipped'), to: P('Event_Received'), reason: 'other direction' },
          ],
          summary: 'two links',
        },
      );
    let sent: ReturnType<typeof body>;

    it('answers per item: applied, duplicate, invalid:<reason>', async () => {
      sent = body();
      const result = await submit(agentA, claimed.taskId, sent);
      expect(result.items.map((i) => i.result)).toEqual([
        'applied',
        'applied',
        'duplicate',
        'applied',
        'invalid:unknown-ref',
        'invalid:outside-task-model',
        'invalid:type-mismatch',
        'invalid:confidence-out-of-range',
        'invalid:rationale-too-long',
        'invalid:question-too-long',
        'invalid:malformed-ref',
        'invalid:type-not-allowed',
        'invalid:too-much-evidence',
      ]);
      expect(result.counts).toEqual({
        applied: 3,
        duplicate: 1,
        suppressed: 0,
        reopened: 0,
        invalid: 9,
      });
      expect(result.replayed).toBe(false);
      expect(result.items[1]?.status).toBe('proposed');
      expect(result.items[2]?.relationId).toBe(result.items[1]?.relationId);
      expect(result.items[4]).toEqual({
        index: 4,
        result: 'invalid:unknown-ref',
        relationId: null,
        status: null,
      });
    });

    it('records the proposals with provenance from the credential and the declaration', async () => {
      const trigger = await relation('pipe', O('End_Done'), B('Start_Manual'));
      expect(trigger).toMatchObject({
        type: 'trigger',
        status: 'proposed',
        endpointState: 'ok',
        version: 1,
        source: 'agent',
        provenance: {
          kind: 'proposal',
          sourceKind: 'agent',
          handle: 'agent:test proa:read proa:propose',
          procedure: { id: 'proa-relations', version: '0.0.1' },
          llmModel: 'sim-1',
          question: 'Startet die Rechnung wirklich erst nach Auftragsende?',
        },
      });
      expect(trigger?.provenance?.clientId).toMatch(/^agt_/);
      // New relations carry the database's time (the M1 `updatedAt` fix).
      expect(Math.abs(Date.parse(trigger?.updatedAt ?? '') - Date.now())).toBeLessThan(60_000);
      // The rule's key proposal and the agent's proposal on the same relation.
      const key = await relation('pipe', O('Event_Shipped'), B('Start_Shipped'));
      expect(key).toMatchObject({ status: 'proposed', tier: 'key', source: 'agent' });
      const timeline = (await (
        await t.asOwner(`/api/v1/projects/pipe/relations/${key?.id}/assertions`)
      ).json()) as { items: { kind: string; sourceKind: string; submissionId: string | null }[] };
      expect(timeline.items.map((a) => [a.kind, a.sourceKind])).toEqual([
        ['proposal', 'rule'],
        ['proposal', 'agent'],
      ]);
      expect(timeline.items[1]?.submissionId).toMatch(/^sbm_/);
    });

    it('marks the task done and the model waiting for review', async () => {
      const page = (await (
        await t.asOwner(`/api/v1/projects/pipe/analyses?modelKey=${encodeURIComponent(ORDER)}`)
      ).json()) as AnalysisTaskPage;
      expect(page.items[0]).toMatchObject({ state: 'done', submissionId: sent.submissionId });
      expect(await stageOf('pipe', ORDER)).toBe('waiting_for_review');
    });

    it('stores the submission verbatim, without the lease token', async () => {
      const res = await t.asOwner(`/api/v1/projects/pipe/analyses/${claimed.taskId}/submission`);
      expect(res.status).toBe(200);
      const stored = (await res.json()) as AnalysisSubmission;
      const { leaseToken: _secret, ...expected } = sent;
      expect(stored.payload).toEqual(expected);
      expect(JSON.stringify(stored)).not.toContain(claimed.leaseToken);
      expect(stored).toMatchObject({
        submissionId: sent.submissionId,
        procedure: { id: 'proa-relations', version: '0.0.1' },
        llmModel: 'sim-1',
        handle: 'agent:test proa:read proa:propose',
        result: { counts: { applied: 3 } },
      });
      expect(stored.clientId).toMatch(/^agt_/);
    });

    it('replays the same submissionId and refuses a different one (409 already-submitted)', async () => {
      const replay = await submit(agentA, claimed.taskId, sent);
      expect(replay.replayed).toBe(true);
      expect(replay.items).toEqual((await submit(agentA, claimed.taskId, sent)).items);
      const other = await submitRaw(agentA, claimed.taskId, {
        ...sent,
        submissionId: crypto.randomUUID(),
      });
      expect(other.status).toBe(409);
      expect(await problemOf(other)).toMatchObject({ code: 'already-submitted' });
      // Another principal with a guessed token: the lease is not theirs.
      const stranger = await submitRaw(agentB, claimed.taskId, sent);
      expect(stranger.status).toBe(409);
      expect(await problemOf(stranger)).toMatchObject({ code: 'lease-lost' });
    });

    it('rejects more than 200 relations as a whole (422)', async () => {
      const [next] = await claim(agentA);
      expect(next).toBeDefined();
      const many = Array.from({ length: 201 }, () =>
        item('trigger', O('End_Done'), B('Start_Manual')),
      );
      const res = await submitRaw(
        agentA,
        next?.taskId ?? '',
        submission(next as ClaimedAnalysis, many),
      );
      expect(res.status).toBe(422);
      expect((await release(agentA, next?.taskId ?? '', next?.leaseToken ?? '')).status).toBe(200);
    });
  });
});

describe('release', () => {
  it('queues the task again and gives the attempt back; the token is dead afterwards', async () => {
    const [c] = await claim(agentB, { modelKey: PAYMENT });
    expect(c).toMatchObject({ modelKey: PAYMENT, attempt: 1 });
    const res = await release(
      agentB,
      c?.taskId ?? '',
      c?.leaseToken ?? '',
      'cannot reach the model',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ taskId: c?.taskId, state: 'queued' });
    const [task] = await rows<{
      state: string;
      attempts: number;
      last_error: string;
      lease_token_hash: string | null;
    }>(
      `SELECT state, attempts, last_error, lease_token_hash FROM analysis_task WHERE id = '${c?.taskId}'`,
    );
    expect(task).toEqual({
      state: 'queued',
      attempts: 0,
      last_error: 'cannot reach the model',
      lease_token_hash: null,
    });
    const again = await release(agentB, c?.taskId ?? '', c?.leaseToken ?? '');
    expect(again.status).toBe(409);
    expect(await problemOf(again)).toMatchObject({ code: 'lease-lost' });
    const late = await submitRaw(agentB, c?.taskId ?? '', submission(c as ClaimedAnalysis, []));
    expect(await problemOf(late)).toMatchObject({ code: 'lease-lost' });
    expect(await events('pipe', 'analysis.released')).not.toHaveLength(0);
  });

  it('refuses a wrong token and another principal', async () => {
    const [c] = await claim(agentB, { modelKey: PAYMENT });
    for (const [caller, token] of [
      [agentB, `${c?.leaseToken ?? ''}x`],
      [agentA, c?.leaseToken ?? ''],
    ] as const) {
      const res = await release(caller, c?.taskId ?? '', token);
      expect(res.status).toBe(409);
      expect(await problemOf(res)).toMatchObject({ code: 'lease-lost' });
    }
    expect((await release(agentB, c?.taskId ?? '', c?.leaseToken ?? '')).status).toBe(200);
  });

  it('answers 404 for unknown and foreign tasks', async () => {
    const res = await release(agentA, 'ana_01J9Z3N4X5Q6R7S8T9V0W1X2Y3', 'proa_lt_x');
    expect(res.status).toBe(404);
  });
});

describe('lease expiry', () => {
  let a: Caller;
  let b: Caller;

  beforeAll(async () => {
    await t.createProject('lease');
    await t.putModel('lease', ORDER, fakeBpmn(order));
    a = asAgent(t, (await t.createToken('lease', ['proa:propose'])).secret);
    b = asAgent(t, (await t.createToken('lease', ['proa:propose'])).secret);
  });

  it('accepts a late submit while nobody claimed the task again', async () => {
    await t.createProject('late');
    await t.putModel('late', ORDER, fakeBpmn(order));
    const agent = asAgent(t, (await t.createToken('late', ['proa:propose'])).secret);
    const [c] = await claim(agent);
    clock.advance(20 * MINUTE);
    const result = await submit(agent, c?.taskId ?? '', submission(c as ClaimedAnalysis, []));
    expect(result.items).toEqual([]);
    const [e] = await rows<{ payload: { late: boolean } }>(
      `SELECT e.payload FROM event e JOIN project p ON p.id = e.project_id WHERE p.key = 'late' AND e.type = 'analysis.done'`,
    );
    expect(e?.payload.late).toBe(true);
    expect(await stageOf('late', ORDER)).toBe('incorporated');
  });

  it('lets another agent claim an expired lease; the first lease is lost', async () => {
    const [first] = await claim(a);
    expect(first?.attempt).toBe(1);
    expect(await claim(b)).toEqual([]);
    clock.advance(16 * MINUTE);
    const [second] = await claim(b);
    expect(second).toMatchObject({ taskId: first?.taskId, attempt: 2 });
    const res = await submitRaw(a, first?.taskId ?? '', submission(first as ClaimedAnalysis, []));
    expect(res.status).toBe(409);
    expect(await problemOf(res)).toMatchObject({ code: 'lease-lost' });
  });

  it('fails the task in the claim transaction after the third lost lease', async () => {
    clock.advance(16 * MINUTE);
    const [third] = await claim(a);
    expect(third?.attempt).toBe(3);
    clock.advance(16 * MINUTE);
    const pending = (await (await b('/api/v1/analyses/pending')).json()) as PendingAnalyses;
    expect(pending.total).toBe(0);
    expect(await claim(b)).toEqual([]);
    const [task] = await rows<{ state: string; attempts: number; last_error: string }>(
      `SELECT t.state, t.attempts, t.last_error FROM analysis_task t JOIN project p ON p.id = t.project_id WHERE p.key = 'lease'`,
    );
    expect(task).toEqual({ state: 'failed', attempts: 3, last_error: 'lease expired 3 times' });
    expect(await events('lease', 'analysis.')).toEqual([
      'analysis.queued',
      'analysis.claimed',
      'analysis.claimed',
      'analysis.claimed',
      'analysis.failed',
    ]);
    expect(await stageOf('lease', ORDER)).toBe('agent_failed');

    // The last holder's late submit still passes: nobody claimed or cancelled the task.
    const result = await submit(
      a,
      third?.taskId ?? '',
      submission(third as ClaimedAnalysis, [item('trigger', O('End_Done'), O('Task_Pack'))]),
    );
    expect(result.items[0]?.result).toBe('invalid:type-mismatch');
    expect(await stageOf('lease', ORDER)).toBe('incorporated');
  });

  it('requeues a failed model (proa:write)', async () => {
    const owner = (path: string, init?: RequestInit) => t.asOwner(path, init);
    const res = await post(owner, '/api/v1/projects/lease/analyses/requeue', {
      modelKeys: [ORDER],
    });
    expect(((await res.json()) as RequeueResult).items).toEqual([
      { modelKey: ORDER, outcome: 'queued', taskId: expect.stringMatching(/^ana_/) as unknown },
    ]);
    expect(await stageOf('lease', ORDER)).toBe('waiting_for_agent');
  });
});

describe('a new revision', () => {
  let agent: Caller;

  beforeAll(async () => {
    await t.createProject('rev');
    await t.putModel('rev', ORDER, fakeBpmn(order));
    agent = asAgent(t, (await t.createToken('rev', ['proa:read', 'proa:propose'])).secret);
  });

  it('keeps the open task for the same facts (layout only)', async () => {
    const [c] = await claim(agent);
    expect((await t.putModel('rev', ORDER, fakeBpmn({ ...order, layout: 'moved' }))).status).toBe(
      200,
    );
    const [task] = await rows<{ state: string }>(
      `SELECT state FROM analysis_task WHERE id = '${c?.taskId}'`,
    );
    expect(task?.state).toBe('claimed');
    expect((await release(agent, c?.taskId ?? '', c?.leaseToken ?? '')).status).toBe(200);
  });

  it('cancels the open task when the facts change and queues a new one', async () => {
    const [c] = await claim(agent);
    const changed: FakeModelSpec = {
      ...order,
      processes: [
        { ...order.processes[0]!, elements: [{ kind: 'task', id: 'Task_New', name: 'Neu' }] },
      ],
    };
    expect((await t.putModel('rev', ORDER, fakeBpmn(changed))).status).toBe(200);
    for (const res of [
      await submitRaw(agent, c?.taskId ?? '', submission(c as ClaimedAnalysis, [])),
      await release(agent, c?.taskId ?? '', c?.leaseToken ?? ''),
    ]) {
      expect(res.status).toBe(409);
      expect(await problemOf(res)).toMatchObject({ code: 'task-cancelled' });
    }
    const page = (await (
      await t.asOwner('/api/v1/projects/rev/analyses')
    ).json()) as AnalysisTaskPage;
    expect(page.items.map((x) => x.state)).toEqual(['queued', 'cancelled']);
    expect(page.items[1]?.lastError).toBe('new head with different facts');
    const [next] = await claim(agent);
    expect(next?.input.model.rev).toBe(3);
    expect(next?.input.facts.map((f) => f.ref)).toContain(O('Task_New'));
  });
});

describe('supersession', () => {
  let agent: Caller;
  let other: Caller;

  beforeAll(async () => {
    await setUp('super');
    agent = asAgent(t, (await t.createToken('super', ['proa:propose'])).secret);
    other = asAgent(t, (await t.createToken('super', ['proa:propose'])).secret);
  });

  it('withdraws earlier pipeline proposals of the model that a new submission does not repeat', async () => {
    const [c1] = await claim(agent, { modelKey: ORDER });
    await submit(
      agent,
      c1?.taskId ?? '',
      submission(c1 as ClaimedAnalysis, [
        item('trigger', O('End_Done'), B('Start_Manual')),
        item('message', O('Event_Shipped'), B('Event_Paid'), { confidence: 0.4 }),
      ]),
    );
    // An ad-hoc proposal by another agent: never superseded by a submission.
    const adHoc = await post(other, '/api/v1/projects/super/relations', {
      type: 'message',
      from: P('Event_Received'),
      to: B('Event_Paid'),
      confidence: 0.9,
      rationale: 'payment received = Zahlung eingegangen',
    });
    expect(adHoc.status).toBe(200);
    // A second analysis of the model (e.g. a procedure upgrade).
    const owner = (path: string, init?: RequestInit) => t.asOwner(path, init);
    await post(owner, '/api/v1/projects/super/analyses/requeue', { all: true });
    const [c2] = await claim(other, { modelKey: ORDER });
    const result = await submit(
      other,
      c2?.taskId ?? '',
      submission(c2 as ClaimedAnalysis, [item('trigger', O('End_Done'), B('Start_Manual'))]),
    );
    expect(result.items.map((i) => i.result)).toEqual(['applied']);
    expect(result.withdrawn).toBe(1);
    expect(await relation('super', O('Event_Shipped'), B('Event_Paid'))).toBeUndefined();
    const obsolete = (await (
      await t.asOwner('/api/v1/projects/super/relations?status=obsolete')
    ).json()) as RelationPage;
    expect(obsolete.items.map((r) => [r.from, r.to])).toEqual([
      [O('Event_Shipped'), B('Event_Paid')],
    ]);
    expect(await relation('super', O('End_Done'), B('Start_Manual'))).toMatchObject({
      status: 'proposed',
    });
    expect(await relation('super', P('Event_Received'), B('Event_Paid'))).toMatchObject({
      status: 'proposed',
    });
    const timeline = (await (
      await t.asOwner(`/api/v1/projects/super/relations/${obsolete.items[0]?.id}/assertions`)
    ).json()) as { items: { kind: string; rationale: string | null }[] };
    expect(timeline.items.map((a) => a.kind)).toEqual(['proposal', 'withdrawal']);
    expect(timeline.items[1]?.rationale).toMatch(/^superseded by submission /);
  });

  it('requeue: open tasks stay, unknown models are reported, write scope required', async () => {
    const owner = (path: string, init?: RequestInit) => t.asOwner(path, init);
    const res = await post(owner, '/api/v1/projects/super/analyses/requeue', {
      modelKeys: [BILLING, 'nope/nope'],
    });
    expect(((await res.json()) as RequeueResult).items).toEqual([
      { modelKey: BILLING, outcome: 'open', taskId: expect.stringMatching(/^ana_/) as unknown },
      { modelKey: 'nope/nope', outcome: 'not-found', taskId: null },
    ]);
    const denied = await post(agent, '/api/v1/projects/super/analyses/requeue', { all: true });
    expect(denied.status).toBe(403);
    const invalid = await post(owner, '/api/v1/projects/super/analyses/requeue', {});
    expect(invalid.status).toBe(422);
  });
});

describe('scopes', () => {
  it('needs proa:propose to claim, submit and release (read and write tokens get 403)', async () => {
    for (const secret of [tokens.read, tokens.write]) {
      const caller = asAgent(t, secret);
      const res = await post(caller, '/api/v1/analyses/claim', {});
      expect(res.status).toBe(403);
      expect(await problemOf(res)).toMatchObject({ code: 'insufficient-scope' });
      expect((await post(caller, '/api/v1/analyses/claim', { projectId: 'pipe' })).status).toBe(
        403,
      );
      expect((await caller('/api/v1/analyses/pending')).status).toBe(403);
    }
    const anonymous = await t.request('/api/v1/analyses/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(anonymous.status).toBe(401);
  });

  it('lets the owner work the pipeline too (as a human, by REST)', async () => {
    const owner = (path: string, init?: RequestInit) => t.asOwner(path, init);
    const pending = (await (await owner('/api/v1/analyses/pending')).json()) as PendingAnalyses;
    expect(pending.items.map((i) => i.projectKey)).toContain('pipe');
  });
});

describe('a claim whose input cannot be built', () => {
  it('hands the tasks back at once (500 to the caller, the task queued again)', async () => {
    const failing = startTestApp(database, {
      clock,
      analysis: {
        ...fakeAnalysis(),
        candidates: () => {
          throw new Error('candidate generation failed');
        },
      },
    });
    await failing.createProject('broken');
    await failing.putModel('broken', ORDER, fakeBpmn(order));
    const secret = (await failing.createToken('broken', ['proa:propose'])).secret;
    const res = await post(asAgent(failing, secret), '/api/v1/analyses/claim', {});
    expect(res.status).toBe(500);
    expect(await problemOf(res)).toMatchObject({ code: 'internal' });
    const [task] = await rows<{ state: string; attempts: number; last_error: string }>(
      `SELECT t.state, t.attempts, t.last_error FROM analysis_task t JOIN project p ON p.id = t.project_id WHERE p.key = 'broken'`,
    );
    expect(task).toEqual({
      state: 'queued',
      attempts: 0,
      last_error: 'the claim input could not be built',
    });
  });
});

/** Claims `modelKey` three times, letting each lease expire: the task is due to fail. */
async function loseThreeLeases(agent: Caller, project: string, modelKey: string) {
  let last: ClaimedAnalysis | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    [last] = await claim(agent, { projectId: project, modelKey });
    expect(last?.attempt).toBe(attempt);
    clock.advance(16 * MINUTE);
  }
  return last as ClaimedAnalysis;
}

describe('a task whose last lease expired', () => {
  const owner: Caller = (path, init) => t.asOwner(path, init);

  it('fails when an agent asks what is pending, without anybody claiming', async () => {
    await t.createProject('stuck');
    await t.putModel('stuck', ORDER, fakeBpmn(order));
    const agent = asAgent(t, (await t.createToken('stuck', ['proa:propose'])).secret);
    await loseThreeLeases(agent, 'stuck', ORDER);
    expect(await stageOf('stuck', ORDER)).toBe('agent_working');
    const pending = (await (await agent('/api/v1/analyses/pending')).json()) as PendingAnalyses;
    expect(pending.total).toBe(0);
    expect(await stageOf('stuck', ORDER)).toBe('agent_failed');
    expect(await events('stuck', 'analysis.failed')).toEqual(['analysis.failed']);
  });

  it('is requeued by the owner even when nobody noticed the expiry', async () => {
    await t.createProject('stuck2');
    await t.putModel('stuck2', ORDER, fakeBpmn(order));
    const agent = asAgent(t, (await t.createToken('stuck2', ['proa:propose'])).secret);
    await loseThreeLeases(agent, 'stuck2', ORDER);
    const res = await post(owner, '/api/v1/projects/stuck2/analyses/requeue', { all: true });
    expect(((await res.json()) as RequeueResult).items).toEqual([
      { modelKey: ORDER, outcome: 'queued', taskId: expect.stringMatching(/^ana_/) as unknown },
    ]);
    expect(await stageOf('stuck2', ORDER)).toBe('waiting_for_agent');
    const states = (
      (await (await owner('/api/v1/projects/stuck2/analyses')).json()) as AnalysisTaskPage
    ).items.map((x) => x.state);
    expect(states).toEqual(['queued', 'failed']);
  });

  it('requeue cancels an expired lease with attempts left; its holder cannot submit late', async () => {
    await t.createProject('stuck3');
    await t.putModel('stuck3', ORDER, fakeBpmn(order));
    const agent = asAgent(t, (await t.createToken('stuck3', ['proa:propose'])).secret);
    const [c] = await claim(agent);
    clock.advance(16 * MINUTE);
    const res = await post(owner, '/api/v1/projects/stuck3/analyses/requeue', {
      modelKeys: [ORDER],
    });
    expect(((await res.json()) as RequeueResult).items[0]?.outcome).toBe('queued');
    const late = await submitRaw(agent, c?.taskId ?? '', submission(c as ClaimedAnalysis, []));
    expect(late.status).toBe(409);
    expect(await problemOf(late)).toMatchObject({ code: 'task-cancelled' });
    // An active lease stays open.
    const [next] = await claim(agent);
    const again = await post(owner, '/api/v1/projects/stuck3/analyses/requeue', {
      modelKeys: [ORDER],
    });
    expect(((await again.json()) as RequeueResult).items).toEqual([
      { modelKey: ORDER, outcome: 'open', taskId: next?.taskId },
    ]);
  });
});

describe('a late submit after the task failed', () => {
  const owner: Caller = (path, init) => t.asOwner(path, init);

  it('is refused once a newer task of the model ran, so it cannot supersede it', async () => {
    await t.createProject('stale');
    await t.putModel('stale', ORDER, fakeBpmn(order));
    await t.putModel('stale', BILLING, fakeBpmn(billing));
    const a = asAgent(t, (await t.createToken('stale', ['proa:propose'])).secret);
    const b = asAgent(t, (await t.createToken('stale', ['proa:propose'])).secret);
    const stale = await loseThreeLeases(a, 'stale', ORDER);
    await post(owner, '/api/v1/projects/stale/analyses/requeue', { modelKeys: [ORDER] });
    const [fresh] = await claim(b, { modelKey: ORDER });
    await submit(
      b,
      fresh?.taskId ?? '',
      submission(fresh as ClaimedAnalysis, [item('trigger', O('End_Done'), B('Start_Manual'))]),
    );
    const res = await submitRaw(a, stale.taskId, submission(stale, []));
    expect(res.status).toBe(409);
    expect(await problemOf(res)).toMatchObject({
      code: 'task-cancelled',
      detail: 'superseded by a newer analysis task of the model',
    });
    expect(await relation('stale', O('End_Done'), B('Start_Manual'))).toMatchObject({
      status: 'proposed',
    });
  });

  it('is refused when the model changed after the failure, even without a newer task', async () => {
    await t.createProject('stale2');
    await t.putModel('stale2', ORDER, fakeBpmn(order));
    const a = asAgent(t, (await t.createToken('stale2', ['proa:propose'])).secret);
    const [first] = await claim(a);
    await submit(a, first?.taskId ?? '', submission(first as ClaimedAnalysis, []));
    // New facts: a new task, which fails.
    const changed: FakeModelSpec = {
      ...order,
      processes: [
        {
          ...order.processes[0]!,
          elements: [
            ...(order.processes[0]?.elements ?? []),
            { kind: 'task', id: 'T2', name: 'Neu' },
          ],
        },
      ],
    };
    expect((await t.putModel('stale2', ORDER, fakeBpmn(changed))).status).toBe(200);
    const stale = await loseThreeLeases(a, 'stale2', ORDER);
    await a('/api/v1/analyses/pending'); // notices the expiry: the task fails
    expect(await stageOf('stale2', ORDER)).toBe('agent_failed');
    // Back to the analysed facts (another layout): no new task is queued.
    expect(
      (await t.putModel('stale2', ORDER, fakeBpmn({ ...order, layout: 'moved' }))).status,
    ).toBe(200);
    const res = await submitRaw(a, stale.taskId, submission(stale, []));
    expect(res.status).toBe(409);
    expect(await problemOf(res)).toMatchObject({
      code: 'task-cancelled',
      detail: 'the model changed after the task failed',
    });
  });
});

describe('limits and control characters in submissions', () => {
  let agent: Caller;

  beforeAll(async () => {
    await setUp('text');
    agent = asAgent(t, (await t.createToken('text', ['proa:read', 'proa:propose'])).secret);
  });

  it('refuses a body over 1 MB with 413 payload-too-large', async () => {
    const [c] = await claim(agent, { modelKey: PAYMENT });
    const noLinks = Array.from({ length: 500 }, (_, i) => ({
      from: P('Event_Received'),
      to: `${ORDER}#x${i}`,
      reason: 'x'.repeat(2000),
    }));
    const big = submission(c as ClaimedAnalysis, [], { noLinks, summary: 'gross' });
    const huge = {
      ...big,
      relations: [1, 2, 3].map(() =>
        item('message', P('Event_Received'), B('Event_Paid'), { rationale: 'y'.repeat(19_000) }),
      ),
    };
    const res = await submitRaw(agent, c?.taskId ?? '', huge);
    expect(res.status).toBe(413);
    expect(await problemOf(res)).toMatchObject({ code: 'payload-too-large' });
    expect((await release(agent, c?.taskId ?? '', c?.leaseToken ?? '')).status).toBe(200);
  });

  it('answers an item with control characters invalid; the others apply and NUL is stored as U+FFFD', async () => {
    const [c] = await claim(agent, { modelKey: ORDER });
    const result = await submit(
      agent,
      c?.taskId ?? '',
      submission(
        c as ClaimedAnalysis,
        [
          item('message', O('Event_Shipped'), B('Event_Paid'), { rationale: 'a\u0000b' }),
          item('trigger', O('End_Done'), B('Start_Manual'), { question: 'warum\u0007?' }),
          item('message', O('Event_Shipped'), B('Start_Shipped'), { evidence: ['\u0000'] }),
          item('trigger', O('End_Done'), B('Start_Manual'), {
            rationale: 'Zeile 1\nZeile 2\tmit Tab',
          }),
        ],
        { noLinks: [{ from: O('Task_Pack'), to: B('Event_Paid'), reason: 'nein\u0000' }] },
      ),
    );
    expect(result.items.map((i) => i.result)).toEqual([
      'invalid:control-characters',
      'invalid:control-characters',
      'invalid:control-characters',
      'applied',
    ]);
    const stored = (await (
      await t.asOwner(`/api/v1/projects/text/analyses/${c?.taskId}/submission`)
    ).json()) as AnalysisSubmission;
    const payload = stored.payload as {
      relations: { rationale: string }[];
      noLinks: { reason: string }[];
    };
    expect(payload.relations[0]?.rationale).toBe('a�b');
    expect(payload.noLinks[0]?.reason).toBe('nein�');
  });

  it('refuses control characters in the declared model and a release reason (422)', async () => {
    const [c] = await claim(agent, { modelKey: BILLING });
    const bad = await submitRaw(
      agent,
      c?.taskId ?? '',
      submission(c as ClaimedAnalysis, [], { llmModel: 'model\u0000' }),
    );
    expect(bad.status).toBe(422);
    const reason = await release(agent, c?.taskId ?? '', c?.leaseToken ?? '', 'weil\u0000');
    expect(reason.status).toBe(422);
    expect((await release(agent, c?.taskId ?? '', c?.leaseToken ?? '', 'weil')).status).toBe(200);
  });
});

describe('revoking an agent token', () => {
  const owner: Caller = (path, init) => t.asOwner(path, init);

  it('withdraws its live proposals and hands back its claimed tasks; decisions stay', async () => {
    await setUp('revoke');
    const token = await t.createToken('revoke', ['proa:read', 'proa:propose']);
    const bot = asAgent(t, token.secret);
    const other = asAgent(t, (await t.createToken('revoke', ['proa:propose'])).secret);
    const [c] = await claim(bot, { modelKey: ORDER });
    await submit(
      bot,
      c?.taskId ?? '',
      submission(c as ClaimedAnalysis, [
        item('trigger', O('End_Done'), B('Start_Manual')),
        item('message', O('Event_Shipped'), B('Event_Paid'), { confidence: 0.4 }),
      ]),
    );
    // An ad-hoc proposal of the token, the same pair proposed by another agent, and a decision.
    expect(
      (
        await post(bot, '/api/v1/projects/revoke/relations', {
          type: 'message',
          from: P('Event_Received'),
          to: B('Event_Paid'),
          confidence: 0.9,
          rationale: 'payment received',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(other, '/api/v1/projects/revoke/relations', {
          type: 'message',
          from: O('Event_Shipped'),
          to: B('Event_Paid'),
          confidence: 0.5,
          rationale: 'other agent',
        })
      ).status,
    ).toBe(200);
    const accepted = await relation('revoke', O('End_Done'), B('Start_Manual'));
    expect(
      (
        await post(owner, `/api/v1/projects/revoke/relations/${accepted?.id}/decision`, {
          verdict: 'accept',
        })
      ).status,
    ).toBe(200);
    const [working] = await claim(bot, { modelKey: BILLING });
    expect(working?.attempt).toBe(1);

    const res = await t.asOwner(`/api/v1/projects/revoke/agent-tokens/${token.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);

    expect(await relation('revoke', P('Event_Received'), B('Event_Paid'))).toBeUndefined();
    expect(await relation('revoke', O('Event_Shipped'), B('Event_Paid'))).toMatchObject({
      status: 'proposed',
      provenance: { rationale: 'other agent' },
    });
    expect(await relation('revoke', O('End_Done'), B('Start_Manual'))).toMatchObject({
      status: 'accepted',
    });
    const [task] = await rows<{ state: string; attempts: number; last_error: string }>(
      `SELECT state, attempts, last_error FROM analysis_task WHERE id = '${working?.taskId}'`,
    );
    expect(task).toMatchObject({ state: 'queued', attempts: 0 });
    expect(task?.last_error).toMatch(/^agent token .* revoked$/);
    const withdrawals = await rows<{ rationale: string; principal_id: string }>(
      `SELECT a.rationale FROM relation_assertion a JOIN project p ON p.id = a.project_id
       WHERE p.key = 'revoke' AND a.kind = 'withdrawal' ORDER BY a.seq`,
    );
    expect(withdrawals).toHaveLength(3);
    // Revoking again changes nothing.
    const again = await t.asOwner(`/api/v1/projects/revoke/agent-tokens/${token.id}`, {
      method: 'DELETE',
    });
    expect(again.status).toBe(204);
    expect(await events('revoke', 'agent_token.revoked')).toEqual(['agent_token.revoked']);
  });
});
