/**
 * Judge each pair once (procedure `proa-relations@0.2.0`, CONCEPT §3)
 * against real PostgreSQL: the claim lists the current agent judgements
 * (`judged`) and the pairs a partner analysis judges (`skip`), and stores the
 * assignment; a submission records proposals with their basis, validates and
 * stores no-links, withdraws only what is stale on the model's side or what
 * the caller replaces, and reports `uncovered`; ingest queues on every facts
 * change and revive; losses (token revocation, `withdraw_proposal`) queue the
 * pairs again; reviewers see live, current no-links on the relation, and the
 * relation's version moves whenever they may change.
 */
import { randomUUID } from 'node:crypto';

import {
  SubmissionResult,
  type BulkDecisionResult,
  type ClaimedRelationsAnalysis,
  type ClaimInput,
  type DeclaredProcedure,
  type ModelPage,
  type Relation,
  type RelationPage,
  type RequeueResult,
  type SubmitAnalysisInput,
} from '@proa/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApp, testClock, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { fakeBpmn, type FakeElement, type FakeModelSpec } from '../support/fake-analysis.ts';
import {
  RELATIONS_PROCEDURE,
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
/** `a/…` sorts before `b/…`: the queued-partner rule hands a pair to the earlier key. */
const SENDER = 'a/sender';
const RECEIVER = 'b/receiver';
const S = (id: string) => `${SENDER}#${id}`;
const R = (id: string) => `${RECEIVER}#${id}`;
/** The two candidate pairs of the sender and the receiver. */
const MESSAGE = { type: 'message', from: S('Event_Sent'), to: R('Start_Received') } as const;
const TRIGGER = { type: 'trigger', from: S('End_Done'), to: R('Start_Manual') } as const;

function sender(extra: { doc?: string; elements?: FakeElement[] } = {}): FakeModelSpec {
  return {
    processes: [
      {
        id: 'Process_Send',
        name: 'Versand',
        elements: [
          {
            kind: 'msg_throw',
            id: 'Event_Sent',
            name: 'Ware versandt',
            ref: 'WareVersandt',
            ...(extra.doc === undefined ? {} : { doc: extra.doc }),
          },
          { kind: 'evt_end', id: 'End_Done', name: 'Auftrag erledigt' },
          ...(extra.elements ?? []),
        ],
      },
    ],
  };
}

function receiver(extra: FakeElement[] = []): FakeModelSpec {
  return {
    processes: [
      {
        id: 'Process_Receive',
        name: 'Empfang',
        elements: [
          {
            kind: 'msg_catch',
            id: 'Start_Received',
            name: 'Ware versandt',
            ref: 'WareVersandt',
            elementType: 'bpmn:StartEvent',
          },
          { kind: 'evt_start', id: 'Start_Manual', name: 'Auftrag erledigt' },
          ...extra,
        ],
      },
    ],
  };
}

let database: TestDatabase;
let t: TestApp;
const clock = testClock(new Date('2026-10-08T08:00:00.000Z'));
const owner: Caller = (path, init) => t.asOwner(path, init);

async function rows<T>(query: string): Promise<T[]> {
  return (await database.db.execute(sql.raw(query))).rows as T[];
}

/** A project with the sender and the receiver (both queued). */
async function seed(project: string, keys: readonly [string, string] = [SENDER, RECEIVER]) {
  await t.createProject(project);
  expect((await t.putModel(project, keys[0], fakeBpmn(sender()))).status).toBe(201);
  expect((await t.putModel(project, keys[1], fakeBpmn(receiver()))).status).toBe(201);
}

async function agentOf(project: string): Promise<Caller> {
  return asAgent(t, (await t.createToken(project, ['proa:read', 'proa:propose'])).secret);
}

async function claimOf(caller: Caller, project: string, modelKey: string) {
  const [c] = await claim(caller, { projectId: project, modelKey });
  if (!c) throw new Error(`no task for ${modelKey}`);
  return c;
}

const keyOf = (p: { type: string; from: string; to: string }) => `${p.type} ${p.from} ${p.to}`;

/** The typed pairs a claim input offers as candidates. */
const candidatesOf = (input: ClaimInput) =>
  input.candidates.map(([type, from, to]) => keyOf({ type, from, to }));

/** The typed pairs of `judged`, link verdicts resolved through `relations`. */
function judgedOf(input: ClaimInput): string[] {
  return (input.judged ?? []).map((j) => {
    if (!('relation' in j)) return keyOf(j);
    const r = input.relations.find((x) => x.id === j.relation);
    if (!r) throw new Error(`judged relation ${j.relation} is not in relations`);
    return keyOf(r);
  });
}

const noLink = (p: { type: string; from: string; to: string }, reason = 'no-evidence: nein') => ({
  ...p,
  reason,
});

function body(
  c: Pick<ClaimedRelationsAnalysis, 'leaseToken'>,
  relations: ReturnType<typeof item>[],
  noLinks: ReturnType<typeof noLink>[] = [],
  procedure: DeclaredProcedure = RELATIONS_PROCEDURE,
): SubmitAnalysisInput {
  return { ...submission(c, relations), noLinks, procedure };
}

/** The live relation of a pair, obsolete included. */
async function relationOf(project: string, pair: { from: string; to: string }) {
  const res = await t.asOwner(`/api/v1/projects/${project}/relations?limit=200`);
  const live = ((await res.json()) as RelationPage).items;
  const obsolete = (
    (await (
      await t.asOwner(`/api/v1/projects/${project}/relations?limit=200&status=obsolete`)
    ).json()) as RelationPage
  ).items;
  return [...live, ...obsolete].find((r) => r.from === pair.from && r.to === pair.to);
}

/** The live no-links on a typed pair, oldest first. */
async function liveNoLinks(project: string, pair: { type: string; from: string; to: string }) {
  return rows<{ id: string; from_hash: string; to_hash: string; principal_id: string }>(
    `SELECT n.id, n.from_hash, n.to_hash, n.principal_id FROM no_link n
     JOIN project p ON p.id = n.project_id
     WHERE p.key = '${project}' AND n.type = '${pair.type}' AND n.from_ref = '${pair.from}'
       AND n.to_ref = '${pair.to}'
       AND NOT EXISTS (SELECT 1 FROM no_link_withdrawal w WHERE w.no_link_id = n.id)
     ORDER BY n.seq, n.id`,
  );
}

async function headHash(project: string, modelKey: string): Promise<string> {
  const [row] = await rows<{ facts_hash: string }>(
    `SELECT r.facts_hash FROM model m JOIN project p ON p.id = m.project_id
     JOIN model_revision r ON r.id = m.head_revision_id
     WHERE p.key = '${project}' AND m.key = '${modelKey}'`,
  );
  if (!row) throw new Error(`no head of ${modelKey}`);
  return row.facts_hash;
}

/** The basis of the live agent proposal stances on a pair (each principal's latest assertion). */
async function proposalBases(project: string, pair: { type: string; from: string; to: string }) {
  const latest = await rows<{ kind: string; from_hash: string | null; to_hash: string | null }>(
    `SELECT DISTINCT ON (a.principal_id) a.kind, a.from_hash, a.to_hash
     FROM relation_assertion a JOIN relation r ON r.id = a.relation_id
     JOIN project p ON p.id = a.project_id
     WHERE p.key = '${project}' AND r.type = '${pair.type}' AND r.from_ref = '${pair.from}'
       AND r.to_ref = '${pair.to}' AND a.source_kind <> 'rule' AND a.kind <> 'note'
     ORDER BY a.principal_id, a.seq DESC`,
  );
  return latest
    .filter((a) => a.kind === 'proposal')
    .map((a) => ({ from_hash: a.from_hash, to_hash: a.to_hash }));
}

async function openTasks(project: string): Promise<Record<string, string>> {
  const list = await rows<{ key: string; state: string; requeue_after: boolean }>(
    `SELECT m.key, t.state, t.requeue_after FROM analysis_task t JOIN model m ON m.id = t.model_id
     JOIN project p ON p.id = t.project_id
     WHERE p.key = '${project}' AND t.state IN ('queued', 'claimed') ORDER BY m.key`,
  );
  return Object.fromEntries(
    list.map((x) => [x.key, x.state + (x.requeue_after ? ' requeue_after' : '')]),
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database, { clock });
});

afterAll(async () => {
  await database.drop();
});

describe('judge each pair once across two models, one after the other', () => {
  it('lists the first analysis’s judgements for the second, which judges nothing again', async () => {
    await seed('seq');
    const agent = await agentOf('seq');
    const first = await claimOf(agent, 'seq', SENDER);
    expect(candidatesOf(first.input).sort()).toEqual([keyOf(MESSAGE), keyOf(TRIGGER)].sort());
    expect(first.input.judged).toBeUndefined();
    expect(first.input.skip).toBeUndefined();
    const r1 = await submit(
      agent,
      first.taskId,
      body(first, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)], [noLink(TRIGGER)]),
    );
    expect(r1.items.map((i) => i.result)).toEqual(['applied']);
    expect(r1.noLinks).toEqual({
      items: [{ index: 0, result: 'stored' }],
      counts: { stored: 1, duplicate: 0, invalid: 0 },
    });
    expect(r1).toMatchObject({ withdrawn: 0, withdrawnNoLinks: 0, uncovered: { count: 0 } });

    const second = await claimOf(agent, 'seq', RECEIVER);
    expect(judgedOf(second.input).sort()).toEqual([keyOf(MESSAGE), keyOf(TRIGGER)].sort());
    expect(second.input.judged).toContainEqual({
      ...TRIGGER,
      origin: SENDER,
      by: 'agent:test proa:read proa:propose',
      mine: true,
      reason: 'no-evidence: nein',
    });
    expect(second.input.judged).toContainEqual(
      expect.objectContaining({
        origin: SENDER,
        mine: true,
        relation: expect.any(String) as unknown,
      }),
    );
    // Each pair is listed once: the judged pairs are no candidates any more.
    expect(candidatesOf(second.input)).toEqual([]);
    const r2 = await submit(agent, second.taskId, body(second, []));
    expect(r2).toMatchObject({
      withdrawn: 0,
      withdrawnNoLinks: 0,
      uncovered: { count: 0, pairs: [] },
    });
    const message = await relationOf('seq', MESSAGE);
    expect(message).toMatchObject({ status: 'proposed', source: 'agent' });
    // The basis: both models as the first claim saw them.
    expect(await proposalBases('seq', MESSAGE)).toMatchObject([
      { from_hash: await headHash('seq', SENDER), to_hash: await headHash('seq', RECEIVER) },
    ]);
  });
});

async function requeue(project: string, modelKeys: string[]): Promise<RequeueResult> {
  const res = await post(owner, `/api/v1/projects/${project}/analyses/requeue`, { modelKeys });
  expect(res.status).toBe(200);
  return (await res.json()) as RequeueResult;
}

async function modelId(project: string, key: string): Promise<string> {
  const res = await t.asOwner(`/api/v1/projects/${project}/models?limit=200`);
  const found = ((await res.json()) as ModelPage).items.find((m) => m.key === key);
  if (!found) throw new Error(`no model ${key}`);
  return found.id;
}

/** A sender with one more element: other facts, the same endpoint fingerprints. */
const senderV2 = () => sender({ elements: [{ kind: 'task', id: 'Task_New', name: 'Neu' }] });
const receiverV2 = () => receiver([{ kind: 'task', id: 'Task_New', name: 'Neu' }]);

describe('the assignment at the claim', () => {
  it('hands a pair to the queued partner with the earlier key', async () => {
    await seed('queued');
    const agent = await agentOf('queued');
    const later = await claimOf(agent, 'queued', RECEIVER);
    // The sender sorts first, is queued and has both pairs among its candidates: it judges them.
    expect(later.input.skip).toEqual([
      { ...TRIGGER, model: SENDER, reason: 'queued' },
      { ...MESSAGE, model: SENDER, reason: 'queued' },
    ]);
    expect(candidatesOf(later.input)).toEqual([]);
    const earlier = await claimOf(agent, 'queued', SENDER);
    expect(earlier.input.skip).toBeUndefined();
    expect(candidatesOf(earlier.input).sort()).toEqual([keyOf(MESSAGE), keyOf(TRIGGER)].sort());
    const [stored] = await rows<{ assignment: unknown[]; claimed_seq: string }>(
      `SELECT assignment, claimed_seq FROM analysis_task WHERE id = '${earlier.taskId}'`,
    );
    expect(stored?.assignment).toEqual([MESSAGE, TRIGGER]);
    expect(Number(stored?.claimed_seq)).toBeGreaterThan(0);
    const r1 = await submit(
      agent,
      earlier.taskId,
      body(earlier, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)], [noLink(TRIGGER)]),
    );
    const r2 = await submit(agent, later.taskId, body(later, []));
    expect([r1.uncovered, r2.uncovered]).toEqual([
      { count: 0, pairs: [] },
      { count: 0, pairs: [] },
    ]);
  });

  it('assigns no compatible pair: it stays a candidate, never uncovered, until a verdict lists it', async () => {
    // One more catch without lexical evidence: a `compatible` pair of the sender's throw.
    const PAID = { type: 'message', from: S('Event_Sent'), to: R('Catch_Paid') } as const;
    const paid: FakeElement = {
      kind: 'msg_catch',
      id: 'Catch_Paid',
      name: 'Zahlung eingegangen',
      ref: 'ZahlungEingegangen',
    };
    for (const project of ['compatible', 'compatible-judged']) {
      await t.createProject(project);
      expect((await t.putModel(project, SENDER, fakeBpmn(sender()))).status).toBe(201);
      expect((await t.putModel(project, RECEIVER, fakeBpmn(receiver([paid])))).status).toBe(201);
    }

    // Nobody examines it: neither analysis is assigned it, so neither leaves it uncovered.
    const a = await agentOf('compatible');
    const later = await claimOf(a, 'compatible', RECEIVER);
    // The queued sender sorts first and takes the key and lexical pairs, not the compatible one.
    expect(later.input.skip?.map(keyOf).sort()).toEqual([keyOf(MESSAGE), keyOf(TRIGGER)].sort());
    expect(later.input.candidates).toEqual([
      [PAID.type, PAID.from, PAID.to, 'compatible', expect.any(Number)],
    ]);
    const earlier = await claimOf(a, 'compatible', SENDER);
    expect(candidatesOf(earlier.input).sort()).toEqual(
      [keyOf(MESSAGE), keyOf(TRIGGER), keyOf(PAID)].sort(),
    );
    const [stored] = await rows<{ assignment: unknown[] }>(
      `SELECT assignment FROM analysis_task WHERE id = '${earlier.taskId}'`,
    );
    expect(stored?.assignment).toEqual([MESSAGE, TRIGGER]);
    const r1 = await submit(
      a,
      earlier.taskId,
      body(earlier, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)], [noLink(TRIGGER)]),
    );
    const r2 = await submit(a, later.taskId, body(later, []));
    expect([r1.uncovered, r2.uncovered]).toEqual([
      { count: 0, pairs: [] },
      { count: 0, pairs: [] },
    ]);

    // The sender examines it in its partner search: its verdict spares the receiver the pair.
    const b = await agentOf('compatible-judged');
    const x = await claimOf(b, 'compatible-judged', SENDER);
    const r3 = await submit(
      b,
      x.taskId,
      body(x, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)], [noLink(TRIGGER), noLink(PAID)]),
    );
    expect(r3.noLinks?.counts).toEqual({ stored: 2, duplicate: 0, invalid: 0 });
    const y = await claimOf(b, 'compatible-judged', RECEIVER);
    expect(judgedOf(y.input).sort()).toEqual([keyOf(MESSAGE), keyOf(TRIGGER), keyOf(PAID)].sort());
    expect(candidatesOf(y.input)).toEqual([]);
  });

  it('assigns a relation on a compatible pair to exactly one of two concurrent claims', async () => {
    // A catch without lexical evidence: the sender's throw and it are a `compatible` pair.
    const PAID = { type: 'message', from: S('Event_Sent'), to: R('Catch_Paid') } as const;
    const paid: FakeElement = {
      kind: 'msg_catch',
      id: 'Catch_Paid',
      name: 'Zahlung eingegangen',
      ref: 'ZahlungEingegangen',
    };
    const extra: FakeElement = { kind: 'task', id: 'Task_New', name: 'Neu' };
    const all = [MESSAGE, TRIGGER, PAID].map(keyOf).sort();
    const assignmentOf = async (taskId: string) => {
      const [stored] = await rows<{ assignment: { type: string; from: string; to: string }[] }>(
        `SELECT assignment FROM analysis_task WHERE id = '${taskId}'`,
      );
      return (stored?.assignment ?? []).map(keyOf).sort();
    };
    for (const project of ['relation-two', 'relation-one-call']) {
      await t.createProject(project);
      expect((await t.putModel(project, SENDER, fakeBpmn(sender()))).status).toBe(201);
      expect((await t.putModel(project, RECEIVER, fakeBpmn(receiver([paid])))).status).toBe(201);
      // The sender's partner search proposes the compatible pair: a semantic relation.
      const a = await agentOf(project);
      const x = await claimOf(a, project, SENDER);
      const r = await submit(
        a,
        x.taskId,
        body(
          x,
          [item(MESSAGE.type, MESSAGE.from, MESSAGE.to), item(PAID.type, PAID.from, PAID.to)],
          [noLink(TRIGGER)],
        ),
      );
      expect(r.items.map((i) => i.result)).toEqual(['applied', 'applied']);
      const y = await claimOf(a, project, RECEIVER);
      await submit(a, y.taskId, body(y, []));
      expect(await relationOf(project, PAID)).toMatchObject({
        status: 'proposed',
        tier: 'semantic',
      });
      // Both models change: no judgement is current any more.
      const revised = fakeBpmn(sender({ elements: [extra] }));
      expect((await t.putModel(project, SENDER, revised)).status).toBe(200);
      expect((await t.putModel(project, RECEIVER, fakeBpmn(receiver([paid, extra])))).status).toBe(
        200,
      );
    }

    // Two agents claim both models at once.
    const a = await agentOf('relation-two');
    const b = await agentOf('relation-two');
    const x = await claimOf(a, 'relation-two', SENDER);
    // Still a compatible candidate here, but a relation: assigned like a systematic pair.
    expect(x.input.candidates).toContainEqual([
      PAID.type,
      PAID.from,
      PAID.to,
      'compatible',
      expect.any(Number),
    ]);
    expect(await assignmentOf(x.taskId)).toEqual(all);
    const y = await claimOf(b, 'relation-two', RECEIVER);
    expect(y.input.skip?.map(keyOf).sort()).toEqual(all);
    expect(y.input.skip?.every((p) => p.model === SENDER && p.reason === 'claimed')).toBe(true);
    expect(candidatesOf(y.input)).toEqual([]);
    expect(await assignmentOf(y.taskId)).toEqual([]);
    // Leaving the relation out shows as uncovered; the receiver owes nothing.
    const rx = await submit(
      a,
      x.taskId,
      body(x, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)], [noLink(TRIGGER)]),
    );
    expect(rx.uncovered).toEqual({ count: 1, pairs: [PAID] });
    const ry = await submit(b, y.taskId, body(y, []));
    expect(ry.uncovered).toEqual({ count: 0, pairs: [] });

    // One claim call for both: the later task sees the earlier one's assignment.
    const c = await agentOf('relation-one-call');
    const both = await claim(c, { projectId: 'relation-one-call', max: 2 });
    const xs = both.find((i) => i.modelKey === SENDER);
    const ys = both.find((i) => i.modelKey === RECEIVER);
    if (!xs || !ys) throw new Error('expected both tasks');
    expect(await assignmentOf(xs.taskId)).toEqual(all);
    expect(ys.input.skip?.map(keyOf).sort()).toEqual(all);
    expect(await assignmentOf(ys.taskId)).toEqual([]);
  });

  it('skips what a claimed partner holds; releasing and claiming either side again loses nothing', async () => {
    await seed('claimed');
    const a = await agentOf('claimed');
    const b = await agentOf('claimed');
    const x = await claimOf(a, 'claimed', SENDER);
    expect(candidatesOf(x.input)).toHaveLength(2);
    let y = await claimOf(b, 'claimed', RECEIVER);
    const held = [
      { ...TRIGGER, model: SENDER, reason: 'claimed' },
      { ...MESSAGE, model: SENDER, reason: 'claimed' },
    ];
    expect(y.input.skip).toEqual(held);
    // The receiver is handed back and claimed again while the sender works: still skipped.
    expect((await release(b, y.taskId, y.leaseToken)).status).toBe(200);
    y = await claimOf(b, 'claimed', RECEIVER);
    expect(y.input.skip).toEqual(held);
    // The sender is handed back and claimed again: the receiver skipped the pairs, so it judges them.
    expect((await release(a, x.taskId, x.leaseToken)).status).toBe(200);
    const x2 = await claimOf(a, 'claimed', SENDER);
    expect(x2.input.skip).toBeUndefined();
    expect(candidatesOf(x2.input)).toHaveLength(2);
    const r1 = await submit(
      a,
      x2.taskId,
      body(x2, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)], [noLink(TRIGGER)]),
    );
    const r2 = await submit(b, y.taskId, body(y, []));
    expect([r1.uncovered?.count, r2.uncovered?.count]).toEqual([0, 0]);
  });

  it('lets a claim judge what an expired lease held; claimed again, that task skips it', async () => {
    await seed('expiry');
    const a = await agentOf('expiry');
    const b = await agentOf('expiry');
    const x = await claimOf(a, 'expiry', SENDER);
    clock.advance(16 * MINUTE);
    const y = await claimOf(b, 'expiry', RECEIVER);
    expect(y.input.skip).toBeUndefined();
    expect(candidatesOf(y.input)).toHaveLength(2);
    const again = await claimOf(a, 'expiry', SENDER);
    expect(again).toMatchObject({ taskId: x.taskId, attempt: 2 });
    expect(again.input.skip?.map((s) => [s.model, s.reason])).toEqual([
      [RECEIVER, 'claimed'],
      [RECEIVER, 'claimed'],
    ]);
    expect(candidatesOf(again.input)).toEqual([]);
  });

  it('judges a pair against a partner version uploaded after the claim that was assigned it', async () => {
    await seed('upload-partner');
    const a = await agentOf('upload-partner');
    const b = await agentOf('upload-partner');
    const x = await claimOf(a, 'upload-partner', SENDER);
    expect((await t.putModel('upload-partner', RECEIVER, fakeBpmn(receiverV2()))).status).toBe(200);
    // The sender's claim saw the old receiver; its judgements would not be current.
    const y = await claimOf(b, 'upload-partner', RECEIVER);
    expect(y.input.skip).toBeUndefined();
    expect(candidatesOf(y.input)).toHaveLength(2);
    const verdicts = (c: ClaimedRelationsAnalysis) =>
      body(c, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)], [noLink(TRIGGER)]);
    await submit(a, x.taskId, verdicts(x));
    // The receiver's submission withdraws the sender's judgements on the old receiver.
    const ry = await submit(b, y.taskId, verdicts(y));
    expect(ry).toMatchObject({ withdrawn: 1, withdrawnNoLinks: 1 });
    expect(await proposalBases('upload-partner', MESSAGE)).toEqual([
      {
        from_hash: await headHash('upload-partner', SENDER),
        to_hash: await headHash('upload-partner', RECEIVER),
      },
    ]);
    await requeue('upload-partner', [SENDER]);
    const check = await claimOf(a, 'upload-partner', SENDER);
    expect(check.input.judged?.map((j) => j.origin)).toEqual([RECEIVER, RECEIVER]);
  });

  it('judges a pair against a claimant version uploaded after the partner’s claim', async () => {
    await seed('upload-self');
    const a = await agentOf('upload-self');
    const b = await agentOf('upload-self');
    await claimOf(a, 'upload-self', SENDER);
    const y = await claimOf(b, 'upload-self', RECEIVER);
    expect(y.input.skip).toHaveLength(2);
    // The sender changes: its claim is cancelled, and the new one judges the pairs.
    expect((await t.putModel('upload-self', SENDER, fakeBpmn(senderV2()))).status).toBe(200);
    const x2 = await claimOf(a, 'upload-self', SENDER);
    expect(x2.input.skip).toBeUndefined();
    expect(candidatesOf(x2.input)).toHaveLength(2);
    await submit(
      a,
      x2.taskId,
      body(x2, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)], [noLink(TRIGGER)]),
    );
    const ry = await submit(b, y.taskId, body(y, []));
    expect(ry.uncovered).toEqual({ count: 0, pairs: [] });
    expect(await proposalBases('upload-self', MESSAGE)).toEqual([
      {
        from_hash: await headHash('upload-self', SENDER),
        to_hash: await headHash('upload-self', RECEIVER),
      },
    ]);
  });
});

describe('disagreements stay visible', () => {
  async function disagree(project: string, sameToken: boolean) {
    await seed(project);
    const a = await agentOf(project);
    const b = sameToken ? a : await agentOf(project);
    const x = await claimOf(a, project, SENDER);
    await submit(
      a,
      x.taskId,
      body(x, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)], [noLink(TRIGGER)]),
    );
    const y = await claimOf(b, project, RECEIVER);
    expect(y.input.judged?.every((j) => (j.mine === true) === sameToken)).toBe(true);
    const ry = await submit(
      b,
      y.taskId,
      body(y, [], [noLink(MESSAGE, 'near-miss: „versandt“ ist hier ein anderes Ereignis.')]),
    );
    expect(ry.noLinks?.items).toEqual([{ index: 0, result: 'stored' }]);
    expect(ry).toMatchObject({ withdrawn: 0, withdrawnNoLinks: 0 });
    const expected = {
      status: 'proposed',
      source: 'agent',
      noLinks: [
        {
          id: expect.stringMatching(/^nlk_/) as unknown,
          handle: 'agent:test proa:read proa:propose',
          origin: RECEIVER,
          reason: 'near-miss: „versandt“ ist hier ein anderes Ereignis.',
          at: expect.any(String) as unknown,
        },
      ],
    };
    expect(await relationOf(project, MESSAGE)).toMatchObject(expected);
    // A requeue of either side keeps both judgements.
    for (const key of [SENDER, RECEIVER]) {
      await requeue(project, [key]);
      const c = await claimOf(key === SENDER ? a : b, project, key);
      expect(judgedOf(c.input).filter((k) => k === keyOf(MESSAGE))).toHaveLength(2);
      const r = await submit(key === SENDER ? a : b, c.taskId, body(c, []));
      expect(r).toMatchObject({ withdrawn: 0, withdrawnNoLinks: 0 });
    }
    expect(await relationOf(project, MESSAGE)).toMatchObject(expected);
    // Only current no-links show: after a new receiver version, none (until it is analysed).
    expect((await t.putModel(project, RECEIVER, fakeBpmn(receiverV2()))).status).toBe(200);
    expect((await relationOf(project, MESSAGE))?.noLinks).toEqual([]);
  }

  it('another principal’s no-link against a link', async () => {
    await disagree('disagree', false);
  });

  it('the same principal from another model’s analysis (one token)', async () => {
    await disagree('one-token', true);
  });

  it('the same principal changing its mind in a re-analysis of the same model replaces itself', async () => {
    await seed('mind');
    const a = await agentOf('mind');
    const x = await claimOf(a, 'mind', SENDER);
    await submit(
      a,
      x.taskId,
      body(x, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)], [noLink(TRIGGER)]),
    );
    await requeue('mind', [SENDER]);
    const x2 = await claimOf(a, 'mind', SENDER);
    expect(judgedOf(x2.input)).toContain(keyOf(MESSAGE));
    const r2 = await submit(a, x2.taskId, body(x2, [], [noLink(MESSAGE)]));
    expect(r2).toMatchObject({ withdrawn: 1, withdrawnNoLinks: 0 });
    // The rule tier's key proposal keeps the relation open; the agent objects.
    expect(await relationOf('mind', MESSAGE)).toMatchObject({
      status: 'proposed',
      source: 'rule',
      noLinks: [{ origin: SENDER, reason: 'no-evidence: nein' }],
    });
    await requeue('mind', [SENDER]);
    const x3 = await claimOf(a, 'mind', SENDER);
    const r3 = await submit(a, x3.taskId, body(x3, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)]));
    expect(r3).toMatchObject({ withdrawn: 0, withdrawnNoLinks: 1 });
    expect(await relationOf('mind', MESSAGE)).toMatchObject({ source: 'agent', noLinks: [] });
  });

  it('a no-link answered duplicate also replaces the caller’s own proposal from this model’s analysis', async () => {
    await seed('mind-duplicate');
    const a = await agentOf('mind-duplicate');
    const x = await claimOf(a, 'mind-duplicate', SENDER);
    await submit(
      a,
      x.taskId,
      body(x, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)], [noLink(TRIGGER)]),
    );
    // The same token contradicts itself from the receiver's analysis: both stay.
    const y = await claimOf(a, 'mind-duplicate', RECEIVER);
    const ry = await submit(a, y.taskId, body(y, [], [noLink(MESSAGE)]));
    expect(ry.noLinks?.items).toEqual([{ index: 0, result: 'stored' }]);
    expect(ry).toMatchObject({ withdrawn: 0, withdrawnNoLinks: 0 });
    // Re-analysing the sender, it no-links the pair: a duplicate of its receiver no-link,
    // which still replaces its own sender proposal.
    await requeue('mind-duplicate', [SENDER]);
    const x2 = await claimOf(a, 'mind-duplicate', SENDER);
    const r2 = await submit(a, x2.taskId, body(x2, [], [noLink(MESSAGE)]));
    expect(r2.noLinks?.items).toEqual([{ index: 0, result: 'duplicate' }]);
    expect(r2).toMatchObject({ withdrawn: 1, withdrawnNoLinks: 0 });
    expect(await relationOf('mind-duplicate', MESSAGE)).toMatchObject({
      status: 'proposed',
      source: 'rule',
      noLinks: [{ origin: RECEIVER }],
    });
  });
});

describe('a new version of a model', () => {
  it('a doc-only change: the re-analysis judges the pairs again; an identical repeat gets the new basis', async () => {
    await seed('doc');
    const a = await agentOf('doc');
    const b = await agentOf('doc');
    const verdicts = (c: ClaimedRelationsAnalysis) =>
      body(
        c,
        [item(MESSAGE.type, MESSAGE.from, MESSAGE.to, { rationale: 'gleiche Nachricht' })],
        [noLink(TRIGGER)],
      );
    const x = await claimOf(a, 'doc', SENDER);
    await submit(a, x.taskId, verdicts(x));
    const y = await claimOf(b, 'doc', RECEIVER);
    await submit(b, y.taskId, body(y, []));
    const before = await headHash('doc', SENDER);
    expect(
      (await t.putModel('doc', SENDER, fakeBpmn(sender({ doc: 'Versendet die Ware.' })))).status,
    ).toBe(200);
    expect(await relationOf('doc', MESSAGE)).toMatchObject({ endpointState: 'ok' });
    const x2 = await claimOf(a, 'doc', SENDER);
    expect(x2.input.judged).toBeUndefined();
    expect(candidatesOf(x2.input)).toHaveLength(2);
    const r = await submit(a, x2.taskId, verdicts(x2));
    expect(r.items.map((i) => [i.result, i.status])).toEqual([['applied', 'proposed']]);
    expect(r).toMatchObject({
      withdrawn: 0,
      noLinks: { counts: { stored: 1, duplicate: 0, invalid: 0 } },
      withdrawnNoLinks: 1,
    });
    const after = await headHash('doc', SENDER);
    expect(after).not.toBe(before);
    expect(await proposalBases('doc', MESSAGE)).toEqual([
      { from_hash: after, to_hash: await headHash('doc', RECEIVER) },
    ]);
    expect(await liveNoLinks('doc', TRIGGER)).toMatchObject([{ from_hash: after }]);
    // The receiver, analysed again, finds both pairs judged.
    await requeue('doc', [RECEIVER]);
    const y2 = await claimOf(b, 'doc', RECEIVER);
    expect(judgedOf(y2.input).sort()).toEqual([keyOf(MESSAGE), keyOf(TRIGGER)].sort());
  });

  it('a revert X1 → X2 → X1 with a partner analysis in between: X is queued and judges against X1', async () => {
    // The receiver sorts first here, so it judges the pairs while the sender is queued.
    const X = 'c/sender';
    const Y = 'a/receiver';
    const msg = { type: 'message', from: `${X}#Event_Sent`, to: `${Y}#Start_Received` } as const;
    const trg = { type: 'trigger', from: `${X}#End_Done`, to: `${Y}#Start_Manual` } as const;
    await seed('revert', [X, Y]);
    const a = await agentOf('revert');
    const b = await agentOf('revert');
    const verdicts = (c: ClaimedRelationsAnalysis) =>
      body(c, [item(msg.type, msg.from, msg.to)], [noLink(trg)]);
    const y = await claimOf(a, 'revert', Y);
    await submit(a, y.taskId, verdicts(y));
    const x = await claimOf(b, 'revert', X);
    expect(candidatesOf(x.input)).toEqual([]);
    await submit(b, x.taskId, body(x, []));
    const v1 = await headHash('revert', X);

    expect((await t.putModel('revert', X, fakeBpmn(senderV2()))).status).toBe(200);
    await requeue('revert', [Y]);
    const y2 = await claimOf(a, 'revert', Y);
    expect(candidatesOf(y2.input)).toHaveLength(2);
    await submit(a, y2.taskId, verdicts(y2));

    // Back to the first version: queued, although a done task analysed these facts.
    expect((await t.putModel('revert', X, fakeBpmn(sender()))).status).toBe(200);
    expect(await openTasks('revert')).toEqual({ [X]: 'queued' });
    const x2 = await claimOf(b, 'revert', X);
    expect(candidatesOf(x2.input)).toHaveLength(2);
    const r = await submit(b, x2.taskId, verdicts(x2));
    expect(r).toMatchObject({ withdrawn: 1, withdrawnNoLinks: 1 });
    expect(await proposalBases('revert', msg)).toEqual([
      { from_hash: v1, to_hash: await headHash('revert', Y) },
    ]);
    expect(await liveNoLinks('revert', trg)).toMatchObject([{ from_hash: v1 }]);
  });

  it('delete Y, change and analyse X, revive Y unchanged: Y is queued and judges the pairs', async () => {
    await seed('revive');
    const a = await agentOf('revive');
    const x = await claimOf(a, 'revive', SENDER);
    await submit(
      a,
      x.taskId,
      body(x, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)], [noLink(TRIGGER)]),
    );
    const y = await claimOf(a, 'revive', RECEIVER);
    await submit(a, y.taskId, body(y, []));
    const res = await t.asOwner(
      `/api/v1/projects/revive/models/${await modelId('revive', RECEIVER)}`,
      {
        method: 'DELETE',
      },
    );
    expect(res.status).toBe(204);
    expect((await t.putModel('revive', SENDER, fakeBpmn(senderV2()))).status).toBe(200);
    const x2 = await claimOf(a, 'revive', SENDER);
    expect(candidatesOf(x2.input)).toEqual([]);
    const r = await submit(a, x2.taskId, body(x2, []));
    expect(r).toMatchObject({ withdrawn: 1, withdrawnNoLinks: 1 });
    // The receiver comes back unchanged: queued anyway, and it judges the pairs.
    expect((await t.putModel('revive', RECEIVER, fakeBpmn(receiver()))).status).toBe(201);
    expect(await openTasks('revive')).toEqual({ [RECEIVER]: 'queued' });
    const y2 = await claimOf(a, 'revive', RECEIVER);
    expect(candidatesOf(y2.input)).toHaveLength(2);
  });

  it('a procedure release: after a requeue every pair is judged once more', async () => {
    await seed('release');
    const token = await t.createToken('release', ['proa:read', 'proa:propose']);
    const a = asAgent(t, token.secret);
    const verdicts = (c: ClaimedRelationsAnalysis, procedure: DeclaredProcedure) =>
      body(c, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)], [noLink(TRIGGER)], procedure);
    const x = await claimOf(a, 'release', SENDER);
    await submit(a, x.taskId, verdicts(x, RELATIONS_PROCEDURE));
    const y = await claimOf(a, 'release', RECEIVER);
    await submit(a, y.taskId, body(y, []));

    const next: DeclaredProcedure = { id: RELATIONS_PROCEDURE.id, version: '9.9.9' };
    const released = startTestApp(database, { clock, expectedProcedure: () => next });
    const a2 = asAgent(released, token.secret);
    const res = await released.asOwner('/api/v1/projects/release/analyses/requeue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    expect(res.status).toBe(200);
    // Nothing is current under the new procedure: the relation shows no objection either.
    const [x2] = await claim(a2, { projectId: 'release', modelKey: SENDER });
    expect(x2?.procedure).toEqual(next);
    expect(x2?.input.judged).toBeUndefined();
    expect(candidatesOf(x2?.input as ClaimInput)).toHaveLength(2);
    const r = await submit(a2, x2?.taskId ?? '', verdicts(x2 as ClaimedRelationsAnalysis, next));
    expect(r.items.map((i) => i.result)).toEqual(['applied']);
    expect(r).toMatchObject({ withdrawn: 0, withdrawnNoLinks: 1 });
    const [y2] = await claim(a2, { projectId: 'release', modelKey: RECEIVER });
    expect(judgedOf(y2?.input as ClaimInput).sort()).toEqual(
      [keyOf(MESSAGE), keyOf(TRIGGER)].sort(),
    );
    expect(candidatesOf(y2?.input as ClaimInput)).toEqual([]);
  });
});

describe('held pairs', () => {
  it('a held pair the sender confirms is its judgement: the receiver skips it, the hold stays', async () => {
    await seed('held');
    const token = await t.createToken('held', ['proa:read', 'proa:propose']);
    const a = asAgent(t, token.secret);
    const x = await claimOf(a, 'held', SENDER);
    await submit(
      a,
      x.taskId,
      body(x, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)], [noLink(TRIGGER)]),
    );
    const y = await claimOf(a, 'held', RECEIVER);
    await submit(a, y.taskId, body(y, []));
    const message = (await relationOf('held', MESSAGE)) as Relation;
    const hold = await post(owner, `/api/v1/projects/held/relations/${message.id}/decision`, {
      verdict: 'hold',
      note: 'Fachbereich fragen',
    });
    expect(hold.status).toBe(200);

    // A procedure release and a requeue of both models: no judgement is current.
    const next: DeclaredProcedure = { id: RELATIONS_PROCEDURE.id, version: '9.9.9' };
    const released = startTestApp(database, { clock, expectedProcedure: () => next });
    const a2 = asAgent(released, token.secret);
    const res = await released.asOwner('/api/v1/projects/held/analyses/requeue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    expect(res.status).toBe(200);
    const [x2] = await claim(a2, { projectId: 'held', modelKey: SENDER });
    if (!x2) throw new Error('no sender task');
    expect(candidatesOf(x2.input)).toContain(keyOf(MESSAGE));
    // The sender confirms the held pair (procedure §10): recorded, the hold stays in force.
    const r = await submit(
      a2,
      x2.taskId,
      body(
        x2,
        [item(MESSAGE.type, MESSAGE.from, MESSAGE.to, { rationale: 'bestätigt' })],
        [noLink(TRIGGER)],
        next,
      ),
    );
    expect(r.items.map((i) => [i.result, i.status])).toEqual([['applied', 'held']]);
    expect(r).toMatchObject({ withdrawn: 0, withdrawnNoLinks: 1, uncovered: { count: 0 } });
    expect(await relationOf('held', MESSAGE)).toMatchObject({ status: 'held', source: 'human' });
    expect(await proposalBases('held', MESSAGE)).toEqual([
      { from_hash: await headHash('held', SENDER), to_hash: await headHash('held', RECEIVER) },
    ]);
    // The receiver finds both pairs judged and owes nothing.
    const [y2] = await claim(a2, { projectId: 'held', modelKey: RECEIVER });
    if (!y2) throw new Error('no receiver task');
    expect(judgedOf(y2.input).sort()).toEqual([keyOf(MESSAGE), keyOf(TRIGGER)].sort());
    expect(candidatesOf(y2.input)).toEqual([]);
    const [stored] = await rows<{ assignment: unknown[] }>(
      `SELECT assignment FROM analysis_task WHERE id = '${y2.taskId}'`,
    );
    expect(stored?.assignment).toEqual([]);
    const ry = await submit(a2, y2.taskId, body(y2, [], [], next));
    expect(ry.uncovered).toEqual({ count: 0, pairs: [] });
    expect(await relationOf('held', MESSAGE)).toMatchObject({ status: 'held' });
  });
});

describe('losses queue the pairs again', () => {
  it('revoking a token withdraws its no-links and queues both endpoint models', async () => {
    const THIRD = 'c/third';
    await seed('revoke-nl');
    expect((await t.putModel('revoke-nl', THIRD, fakeBpmn(receiver()))).status).toBe(201);
    const token = await t.createToken('revoke-nl', ['proa:read', 'proa:propose']);
    const bot = asAgent(t, token.secret);
    const other = await agentOf('revoke-nl');
    const x = await claimOf(bot, 'revoke-nl', SENDER);
    const third = (id: string) => `${THIRD}#${id}`;
    await submit(
      bot,
      x.taskId,
      body(
        x,
        [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)],
        [
          noLink(TRIGGER),
          noLink({ type: 'message', from: MESSAGE.from, to: third('Start_Received') }),
          noLink({ type: 'trigger', from: TRIGGER.from, to: third('Start_Manual') }),
        ],
      ),
    );
    const y = await claimOf(other, 'revoke-nl', RECEIVER);
    await submit(other, y.taskId, body(y, []));
    const z = await claimOf(other, 'revoke-nl', THIRD);
    expect(z.input.judged).toHaveLength(2);
    const versionBefore = (await relationOf('revoke-nl', MESSAGE))?.version ?? 0;

    const res = await t.asOwner(`/api/v1/projects/revoke-nl/agent-tokens/${token.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(await liveNoLinks('revoke-nl', TRIGGER)).toEqual([]);
    const withdrawals = await rows<{ seq: string; reason: string }>(
      `SELECT w.seq, w.reason FROM no_link_withdrawal w JOIN project p ON p.id = w.project_id
       WHERE p.key = 'revoke-nl'`,
    );
    const [revoked] = await rows<{ seq: string }>(
      `SELECT e.seq FROM event e JOIN project p ON p.id = e.project_id
       WHERE p.key = 'revoke-nl' AND e.type = 'agent_token.revoked'`,
    );
    expect(withdrawals).toHaveLength(3);
    expect(withdrawals.every((w) => w.seq === revoked?.seq)).toBe(true);
    expect(withdrawals[0]?.reason).toMatch(/^agent token .* revoked$/);
    expect(await relationOf('revoke-nl', MESSAGE)).toMatchObject({
      status: 'proposed',
      source: 'rule',
    });
    expect((await relationOf('revoke-nl', MESSAGE))?.version).toBeGreaterThan(versionBefore);
    // Both done models are queued; the claimed one queues a follow-up after its submit.
    expect(await openTasks('revoke-nl')).toEqual({
      [SENDER]: 'queued',
      [RECEIVER]: 'queued',
      [THIRD]: 'claimed requeue_after',
    });
    await submit(other, z.taskId, body(z, []));
    expect(await openTasks('revoke-nl')).toMatchObject({ [THIRD]: 'queued' });
    const x2 = await claimOf(other, 'revoke-nl', SENDER);
    expect(candidatesOf(x2.input).sort()).toEqual(
      [
        keyOf(MESSAGE),
        keyOf(TRIGGER),
        keyOf({ type: 'message', from: MESSAGE.from, to: third('Start_Received') }),
        keyOf({ type: 'trigger', from: TRIGGER.from, to: third('Start_Manual') }),
      ].sort(),
    );
  });

  it('withdraw_proposal of a pipeline proposal queues both endpoint models', async () => {
    await seed('withdraw');
    const a = await agentOf('withdraw');
    const x = await claimOf(a, 'withdraw', SENDER);
    await submit(
      a,
      x.taskId,
      body(x, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)], [noLink(TRIGGER)]),
    );
    const y = await claimOf(a, 'withdraw', RECEIVER);
    await submit(a, y.taskId, body(y, []));
    expect(await openTasks('withdraw')).toEqual({});
    const r = await relationOf('withdraw', MESSAGE);
    const res = await a(`/api/v1/projects/withdraw/relations/${r?.id}/proposal`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(await openTasks('withdraw')).toEqual({ [SENDER]: 'queued', [RECEIVER]: 'queued' });
    const x2 = await claimOf(a, 'withdraw', SENDER);
    expect(candidatesOf(x2.input)).toEqual([keyOf(MESSAGE)]);
  });
});

describe('submissions', () => {
  it('give a partner without a head at the claim its head as basis (no 500)', async () => {
    await seed('late-partner');
    const a = await agentOf('late-partner');
    // The receiver is deleted at the claim and comes back changed; c/late is new.
    const del = await t.asOwner(
      `/api/v1/projects/late-partner/models/${await modelId('late-partner', RECEIVER)}`,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(204);
    const x = await claimOf(a, 'late-partner', SENDER);
    expect(candidatesOf(x.input)).toEqual([]);
    expect((await t.putModel('late-partner', RECEIVER, fakeBpmn(receiverV2()))).status).toBe(201);
    expect((await t.putModel('late-partner', 'c/late', fakeBpmn(receiver()))).status).toBe(201);
    const late = {
      type: 'message',
      from: MESSAGE.from,
      to: 'c/late#Start_Received',
    } as const;
    const lateTrigger = { type: 'trigger', from: TRIGGER.from, to: 'c/late#Start_Manual' } as const;
    const r = await submit(
      a,
      x.taskId,
      body(x, [item(late.type, late.from, late.to)], [noLink(lateTrigger), noLink(TRIGGER)]),
    );
    expect(r.items.map((i) => i.result)).toEqual(['applied']);
    expect(r.noLinks?.items.map((i) => i.result)).toEqual(['stored', 'stored']);
    const head = await headHash('late-partner', 'c/late');
    expect(await proposalBases('late-partner', late)).toMatchObject([{ to_hash: head }]);
    expect(await liveNoLinks('late-partner', lateTrigger)).toMatchObject([{ to_hash: head }]);
    // Not the receiver's revision before its deletion: the revived one the agent could see.
    expect(await liveNoLinks('late-partner', TRIGGER)).toMatchObject([
      { to_hash: await headHash('late-partner', RECEIVER) },
    ]);
  });

  it('answer every no-link: stored, duplicate or invalid:<reason>', async () => {
    await t.createProject('nl-valid');
    const multi = (kind: 'msg_throw' | 'sig_throw' | 'msg_catch' | 'sig_catch', id: string) =>
      ({ kind, id, name: 'Mehrfach', ref: 'Mehrfach' }) as FakeElement;
    await t.putModel(
      'nl-valid',
      SENDER,
      fakeBpmn(
        sender({
          elements: [
            multi('msg_throw', 'Event_Multi'),
            multi('sig_throw', 'Event_Multi'),
            { kind: 'evt_start', id: 'Start_Self', name: 'Selbst' },
          ],
        }),
      ),
    );
    await t.putModel(
      'nl-valid',
      RECEIVER,
      fakeBpmn(receiver([multi('msg_catch', 'Catch_Multi'), multi('sig_catch', 'Catch_Multi')])),
    );
    const a = await agentOf('nl-valid');
    const x = await claimOf(a, 'nl-valid', SENDER);
    const pair = (type: string | undefined, from: string, to: string, reason = 'x: y') => ({
      ...(type === undefined ? {} : { type }),
      from,
      to,
      reason,
    });
    const sent: SubmitAnalysisInput = {
      ...submission(x, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)]),
      noLinks: [
        pair('manual', MESSAGE.from, MESSAGE.to),
        pair(undefined, 'not a ref', MESSAGE.to),
        pair('trigger', TRIGGER.from, TRIGGER.to, 'nein\u0007'),
        pair(undefined, R('Start_Received'), R('Start_Manual')),
        pair('message', S('Event_Nope'), MESSAGE.to),
        pair('signal', MESSAGE.from, MESSAGE.to),
        pair('trigger', TRIGGER.from, S('Start_Self')),
        pair(undefined, S('Event_Multi'), R('Catch_Multi')),
        pair(undefined, MESSAGE.from, MESSAGE.to),
        pair('trigger', TRIGGER.from, TRIGGER.to),
        pair(undefined, TRIGGER.from, TRIGGER.to),
        pair('signal', S('Event_Multi'), R('Catch_Multi')),
      ],
    };
    const r = await submit(a, x.taskId, sent);
    expect(r.noLinks?.items.map((i) => i.result)).toEqual([
      'invalid:type-not-allowed',
      'invalid:malformed-ref',
      'invalid:control-characters',
      'invalid:outside-task-model',
      'invalid:unknown-ref',
      'invalid:type-mismatch',
      'invalid:same-process',
      'invalid:type-required',
      'invalid:also-proposed',
      'stored',
      'duplicate',
      'stored',
    ]);
    expect(r.noLinks?.counts).toEqual({ stored: 2, duplicate: 1, invalid: 9 });
    // Across submissions: the caller's live, current no-link on the typed pair.
    await requeue('nl-valid', [SENDER]);
    const x2 = await claimOf(a, 'nl-valid', SENDER);
    const r2 = await submit(a, x2.taskId, body(x2, [], [noLink(TRIGGER)]));
    expect(r2.noLinks?.items).toEqual([{ index: 0, result: 'duplicate' }]);
    expect(await liveNoLinks('nl-valid', TRIGGER)).toHaveLength(1);
  });

  it('report the assigned pairs left unjudged; nothing is queued for them', async () => {
    await seed('uncovered');
    const a = await agentOf('uncovered');
    const x = await claimOf(a, 'uncovered', SENDER);
    const r = await submit(a, x.taskId, body(x, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)]));
    expect(r.uncovered).toEqual({ count: 1, pairs: [TRIGGER] });
    expect(await openTasks('uncovered')).toEqual({ [RECEIVER]: 'queued' });
    // Claimed one after the other, the partner still sees the pair and judges it.
    const y = await claimOf(a, 'uncovered', RECEIVER);
    expect(candidatesOf(y.input)).toEqual([keyOf(TRIGGER)]);
  });

  it('report uncovered pairs on a late submit after the task failed: the assignment stays', async () => {
    await seed('late-failed');
    const a = await agentOf('late-failed');
    let x: ClaimedRelationsAnalysis | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      x = await claimOf(a, 'late-failed', SENDER);
      expect(x.attempt).toBe(attempt);
      clock.advance(16 * MINUTE);
    }
    if (!x) throw new Error('no claim');
    // Asking what is pending fails the task; its assignment stays.
    expect((await a('/api/v1/analyses/pending')).status).toBe(200);
    const [task] = await rows<{ state: string; assignment: unknown[] }>(
      `SELECT state, assignment FROM analysis_task WHERE id = '${x.taskId}'`,
    );
    expect(task).toEqual({ state: 'failed', assignment: [MESSAGE, TRIGGER] });
    const r = await submit(a, x.taskId, body(x, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)]));
    expect(r.uncovered).toEqual({ count: 1, pairs: [TRIGGER] });
    const [done] = await rows<{ payload: { late: boolean; uncovered: number } }>(
      `SELECT e.payload FROM event e JOIN project p ON p.id = e.project_id
       WHERE p.key = 'late-failed' AND e.type = 'analysis.done'`,
    );
    expect(done?.payload).toMatchObject({ late: true, uncovered: 1 });
  });

  it('replay a result stored before no-links were validated as it was stored', async () => {
    await seed('replay');
    const a = await agentOf('replay');
    const x = await claimOf(a, 'replay', SENDER);
    const submissionId = randomUUID();
    const old = {
      taskId: x.taskId,
      submissionId,
      replayed: false,
      items: [],
      counts: { applied: 0, duplicate: 0, suppressed: 0, reopened: 0, invalid: 0 },
      withdrawn: 0,
    };
    await database.db.execute(
      sql`INSERT INTO analysis_submission (id, project_id, task_id, client_submission_id, principal_id, declared, payload, result, seq)
          SELECT ${'sbm_01J9Z3N4X5Q6R7S8T9V0W1X2Y3'}, t.project_id, t.id, ${submissionId}, t.claimed_by,
                 ${JSON.stringify({ procedure: RELATIONS_PROCEDURE, llmModel: null })}::jsonb, '{}'::jsonb,
                 ${JSON.stringify(old)}::jsonb, t.claimed_seq
          FROM analysis_task t WHERE t.id = ${x.taskId}`,
    );
    await database.db.execute(sql`UPDATE analysis_task SET state = 'done' WHERE id = ${x.taskId}`);
    const res = await submitRaw(a, x.taskId, { ...body(x, []), submissionId });
    expect(res.status).toBe(200);
    const replayed: unknown = await res.json();
    expect(replayed).toEqual({ ...old, replayed: true });
    expect(SubmissionResult.parse(replayed)).toEqual({ ...old, replayed: true });
  });
});

describe('the review', () => {
  it('a bulk decision prepared before a no-link arrived fails (409): the version moved', async () => {
    await seed('bulk-nl');
    const a = await agentOf('bulk-nl');
    const b = await agentOf('bulk-nl');
    const x = await claimOf(a, 'bulk-nl', SENDER);
    await submit(a, x.taskId, body(x, [item(MESSAGE.type, MESSAGE.from, MESSAGE.to)]));
    const prepared = (await relationOf('bulk-nl', MESSAGE)) as Relation;
    const y = await claimOf(b, 'bulk-nl', RECEIVER);
    const r = await submit(b, y.taskId, body(y, [], [noLink(MESSAGE)]));
    expect(r.noLinks?.counts.stored).toBe(1);
    const now = (await relationOf('bulk-nl', MESSAGE)) as Relation;
    expect(now.version).toBe(prepared.version + 1);
    expect(now.noLinks).toHaveLength(1);
    const res = await post(owner, '/api/v1/projects/bulk-nl/decisions', {
      verdict: 'accept',
      items: [{ id: prepared.id, version: prepared.version }],
      expectedCount: 1,
    });
    expect(res.status).toBe(409);
    expect(await problemOf(res)).toMatchObject({
      code: 'conflict',
      mismatches: [{ id: prepared.id, reason: 'version', version: now.version }],
    });
    const ok = await post(owner, '/api/v1/projects/bulk-nl/decisions', {
      verdict: 'accept',
      items: [{ id: now.id, version: now.version }],
      expectedCount: 1,
    });
    expect(((await ok.json()) as BulkDecisionResult).items[0]).toMatchObject({
      status: 'accepted',
      noLinks: [{ origin: RECEIVER }],
    });
  });

  it('a revert that makes a no-link current again moves the version: a bulk decision prepared before fails (409)', async () => {
    await seed('revert-nl');
    const a = await agentOf('revert-nl');
    const x = await claimOf(a, 'revert-nl', SENDER);
    await submit(a, x.taskId, body(x, [], [noLink(MESSAGE), noLink(TRIGGER)]));
    const judged = (await relationOf('revert-nl', MESSAGE)) as Relation;
    expect(judged.noLinks).toHaveLength(1);
    // A documentation change of the sender: the no-link is no longer current.
    const doc = fakeBpmn(sender({ doc: 'Versendet die Ware.' }));
    expect((await t.putModel('revert-nl', SENDER, doc)).status).toBe(200);
    const prepared = (await relationOf('revert-nl', MESSAGE)) as Relation;
    expect(prepared).toMatchObject({ endpointState: 'ok', noLinks: [] });
    expect(prepared.version).toBeGreaterThan(judged.version);
    // Back to the first version before the re-analysis: the objection is current again.
    expect((await t.putModel('revert-nl', SENDER, fakeBpmn(sender()))).status).toBe(200);
    const now = (await relationOf('revert-nl', MESSAGE)) as Relation;
    expect(now.noLinks).toHaveLength(1);
    expect(now.version).toBeGreaterThan(prepared.version);
    const res = await post(owner, '/api/v1/projects/revert-nl/decisions', {
      verdict: 'accept',
      items: [{ id: prepared.id, version: prepared.version }],
      expectedCount: 1,
    });
    expect(res.status).toBe(409);
    expect(await problemOf(res)).toMatchObject({
      code: 'conflict',
      mismatches: [{ id: prepared.id, reason: 'version', version: now.version }],
    });
  });
});
