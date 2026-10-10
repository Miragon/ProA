/**
 * The `placement` pipeline kind (M4 §3.2, M4 S5) against PostgreSQL, over
 * REST and over MCP with agent tokens: judge each process once. Queue
 * triggers (chain saves with a new structure, new or changed processes, lost
 * judgements; never layout-only saves, model deletions or human decisions),
 * one open placement task per chain, the default kinds, claim, submit,
 * release, lease expiry and late submits, `wrong-task-kind`, the item and
 * unsure checks, the verdict memory (`placement_input`: invalid items are
 * offered again, unsure and skipped ones only after their input changed),
 * supersession, saves during a lease, truncation and its follow-up,
 * revocation and withdrawals, revival, ad-hoc proposals as verdicts, only
 * what a claim shows moving an input hash (notes on open proposals, org
 * units, sibling processes), the `inTask` marker of `list_unplaced_processes`,
 * the first task at server start, and the stage of the chain. Synthetic
 * models and chains only.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type {
  AnalysisTaskPage,
  ClaimedPlacementAnalysis,
  CreatedAgentToken,
  PendingAnalyses,
  Placement,
  PlacementAssertionList,
  PlacementPage,
  PostPlacementsResult,
  Project,
  RequeueResult,
  SaveValueChainResult,
  UnplacedProcessPage,
  ValueChainDetail,
} from '@proa/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createStore } from '../../src/db/store.ts';
import { startTestApp, testClock, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { fakeBpmn, type FakeProcess } from '../support/fake-analysis.ts';
import { listen } from '../support/http.ts';
import {
  PLACEMENTS_PROCEDURE,
  asAgent,
  claim,
  claimKinds,
  claimPlacement,
  placementSubmission,
  post,
  problemOf,
  release,
  submitPlacement,
  submitRaw,
  type Caller,
} from '../support/pipeline.ts';
import { chain, chainPath, type StepSpec } from '../support/value-chain.ts';

const MINUTE = 60_000;

let database: TestDatabase;
let t: TestApp;

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database);
});

afterAll(async () => {
  await database.drop();
});

const STEPS: StepSpec[] = [
  { id: 'step-verwaltung', name: 'Verwaltung', x: 0 },
  { id: 'step-pruefung', name: 'Antragsprüfung', parent: 'step-verwaltung', y: 100 },
  { id: 'step-ausgabe', name: 'Bescheidausgabe', parent: 'step-verwaltung', y: 200 },
  { id: 'step-studium', name: 'Studium', x: 300 },
  { id: 'step-lehre', name: 'Lehre', parent: 'step-studium', x: 300, y: 100 },
  { id: 'step-pruefungen', name: 'Prüfungen', parent: 'step-studium', x: 300, y: 200 },
];
const doc = (steps: StepSpec[] = STEPS, dx = 0) =>
  chain({
    steps: steps.map((s) => ({ ...s, x: (s.x ?? 0) + dx })),
    sequence: [['step-verwaltung', 'step-studium']],
  });
const renamed = (id: string, name: string, steps = STEPS) =>
  steps.map((s) => (s.id === id ? { ...s, name } : s));

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text.slice(0, 800)).toBe(status);
  return JSON.parse(text) as T;
}

/** One project with models, an agent token and (optionally) the chain. */
class Fixture {
  readonly key: string;
  project!: Project;
  token!: CreatedAgentToken;
  agent!: Caller;
  rev = 0;

  constructor(key: string) {
    this.key = key;
  }

  static async create(
    key: string,
    models: Record<string, FakeProcess[]>,
    steps: StepSpec[] | null = STEPS,
  ): Promise<Fixture> {
    const f = new Fixture(key);
    f.project = await t.createProject(key);
    for (const [model, processes] of Object.entries(models)) await f.put(model, processes);
    f.token = await t.createToken(key, ['proa:read', 'proa:propose']);
    f.agent = asAgent(t, f.token.secret);
    if (steps) await f.createChain(steps);
    return f;
  }

  async put(model: string, processes: FakeProcess[], layout?: string): Promise<void> {
    const res = await t.putModel(
      this.key,
      model,
      fakeBpmn({ processes, ...(layout ? { layout } : {}) }),
    );
    expect([200, 201], await res.clone().text()).toContain(res.status);
  }

  async createChain(steps: StepSpec[] = STEPS): Promise<SaveValueChainResult> {
    const r = await json<SaveValueChainResult>(
      await t.asOwner(`/api/v1/projects/${this.key}/value-chains`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'main', content: doc(steps) }),
      }),
      201,
    );
    this.rev = r.valueChain?.headRev ?? 0;
    return r;
  }

  async save(steps: StepSpec[] = STEPS, dx = 0): Promise<SaveValueChainResult> {
    const r = await json<SaveValueChainResult>(
      await t.asOwner(chainPath(this.key, '/content'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': `"r${this.rev}"` },
        body: JSON.stringify(doc(steps, dx)),
      }),
    );
    this.rev = r.valueChain?.headRev ?? this.rev;
    return r;
  }

  async newToken(): Promise<{ token: CreatedAgentToken; agent: Caller }> {
    const token = await t.createToken(this.key, ['proa:read', 'proa:propose']);
    return { token, agent: asAgent(t, token.secret) };
  }

  async events(after = 0) {
    return createStore(database.db).read((tx) =>
      tx.events.list(this.project.id, { afterSeq: after, limit: 10_000 }),
    );
  }

  async lastSeq(): Promise<number> {
    return (await this.events()).at(-1)?.seq ?? 0;
  }

  /** The placement analysis events after `seq`: `type reason|due`. */
  async chainEvents(after: number): Promise<string[]> {
    return (await this.events(after))
      .filter((e) => e.type.startsWith('analysis.') && e.payload['kind'] === 'placement')
      .map((e) => `${e.type} ${(e.payload['reason'] as string | undefined) ?? ''}`.trim());
  }

  async detail(): Promise<ValueChainDetail> {
    return json<ValueChainDetail>(await t.asOwner(chainPath(this.key)));
  }

  async placements(query = ''): Promise<Placement[]> {
    return (
      await json<PlacementPage>(
        await t.asOwner(chainPath(this.key, `/placements?limit=200${query}`)),
      )
    ).items;
  }

  /** The placement of `process` on `step`, obsolete ones included. */
  async placementOn(step: string, process: string): Promise<Placement | undefined> {
    return [...(await this.placements()), ...(await this.placements('&status=obsolete'))].find(
      (p) => p.elementId === step && p.process === process,
    );
  }

  async timeline(id: string) {
    return (
      await json<PlacementAssertionList>(
        await t.asOwner(chainPath(this.key, `/placements/${id}/assertions`)),
      )
    ).items;
  }

  async requeue(): Promise<RequeueResult['valueChain']> {
    return (
      await json<RequeueResult>(
        await post((p, i) => t.asOwner(p, i), `/api/v1/projects/${this.key}/analyses/requeue`, {
          valueChain: true,
        }),
      )
    ).valueChain;
  }

  async pending(kinds = '', caller: Caller = this.agent): Promise<number> {
    return (
      await json<PendingAnalyses>(
        await caller(`/api/v1/analyses/pending?projectId=${this.key}${kinds}`),
      )
    ).total;
  }

  async decide(id: string, body: unknown): Promise<Response> {
    return post((p, i) => t.asOwner(p, i), chainPath(this.key, `/placements/${id}/decision`), body);
  }

  async unplaced(): Promise<UnplacedProcessPage['items']> {
    return (
      await json<UnplacedProcessPage>(await t.asOwner(chainPath(this.key, '/unplaced-processes')))
    ).items;
  }

  async rows() {
    return createStore(database.db).read(async (tx) => {
      const chainRow = await tx.valueChains.findByKey(this.project.id, 'main');
      return chainRow ? tx.placementInputs.forChain(this.project.id, chainRow.id) : [];
    });
  }
}

const item = (step: string, process: string, extra: Record<string, unknown> = {}) => ({
  step,
  process,
  confidence: 0.8,
  rationale: `Platzierung von ${process}`,
  ...extra,
});

const procs = (prefix: string, n: number): FakeProcess[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `P_${prefix}${String(i).padStart(2, '0')}`,
    name: `Vorgang ${prefix}${i}`,
  }));

async function only(agent: Caller, project: string): Promise<ClaimedPlacementAnalysis> {
  const [c, ...rest] = await claimPlacement(agent, { projectId: project });
  expect(rest).toEqual([]);
  if (!c) throw new Error(`no placement task in ${project}`);
  return c;
}

// ---------------------------------------------------------------- triggers

describe('queue triggers', () => {
  const A = 'verwaltung/antrag#P_Antrag';
  const B = 'verwaltung/bescheid#P_Bescheid';
  const C = 'studium/einschreibung#P_Einschreibung';
  let f: Fixture;

  beforeAll(async () => {
    f = await Fixture.create(
      'pl-queue',
      {
        'verwaltung/antrag': [{ id: 'P_Antrag', name: 'Antrag stellen' }],
        'verwaltung/bescheid': [{ id: 'P_Bescheid', name: 'Bescheid erstellen' }],
      },
      null,
    );
  });

  it('queues a task when the chain is created with processes to place', async () => {
    const before = await f.lastSeq();
    await f.createChain();
    const queued = (await f.events(before)).filter((e) => e.type === 'analysis.queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toMatchObject({
      kind: 'placement',
      key: 'main',
      rev: 1,
      due: 2,
      reason: 'value chain saved',
    });
    expect(queued[0]?.subjectRef).toMatch(/^vch_/);
    const tasks = await json<AnalysisTaskPage>(
      await t.asOwner(`/api/v1/projects/${f.key}/analyses?kind=placement`),
    );
    expect(tasks.items).toEqual([
      expect.objectContaining({
        kind: 'placement',
        subjectKind: 'value_chain',
        state: 'queued',
        valueChainKey: 'main',
        modelId: null,
        modelKey: null,
        revisionId: null,
        factsHash: null,
      }),
    ]);
    expect(tasks.items[0]?.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      (
        await json<AnalysisTaskPage>(
          await t.asOwner(`/api/v1/projects/${f.key}/analyses?kind=relations`),
        )
      ).items.every((i) => i.kind === 'relations'),
    ).toBe(true);
  });

  it('never queues for a layout-only save, but for a new structure once nothing is open', async () => {
    const c = await only(f.agent, f.key);
    expect(c.input.processes.map((p) => p.process)).toEqual([A, B]);
    await submitPlacement(
      f.agent,
      c.taskId,
      placementSubmission(c, [], {
        unsure: [
          { process: A, reason: 'Kein passender Schritt.' },
          { process: B, reason: 'Kein passender Schritt.' },
        ],
      }),
    );
    let before = await f.lastSeq();
    await f.save(STEPS, 40);
    expect(await f.chainEvents(before)).toEqual([]);
    expect((await f.detail()).pipeline).toMatchObject({ due: 0, unsure: 2 });
    before = await f.lastSeq();
    await f.save(renamed('step-lehre', 'Lehrbetrieb'));
    expect(await f.chainEvents(before)).toEqual(['analysis.queued value chain saved']);
    const again = await only(f.agent, f.key);
    // Offered again with the earlier unsure verdict: the structure changed.
    expect(again.input.processes.map((p) => [p.process, p.unsure?.reason])).toEqual([
      [A, 'Kein passender Schritt.'],
      [B, 'Kein passender Schritt.'],
    ]);
    await submitPlacement(
      f.agent,
      again.taskId,
      placementSubmission(again, [], {
        unsure: [
          { process: A, reason: 'Immer noch unklar.' },
          { process: B, reason: 'Immer noch unklar.' },
        ],
      }),
    );
  });

  it('queues for new or changed processes, never for a layout-only upload or a deletion', async () => {
    let before = await f.lastSeq();
    await f.put('verwaltung/antrag', [{ id: 'P_Antrag', name: 'Antrag stellen' }], 'moved');
    expect(await f.chainEvents(before)).toEqual([]);
    before = await f.lastSeq();
    await f.put('studium/einschreibung', [{ id: 'P_Einschreibung', name: 'Einschreibung' }]);
    const events = await f.events(before);
    // After the relation task of the new model, so relation events keep their order.
    expect(
      events.map((e) => `${e.type}:${(e.payload['kind'] as string | undefined) ?? ''}`),
    ).toEqual(['model.revised:', 'analysis.queued:relations', 'analysis.queued:placement']);
    expect(events.at(-1)?.payload).toMatchObject({ due: 1, reason: 'models changed' });
    const c = await only(f.agent, f.key);
    expect(c.input.processes.map((p) => p.process)).toEqual([C]);
    await submitPlacement(f.agent, c.taskId, placementSubmission(c, [item('step-lehre', C)]));
    before = await f.lastSeq();
    const model = (
      (await (await t.asOwner(`/api/v1/projects/${f.key}/models`)).json()) as {
        items: { id: string; key: string }[];
      }
    ).items.find((m) => m.key === 'studium/einschreibung');
    expect(
      (await t.asOwner(`/api/v1/projects/${f.key}/models/${model?.id}`, { method: 'DELETE' }))
        .status,
    ).toBe(204);
    expect(await f.chainEvents(before)).toEqual([]);
  });

  it('never queues for a human decision, which makes the process due for the next task', async () => {
    const proposed = await json<PostPlacementsResult>(
      await post(f.agent, chainPath(f.key, '/placements'), {
        kind: 'propose',
        placements: [item('step-pruefung', A)],
      }),
    );
    const id = proposed.kind === 'propose' ? proposed.items[0]?.placementId : null;
    expect((await f.detail()).pipeline.due).toBe(0);
    const before = await f.lastSeq();
    expect(
      (await f.decide(id ?? '', { verdict: 'reject', reason: 'Gehört zur Ausgabe.' })).status,
    ).toBe(200);
    expect(await f.chainEvents(before)).toEqual([]);
    expect((await f.detail()).pipeline).toMatchObject({ due: 1, task: { state: 'done' } });
    expect(await f.requeue()).toMatchObject({ outcome: 'queued' });
    expect(await f.requeue()).toMatchObject({ outcome: 'open' });
  });

  it('cancels the open task when the chain is deleted', async () => {
    const before = await f.lastSeq();
    expect((await t.asOwner(chainPath(f.key), { method: 'DELETE' })).status).toBe(204);
    expect(await f.chainEvents(before)).toEqual(['analysis.cancelled value chain deleted']);
    expect(await f.requeue()).toEqual({ outcome: 'not-found', taskId: null });
    expect(await claimPlacement(f.agent, { projectId: f.key })).toEqual([]);
  });

  it('re-offers every process of a revived chain (new step generations)', async () => {
    const before = await f.lastSeq();
    await f.createChain();
    const queued = (await f.events(before)).filter((e) => e.type === 'analysis.queued');
    expect(queued.map((e) => e.payload)).toEqual([
      expect.objectContaining({ kind: 'placement', due: 2, reason: 'value chain saved' }),
    ]);
  });
});

// ------------------------------------------------------------------- kinds

describe('task kinds', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await Fixture.create('pl-kinds', {
      'a/eins': [{ id: 'P_Eins', name: 'Erster Vorgang' }],
      'b/zwei': [{ id: 'P_Zwei', name: 'Zweiter Vorgang' }],
    });
  });

  it('never gives a client of the default kinds a placement task, nor counts one', async () => {
    expect(await f.pending()).toBe(2);
    expect(await f.pending('&kinds=placement')).toBe(1);
    expect(await f.pending('&kinds=relations&kinds=placement')).toBe(3);
    const relations = await claim(f.agent, { projectId: f.key, max: 5 });
    expect(relations.map((c) => c.kind)).toEqual(['relations', 'relations']);
    expect(await f.pending()).toBe(0);
    expect(await f.pending('&kinds=placement')).toBe(1);
    // A model narrows to relations tasks.
    expect(
      await claimKinds(f.agent, { projectId: f.key, kinds: ['placement'], modelKey: 'a/eins' }),
    ).toEqual([]);
    for (const c of relations) {
      expect((await release(f.agent, c.taskId, c.leaseToken)).status).toBe(200);
    }
  });

  it('claims both kinds in one call', async () => {
    const items = await claimKinds(f.agent, {
      projectId: f.key,
      max: 5,
      kinds: ['relations', 'placement'],
    });
    expect(items.map((i) => i.kind).sort()).toEqual(['placement', 'relations', 'relations']);
    for (const c of items) {
      expect((await release(f.agent, c.taskId, c.leaseToken)).status).toBe(200);
    }
  });

  it('refuses duplicate, empty or unknown kinds', async () => {
    for (const kinds of [['placement', 'placement'], [], ['describe']]) {
      const res = await post(f.agent, '/api/v1/analyses/claim', { projectId: f.key, kinds });
      expect(res.status, JSON.stringify(kinds)).toBe(422);
    }
  });

  it('never lets two concurrent claims hold the chain task', async () => {
    const other = await f.newToken();
    const [a, b] = await Promise.all([
      claimKinds(f.agent, { projectId: f.key, max: 5, kinds: ['placement', 'relations'] }),
      claimKinds(other.agent, { projectId: f.key, max: 5, kinds: ['placement', 'relations'] }),
    ]);
    const all = [...(a ?? []), ...(b ?? [])];
    expect(all.filter((i) => i.kind === 'placement')).toHaveLength(1);
    expect(new Set(all.map((i) => i.taskId)).size).toBe(all.length);
  });
});

// -------------------------------------------------------- claim and submit

describe('claim and submit', () => {
  const A = 'm/a#P_A';
  const B = 'm/b#P_B';
  const C = 'm/c#P_C';
  const D = 'm/d#P_D';
  const E = 'm/e#P_E';
  let f: Fixture;
  let c: ClaimedPlacementAnalysis;

  beforeAll(async () => {
    f = await Fixture.create(
      'pl-flow',
      {
        'm/a': [{ id: 'P_A', name: 'Antrag aufnehmen' }],
        'm/b': [{ id: 'P_B', name: 'Bescheid drucken' }],
        'm/c': [{ id: 'P_C', name: 'Akte führen' }],
        'm/d': [{ id: 'P_D', name: 'Dokumente prüfen' }],
        'm/e': [{ id: 'P_E', name: 'Einladung senden' }],
      },
      null,
    );
    await f.createChain();
    // D has a home before the claim, so it is not in the task's input.
    await json(
      await post((p, i) => t.asOwner(p, i), chainPath(f.key, '/placements'), {
        kind: 'manual',
        step: 'step-pruefung',
        process: D,
        rationale: 'Gehört zur Prüfung.',
      }),
    );
  });

  it('renders the claim input at the head', async () => {
    c = await only(f.agent, f.key);
    expect(c).toMatchObject({
      kind: 'placement',
      projectKey: f.key,
      valueChainKey: 'main',
      rev: 1,
      attempt: 1,
      procedure: PLACEMENTS_PROCEDURE,
    });
    expect(c.revisionId).toMatch(/^vcr_/);
    expect(c.input).toMatchObject({
      format: 'proa-claim-placement/1',
      truncated: false,
      remaining: 0,
      valueChain: { key: 'main', rev: 1, revisionId: c.revisionId },
    });
    expect(c.input.processes.map((p) => p.process)).toEqual([A, B, C, E]);
    expect(c.input.steps.map((s) => s.id)).toContain('step-pruefung');
    expect(c.input.steps[0]).not.toHaveProperty('bounds');
    expect(c.input.examples).toEqual([
      { step: 'step-pruefung', process: D, name: 'Dokumente prüfen' },
    ]);
  });

  it('refuses items of the other kind, both ways', async () => {
    const wrong = await submitRaw(
      f.agent,
      c.taskId,
      placementSubmission(c, [], {
        relations: [{ type: 'message', from: `${A}`, to: `${B}`, confidence: 1 }],
      }),
    );
    expect(wrong.status).toBe(422);
    expect(await problemOf(wrong)).toMatchObject({ code: 'wrong-task-kind' });
    const other = await Fixture.create('pl-flow-rel', { 'x/y': [{ id: 'P_Y', name: 'Y' }] }, null);
    const [r] = await claim(other.agent, { projectId: other.key });
    if (!r) throw new Error('no relations task');
    const back = await submitRaw(other.agent, r.taskId, {
      leaseToken: r.leaseToken,
      submissionId: crypto.randomUUID(),
      procedure: r.procedure,
      relations: [],
      unsure: [{ process: 'x/y#P_Y', reason: 'unklar' }],
    });
    expect(back.status).toBe(422);
    expect(await problemOf(back)).toMatchObject({ code: 'wrong-task-kind' });
  });

  it('answers per item and records a verdict per process', async () => {
    // E's model is deleted during the lease: an unsure verdict on it names no head process.
    const model = (
      (await (await t.asOwner(`/api/v1/projects/${f.key}/models`)).json()) as {
        items: { id: string; key: string }[];
      }
    ).items.find((m) => m.key === 'm/e');
    await t.asOwner(`/api/v1/projects/${f.key}/models/${model?.id}`, { method: 'DELETE' });
    const body = placementSubmission(
      c,
      [
        item('step-pruefung', A),
        item('step-pruefung', A),
        item('step-ausgabe', B, { confidence: 2 }),
        item('step-pruefung', D),
        item('step-nirgends', C),
        item('@outside', A, { rationale: ' ' }),
      ],
      {
        unsure: [
          { process: C, reason: 'Kein Schritt für Aktenführung.' },
          { process: C, reason: '' },
          { process: C, reason: 'x'.repeat(1001) },
          { process: C, reason: 'Steuer\u0001zeichen' },
          { process: C, reason: 'noch einmal' },
          { process: 'kein ref', reason: 'x' },
          { process: D, reason: 'x' },
          { process: E, reason: 'x' },
          { process: A, reason: 'x' },
        ],
        summary: 'Teilweise platziert.',
      },
    );
    const result = await submitPlacement(f.agent, c.taskId, body);
    expect(result.placements.items.map((i) => i.result)).toEqual([
      'applied',
      'duplicate',
      'invalid:confidence-out-of-range',
      'invalid:outside-task-input',
      'invalid:unknown-step',
      'invalid:rationale-required',
    ]);
    expect(result.placements.counts).toEqual({
      applied: 1,
      duplicate: 1,
      suppressed: 0,
      reopened: 0,
      invalid: 4,
    });
    expect(result.unsure.items.map((i) => i.result)).toEqual([
      'stored',
      'invalid:reason-required',
      'invalid:reason-too-long',
      'invalid:control-characters',
      'duplicate',
      'invalid:malformed-ref',
      'invalid:outside-task-input',
      'invalid:unknown-process',
      'invalid:also-placed',
    ]);
    expect(result.unsure.counts).toEqual({ stored: 1, duplicate: 1, invalid: 7 });
    // B had only an invalid item, E only an invalid unsure item: no verdict, offered again.
    expect(result.skipped).toEqual({ count: 0, processes: [] });
    expect(result).toMatchObject({
      kind: 'placement',
      withdrawn: 0,
      followUp: false,
      replayed: false,
    });
    expect((await f.rows()).map((r) => [r.processRef, r.outcome, r.reason, r.taskId])).toEqual([
      [A, 'proposed', null, c.taskId],
      [C, 'unsure', 'Kein Schritt für Aktenführung.', c.taskId],
    ]);
    // The basis of the pipeline proposal: the claim's structure and the model's facts.
    const placed = await f.placementOn('step-pruefung', A);
    const history = await f.timeline(placed?.id ?? '');
    expect(history.at(-1)).toMatchObject({
      kind: 'proposal',
      submissionId: expect.stringMatching(/^sbm_/) as unknown,
    });

    // Replay and a second submission.
    expect(await submitPlacement(f.agent, c.taskId, body)).toEqual({ ...result, replayed: true });
    const again = await submitRaw(f.agent, c.taskId, {
      ...body,
      submissionId: crypto.randomUUID(),
    });
    expect(again.status).toBe(409);
    expect(await problemOf(again)).toMatchObject({ code: 'already-submitted' });
    const done = (await f.events()).filter((e) => e.type === 'analysis.done').at(-1);
    expect(done?.payload).toMatchObject({
      kind: 'placement',
      counts: result.placements.counts,
      unsure: result.unsure.counts,
      withdrawn: 0,
      skipped: 0,
      followUp: false,
      late: false,
    });
    const stored = await json<{ payload: Record<string, unknown>; result: unknown }>(
      await t.asOwner(`/api/v1/projects/${f.key}/analyses/${c.taskId}/submission`),
    );
    expect(stored.payload).not.toHaveProperty('leaseToken');
    expect(stored.result).toEqual(result);
  });

  it('shows the verdicts: unsure in the chain detail, judged in the unplaced list', async () => {
    const detail = await f.detail();
    expect(detail.unsure).toEqual([
      expect.objectContaining({
        process: C,
        reason: 'Kein Schritt für Aktenführung.',
        current: true,
      }),
    ]);
    expect(detail.pipeline).toMatchObject({ stage: 'waiting_for_review', due: 1, unsure: 1 });
    const unplaced = await f.unplaced();
    expect(unplaced.find((u) => u.process === C)?.judged).toMatchObject({
      outcome: 'unsure',
      reason: 'Kein Schritt für Aktenführung.',
      by: expect.stringMatching(/^agent:/) as unknown,
    });
    expect(unplaced.find((u) => u.process === B)).not.toHaveProperty('judged');
  });

  it('offers only the processes without a verdict, and remembers a skipped one', async () => {
    expect(await f.requeue()).toMatchObject({ outcome: 'queued' });
    const next = await only(f.agent, f.key);
    expect(next.input.processes.map((p) => p.process)).toEqual([B]);
    const result = await submitPlacement(f.agent, next.taskId, placementSubmission(next, []));
    expect(result.skipped).toEqual({ count: 1, processes: [B] });
    expect((await f.rows()).find((r) => r.processRef === B)?.outcome).toBe('skipped');
    expect(await f.requeue()).toEqual({ outcome: 'nothing-due', taskId: null });
  });

  it('offers an unsure process again with its reason once its input changed', async () => {
    await f.put('m/c', [{ id: 'P_C', name: 'Akte führen', doc: 'Führt die Studierendenakte.' }]);
    const next = await only(f.agent, f.key);
    expect(next.input.processes.map((p) => [p.process, p.unsure?.reason])).toEqual([
      [C, 'Kein Schritt für Aktenführung.'],
    ]);
    expect(next.input.processes[0]?.doc).toBe('Führt die Studierendenakte.');
    await submitPlacement(
      f.agent,
      next.taskId,
      placementSubmission(next, [item('step-ausgabe', C)]),
    );
  });
});

// -------------------------------------------------------------------- lease

describe('lease, release, failure and late submits', () => {
  const clock = testClock();
  let lt: TestApp;
  let f: Fixture;
  const A = 'l/a#P_A';

  beforeAll(async () => {
    lt = startTestApp(database, { clock });
    const project = await lt.createProject('pl-lease');
    await lt.putModel(project.key, 'l/a', fakeBpmn({ processes: [{ id: 'P_A', name: 'Ablauf' }] }));
    f = new Fixture(project.key);
    f.project = project;
    f.token = await lt.createToken(project.key, ['proa:read', 'proa:propose']);
    f.agent = (path, init) => lt.asToken(f.token.secret, path, init);
    await json(
      await lt.asOwner(`/api/v1/projects/${project.key}/value-chains`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'main', content: doc() }),
      }),
      201,
    );
  });

  it('hands a released task back without counting the attempt', async () => {
    const c = await only(f.agent, f.key);
    expect(c.attempt).toBe(1);
    const before = await f.lastSeq();
    expect((await release(f.agent, c.taskId, c.leaseToken, 'keine Zeit')).status).toBe(200);
    const released = (await f.events(before)).find((e) => e.type === 'analysis.released');
    expect(released?.payload).toMatchObject({
      kind: 'placement',
      key: 'main',
      reason: 'keine Zeit',
    });
    expect(released?.payload).not.toHaveProperty('modelKey');
    expect((await only(f.agent, f.key)).attempt).toBe(1);
  });

  it('fails the task when its lease expires at the last attempt; a late submit still counts', async () => {
    const other = (path: string, init?: RequestInit) => lt.asToken(f.token.secret, path, init);
    let last: ClaimedPlacementAnalysis | undefined;
    for (let attempt = 2; attempt <= 3; attempt++) {
      clock.advance(16 * MINUTE);
      last = await only(other, f.key);
      expect(last.attempt).toBe(attempt);
    }
    clock.advance(16 * MINUTE);
    const before = await f.lastSeq();
    expect(await claimPlacement(f.agent, { projectId: f.key })).toEqual([]);
    const failed = (await f.events(before)).find((e) => e.type === 'analysis.failed');
    expect(failed?.payload).toMatchObject({ kind: 'placement', key: 'main', attempts: 3 });
    const detail = await json<ValueChainDetail>(await lt.asOwner(chainPath(f.key)));
    expect(detail.pipeline).toMatchObject({
      stage: 'agent_failed',
      task: { state: 'failed', attempts: 3 },
    });
    if (!last) throw new Error('no claim');
    const late = await submitPlacement(
      other,
      last.taskId,
      placementSubmission(last, [item('step-lehre', A)]),
    );
    expect(late.placements.counts.applied).toBe(1);
    expect(
      (await f.events()).filter((e) => e.type === 'analysis.done').at(-1)?.payload,
    ).toMatchObject({
      late: true,
    });
  });

  it('cancels a late submit when a newer chain task exists', async () => {
    // A changed process is due again.
    await lt.putModel(f.key, 'l/a', fakeBpmn({ processes: [{ id: 'P_A', name: 'Ablauf neu' }] }));
    let last = await only(f.agent, f.key);
    for (let attempt = 2; attempt <= 3; attempt++) {
      clock.advance(16 * MINUTE);
      last = await only(f.agent, f.key);
      expect(last.attempt).toBe(attempt);
    }
    clock.advance(16 * MINUTE);
    expect(await claimPlacement(f.agent, { projectId: f.key })).toEqual([]);
    expect(
      (
        await json<RequeueResult>(
          await post((p, i) => lt.asOwner(p, i), `/api/v1/projects/${f.key}/analyses/requeue`, {
            valueChain: true,
          }),
        )
      ).valueChain,
    ).toMatchObject({ outcome: 'queued' });
    const late = await submitRaw(f.agent, last.taskId, placementSubmission(last, []));
    expect(late.status).toBe(409);
    expect(await problemOf(late)).toMatchObject({
      code: 'task-cancelled',
      detail: 'superseded by a newer analysis task of the value chain',
    });
  });
});

// ------------------------------------------------------------- supersession

describe('supersession', () => {
  const P1 = 's/eins#P_Eins';
  const P2 = 's/zwei#P_Zwei';
  let f: Fixture;
  let x: Caller;
  let y: Caller;

  beforeAll(async () => {
    f = await Fixture.create(
      'pl-super',
      {
        's/eins': [{ id: 'P_Eins', name: 'Erstbearbeitung' }],
        's/zwei': [{ id: 'P_Zwei', name: 'Prüfungen' }],
      },
      null,
    );
    await f.createChain();
    x = f.agent;
    y = (await f.newToken()).agent;
  });

  it('withdraws stale pipeline proposals of any principal, never rule or ad-hoc ones', async () => {
    const c1 = await only(x, f.key);
    // P2 equals the step name "Prüfungen": the rule tier proposed it.
    expect(c1.input.processes.find((p) => p.process === P2)?.proposals).toEqual([
      expect.objectContaining({
        step: 'step-pruefungen',
        source: 'rule',
        by: 'proa-rules',
        tier: 'key',
      }),
    ]);
    await submitPlacement(
      x,
      c1.taskId,
      placementSubmission(c1, [item('step-pruefung', P1), item('step-pruefungen', P2)]),
    );
    await f.save(renamed('step-lehre', 'Lehrbetrieb'));
    const c2 = await only(y, f.key);
    expect(c2.input.processes.map((p) => p.process)).toEqual([P1, P2]);
    const r2 = await submitPlacement(
      y,
      c2.taskId,
      placementSubmission(c2, [item('step-ausgabe', P1)], {
        unsure: [{ process: P2, reason: 'Unklar.' }],
      }),
    );
    // Both of x's proposals rest on the old structure.
    expect(r2.withdrawn).toBe(2);
    const stale = await f.placementOn('step-pruefung', P1);
    expect(stale?.status).toBe('obsolete');
    const withdrawal = (await f.timeline(stale?.id ?? '')).at(-1);
    expect(withdrawal).toMatchObject({
      kind: 'withdrawal',
      rationale: `Veraltet: ersetzt durch Einreichung ${(await f.events()).filter((e) => e.type === 'analysis.done').at(-1)?.payload['submissionId'] as string}`,
    });
    // The rule tier's proposal stays.
    expect((await f.placementOn('step-pruefungen', P2))?.status).toBe('proposed');
  });

  it('keeps other principals’ current proposals and replaces the caller’s unrepeated ones', async () => {
    // x proposes P1 ad hoc, then a human note makes P1 due (the basis stays the same).
    const adHoc = await json<PostPlacementsResult>(
      await post(x, chainPath(f.key, '/placements'), {
        kind: 'propose',
        placements: [item('step-lehre', P1)],
      }),
    );
    expect(adHoc.kind === 'propose' && adHoc.items[0]?.result).toBe('applied');
    const ys = await f.placementOn('step-ausgabe', P1);
    expect(
      (
        await post(
          (p, i) => t.asOwner(p, i),
          chainPath(f.key, `/placements/${ys?.id ?? ''}/notes`),
          {
            text: 'Bitte genauer prüfen.',
          },
        )
      ).status,
    ).toBe(201);
    expect(await f.requeue()).toMatchObject({ outcome: 'queued' });
    const c3 = await only(x, f.key);
    expect(c3.input.processes.map((p) => p.process)).toEqual([P1]);
    expect(c3.input.processes[0]?.proposals.map((p) => [p.step, p.mine === true]).sort()).toEqual([
      ['step-ausgabe', false],
      ['step-lehre', true],
    ]);
    const r3 = await submitPlacement(
      x,
      c3.taskId,
      placementSubmission(c3, [item('step-pruefung', P1)]),
    );
    // y's proposal is current (same basis): it stays, so the reviewer sees the disagreement.
    expect(r3.withdrawn).toBe(0);
    expect((await f.placementOn('step-ausgabe', P1))?.status).toBe('proposed');
    // Another note: x now places P1 elsewhere; its earlier pipeline proposal is replaced.
    await post((p, i) => t.asOwner(p, i), chainPath(f.key, `/placements/${ys?.id ?? ''}/notes`), {
      text: 'Noch einmal.',
    });
    expect(await f.requeue()).toMatchObject({ outcome: 'queued' });
    const c4 = await only(x, f.key);
    const r4 = await submitPlacement(
      x,
      c4.taskId,
      placementSubmission(c4, [item('step-pruefungen', P1)]),
    );
    expect(r4.withdrawn).toBe(1);
    const replaced = await f.placementOn('step-pruefung', P1);
    expect(replaced?.status).toBe('obsolete');
    expect((await f.timeline(replaced?.id ?? '')).at(-1)?.rationale).toMatch(
      /^Ersetzt durch Einreichung [0-9a-f-]{36}$/,
    );
    // y's current proposal and x's ad-hoc proposal stay.
    expect((await f.placementOn('step-ausgabe', P1))?.status).toBe('proposed');
    expect((await f.placementOn('step-lehre', P1))?.status).toBe('proposed');
  });
});

// ------------------------------------------------------- saves during a lease

describe('a save during the lease', () => {
  const P1 = 'w/eins#P_Eins';
  const P2 = 'w/zwei#P_Zwei';
  let f: Fixture;

  beforeAll(async () => {
    f = await Fixture.create(
      'pl-save',
      {
        'w/eins': [{ id: 'P_Eins', name: 'Erfassung' }],
        'w/zwei': [{ id: 'P_Zwei', name: 'Versand' }],
      },
      null,
    );
    await f.createChain();
  });

  it('never cancels the claim; the submission queues the follow-up', async () => {
    const c = await only(f.agent, f.key);
    const before = await f.lastSeq();
    await f.save(STEPS.filter((s) => s.id !== 'step-ausgabe'));
    expect(await f.chainEvents(before)).toEqual([]);
    const tasks = await json<AnalysisTaskPage>(
      await t.asOwner(`/api/v1/projects/${f.key}/analyses?kind=placement&state=claimed`),
    );
    expect(tasks.items.map((i) => i.id)).toEqual([c.taskId]);
    const result = await submitPlacement(
      f.agent,
      c.taskId,
      placementSubmission(c, [item('step-ausgabe', P1), item('step-lehre', P2)]),
    );
    // The step was deleted meanwhile: P1's only item is invalid, so P1 is offered again.
    expect(result.placements.items.map((i) => i.result)).toEqual([
      'invalid:unknown-step',
      'applied',
    ]);
    expect(result.followUp).toBe(true);
    expect(await f.chainEvents(before)).toEqual(['analysis.done', 'analysis.queued follow-up']);
    const next = await only(f.agent, f.key);
    // P2 too: its proposal rests on the structure the save replaced.
    expect(next.input.processes.map((p) => p.process)).toEqual([P1, P2]);
    const r = await submitPlacement(
      f.agent,
      next.taskId,
      placementSubmission(next, [item('step-pruefung', P1), item('step-lehre', P2)]),
    );
    // P2's own proposal on the old structure is replaced by its repetition on the new one.
    expect(r).toMatchObject({ withdrawn: 0, followUp: false });
    const p2 = await f.placementOn('step-lehre', P2);
    expect((await f.timeline(p2?.id ?? '')).filter((a) => a.kind === 'proposal')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- truncation

describe('truncation', () => {
  it('queues exactly one follow-up for 60 processes, and none after it', async () => {
    const f = await Fixture.create('pl-many', { 'v/viele': procs('V', 60) });
    const c = await only(f.agent, f.key);
    expect(c.input).toMatchObject({ truncated: true, remaining: 10 });
    expect(c.input.processes).toHaveLength(50);
    const r1 = await submitPlacement(
      f.agent,
      c.taskId,
      placementSubmission(c, [], {
        unsure: c.input.processes.map((p) => ({ process: p.process, reason: 'Unklar.' })),
      }),
    );
    expect(r1.followUp).toBe(true);
    const next = await only(f.agent, f.key);
    expect(next.input).toMatchObject({ truncated: false, remaining: 0 });
    expect(next.input.processes).toHaveLength(10);
    const r2 = await submitPlacement(
      f.agent,
      next.taskId,
      placementSubmission(next, [], {
        unsure: next.input.processes.map((p) => ({ process: p.process, reason: 'Unklar.' })),
      }),
    );
    expect(r2.followUp).toBe(false);
    expect(await f.pending('&kinds=placement')).toBe(0);
    expect((await f.detail()).pipeline).toMatchObject({ due: 0, unsure: 60 });
  });

  it('queues no follow-up without progress (only invalid items)', async () => {
    const f = await Fixture.create('pl-noprog', { 'v/viele': procs('W', 60) });
    const c = await only(f.agent, f.key);
    const r = await submitPlacement(
      f.agent,
      c.taskId,
      placementSubmission(
        c,
        c.input.processes.map((p) => item('step-lehre', p.process, { confidence: 3 })),
      ),
    );
    expect(r).toMatchObject({ followUp: false, skipped: { count: 0 } });
    expect(await f.pending('&kinds=placement')).toBe(0);
    expect((await f.detail()).pipeline.due).toBe(60);
    expect(await f.rows()).toEqual([]);
  });
});

// ------------------------------------------------------- lost judgements

describe('lost judgements', () => {
  const P1 = 'r/eins#P_Eins';
  const P2 = 'r/zwei#P_Zwei';

  it('forgets a withdrawn pipeline proposal and queues the process again', async () => {
    const f = await Fixture.create('pl-withdraw', {
      'r/eins': [{ id: 'P_Eins', name: 'Eins' }],
      'r/zwei': [{ id: 'P_Zwei', name: 'Zwei' }],
    });
    const c = await only(f.agent, f.key);
    await submitPlacement(
      f.agent,
      c.taskId,
      placementSubmission(c, [item('step-lehre', P1)], {
        unsure: [{ process: P2, reason: 'Unklar.' }],
      }),
    );
    const placed = await f.placementOn('step-lehre', P1);
    const before = await f.lastSeq();
    expect(
      (
        await f.agent(chainPath(f.key, `/placements/${placed?.id ?? ''}/proposal`), {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    expect(await f.chainEvents(before)).toEqual(['analysis.queued judgement withdrawn']);
    expect((await f.rows()).map((r) => r.processRef)).toEqual([P2]);
    const next = await only(f.agent, f.key);
    expect(next.input.processes.map((p) => p.process)).toEqual([P1]);
  });

  it('forgets a revoked token’s verdicts, releases its chain task and queues', async () => {
    const f = await Fixture.create('pl-revoke', {
      'r/eins': [{ id: 'P_Eins', name: 'Eins' }],
      'r/zwei': [{ id: 'P_Zwei', name: 'Zwei' }],
    });
    const c = await only(f.agent, f.key);
    await submitPlacement(
      f.agent,
      c.taskId,
      placementSubmission(c, [item('step-lehre', P1)], {
        unsure: [{ process: P2, reason: 'Unklar.' }],
      }),
    );
    expect(await f.rows()).toHaveLength(2);
    const before = await f.lastSeq();
    expect(
      (
        await t.asOwner(`/api/v1/projects/${f.key}/agent-tokens/${f.token.id}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(204);
    expect(await f.chainEvents(before)).toEqual(['analysis.queued judgement withdrawn']);
    expect(await f.rows()).toEqual([]);
    const other = await f.newToken();
    const next = await only(other.agent, f.key);
    expect(next.input.processes.map((p) => p.process)).toEqual([P1, P2]);

    // Revoked while it holds the chain task: the task is released.
    const third = await f.newToken();
    expect((await release(other.agent, next.taskId, next.leaseToken)).status).toBe(200);
    await only(third.agent, f.key);
    const mid = await f.lastSeq();
    await t.asOwner(`/api/v1/projects/${f.key}/agent-tokens/${third.token.id}`, {
      method: 'DELETE',
    });
    const released = (await f.events(mid)).find((e) => e.type === 'analysis.released');
    expect(released?.payload).toMatchObject({ kind: 'placement', key: 'main' });
    expect(await f.pending('&kinds=placement', other.agent)).toBe(1);
  });
});

// ------------------------------------------------------------------ ad hoc

describe('ad-hoc proposals are verdicts', () => {
  it('keeps a process an agent placed ad hoc out of the next placement task', async () => {
    const P1 = 'h/eins#P_Eins';
    const P2 = 'h/zwei#P_Zwei';
    const f = await Fixture.create('pl-adhoc', {
      'h/eins': [{ id: 'P_Eins', name: 'Eins' }],
      'h/zwei': [{ id: 'P_Zwei', name: 'Zwei' }],
    });
    await post(f.agent, chainPath(f.key, '/placements'), {
      kind: 'propose',
      placements: [item('step-lehre', P1)],
    });
    expect((await f.rows()).map((r) => [r.processRef, r.outcome, r.taskId])).toEqual([
      [P1, 'proposed', null],
    ]);
    const c = await only(f.agent, f.key);
    expect(c.input.processes.map((p) => p.process)).toEqual([P2]);
    // A human's ad-hoc proposal is no agent verdict.
    await post((p, i) => t.asOwner(p, i), chainPath(f.key, '/placements'), {
      kind: 'propose',
      placements: [item('step-lehre', P2)],
    });
    expect((await f.rows()).map((r) => r.processRef)).toEqual([P1]);
    // Withdrawing its ad-hoc proposal takes the agent's verdict back: P1 is due again.
    expect((await release(f.agent, c.taskId, c.leaseToken)).status).toBe(200);
    const placed = await f.placementOn('step-lehre', P1);
    const before = await f.lastSeq();
    expect(
      (
        await f.agent(chainPath(f.key, `/placements/${placed?.id ?? ''}/proposal`), {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    expect(await f.rows()).toEqual([]);
    // The released task is queued: its claim renders the head.
    expect(await f.chainEvents(before)).toEqual([]);
    const again = await only(f.agent, f.key);
    expect(again.input.processes.map((p) => p.process)).toEqual([P1, P2]);
  });
});

// ------------------------------------------------------- what a claim shows

describe('only what a claim shows moves an input hash', () => {
  const owner = (p: string, i?: RequestInit) => t.asOwner(p, i);

  it('shows a note on a proposed placement in the claim the note made due', async () => {
    const P1 = 'n/eins#P_Eins';
    const P2 = 'n/zwei#P_Zwei';
    const f = await Fixture.create('pl-note', {
      'n/eins': [{ id: 'P_Eins', name: 'Eingang' }],
      'n/zwei': [{ id: 'P_Zwei', name: 'Zweitschrift' }],
    });
    const c1 = await only(f.agent, f.key);
    await submitPlacement(
      f.agent,
      c1.taskId,
      placementSubmission(c1, [item('step-pruefung', P1)], {
        unsure: [{ process: P2, reason: 'Unklar.' }],
      }),
    );
    expect((await f.detail()).pipeline.due).toBe(0);
    const proposed = await f.placementOn('step-pruefung', P1);
    expect(proposed?.status).toBe('proposed');
    // A reviewer's remark without a decision: P1 is due, nothing is queued by it.
    const before = await f.lastSeq();
    expect(
      (
        await post(owner, chainPath(f.key, `/placements/${proposed?.id ?? ''}/notes`), {
          text: 'Eher Bescheidausgabe?',
        })
      ).status,
    ).toBe(201);
    expect(await f.chainEvents(before)).toEqual([]);
    expect((await f.detail()).pipeline).toMatchObject({ due: 1, task: { state: 'done' } });
    // The next task (here a requeue; an upload does the same) shows the note on the proposal.
    expect(await f.requeue()).toMatchObject({ outcome: 'queued' });
    const c2 = await only(f.agent, f.key);
    expect(c2.input.processes.map((p) => p.process)).toEqual([P1]);
    expect(c2.input.processes[0]?.proposals).toEqual([
      expect.objectContaining({
        step: 'step-pruefung',
        status: 'proposed',
        mine: true,
        notes: [{ text: 'Eher Bescheidausgabe?', at: expect.any(String) as unknown }],
      }),
    ]);
    expect(c2.input.processes[0]?.decisions).toEqual([]);
  });

  it('re-offers nothing after saves that only add an org unit, during a lease or after it', async () => {
    const P1 = 'o/eins#P_Eins';
    const P2 = 'o/zwei#P_Zwei';
    const f = await Fixture.create('pl-org', {
      'o/eins': [{ id: 'P_Eins', name: 'Erfassung' }],
      'o/zwei': [{ id: 'P_Zwei', name: 'Zustellung' }],
    });
    const withOrg = (name: string) =>
      chain({
        steps: STEPS,
        sequence: [['step-verwaltung', 'step-studium']],
        orgUnits: [{ id: 'org-amt', name, owns: ['step-pruefung'] }],
      });
    const saveOrg = async (name: string) => {
      const r = await json<SaveValueChainResult>(
        await t.asOwner(chainPath(f.key, '/content'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'if-match': `"r${f.rev}"` },
          body: JSON.stringify(withOrg(name)),
        }),
      );
      expect(r.outcome).toBe('revised');
      f.rev = r.valueChain?.headRev ?? f.rev;
      return r;
    };
    const c = await only(f.agent, f.key);
    const before = await f.lastSeq();
    // During the lease: the structure hash moves (org units count there), the claim's steps not.
    const saved = await saveOrg('Studierendenamt');
    expect(saved.revision?.structureHash).not.toBe(c.input.valueChain.structureHash);
    const r = await submitPlacement(
      f.agent,
      c.taskId,
      placementSubmission(c, [], {
        unsure: [
          { process: P1, reason: 'Unklar.' },
          { process: P2, reason: 'Unklar.' },
        ],
      }),
    );
    expect(r.followUp).toBe(false);
    // After it: nothing queued, nothing due.
    await saveOrg('Prüfungsamt');
    expect(await f.chainEvents(before)).toEqual(['analysis.done']);
    expect((await f.detail()).pipeline).toMatchObject({ due: 0, unsure: 2 });
    expect(await f.requeue()).toMatchObject({ outcome: 'nothing-due' });
  });

  it('re-offers only the process whose own fields changed, not its sibling in the same model', async () => {
    const X = 's/beide#P_X';
    const Y = 's/beide#P_Y';
    const model = (doc: string, task = 'Prüfen') => [
      { id: 'P_X', name: 'Erfassung', doc },
      {
        id: 'P_Y',
        name: 'Zustellung',
        elements: [{ kind: 'task' as const, id: 'T_Y', name: task }],
      },
    ];
    const f = await Fixture.create('pl-sibling', {}, null);
    await f.put('s/beide', model('Alt.'));
    await f.createChain();
    const c1 = await only(f.agent, f.key);
    expect(c1.input.processes.map((p) => p.process)).toEqual([X, Y]);
    await submitPlacement(
      f.agent,
      c1.taskId,
      placementSubmission(c1, [item('step-pruefung', X), item('step-ausgabe', Y)]),
    );
    // P_X's documentation changes: only P_X is due.
    let before = await f.lastSeq();
    await f.put('s/beide', model('Neu.'));
    expect(await f.chainEvents(before)).toEqual(['analysis.queued models changed']);
    expect((await f.detail()).pipeline.due).toBe(1);
    const c2 = await only(f.agent, f.key);
    expect(c2.input.processes.map((p) => p.process)).toEqual([X]);
    const r = await submitPlacement(
      f.agent,
      c2.taskId,
      placementSubmission(c2, [item('step-pruefung', X)]),
    );
    expect(r.withdrawn).toBe(0);
    // P_Y's proposal rests on its unchanged input: it stays.
    expect((await f.placementOn('step-ausgabe', Y))?.status).toBe('proposed');
    // A task label inside P_Y changes the model's facts, but nothing a claim shows.
    before = await f.lastSeq();
    await f.put('s/beide', model('Neu.', 'Versenden'));
    expect(await f.chainEvents(before)).toEqual([]);
    expect((await f.detail()).pipeline.due).toBe(0);
  });
});

// ------------------------------------------------- work without a task

describe('list_unplaced_processes beside a claimed task', () => {
  it('marks the processes of the chain task an agent holds, until it submits or its lease ends', async () => {
    const clock = testClock();
    const lt = startTestApp(database, { clock });
    const P1 = 'u/eins#P_Eins';
    const P2 = 'u/zwei#P_Zwei';
    const project = await lt.createProject('pl-intask');
    for (const [model, id] of [
      ['u/eins', 'P_Eins'],
      ['u/zwei', 'P_Zwei'],
    ] as const) {
      await lt.putModel(
        project.key,
        model,
        fakeBpmn({ processes: [{ id, name: `Vorgang ${id}` }] }),
      );
    }
    const token = await lt.createToken(project.key, ['proa:read', 'proa:propose']);
    const agent: Caller = (path, init) => lt.asToken(token.secret, path, init);
    await json(
      await lt.asOwner(`/api/v1/projects/${project.key}/value-chains`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'main', content: doc() }),
      }),
      201,
    );
    const unplaced = async () =>
      (await json<UnplacedProcessPage>(await agent(chainPath(project.key, '/unplaced-processes'))))
        .items;
    expect((await unplaced()).filter((u) => u.inTask)).toEqual([]);

    const c = await only(agent, project.key);
    const marked = await unplaced();
    expect(marked.map((u) => [u.process, u.inTask?.taskId])).toEqual([
      [P1, c.taskId],
      [P2, c.taskId],
    ]);
    expect(marked[0]?.inTask).toEqual({
      taskId: c.taskId,
      claimedBy: expect.stringMatching(/^agent:/) as unknown,
      leaseUntil: c.leaseUntil,
    });
    // An expired lease holds nothing: an agent may work the processes ad hoc.
    clock.advance(16 * MINUTE);
    expect((await unplaced()).filter((u) => u.inTask)).toEqual([]);
    // Claimed again, then submitted: the verdicts show as judged instead.
    const again = await only(agent, project.key);
    expect((await unplaced()).filter((u) => u.inTask)).toHaveLength(2);
    await submitPlacement(
      agent,
      again.taskId,
      placementSubmission(again, [], {
        unsure: [
          { process: P1, reason: 'Unklar.' },
          { process: P2, reason: 'Unklar.' },
        ],
      }),
    );
    const after = await unplaced();
    expect(after.filter((u) => u.inTask)).toEqual([]);
    expect(after.map((u) => u.judged?.outcome)).toEqual(['unsure', 'unsure']);
  });
});

// --------------------------------------------------------------- server start

describe('the server start', () => {
  it('queues the first placement task of a chain that never had one, once', async () => {
    const P1 = 'q/eins#P_Eins';
    const f = await Fixture.create('pl-start', {
      'q/eins': [{ id: 'P_Eins', name: 'Erster Vorgang' }],
      'q/zwei': [{ id: 'P_Zwei', name: 'Zweiter Vorgang' }],
    });
    // As migration 0008 leaves a chain of M4a: no placement task at all.
    await database.db.execute(
      sql`DELETE FROM analysis_task WHERE project_id = ${f.project.id} AND kind = 'placement'`,
    );
    expect((await f.detail()).pipeline).toMatchObject({ task: null, due: 2 });
    expect(await f.pending('&kinds=placement')).toBe(0);
    let before = await f.lastSeq();
    expect(await t.useCases.queueFirstPlacementTasks()).toBeGreaterThanOrEqual(1);
    const queued = (await f.events(before)).filter((e) => e.type === 'analysis.queued');
    expect(queued.map((e) => e.payload)).toEqual([
      expect.objectContaining({ kind: 'placement', due: 2, reason: 'server start' }),
    ]);
    expect(await f.pending('&kinds=placement')).toBe(1);
    // A restart finds the task: nothing more.
    before = await f.lastSeq();
    expect(await t.useCases.queueFirstPlacementTasks()).toBe(0);
    expect(await f.chainEvents(before)).toEqual([]);
    // Once the chain has had a task, what a human decision makes due waits for a trigger.
    const c = await only(f.agent, f.key);
    await submitPlacement(f.agent, c.taskId, placementSubmission(c, [item('step-pruefung', P1)]));
    const proposed = await f.placementOn('step-pruefung', P1);
    expect(
      (await f.decide(proposed?.id ?? '', { verdict: 'reject', reason: 'Nein.' })).status,
    ).toBe(200);
    expect((await f.detail()).pipeline.due).toBe(1);
    before = await f.lastSeq();
    expect(await t.useCases.queueFirstPlacementTasks()).toBe(0);
    expect(await f.chainEvents(before)).toEqual([]);
  });
});

// ------------------------------------------------------------------- stages

describe('the stage of the chain', () => {
  it('walks waiting_for_agent → agent_working → waiting_for_review → waiting_for_clarification → incorporated', async () => {
    const P1 = 'g/eins#P_Eins';
    const empty = await Fixture.create('pl-stage-empty', {});
    expect((await empty.detail()).pipeline).toEqual({
      stage: 'incorporated',
      task: null,
      reviewItems: 0,
      heldItems: 0,
      due: 0,
      unsure: 0,
    });
    const f = await Fixture.create('pl-stage', { 'g/eins': [{ id: 'P_Eins', name: 'Eins' }] });
    expect((await f.detail()).pipeline).toMatchObject({ stage: 'waiting_for_agent', due: 1 });
    const c = await only(f.agent, f.key);
    expect((await f.detail()).pipeline).toMatchObject({
      stage: 'agent_working',
      task: { state: 'claimed', claimedBy: expect.stringMatching(/^agent:/) as unknown },
    });
    await submitPlacement(f.agent, c.taskId, placementSubmission(c, [item('step-lehre', P1)]));
    expect((await f.detail()).pipeline).toMatchObject({
      stage: 'waiting_for_review',
      reviewItems: 1,
      due: 0,
    });
    const p = await f.placementOn('step-lehre', P1);
    expect((await f.decide(p?.id ?? '', { verdict: 'hold', note: 'Rückfrage' })).status).toBe(200);
    expect((await f.detail()).pipeline).toMatchObject({
      stage: 'waiting_for_clarification',
      heldItems: 1,
      reviewItems: 0,
    });
    expect((await f.decide(p?.id ?? '', { verdict: 'accept' })).status).toBe(200);
    expect((await f.detail()).pipeline).toMatchObject({
      stage: 'incorporated',
      reviewItems: 0,
      heldItems: 0,
    });
  });
});

// --------------------------------------------------------------------- MCP

describe('over MCP', () => {
  const P1 = 'q/eins#P_Eins';
  const P2 = 'q/zwei#P_Zwei';
  let server: { url: string; close: () => Promise<void> };
  let client: Client;
  let f: Fixture;

  beforeAll(async () => {
    server = await listen(t.app.fetch);
    f = await Fixture.create('pl-mcp', {
      'q/eins': [{ id: 'P_Eins', name: 'Eins' }],
      'q/zwei': [{ id: 'P_Zwei', name: 'Zwei' }],
    });
    client = new Client({ name: 'placement-test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${f.token.secret}` } },
      }),
    );
    await client.listTools();
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text?: string }[]).map((c) => c.text ?? '').join('');
    return {
      isError: r.isError === true,
      data: (r.structuredContent ?? {}) as Record<string, unknown>,
      text,
    };
  };

  it('claims, submits and reads the stage with the agent tools', async () => {
    // The default kinds: relations tasks only.
    const relations = (await call('claim_analysis', { projectId: f.key, max: 5 })).data[
      'items'
    ] as { kind: string; taskId: string; leaseToken: string }[];
    expect(relations.map((r) => r.kind)).toEqual(['relations', 'relations']);
    for (const r of relations) {
      await call('release_analysis', { taskId: r.taskId, leaseToken: r.leaseToken });
    }
    const claimed = await call('claim_analysis', { projectId: f.key, kinds: ['placement'] });
    const [c] = claimed.data['items'] as ClaimedPlacementAnalysis[];
    expect(c).toMatchObject({ kind: 'placement', valueChainKey: 'main' });
    if (!c) throw new Error('no task');
    const wrong = await call('submit_analysis', {
      taskId: c.taskId,
      leaseToken: c.leaseToken,
      submissionId: crypto.randomUUID(),
      procedure: c.procedure,
      llmModel: 'sim-1',
      noLinks: [{ type: 'message', from: `${P1}`, to: `${P2}`, reason: 'x' }],
    });
    expect(wrong.isError).toBe(true);
    expect(JSON.parse(wrong.text)).toMatchObject({ code: 'wrong-task-kind', status: 422 });
    const submitted = await call('submit_analysis', {
      taskId: c.taskId,
      leaseToken: c.leaseToken,
      submissionId: crypto.randomUUID(),
      procedure: c.procedure,
      llmModel: 'sim-1',
      placements: [item('step-lehre', P1)],
      unsure: [{ process: P2, reason: 'Kein passender Schritt.' }],
    });
    expect(submitted.isError, submitted.text).toBe(false);
    expect(submitted.data).toMatchObject({
      kind: 'placement',
      placements: { counts: { applied: 1 } },
      unsure: { counts: { stored: 1 } },
      skipped: { count: 0 },
      followUp: false,
    });
    // The stored MCP payload has no relation defaults of the placement fields.
    const stored = await json<{ payload: Record<string, unknown> }>(
      await t.asOwner(`/api/v1/projects/${f.key}/analyses/${c.taskId}/submission`),
    );
    expect(stored.payload['placements']).toHaveLength(1);
    const detail = await call('get_value_chain', { projectId: f.key });
    expect(detail.data['pipeline']).toMatchObject({
      stage: 'waiting_for_review',
      due: 0,
      unsure: 1,
    });
    expect(detail.data['unsure']).toEqual([
      expect.objectContaining({ process: P2, current: true }),
    ]);
    const unplaced = await call('list_unplaced_processes', { projectId: f.key });
    expect(
      (unplaced.data['items'] as { process: string; judged?: unknown }[]).find(
        (u) => u.process === P2,
      )?.judged,
    ).toMatchObject({
      outcome: 'unsure',
    });
    const procedure = await call('get_procedure', { id: 'placements' });
    expect(procedure.data).toMatchObject({ id: 'proa-placements' });
  });
});

/** A relations submission of a stored MCP payload stays as it was (no placement fields). */
describe('relations payloads over MCP', () => {
  it('stores no placements or unsure fields', async () => {
    const server = await listen(t.app.fetch);
    const f = await Fixture.create(
      'pl-mcp-rel',
      { 'z/eins': [{ id: 'P_Eins', name: 'Eins' }] },
      null,
    );
    const client = new Client({ name: 'placement-test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${f.token.secret}` } },
      }),
    );
    try {
      const claimed = await client.callTool({
        name: 'claim_analysis',
        arguments: { projectId: f.key },
      });
      const [c] = (
        claimed.structuredContent as {
          items: { taskId: string; leaseToken: string; procedure: unknown; kind: string }[];
        }
      ).items;
      expect(c?.kind).toBe('relations');
      const r = await client.callTool({
        name: 'submit_analysis',
        arguments: {
          taskId: c?.taskId,
          leaseToken: c?.leaseToken,
          submissionId: crypto.randomUUID(),
          procedure: c?.procedure,
          llmModel: 'sim-1',
          relations: [],
        },
      });
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent).not.toHaveProperty('kind');
      const stored = await json<{ payload: Record<string, unknown> }>(
        await t.asOwner(`/api/v1/projects/${f.key}/analyses/${c?.taskId ?? ''}/submission`),
      );
      expect(Object.keys(stored.payload).sort()).toEqual([
        'costUsd',
        'llmModel',
        'noLinks',
        'procedure',
        'relations',
        'submissionId',
        'summary',
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
