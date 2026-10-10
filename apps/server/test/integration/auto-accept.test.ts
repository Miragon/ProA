/**
 * Auto-accept rules (owner decision 19) against PostgreSQL, over REST with
 * the owner session and agent tokens: acceptances of pipeline and ad-hoc
 * proposals recorded as decisions of the rule's author (marker, event),
 * results that report the state before the rules ran, judge-once with an
 * auto-accepted pair, revocation (back to proposed, obsolete with a requeue,
 * human decisions untouched, by rule, agent or ids), "apply" with its dry
 * run and conflicts, revisions with If-Match, validation, the system rule,
 * token revocation, endpoint changes, and placements (ambiguity, @outside,
 * home step, unsure verdicts, revocation without a new task, step rename).
 * Synthetic models and chains only.
 */
import type {
  AnalysisTaskPage,
  ApplyAutoAcceptResult,
  AutoAcceptLedger,
  AutoAcceptPreview,
  AutoAcceptRevocationResult,
  AutoAcceptRuleDetail,
  AutoAcceptRuleDraftInput,
  AutoAcceptRuleList,
  ClaimedPlacementAnalysis,
  CreatedAgentToken,
  Me,
  Placement,
  PlacementPage,
  PostPlacementsResult,
  ProposeRelationResult,
  Relation,
  RelationPage,
  SaveAutoAcceptRuleResult,
  SaveValueChainResult,
  SubmissionResult,
} from '@proa/contracts';
import { newId } from '@proa/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createStore } from '../../src/db/store.ts';
import type { Actor } from '../../src/domain/actor.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { fakeBpmn, type FakeModelSpec, type FakeProcess } from '../support/fake-analysis.ts';
import {
  asAgent,
  claim,
  claimPlacement,
  item,
  placementSubmission,
  post,
  submission,
  submit,
  submitPlacement,
  type Caller,
} from '../support/pipeline.ts';
import { chain, chainPath, type StepSpec } from '../support/value-chain.ts';

let database: TestDatabase;
let t: TestApp;
let me: Me;

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database);
  me = (await (await t.asOwner('/api/v1/me')).json()) as Me;
});

afterAll(async () => {
  await database.drop();
});

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text.slice(0, 800)).toBe(status);
  return JSON.parse(text) as T;
}

const rulesPath = (p: string, rest = '') => `/api/v1/projects/${p}/auto-accept-rules${rest}`;

function send(method: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return t.asOwner(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function createRule(
  project: string,
  draft: Partial<AutoAcceptRuleDraftInput> & Pick<AutoAcceptRuleDraftInput, 'name'>,
): Promise<SaveAutoAcceptRuleResult> {
  return json<SaveAutoAcceptRuleResult>(
    await send('POST', rulesPath(project), {
      kind: 'relation',
      tier: 'key',
      minConfidence: 0.9,
      enabled: true,
      ...draft,
    }),
    201,
  );
}

function revise(
  project: string,
  rule: AutoAcceptRuleDetail,
  change: Record<string, unknown>,
  ifMatch?: string,
) {
  const draft = {
    name: rule.name,
    enabled: rule.enabled,
    note: rule.note,
    kind: rule.kind,
    tier: rule.tier,
    minConfidence: rule.minConfidence,
    relationType: rule.relationType,
    agentPrincipalId: rule.agentPrincipalId,
    llmModel: rule.llmModel,
    includeAdHoc: rule.includeAdHoc,
    ...change,
  };
  return send(
    'PUT',
    rulesPath(project, `/${rule.id}`),
    draft,
    ifMatch === undefined ? {} : { 'if-match': ifMatch },
  );
}

async function ledger(project: string, query = ''): Promise<AutoAcceptLedger['items']> {
  return (
    await json<AutoAcceptLedger>(
      await t.asOwner(`/api/v1/projects/${project}/auto-accepted${query}`),
    )
  ).items;
}

function revoke(project: string, body: Record<string, unknown>, dryRun: boolean) {
  return send(
    'POST',
    `/api/v1/projects/${project}/auto-accept-revocations${dryRun ? '?dryRun=true' : ''}`,
    body,
  );
}

function apply(project: string, ruleId: string, body: Record<string, unknown>, dryRun: boolean) {
  return send('POST', rulesPath(project, `/${ruleId}/apply${dryRun ? '?dryRun=true' : ''}`), body);
}

/** A user on the web who is a member of the project with `role` (R1 server mode, inserted directly). */
async function member(projectId: string, role: 'owner' | 'editor' | 'viewer'): Promise<Actor> {
  const principalId = newId('principal');
  const handle = `user:${role}-${principalId.slice(-6).toLowerCase()}`;
  await database.db.execute(
    sql`insert into principal (id, kind, iss, subject, handle) values (${principalId}, 'user', 'urn:proa:test', ${principalId}, ${handle})`,
  );
  await database.db.execute(
    sql`insert into membership (project_id, principal_id, role) values (${projectId}, ${principalId}, ${role})`,
  );
  return {
    principalId,
    kind: 'user',
    handle,
    clientId: 'proa-web',
    interactive: true,
    scopes: ['proa:read', 'proa:propose', 'proa:write', 'proa:review'],
    binding: null,
  };
}

async function events(projectId: string, after = 0) {
  return createStore(database.db).read((tx) =>
    tx.events.list(projectId as never, { afterSeq: after, limit: 10_000 }),
  );
}

// ------------------------------------------------------------- relations

const ORDER = 'vertrieb/auftrag';
const BILLING = 'finanzen/rechnung';
const O = (id: string) => `${ORDER}#${id}`;
const B = (id: string) => `${BILLING}#${id}`;
const SHIPPED: [string, string] = [O('Event_Shipped'), B('Start_Shipped')];
const INVOICE: [string, string] = [O('Event_Invoice'), B('Catch_Invoice')];
const DONE: [string, string] = [O('End_Done'), B('Start_Manual')];

function orderSpec(extra: FakeProcess['elements'] = []): FakeModelSpec {
  return {
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
          {
            kind: 'msg_throw',
            id: 'Event_Invoice',
            name: 'Rechnung angefordert',
            ref: 'RechnungAngefordert',
          },
          { kind: 'evt_end', id: 'End_Done', name: 'Auftrag erledigt' },
          ...(extra ?? []),
        ],
      },
    ],
  };
}

function billingSpec(shippedLabel = 'Ware versandbereit'): FakeModelSpec {
  return {
    processes: [
      {
        id: 'Process_Billing',
        name: 'Rechnungsstellung',
        elements: [
          {
            kind: 'msg_catch',
            id: 'Start_Shipped',
            name: shippedLabel,
            ref: 'WareVersandbereit',
            elementType: 'bpmn:StartEvent',
          },
          {
            kind: 'msg_catch',
            id: 'Catch_Invoice',
            name: 'Rechnung angefordert',
            ref: 'RechnungAngefordert',
          },
          { kind: 'evt_start', id: 'Start_Manual', name: 'Auftrag erledigt' },
        ],
      },
    ],
  };
}

interface RelationProject {
  key: string;
  id: string;
  token: CreatedAgentToken;
  agent: Caller;
}

async function relationProject(key: string): Promise<RelationProject> {
  const project = await t.createProject(key);
  await t.putModel(key, ORDER, fakeBpmn(orderSpec()));
  await t.putModel(key, BILLING, fakeBpmn(billingSpec()));
  const token = await t.createToken(key, ['proa:read', 'proa:propose']);
  return { key, id: project.id, token, agent: asAgent(t, token.secret) };
}

async function submitModel(
  p: RelationProject,
  modelKey: string,
  items: ReturnType<typeof item>[],
): Promise<{ result: SubmissionResult; body: ReturnType<typeof submission>; taskId: string }> {
  const [claimed] = await claim(p.agent, { projectId: p.key, modelKey });
  if (!claimed) throw new Error(`no task for ${modelKey}`);
  const body = submission(claimed, items);
  return { result: await submit(p.agent, claimed.taskId, body), body, taskId: claimed.taskId };
}

async function relations(project: string, query = ''): Promise<Relation[]> {
  const live = await json<RelationPage>(
    await t.asOwner(`/api/v1/projects/${project}/relations?limit=200${query}`),
  );
  const obsolete = await json<RelationPage>(
    await t.asOwner(`/api/v1/projects/${project}/relations?limit=200&status=obsolete`),
  );
  return [...live.items, ...obsolete.items];
}

async function relation(project: string, [from, to]: [string, string]): Promise<Relation> {
  const found = (await relations(project)).find((r) => r.from === from && r.to === to);
  if (!found) throw new Error(`no relation ${from} → ${to}`);
  return found;
}

async function markedRows(projectId: string) {
  const r = await database.db.execute<{
    id: string;
    relation_id: string;
    kind: string;
    verdict: string | null;
    source_kind: string;
    principal_id: string;
    client_id: string | null;
    tier: string | null;
    rationale: string | null;
    auto_accept_rule_id: string;
    auto_accept_rule_revision: number;
    auto_accept_trigger_id: string | null;
  }>(
    sql`select * from relation_assertion where project_id = ${projectId} and auto_accept_rule_id is not null order by seq`,
  );
  return r.rows;
}

const msg = (pair: [string, string], confidence = 0.95, extra: Parameters<typeof item>[3] = {}) =>
  item('message', pair[0], pair[1], { confidence, ...extra });
/** The trigger pair: lexical tier, and no rule-tier proposal on it. */
const trig = (confidence: number) => item('trigger', DONE[0], DONE[1], { confidence });

describe('relations: the pipeline', () => {
  let p: RelationProject;
  let rule: AutoAcceptRuleDetail;
  let triggerId: string;

  beforeAll(async () => {
    p = await relationProject('aa-pipe');
    rule = (await createRule(p.key, { name: 'Schlüssel ab 90 %' })).rule;
  });

  it('accepts a matching proposal as the rule author’s decision; the result is from before', async () => {
    const before = (await events(p.id)).at(-1)?.seq ?? 0;
    const { result, body, taskId } = await submitModel(p, ORDER, [
      msg(SHIPPED),
      msg(INVOICE, 0.85),
      item('trigger', DONE[0], DONE[1], { confidence: 0.99 }),
    ]);
    expect(result.items.map((i) => [i.result, i.status])).toEqual([
      ['applied', 'proposed'],
      ['applied', 'proposed'],
      ['applied', 'proposed'],
    ]);
    const accepted = await relation(p.key, SHIPPED);
    expect(accepted).toMatchObject({
      status: 'accepted',
      source: 'human',
      provenance: {
        kind: 'decision',
        verdict: 'accept',
        sourceKind: 'human',
        principalId: me.principalId,
        rationale: null,
        tier: null,
      },
    });
    expect((await relation(p.key, INVOICE)).status).toBe('proposed');
    expect((await relation(p.key, DONE)).status).toBe('proposed');

    const rows = await markedRows(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      relation_id: accepted.id,
      kind: 'decision',
      verdict: 'accept',
      source_kind: 'human',
      principal_id: me.principalId,
      client_id: 'proa-web',
      tier: null,
      auto_accept_rule_id: rule.id,
      auto_accept_rule_revision: 1,
    });
    triggerId = rows[0]?.auto_accept_trigger_id ?? '';
    const timeline = await json<{ items: { id: string; sourceKind: string; kind: string }[] }>(
      await t.asOwner(`/api/v1/projects/${p.key}/relations/${accepted.id}/assertions`),
    );
    expect(timeline.items.find((a) => a.id === triggerId)).toMatchObject({
      sourceKind: 'agent',
      kind: 'proposal',
    });

    const decided = (await events(p.id, before)).filter(
      (e) => e.type === 'relation.decided' && e.subjectRef === accepted.id,
    );
    expect(decided).toHaveLength(1);
    expect(decided[0]?.principalId).toBe(p.token.principalId);
    expect(decided[0]?.payload).toMatchObject({
      sourceKind: 'human',
      principalId: me.principalId,
      verdict: 'accept',
      autoAccept: { ruleId: rule.id, revision: 1, triggerId },
    });
    // Unmarked events stay as they were.
    const proposed = (await events(p.id, before)).filter((e) => e.type === 'relation.proposed');
    expect(proposed.every((e) => !('autoAccept' in e.payload))).toBe(true);

    // A replay returns the stored result (from before the rules ran).
    const replay = await submit(p.agent, taskId, body);
    expect(replay.replayed).toBe(true);
    expect(replay.items[0]?.status).toBe('proposed');
  });

  it('lists the acceptance in the ledger and the rule statistics', async () => {
    const entries = await ledger(p.key);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'relation',
      type: 'message',
      from: SHIPPED[0],
      to: SHIPPED[1],
      status: 'accepted',
      ruleId: rule.id,
      revision: 1,
      ruleName: 'Schlüssel ab 90 %',
      state: 'in-force',
      triggerId,
      decidedBy: { principalId: me.principalId },
      agent: { principalId: p.token.principalId },
      confidence: 0.95,
      tier: 'key',
      llmModel: 'sim-1',
    });
    const list = await json<AutoAcceptRuleList>(await t.asOwner(rulesPath(p.key)));
    expect(list.items[0]?.stats).toMatchObject({ inForce: 1, revoked: 0 });
    expect(list.items[0]?.authorIsOwner).toBe(true);
    expect(await ledger(p.key, '?state=revoked')).toEqual([]);
  });

  it('never assigns the pair again; the partner’s claim shows a plain human acceptance', async () => {
    const [claimed] = await claim(p.agent, { projectId: p.key, modelKey: BILLING });
    if (!claimed) throw new Error('no billing task');
    const pair = (x: { type: string; from: string; to: string }) => `${x.type} ${x.from} ${x.to}`;
    expect(claimed.input.candidates.map((c) => `${c[0]} ${c[1]} ${c[2]}`)).not.toContain(
      pair({ type: 'message', from: SHIPPED[0], to: SHIPPED[1] }),
    );
    const shown = claimed.input.relations.find((r) => r.from === SHIPPED[0] && r.to === SHIPPED[1]);
    expect(shown).toMatchObject({
      status: 'accepted',
      source: 'human',
      decision: { verdict: 'accept' },
    });
    expect(shown?.decision).not.toHaveProperty('note');
    const text = JSON.stringify(claimed.input);
    expect(text).not.toContain('aar_');
    expect(text).not.toContain('autoAccept');
    expect(text).not.toContain('Schlüssel ab 90');
    await post(p.agent, `/api/v1/analyses/${claimed.taskId}/release`, {
      leaseToken: claimed.leaseToken,
    });
  });

  it('reports the same result with and without rules', async () => {
    const results: SubmissionResult[] = [];
    for (const [key, rules] of [
      ['aa-same-none', 0],
      ['aa-same-off', 1],
      ['aa-same-on', 2],
    ] as const) {
      const q = await relationProject(key);
      if (rules > 0) await createRule(q.key, { name: 'Regel', enabled: rules === 2 });
      results.push((await submitModel(q, ORDER, [msg(SHIPPED), msg(INVOICE, 0.6)])).result);
      const status = (await relation(q.key, SHIPPED)).status;
      expect(status, key).toBe(rules === 2 ? 'accepted' : 'proposed');
    }
    const strip = (r: SubmissionResult) => ({
      ...r,
      taskId: null,
      submissionId: null,
      items: r.items.map((i) => ({ ...i, relationId: null })),
    });
    expect(strip(results[1] as SubmissionResult)).toEqual(strip(results[0] as SubmissionResult));
    expect(strip(results[2] as SubmissionResult)).toEqual(strip(results[0] as SubmissionResult));
  });
});

describe('relations: ad hoc and revocation', () => {
  let p: RelationProject;
  let rule: AutoAcceptRuleDetail;

  beforeAll(async () => {
    p = await relationProject('aa-adhoc');
    rule = (await createRule(p.key, { name: 'Ad hoc' })).rule;
  });

  const propose = async (confidence: number) =>
    json<ProposeRelationResult>(
      await post(p.agent, `/api/v1/projects/${p.key}/relations`, msg(SHIPPED, confidence)),
    );

  it('takes ad-hoc proposals only when the rule includes them', async () => {
    const first = await propose(0.95);
    expect(first).toMatchObject({ result: 'applied', relation: { status: 'proposed' } });
    expect((await relation(p.key, SHIPPED)).status).toBe('proposed');

    const res = await revise(p.key, rule, { includeAdHoc: true }, '"r1"');
    const revised = await json<SaveAutoAcceptRuleResult>(res);
    expect(res.headers.get('etag')).toBe('"r2"');
    expect(revised).toMatchObject({
      outcome: 'revised',
      rule: { revision: 2, includeAdHoc: true },
    });
    rule = revised.rule;

    // The response reports the state before the rule ran.
    const second = await propose(0.96);
    expect(second).toMatchObject({ result: 'applied', relation: { status: 'proposed' } });
    expect((await relation(p.key, SHIPPED)).status).toBe('accepted');
    const rows = await markedRows(p.id);
    expect(rows.map((r) => [r.kind, r.auto_accept_rule_revision])).toEqual([['decision', 2]]);
  });

  it('revokes with a dry run and expectedCount; the item returns to review, nothing is queued', async () => {
    const tasksBefore = await json<AnalysisTaskPage>(
      await t.asOwner(`/api/v1/projects/${p.key}/analyses?limit=200`),
    );
    const dry = await json<AutoAcceptRevocationResult>(
      await revoke(p.key, { ruleId: rule.id }, true),
    );
    expect(dry).toMatchObject({ dryRun: true, count: 1, toProposed: 1, toObsolete: 0 });
    expect(dry.items[0]).toMatchObject({
      outcome: 'proposed',
      from: SHIPPED[0],
      state: 'in-force',
    });
    expect((await relation(p.key, SHIPPED)).status).toBe('accepted');

    const conflict = await revoke(p.key, { ruleId: rule.id, expectedCount: 0 }, false);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'conflict', count: 1 });
    expect((await revoke(p.key, { ruleId: rule.id }, false)).status).toBe(422);

    const done = await json<AutoAcceptRevocationResult>(
      await revoke(p.key, { ruleId: rule.id, expectedCount: 1, reason: 'Zu früh.' }, false),
    );
    expect(done).toMatchObject({ dryRun: false, count: 1, toProposed: 1 });
    expect(done.items[0]).toMatchObject({ outcome: 'proposed', status: 'proposed' });
    const back = await relation(p.key, SHIPPED);
    expect(back).toMatchObject({ status: 'proposed', provenance: { sourceKind: 'agent' } });

    const rows = await markedRows(p.id);
    expect(
      rows.map((r) => [r.kind, r.source_kind, r.principal_id, r.auto_accept_trigger_id]),
    ).toEqual([
      ['decision', 'human', me.principalId, expect.stringMatching(/^asr_/)],
      ['withdrawal', 'human', me.principalId, null],
    ]);
    expect(rows[1]?.rationale).toBe('Automatische Annahme widerrufen: Zu früh.');
    expect((await ledger(p.key))[0]).toMatchObject({ state: 'revoked' });
    const revokedEvent = (await events(p.id)).filter((e) => e.type === 'auto_accept.revoked');
    expect(revokedEvent.at(-1)?.payload).toMatchObject({ ruleId: rule.id, count: 1 });

    // The agent's judgement is still current: nothing is queued again.
    const tasksAfter = await json<AnalysisTaskPage>(
      await t.asOwner(`/api/v1/projects/${p.key}/analyses?limit=200`),
    );
    expect(tasksAfter.items.length).toBe(tasksBefore.items.length);

    // Nothing left to revoke; a revoked item is never auto-accepted again.
    expect(
      await json<AutoAcceptRevocationResult>(await revoke(p.key, { ruleId: rule.id }, true)),
    ).toMatchObject({
      count: 0,
      alreadyRevoked: 1,
    });
    await propose(0.97);
    expect((await relation(p.key, SHIPPED)).status).toBe('proposed');
  });

  it('revokes by ids, and only in-force items', async () => {
    const r = await relation(p.key, SHIPPED);
    expect(
      await json<AutoAcceptRevocationResult>(await revoke(p.key, { ids: [r.id] }, true)),
    ).toMatchObject({
      count: 0,
      alreadyRevoked: 1,
    });
    expect((await revoke(p.key, {}, true)).status).toBe(422);
  });
});

describe('relations: revocation outcomes', () => {
  it('leaves an item a human decided since untouched', async () => {
    const p = await relationProject('aa-human');
    const { rule } = await createRule(p.key, { name: 'Regel' });
    await submitModel(p, ORDER, [msg(SHIPPED)]);
    const r = await relation(p.key, SHIPPED);
    expect(r.status).toBe('accepted');
    await json(
      await send('POST', `/api/v1/projects/${p.key}/relations/${r.id}/decision`, {
        verdict: 'reject',
        reason: 'Falsch.',
      }),
    );
    expect(
      await json<AutoAcceptRevocationResult>(await revoke(p.key, { ruleId: rule.id }, true)),
    ).toMatchObject({
      count: 0,
      humanDecidedSince: 1,
    });
    expect((await ledger(p.key))[0]).toMatchObject({
      state: 'human-decided',
      laterVerdict: 'reject',
    });
    const list = await json<AutoAcceptRuleList>(await t.asOwner(rulesPath(p.key)));
    expect(list.items[0]?.stats).toMatchObject({ inForce: 0, overruled: 1 });
  });

  it('turns an item obsolete when its proposal was superseded, and queues the models again', async () => {
    const p = await relationProject('aa-super');
    const { rule } = await createRule(p.key, {
      name: 'Auslöser',
      tier: 'lexical',
      relationType: 'trigger',
    });
    await submitModel(p, ORDER, [trig(0.95)]);
    expect((await relation(p.key, DONE)).status).toBe('accepted');
    // A new version of the order model; its analysis judges the pair no more.
    await t.putModel(
      p.key,
      ORDER,
      fakeBpmn(orderSpec([{ kind: 'task', id: 'Task_Pack', name: 'Packen' }])),
    );
    const { result } = await submitModel(p, ORDER, []);
    expect(result.withdrawn).toBe(1);
    expect((await relation(p.key, DONE)).status).toBe('accepted');

    const before = (await events(p.id)).at(-1)?.seq ?? 0;
    const dry = await json<AutoAcceptRevocationResult>(
      await revoke(p.key, { ruleId: rule.id }, true),
    );
    expect(dry).toMatchObject({ count: 1, toObsolete: 1, toProposed: 0 });
    await json(await revoke(p.key, { ruleId: rule.id, expectedCount: 1 }, false));
    expect((await relation(p.key, DONE)).status).toBe('obsolete');
    const queued = (await events(p.id, before)).filter(
      (e) => e.type === 'analysis.queued' && e.payload['reason'] === 'judgement withdrawn',
    );
    expect(queued.map((e) => e.payload['modelKey'])).toContain(ORDER);
  });

  it('keeps an acceptance when the agent token is revoked; revoking by agent withdraws it', async () => {
    const p = await relationProject('aa-token');
    await createRule(p.key, { name: 'Regel', tier: 'lexical' });
    await submitModel(p, ORDER, [trig(0.95)]);
    expect((await relation(p.key, DONE)).status).toBe('accepted');
    expect(
      (
        await t.asOwner(`/api/v1/projects/${p.key}/agent-tokens/${p.token.id}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(204);
    expect((await relation(p.key, DONE)).status).toBe('accepted');
    const tokens = await json<{ items: { id: string; principalId: string }[] }>(
      await t.asOwner(`/api/v1/projects/${p.key}/agent-tokens`),
    );
    expect(tokens.items.find((x) => x.id === p.token.id)?.principalId).toBe(p.token.principalId);
    const dry = await json<AutoAcceptRevocationResult>(
      await revoke(p.key, { agentPrincipalId: p.token.principalId }, true),
    );
    expect(dry).toMatchObject({ count: 1, toObsolete: 1 });
    await json(
      await revoke(p.key, { agentPrincipalId: p.token.principalId, expectedCount: 1 }, false),
    );
    expect((await relation(p.key, DONE)).status).toBe('obsolete');
  });

  it('keeps a later human proposal of the rule’s author when revoking', async () => {
    const p = await relationProject('aa-author');
    const { rule } = await createRule(p.key, { name: 'Regel' });
    await submitModel(p, ORDER, [msg(SHIPPED)]);
    expect((await relation(p.key, SHIPPED)).status).toBe('accepted');
    // An endpoint changes; the owner (the rule's author) proposes the pair again.
    await t.putModel(p.key, BILLING, fakeBpmn(billingSpec('Ware ist versandbereit')));
    const proposed = await json<ProposeRelationResult>(
      await send('POST', `/api/v1/projects/${p.key}/relations`, msg(SHIPPED, 0.9)),
    );
    expect(proposed.result).toBe('applied');
    // The acceptance is still the rule's and in force.
    expect((await ledger(p.key))[0]).toMatchObject({ state: 'in-force' });
    const dry = await json<AutoAcceptRevocationResult>(
      await revoke(p.key, { ruleId: rule.id }, true),
    );
    expect(dry).toMatchObject({ count: 1, toProposed: 1, toObsolete: 0 });
    await json(await revoke(p.key, { ruleId: rule.id, expectedCount: 1 }, false));
    // The revocation ended the acceptance only: the owner's proposal is still live.
    expect(await relation(p.key, SHIPPED)).toMatchObject({
      status: 'proposed',
      provenance: { kind: 'proposal', sourceKind: 'human', principalId: me.principalId },
    });
    expect((await ledger(p.key))[0]).toMatchObject({ state: 'revoked' });
  });

  it('sends an item whose endpoint changed to review; a rule never re-confirms it', async () => {
    const p = await relationProject('aa-endpoint');
    await createRule(p.key, { name: 'Regel' });
    await submitModel(p, ORDER, [msg(SHIPPED)]);
    await t.putModel(p.key, BILLING, fakeBpmn(billingSpec('Ware ist versandbereit')));
    expect(await relation(p.key, SHIPPED)).toMatchObject({
      status: 'accepted',
      endpointState: 'changed',
    });
    const { result } = await submitModel(p, BILLING, [msg(SHIPPED, 0.99)]);
    expect(result.items[0]?.result).toBe('applied');
    expect(await relation(p.key, SHIPPED)).toMatchObject({
      status: 'accepted',
      endpointState: 'changed',
    });
    expect((await markedRows(p.id)).filter((r) => r.kind === 'decision')).toHaveLength(1);
  });
});

describe('apply, revisions and validation', () => {
  let p: RelationProject;
  let rule: AutoAcceptRuleDetail;

  beforeAll(async () => {
    p = await relationProject('aa-apply');
    rule = (await createRule(p.key, { name: 'Später', enabled: false })).rule;
    await submitModel(p, ORDER, [
      msg(SHIPPED),
      msg(INVOICE),
      item('trigger', DONE[0], DONE[1], { confidence: 0.99 }),
    ]);
  });

  it('is off by default: a disabled rule accepts nothing', async () => {
    expect((await relation(p.key, SHIPPED)).status).toBe('proposed');
    expect(await markedRows(p.id)).toEqual([]);
  });

  it('previews what the rule would accept now', async () => {
    const preview = await json<AutoAcceptPreview>(
      await send('POST', rulesPath(p.key, '/preview'), {
        kind: 'relation',
        tier: 'key',
        minConfidence: 0.9,
      }),
    );
    expect(preview).toMatchObject({
      kind: 'relation',
      open: { count: 2 },
      history: { decided: 0 },
    });
    expect(preview.open.items.map((i) => i.from).sort()).toEqual([SHIPPED[0], INVOICE[0]].sort());
    expect(preview.curve).toHaveLength(9);
    expect(preview.curve.find((c) => c.minConfidence === 1)?.open).toBe(0);
    expect(preview.agents).toEqual([
      expect.objectContaining({
        principalId: p.token.principalId,
        tokenId: p.token.id,
        revoked: false,
      }),
    ]);
    expect(preview.llmModels).toEqual(['sim-1']);
  });

  it('applies with a dry run, the head revision and expectedCount', async () => {
    const dry = await json<ApplyAutoAcceptResult>(await apply(p.key, rule.id, {}, true));
    expect(dry).toMatchObject({
      dryRun: true,
      count: 2,
      revision: 1,
      truncated: false,
      enabled: false,
      authorIsOwner: true,
    });
    // Disabled.
    const off = await apply(p.key, rule.id, { revision: 1, expectedCount: 2 }, false);
    expect(off.status).toBe(409);
    expect(await off.json()).toMatchObject({ code: 'conflict', reason: 'rule-disabled' });
    const enabled = await json<SaveAutoAcceptRuleResult>(
      await revise(p.key, rule, { enabled: true }, '"r1"'),
    );
    rule = enabled.rule;
    expect(rule.revision).toBe(2);
    // Nothing changed yet: rules are never retroactive.
    expect((await relation(p.key, SHIPPED)).status).toBe('proposed');
    const stale = await apply(p.key, rule.id, { revision: 1, expectedCount: 2 }, false);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: 'conflict',
      count: 2,
      revision: 2,
      reason: 'revision-changed',
    });
    const changed = await apply(p.key, rule.id, { revision: 2, expectedCount: 1 }, false);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ reason: 'count-changed' });
    expect((await apply(p.key, rule.id, { revision: 2 }, false)).status).toBe(422);

    const before = (await events(p.id)).at(-1)?.seq ?? 0;
    const done = await json<ApplyAutoAcceptResult>(
      await apply(p.key, rule.id, { revision: 2, expectedCount: 2 }, false),
    );
    expect(done).toMatchObject({ dryRun: false, count: 2 });
    expect(done.items.every((i) => i.status === 'accepted')).toBe(true);
    expect((await relation(p.key, SHIPPED)).status).toBe('accepted');
    expect((await relation(p.key, DONE)).status).toBe('proposed');
    const after = await events(p.id, before);
    expect(after.filter((e) => e.type === 'relation.decided').map((e) => e.principalId)).toEqual([
      me.principalId,
      me.principalId,
    ]);
    expect(after.find((e) => e.type === 'auto_accept_rule.applied')?.payload).toEqual({
      ruleId: rule.id,
      revision: 2,
      count: 2,
    });
    expect(await json<ApplyAutoAcceptResult>(await apply(p.key, rule.id, {}, true))).toMatchObject({
      count: 0,
    });
  });

  it('edits as a new revision; decisions keep theirs', async () => {
    const res = await revise(p.key, rule, { minConfidence: 0.95, note: 'strenger' }, '"r2"');
    const edited = await json<SaveAutoAcceptRuleResult>(res);
    expect(edited.rule).toMatchObject({ revision: 3, minConfidence: 0.95, note: 'strenger' });
    expect(edited.rule.revisions.map((r) => [r.revision, r.enabled])).toEqual([
      [1, false],
      [2, true],
      [3, true],
    ]);
    expect((await ledger(p.key)).map((e) => e.revision)).toEqual([2, 2]);
    rule = edited.rule;
    const got = await t.asOwner(rulesPath(p.key, `/${rule.id}`));
    expect(got.headers.get('etag')).toBe('"r3"');
  });

  it('needs If-Match on an edit: 428 without, 412 when stale, unchanged whatever it names', async () => {
    const missing = await revise(p.key, rule, { minConfidence: 0.99 });
    expect(missing.status).toBe(428);
    const stale = await revise(p.key, rule, { minConfidence: 0.99 }, '"r1"');
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({ code: 'revision-conflict', headRev: 3 });
    const same = await json<SaveAutoAcceptRuleResult>(await revise(p.key, rule, {}, '"r1"'));
    expect(same).toMatchObject({ outcome: 'unchanged', rule: { revision: 3 } });
  });

  it('validates drafts', async () => {
    const reason = async (res: Response) => {
      expect(res.status).toBe(422);
      return ((await res.json()) as { reason?: string }).reason;
    };
    expect(
      await reason(
        await send('POST', rulesPath(p.key), {
          name: 'später',
          kind: 'relation',
          tier: 'key',
          minConfidence: 0.9,
        }),
      ),
    ).toBe('name-taken');
    expect(
      await reason(
        await send('POST', rulesPath(p.key), {
          name: 'Agent',
          kind: 'relation',
          tier: 'key',
          minConfidence: 0.9,
          agentPrincipalId: 'prn_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
        }),
      ),
    ).toBe('unknown-agent');
    expect(
      await reason(await revise(p.key, rule, { kind: 'placement', tier: 'lexical' }, '"r3"')),
    ).toBe('kind-changed');
    // The contract refuses what the domain double-checks.
    for (const body of [
      { name: 'x', kind: 'placement', tier: 'key', minConfidence: 0.9 },
      { name: 'x', kind: 'placement', tier: 'lexical', minConfidence: 0.9, relationType: 'call' },
      { name: 'x', kind: 'relation', tier: 'key', minConfidence: 0.49 },
      { name: 'x', kind: 'relation', tier: 'manual', minConfidence: 0.9 },
      { name: '\u0007', kind: 'relation', tier: 'key', minConfidence: 0.9 },
    ]) {
      expect((await send('POST', rulesPath(p.key), body)).status, JSON.stringify(body)).toBe(422);
    }
    // A rule narrowed to the project's agent is fine.
    const narrowed = await createRule(p.key, {
      name: 'Nur dieser Agent',
      agentPrincipalId: p.token.principalId,
      llmModel: 'sim-1',
      enabled: false,
    });
    expect(narrowed.rule.agent).toMatchObject({
      principalId: p.token.principalId,
      tokenId: p.token.id,
    });
  });
});

describe('a rule whose author is no longer an owner', () => {
  it('matches nothing; apply says why; saving it unchanged takes it over', async () => {
    const p = await relationProject('aa-takeover');
    const other = await member(p.id, 'owner');
    const created = await t.useCases.createAutoAcceptRule(other, p.key, {
      name: 'Von Owner B',
      enabled: true,
      note: null,
      kind: 'relation',
      tier: 'key',
      minConfidence: 0.9,
      relationType: null,
      agentPrincipalId: null,
      llmModel: null,
      includeAdHoc: false,
    });
    const ruleId = created.rule.id;
    await database.db.execute(
      sql`update membership set role = 'editor' where project_id = ${p.id} and principal_id = ${other.principalId}`,
    );
    const rule = await json<AutoAcceptRuleDetail>(await t.asOwner(rulesPath(p.key, `/${ruleId}`)));
    expect(rule).toMatchObject({
      authorIsOwner: false,
      author: { principalId: other.principalId },
    });

    // It matches nothing: a new proposal stays proposed.
    await submitModel(p, ORDER, [msg(SHIPPED)]);
    expect((await relation(p.key, SHIPPED)).status).toBe('proposed');
    const dry = await json<ApplyAutoAcceptResult>(await apply(p.key, ruleId, {}, true));
    expect(dry).toMatchObject({ count: 1, enabled: true, authorIsOwner: false });
    const refused = await apply(p.key, ruleId, { revision: 1, expectedCount: 1 }, false);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'conflict', reason: 'author-not-owner' });

    // Saving it unchanged takes it over (still under If-Match), once.
    expect((await revise(p.key, rule, {}, '"r5"')).status).toBe(412);
    const taken = await json<SaveAutoAcceptRuleResult>(await revise(p.key, rule, {}, '"r1"'));
    expect(taken).toMatchObject({
      outcome: 'revised',
      rule: { revision: 2, authorIsOwner: true, author: { principalId: me.principalId } },
    });
    const revised = (await events(p.id)).filter((e) => e.type === 'auto_accept_rule.revised');
    expect(revised.at(-1)?.payload).toMatchObject({ takenOverFrom: other.principalId });
    expect(
      await json<SaveAutoAcceptRuleResult>(await revise(p.key, taken.rule, {}, '"r2"')),
    ).toMatchObject({
      outcome: 'unchanged',
    });
    // Now it applies, under the new author.
    const done = await json<ApplyAutoAcceptResult>(
      await apply(p.key, ruleId, { revision: 2, expectedCount: 1 }, false),
    );
    expect(done).toMatchObject({ count: 1, authorIsOwner: true });
    expect((await relation(p.key, SHIPPED)).status).toBe('accepted');
    expect((await ledger(p.key))[0]).toMatchObject({
      revision: 2,
      decidedBy: { principalId: me.principalId },
    });
  });
});

describe('the ledger is every human reviewer’s, the rules the owners’', () => {
  it('lets an editor read the marks but not the rules; a viewer reads neither', async () => {
    const p = await relationProject('aa-editor');
    const { rule } = await createRule(p.key, { name: 'Regel' });
    await submitModel(p, ORDER, [msg(SHIPPED)]);
    const editor = await member(p.id, 'editor');
    const viewer = await member(p.id, 'viewer');
    const marks = await t.useCases.listAutoAccepted(editor, p.key, {});
    expect(marks.items).toEqual([
      expect.objectContaining({
        from: SHIPPED[0],
        ruleId: rule.id,
        ruleName: 'Regel',
        state: 'in-force',
      }),
    ]);
    await expect(t.useCases.listAutoAcceptRules(editor, p.key)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      t.useCases.revokeAutoAccepted(editor, p.key, { ruleId: rule.id }, { dryRun: true }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.useCases.listAutoAccepted(viewer, p.key, {})).rejects.toMatchObject({
      code: 'forbidden',
    });
    // An agent token is no human.
    const agent = await p.agent(`/api/v1/projects/${p.key}/auto-accepted`);
    expect(agent.status).toBe(403);
    expect(await agent.json()).toMatchObject({ code: 'human-decision-required' });
  });
});

describe('rules of a project', () => {
  it('starts without rules and shows decision 9 as the system rule', async () => {
    await t.createProject('aa-empty');
    await t.putModel(
      'aa-empty',
      'a/caller',
      fakeBpmn({
        processes: [
          { id: 'P_A', elements: [{ kind: 'call', id: 'Call_B', name: 'B', ref: 'P_B' }] },
        ],
      }),
    );
    await t.putModel('aa-empty', 'b/callee', fakeBpmn({ processes: [{ id: 'P_B', name: 'B' }] }));
    const list = await json<AutoAcceptRuleList>(await t.asOwner(rulesPath('aa-empty')));
    expect(list.items).toEqual([]);
    expect(list.system).toMatchObject({
      id: 'proa-rules/1.0.0',
      name: 'Eindeutige Aufrufe',
      kind: 'relation',
      relationType: 'call',
      readOnly: true,
      accepted: 1,
    });
    expect(await ledger('aa-empty')).toEqual([]);
    const missing = await t.asOwner(rulesPath('aa-empty', '/aar_01J9Z3N4X5Q6R7S8T9V0W1X2Y3'));
    expect(missing.status).toBe(404);
  });
});

// ------------------------------------------------------------ placements

const STEPS: StepSpec[] = [
  { id: 'step-verwaltung', name: 'Verwaltung', x: 0 },
  { id: 'step-pruefung', name: 'Antragsprüfung', parent: 'step-verwaltung', y: 100 },
  { id: 'step-ausgabe', name: 'Bescheidausgabe', parent: 'step-verwaltung', y: 200 },
];
const ANTRAG = 'verwaltung/antrag#P_Antrag';
const BESCHEID = 'verwaltung/bescheid#P_Bescheid';
const SONST = 'verwaltung/sonstiges#P_Sonst';

async function placementProject(key: string, adHoc = false) {
  const project = await t.createProject(key);
  await t.putModel(
    key,
    'verwaltung/antrag',
    fakeBpmn({ processes: [{ id: 'P_Antrag', name: 'Antragsprüfung' }] }),
  );
  await t.putModel(
    key,
    'verwaltung/bescheid',
    fakeBpmn({ processes: [{ id: 'P_Bescheid', name: 'Bescheidausgabe' }] }),
  );
  await t.putModel(
    key,
    'verwaltung/sonstiges',
    fakeBpmn({ processes: [{ id: 'P_Sonst', name: 'Sonstiges' }] }),
  );
  const created = await json<SaveValueChainResult>(
    await send('POST', `/api/v1/projects/${key}/value-chains`, {
      key: 'main',
      content: chain({ steps: STEPS }),
    }),
    201,
  );
  const token = await t.createToken(key, ['proa:read', 'proa:propose']);
  // Both agent tiers, so whatever tier a proposal gets, a rule matches.
  for (const tier of ['lexical', 'semantic'] as const) {
    await createRule(key, {
      name: `Platzierung ${tier}`,
      kind: 'placement',
      tier,
      minConfidence: 0.9,
      includeAdHoc: adHoc,
    });
  }
  return {
    key,
    id: project.id,
    token,
    agent: asAgent(t, token.secret),
    rev: created.valueChain?.headRev ?? 1,
  };
}

const place = (
  step: string,
  process: string,
  confidence = 0.95,
  extra: Record<string, unknown> = {},
) => ({
  step,
  process,
  confidence,
  rationale: `Platzierung von ${process}`,
  ...extra,
});

async function placements(key: string): Promise<Placement[]> {
  const live = await json<PlacementPage>(await t.asOwner(chainPath(key, '/placements?limit=200')));
  const obsolete = await json<PlacementPage>(
    await t.asOwner(chainPath(key, '/placements?limit=200&status=obsolete')),
  );
  return [...live.items, ...obsolete.items];
}

async function placementOn(key: string, step: string, process: string): Promise<Placement> {
  const found = (await placements(key)).find((p) => p.elementId === step && p.process === process);
  if (!found) throw new Error(`no placement of ${process} on ${step}`);
  return found;
}

async function claimOne(agent: Caller, key: string): Promise<ClaimedPlacementAnalysis> {
  const [c] = await claimPlacement(agent, { projectId: key });
  if (!c) throw new Error(`no placement task in ${key}`);
  return c;
}

describe('placements', () => {
  it('accepts a lone pipeline proposal, never an ambiguous or @outside one; then revokes it without a new task', async () => {
    const p = await placementProject('aa-plc');
    const c = await claimOne(p.agent, p.key);
    const result = await submitPlacement(
      p.agent,
      c.taskId,
      placementSubmission(c, [
        place('step-pruefung', ANTRAG),
        place('step-pruefung', BESCHEID),
        place('step-ausgabe', BESCHEID),
        place('@outside', SONST, 0.99, { rationale: 'Gehört nicht in diese Kette.' }),
      ]),
    );
    expect(result.placements.items.map((i) => i.status)).toEqual([
      'proposed',
      'proposed',
      'proposed',
      'proposed',
    ]);
    expect((await placementOn(p.key, 'step-pruefung', ANTRAG)).status).toBe('accepted');
    expect((await placementOn(p.key, 'step-pruefung', BESCHEID)).status).toBe('proposed');
    expect((await placementOn(p.key, 'step-ausgabe', BESCHEID)).status).toBe('proposed');
    expect((await placementOn(p.key, '@outside', SONST)).status).toBe('proposed');
    const rows = await database.db.execute<{
      kind: string;
      source_kind: string;
      principal_id: string;
    }>(
      sql`select kind, source_kind, principal_id from placement_assertion where project_id = ${p.id} and auto_accept_rule_id is not null`,
    );
    expect(rows.rows).toEqual([
      { kind: 'decision', source_kind: 'human', principal_id: me.principalId },
    ]);
    const entries = await ledger(p.key, '?kind=placement');
    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'placement',
        valueChainKey: 'main',
        step: 'step-pruefung',
        process: ANTRAG,
        state: 'in-force',
      }),
    ]);

    const before = (await events(p.id)).at(-1)?.seq ?? 0;
    const dry = await json<AutoAcceptRevocationResult>(
      await revoke(p.key, { kind: 'placement', ruleId: entries[0]?.ruleId }, true),
    );
    expect(dry).toMatchObject({ count: 1, toProposed: 1 });
    await json(
      await revoke(
        p.key,
        { kind: 'placement', ruleId: entries[0]?.ruleId, expectedCount: 1 },
        false,
      ),
    );
    expect((await placementOn(p.key, 'step-pruefung', ANTRAG)).status).toBe('proposed');
    // The agent's verdict still matches the process's input: no new placement task.
    expect((await events(p.id, before)).filter((e) => e.type === 'analysis.queued')).toEqual([]);
  });

  it('takes ad-hoc proposals with the switch, and never a second home step', async () => {
    const p = await placementProject('aa-plc-adhoc', true);
    const adHoc = async (step: string, process: string) =>
      json<PostPlacementsResult>(
        await post(p.agent, chainPath(p.key, '/placements'), {
          kind: 'propose',
          placements: [place(step, process)],
        }),
      );
    const first = await adHoc('step-pruefung', ANTRAG);
    expect(first.kind === 'propose' && first.items[0]?.status).toBe('proposed');
    expect((await placementOn(p.key, 'step-pruefung', ANTRAG)).status).toBe('accepted');
    await adHoc('step-ausgabe', ANTRAG);
    expect((await placementOn(p.key, 'step-ausgabe', ANTRAG)).status).toBe('proposed');

    // A human's manual placement on the same step is recorded and confirms the acceptance.
    const manual = await json<PostPlacementsResult>(
      await send('POST', chainPath(p.key, '/placements'), {
        kind: 'manual',
        step: 'step-pruefung',
        process: ANTRAG,
        rationale: 'Passt.',
      }),
    );
    expect(manual.kind === 'manual' && manual.result).toBe('applied');
    expect(await ledger(p.key)).toEqual([
      expect.objectContaining({ state: 'human-decided', laterVerdict: 'accept' }),
    ]);

    // A step rename sends the accepted placement to re-confirm, as for human acceptances.
    await json<SaveValueChainResult>(
      await send(
        'PUT',
        chainPath(p.key, '/content'),
        chain({
          steps: STEPS.map((s) =>
            s.id === 'step-pruefung' ? { ...s, name: 'Prüfung der Anträge' } : s,
          ),
        }),
        { 'if-match': `"r${p.rev}"` },
      ),
    );
    expect(await placementOn(p.key, 'step-pruefung', ANTRAG)).toMatchObject({
      status: 'accepted',
      endpointState: 'changed',
    });
  });

  it('respects another agent’s current unsure verdict', async () => {
    const p = await placementProject('aa-plc-unsure', true);
    const c = await claimOne(p.agent, p.key);
    await submitPlacement(
      p.agent,
      c.taskId,
      placementSubmission(c, [], { unsure: [{ process: ANTRAG, reason: 'Unklar.' }] }),
    );
    const other = await t.createToken(p.key, ['proa:read', 'proa:propose']);
    await json(
      await post(asAgent(t, other.secret), chainPath(p.key, '/placements'), {
        kind: 'propose',
        placements: [place('step-pruefung', ANTRAG)],
      }),
    );
    expect((await placementOn(p.key, 'step-pruefung', ANTRAG)).status).toBe('proposed');
    // The other agent's ad-hoc proposal does not replace the unsure verdict: the preview and
    // "apply" see the same doubt the write path saw.
    const rows = await database.db.execute<{ principal_id: string; outcome: string }>(
      sql`select principal_id, outcome from placement_input where project_id = ${p.id} and process_ref = ${ANTRAG}`,
    );
    expect(rows.rows).toEqual([{ principal_id: p.token.principalId, outcome: 'unsure' }]);
    const list = await json<AutoAcceptRuleList>(await t.asOwner(rulesPath(p.key)));
    for (const r of list.items) {
      const preview = await json<AutoAcceptPreview>(
        await send('POST', rulesPath(p.key, '/preview'), {
          kind: 'placement',
          tier: r.tier,
          minConfidence: 0.9,
          includeAdHoc: true,
        }),
      );
      expect(preview.open.count, r.tier).toBe(0);
      expect(await json<ApplyAutoAcceptResult>(await apply(p.key, r.id, {}, true))).toMatchObject({
        count: 0,
      });
    }
    const blocked = await Promise.all(
      list.items.map(
        async (r) =>
          (await json<ApplyAutoAcceptResult>(await apply(p.key, r.id, {}, true))).blocked,
      ),
    );
    expect(blocked.flat()).toEqual([{ reason: 'agent-unsure', count: 1 }]);
    // The unsure agent changing its mind passes: its own doubt never blocks it.
    await json(
      await post(p.agent, chainPath(p.key, '/placements'), {
        kind: 'propose',
        placements: [place('step-pruefung', ANTRAG)],
      }),
    );
    expect((await placementOn(p.key, 'step-pruefung', ANTRAG)).status).toBe('accepted');
  });
});
