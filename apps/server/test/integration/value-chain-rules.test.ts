/**
 * The rule tier's key proposals and the findings of the value chain over
 * REST (M4 S2) against PostgreSQL: a step whose link names a process, or
 * whose name equals a process name, gets a proposal under `proa-rules`
 * (`source_kind = 'rule'`, tier `key`, confidence 1.0, no client), derived
 * again on every save and model change and withdrawn when no longer derived
 * (rename, removed step, deleted process); a kept link re-asserts it on the
 * new anchor; human decisions suppress it and are never replaced; token
 * revocation leaves it alone; layout-only and unchanged saves write nothing.
 * The findings (`…/findings`, `get_value_chain`) follow the placements.
 * Synthetic chains only.
 */
import type {
  Placement,
  PlacementAssertionList,
  PlacementPage,
  PostPlacementsResult,
  Project,
  Ref,
  SaveValueChainResult,
  UnplacedProcessPage,
  ValueChainDetail,
  ValueChainFindingList,
} from '@proa/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createStore } from '../../src/db/store.ts';
import { RULE_WITHDRAWAL } from '../../src/domain/value-chain/rules.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { fakeBpmn } from '../support/fake-analysis.ts';
import { chain, chainPath, relationSide, type StepSpec } from '../support/value-chain.ts';

let database: TestDatabase;
let t: TestApp;
let project: Project;
let rules: string;

const P = 'vc-rules';
const MAHN = 'finanzen/mahnwesen#P_Mahn' as Ref;
const RECHNUNG = 'finanzen/rechnung#P_Rechnung' as Ref;
const AUFTRAG = 'vertrieb/auftrag#P_Auftrag' as Ref;
const VERSAND = 'lager/versand#P_Versand' as Ref;
const KASSE = 'x/kasse#P_Kasse' as Ref;

const MODELS: Record<string, string> = {
  'finanzen/mahnwesen': fakeBpmn({ processes: [{ id: 'P_Mahn', name: 'Mahnwesen' }] }),
  'finanzen/rechnung': fakeBpmn({ processes: [{ id: 'P_Rechnung', name: 'Rechnungsprüfung' }] }),
  'vertrieb/auftrag': fakeBpmn({
    processes: [
      {
        id: 'P_Auftrag',
        name: 'Auftrag',
        elements: [{ kind: 'call', id: 'Call_Versand', name: 'Versenden', ref: 'P_Versand' }],
      },
    ],
  }),
  'lager/versand': fakeBpmn({ processes: [{ id: 'P_Versand', name: 'Versand' }] }),
  'x/kasse': fakeBpmn({ processes: [{ id: 'P_Kasse', name: 'Kasse' }] }),
};

const LINK = `proa:process/${RECHNUNG}`;
const BASE: StepSpec[] = [
  { id: 'step-vertrieb', name: 'Vertrieb', x: 0 },
  { id: 'step-logistik', name: 'Logistik', x: 300 },
  { id: 'step-lieferung', name: 'Auslieferung', parent: 'step-logistik', x: 300, y: 100 },
  { id: 'step-fakt', name: 'Fakturierung', x: 600 },
  { id: 'step-mahn', name: 'Mahnwesen', parent: 'step-fakt', x: 600, y: 100 },
  { id: 'step-sonder', name: 'Sonderfälle', parent: 'step-fakt', link: LINK, x: 600, y: 200 },
  { id: 'step-kasse', name: 'Kasse', parent: 'step-fakt', x: 600, y: 300 },
];
const doc = (steps: StepSpec[] = BASE, dx = 0) =>
  chain({
    steps: steps.map((s) => ({ ...s, x: (s.x ?? 0) + dx })),
    sequence: [
      ['step-vertrieb', 'step-logistik'],
      ['step-logistik', 'step-fakt'],
    ],
  });
const renamed = (id: string, name: string, steps = BASE) =>
  steps.map((s) => (s.id === id ? { ...s, name } : s));

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

let rev = 0;
async function save(steps: StepSpec[], dx = 0): Promise<SaveValueChainResult> {
  const result = await json<SaveValueChainResult>(
    await t.asOwner(chainPath(P, '/content'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': `"r${rev}"` },
      body: JSON.stringify(doc(steps, dx)),
    }),
    200,
  );
  rev = result.valueChain?.headRev ?? rev;
  return result;
}

const store = () => createStore(database.db);
const events = (after = 0) =>
  store().read((tx) => tx.events.list(project.id, { afterSeq: after, limit: 10_000 }));
const lastSeq = async () => (await events()).at(-1)?.seq ?? 0;

async function placements(query = ''): Promise<Placement[]> {
  return (
    await json<PlacementPage>(await t.asOwner(chainPath(P, `/placements?limit=200${query}`)), 200)
  ).items;
}

async function on(step: string, process: Ref, query = ''): Promise<Placement | undefined> {
  return (await placements(query)).find((p) => p.elementId === step && p.process === process);
}

async function timeline(id: string) {
  return (
    await json<PlacementAssertionList>(
      await t.asOwner(chainPath(P, `/placements/${id}/assertions`)),
      200,
    )
  ).items;
}

async function decide(id: string, body: unknown) {
  return json(await t.asOwner(chainPath(P, `/placements/${id}/decision`), post(body)), 200);
}

async function findings(): Promise<ValueChainFindingList['items']> {
  return (await json<ValueChainFindingList>(await t.asOwner(chainPath(P, '/findings')), 200)).items;
}

async function modelId(key: string): Promise<string> {
  const model = await store().read((tx) => tx.models.findByKey(project.id, key));
  if (!model) throw new Error(`${key} not stored`);
  return model.id;
}

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database);
  project = await t.createProject(P);
  for (const [key, xml] of Object.entries(MODELS)) {
    expect((await t.putModel(P, key, xml)).status).toBe(201);
  }
  rules = await t.useCases.rulesPrincipal();
});

afterAll(async () => {
  await database.drop();
});

describe('on create', () => {
  it('proposes a linked process and a process with the step’s name, under proa-rules', async () => {
    const seq = await lastSeq();
    const created = await json<SaveValueChainResult>(
      await t.asOwner(chainPath(P, '/content'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-none-match': '*' },
        body: JSON.stringify(doc()),
      }),
      201,
    );
    rev = created.valueChain?.headRev ?? 0;

    const all = await placements();
    expect(all.map((p) => [p.elementId, p.process, p.status, p.tier, p.confidence])).toEqual([
      ['step-kasse', KASSE, 'proposed', 'key', 1],
      ['step-mahn', MAHN, 'proposed', 'key', 1],
      ['step-sonder', RECHNUNG, 'proposed', 'key', 1],
    ]);
    const sonder = all.find((p) => p.elementId === 'step-sonder');
    expect(sonder).toMatchObject({ source: 'rule', endpointState: 'ok' });
    expect(sonder?.provenance).toMatchObject({
      sourceKind: 'rule',
      principalId: rules,
      handle: 'proa-rules',
      clientId: null,
      tier: 'key',
    });
    expect(await timeline(sonder?.id ?? '')).toMatchObject([
      {
        kind: 'proposal',
        sourceKind: 'rule',
        evidence: [RECHNUNG, 'step:step-sonder'],
        rationale: `Schlüsselregel: der Link des Schritts nennt diesen Prozess (${LINK}).`,
      },
    ]);

    const written = await events(seq);
    expect(written.map((e) => e.type)).toEqual([
      'value_chain.created',
      'placement.proposed',
      'placement.proposed',
      'placement.proposed',
    ]);
    for (const e of written.slice(1)) {
      expect(e).toMatchObject({ principalId: rules, clientId: null });
      expect(e.payload).toMatchObject({ sourceKind: 'rule', tier: 'key', confidence: 1 });
    }
  });

  it('keeps proposed processes out of the unplaced list and shows them as pending findings', async () => {
    const unplaced = await json<UnplacedProcessPage>(
      await t.asOwner(chainPath(P, '/unplaced-processes')),
      200,
    );
    expect(unplaced.items.map((u) => u.process)).toEqual([VERSAND, AUFTRAG]);
    const found = await findings();
    expect(
      found.filter((f) => f.kind === 'process-without-step').map((f) => [f.process, f.state]),
    ).toEqual([
      [MAHN, 'proposed'],
      [RECHNUNG, 'proposed'],
      [VERSAND, 'none'],
      [AUFTRAG, 'none'],
      [KASSE, 'proposed'],
    ]);
    expect(found.filter((f) => f.kind === 'step-without-process').map((f) => f.elementId)).toEqual([
      'step-fakt',
      'step-logistik',
      'step-vertrieb',
    ]);
    expect(found.filter((f) => f.kind === 'unresolved-link')).toEqual([]);
    // get_value_chain and REST GET …/value-chains/main carry the same findings.
    const detail = await json<ValueChainDetail>(await t.asOwner(chainPath(P)), 200);
    expect(detail.findings).toEqual(found);
  });
});

describe('re-derived on save', () => {
  it('writes nothing for an unchanged or a layout-only save', async () => {
    const before = await placements();
    const seq = await lastSeq();
    expect((await save(BASE)).outcome).toBe('unchanged');
    expect(await lastSeq()).toBe(seq);
    const moved = await save(BASE, 40);
    expect(moved.outcome).toBe('revised');
    expect(moved.impact.structureChanged).toBe(false);
    expect((await events(seq)).map((e) => e.type)).toEqual(['value_chain.revised']);
    expect(await placements()).toEqual(before);
  });

  it('withdraws the proposal when a rename ends the equal name, and proposes again on the way back', async () => {
    const mahn = await on('step-mahn', MAHN);
    const seq = await lastSeq();
    await save(renamed('step-mahn', 'Mahnstufen'));
    expect(await on('step-mahn', MAHN)).toBeUndefined();
    const obsolete = await on('step-mahn', MAHN, '&status=obsolete');
    expect(obsolete).toMatchObject({ id: mahn?.id, status: 'obsolete' });
    // The rules run before the refresh of the endpoint state (as after a model change): the
    // proposal turns obsolete with its withdrawal, no endpoint_changed ok → changed before it.
    const written = await events(seq);
    expect(written.map((e) => e.type)).toEqual(['value_chain.revised', 'placement.withdrawn']);
    expect(written[1]).toMatchObject({
      principalId: rules,
      clientId: null,
      payload: { sourceKind: 'rule' },
    });
    expect((await timeline(mahn?.id ?? '')).at(-1)).toMatchObject({
      kind: 'withdrawal',
      rationale: RULE_WITHDRAWAL,
    });

    // "MAHNWESEN": another spelling, the same normalized name and fingerprint.
    await save(renamed('step-mahn', 'MAHNWESEN'));
    const back = await on('step-mahn', MAHN);
    expect(back).toMatchObject({ id: mahn?.id, status: 'proposed', tier: 'key' });
    expect(back?.version).toBeGreaterThan(obsolete?.version ?? 0);
  });

  it('re-asserts a kept link on the renamed step’s new anchor', async () => {
    const before = await on('step-sonder', RECHNUNG);
    const seq = await lastSeq();
    await save(renamed('step-sonder', 'Spezialfälle', renamed('step-mahn', 'MAHNWESEN')));
    const after = await on('step-sonder', RECHNUNG);
    expect(after).toMatchObject({ id: before?.id, status: 'proposed', endpointState: 'ok' });
    // One proposal on the new anchor; no endpoint_changed ok → changed → ok around it.
    const written = await events(seq);
    expect(written.map((e) => [e.type, e.principalId])).toEqual([
      ['value_chain.revised', written[0]?.principalId],
      ['placement.proposed', rules],
    ]);
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    const history = await timeline(after?.id ?? '');
    expect(history.map((a) => [a.kind, a.sourceKind])).toEqual([
      ['proposal', 'rule'],
      ['proposal', 'rule'],
    ]);
    expect(history[1]?.stepFp).not.toBe(history[0]?.stepFp);
    const step = (await json<ValueChainDetail>(await t.asOwner(chainPath(P)), 200)).steps.find(
      (s) => s.elementId === 'step-sonder',
    );
    expect(history[1]?.stepFp).toBe(step?.fingerprint);
  });

  it('repeats a pasted link per step', async () => {
    await save([
      ...renamed('step-sonder', 'Spezialfälle', renamed('step-mahn', 'MAHNWESEN')),
      { id: 'step-kopie', name: 'Kopie', parent: 'step-fakt', link: LINK, x: 600, y: 400 },
    ]);
    expect(
      (await placements(`&process=${encodeURIComponent(RECHNUNG)}`)).map((p) => p.elementId),
    ).toEqual(['step-kopie', 'step-sonder']);
  });
});

describe('human decisions', () => {
  const steps = (): StepSpec[] => [
    ...renamed('step-sonder', 'Spezialfälle', renamed('step-mahn', 'MAHNWESEN')),
    { id: 'step-kopie', name: 'Kopie', parent: 'step-fakt', link: LINK, x: 600, y: 400 },
  ];

  it('are never replaced: an accepted proposal stays accepted, a rename sends it to re-confirm', async () => {
    const sonder = await on('step-sonder', RECHNUNG);
    await decide(sonder?.id ?? '', { verdict: 'accept', note: 'Passt.' });
    const accepted = await on('step-sonder', RECHNUNG);
    expect(accepted).toMatchObject({ status: 'accepted', endpointState: 'ok' });

    // Derived again on the same anchor: suppressed, nothing written.
    const seq = await lastSeq();
    await save(steps(), 80);
    expect((await events(seq)).map((e) => e.type)).toEqual(['value_chain.revised']);
    expect(await on('step-sonder', RECHNUNG)).toEqual(accepted);

    // A rename that keeps the link: the rule proposes on the new anchor, the acceptance stays.
    const renameSeq = await lastSeq();
    await save(renamed('step-sonder', 'Ausnahmen', steps()));
    const after = await on('step-sonder', RECHNUNG);
    expect(after).toMatchObject({ status: 'accepted', endpointState: 'changed', tier: 'key' });
    // The endpoint change is the saving human's (their save moved it), recorded once.
    const written = await events(renameSeq);
    const human = written[0]?.principalId;
    expect(written.map((e) => [e.type, e.principalId, e.clientId])).toEqual([
      ['value_chain.revised', human, 'proa-web'],
      ['placement.proposed', rules, null],
      ['placement.endpoint_changed', human, 'proa-web'],
    ]);
    expect(human).not.toBe(rules);
    expect(written[2]?.payload).toMatchObject({ previous: 'ok', endpointState: 'changed' });
    expect((await timeline(after?.id ?? '')).map((a) => [a.kind, a.sourceKind])).toEqual([
      ['proposal', 'rule'],
      ['proposal', 'rule'],
      ['decision', 'human'],
      ['proposal', 'rule'],
    ]);
  });

  it('a rejected rule proposal is suppressed and its process is unplaced again', async () => {
    const mahn = await on('step-mahn', MAHN);
    await decide(mahn?.id ?? '', { verdict: 'reject', reason: 'Gehört zum Forderungsmanagement.' });
    const seq = await lastSeq();
    await save(renamed('step-sonder', 'Ausnahmen', steps()), 120);
    expect((await events(seq)).map((e) => e.type)).toEqual(['value_chain.revised']);
    expect(await on('step-mahn', MAHN)).toMatchObject({ status: 'rejected' });
    const unplaced = await json<UnplacedProcessPage>(
      await t.asOwner(chainPath(P, '/unplaced-processes')),
      200,
    );
    expect(unplaced.items.map((u) => u.process)).toContain(MAHN);
    expect((await findings()).find((f) => f.process === MAHN)).toMatchObject({
      kind: 'process-without-step',
      state: 'none',
    });
  });
});

describe('token revocation', () => {
  it('withdraws the token’s proposals and leaves the rule proposals alone', async () => {
    const agent = await t.createToken(P, ['proa:read', 'proa:propose']);
    const proposed = await json<PostPlacementsResult>(
      await t.asToken(
        agent.secret,
        chainPath(P, '/placements'),
        post({
          kind: 'propose',
          placements: [
            {
              step: 'step-lieferung',
              process: VERSAND,
              confidence: 0.8,
              rationale: 'Versendet die Ware.',
            },
            // step-mahn: the owner rejected MAHN there, so that proposal would be suppressed.
            { step: 'step-fakt', process: MAHN, confidence: 0.6, rationale: 'Mahnt.' },
          ],
        }),
      ),
      200,
    );
    expect(proposed.kind === 'propose' && proposed.counts.applied).toBe(2);
    const ruleStances = async () =>
      (
        await Promise.all(
          (await placements('&status=proposed')).map(
            async (p) => [p.id, await timeline(p.id)] as const,
          ),
        )
      ).filter(([, h]) => h.at(-1)?.sourceKind === 'rule');
    const before = await ruleStances();
    const seq = await lastSeq();
    const res = await t.asOwner(`/api/v1/projects/${P}/agent-tokens/${agent.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    const withdrawn = (await events(seq)).filter((e) => e.type === 'placement.withdrawn');
    expect(withdrawn).toHaveLength(2);
    for (const e of withdrawn) expect(e.payload).toMatchObject({ sourceKind: 'agent' });
    expect(await ruleStances()).toEqual(before);
  });
});

describe('model changes', () => {
  it('withdraws the proposal of a deleted process and proposes it again on re-upload', async () => {
    const kasse = await on('step-kasse', KASSE);
    expect(kasse).toMatchObject({ status: 'proposed', tier: 'key' });
    const seq = await lastSeq();
    const del = await t.asOwner(`/api/v1/projects/${P}/models/${await modelId('x/kasse')}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(204);
    expect(await on('step-kasse', KASSE, '&status=obsolete')).toMatchObject({
      id: kasse?.id,
      endpointState: 'missing',
    });
    const written = (await events(seq)).filter((e) => e.type.startsWith('placement.'));
    expect(written.map((e) => [e.type, e.principalId, e.clientId])).toEqual([
      ['placement.withdrawn', rules, null],
    ]);
    // The step's name names no head process any more; a link would be unresolved.
    expect((await findings()).some((f) => f.process === KASSE)).toBe(false);

    expect((await t.putModel(P, 'x/kasse', MODELS['x/kasse'] ?? '')).status).toBe(201);
    expect(await on('step-kasse', KASSE)).toMatchObject({
      id: kasse?.id,
      status: 'proposed',
      endpointState: 'ok',
    });
  });

  it('withdraws a rule proposal whose step a save removes, and derives none there', async () => {
    const kasse = await on('step-kasse', KASSE);
    const seq = await lastSeq();
    const result = await save(
      [
        ...renamed('step-sonder', 'Ausnahmen', renamed('step-mahn', 'MAHNWESEN')),
        { id: 'step-kopie', name: 'Kopie', parent: 'step-fakt', link: LINK, x: 600, y: 400 },
      ].filter((s) => s.id !== 'step-kasse'),
    );
    expect(result.impact.placements).toMatchObject({ stranded: 0, proposalsWithdrawn: 1 });
    expect(await on('step-kasse', KASSE, '&status=obsolete')).toMatchObject({ id: kasse?.id });
    const withdrawn = (await events(seq)).filter((e) => e.type === 'placement.withdrawn');
    // Recorded under the proposer (the rule tier), caused by the saving human (S1).
    expect(withdrawn).toMatchObject([
      { clientId: 'proa-web', payload: { sourceKind: 'rule', principalId: rules } },
    ]);
    expect((await placements()).filter((p) => p.process === KASSE)).toEqual([]);
  });
});

describe('findings', () => {
  it('name the steps of accepted callers and report unresolved links', async () => {
    const manual = await json<PostPlacementsResult>(
      await t.asOwner(
        chainPath(P, '/placements'),
        post({ kind: 'manual', step: 'step-vertrieb', process: AUFTRAG, rationale: 'Vertrieb.' }),
      ),
      200,
    );
    expect(manual.kind).toBe('manual');
    const found = await findings();
    expect(found.find((f) => f.process === VERSAND)).toMatchObject({
      kind: 'process-without-step',
      state: 'none',
      calledFrom: [{ elementId: 'step-vertrieb', process: AUFTRAG }],
    });
    expect(found.some((f) => f.process === AUFTRAG)).toBe(false);
    // Vertrieb has a process now; below Fakturierung the accepted step-sonder placement counts
    // (re-confirming it is an open item of its own), its siblings without one are reported.
    expect(found.filter((f) => f.kind === 'step-without-process').map((f) => f.elementId)).toEqual([
      'step-kopie',
      'step-logistik',
      'step-mahn',
    ]);

    // An opaque link ends the pasted link's rule proposal and is reported.
    await save(
      [
        ...renamed('step-sonder', 'Ausnahmen', renamed('step-mahn', 'MAHNWESEN')),
        {
          id: 'step-kopie',
          name: 'Kopie',
          parent: 'step-fakt',
          link: 'operations-detail',
          x: 600,
          y: 400,
        },
      ].filter((s) => s.id !== 'step-kasse'),
    );
    const after = await findings();
    expect(after.filter((f) => f.kind === 'unresolved-link')).toMatchObject([
      { elementId: 'step-kopie', link: 'operations-detail' },
    ]);
    expect(after.filter((f) => f.kind === 'step-without-process').map((f) => f.elementId)).toEqual([
      'step-kopie',
      'step-logistik',
      'step-mahn',
    ]);
    expect((await json<ValueChainDetail>(await t.asOwner(chainPath(P)), 200)).findings).toEqual(
      after,
    );
  });

  it('leave the relation side untouched and keep the events dense', async () => {
    // Chain writes and rule proposals never touch relations, no-links, tasks or findings
    // (the model uploads and deletions above do, so compare against a fresh digest).
    const digest = await relationSide(database.db, project.id);
    const seq = await lastSeq();
    await save(
      [
        ...renamed('step-sonder', 'Ausnahmen', renamed('step-mahn', 'MAHNWESEN')),
        { id: 'step-kopie', name: 'Kopie', parent: 'step-fakt', link: LINK, x: 600, y: 400 },
      ].filter((s) => s.id !== 'step-kasse'),
    );
    expect((await events(seq)).map((e) => e.type)).toEqual([
      'value_chain.revised',
      'placement.proposed',
    ]);
    expect(await relationSide(database.db, project.id)).toBe(digest);
    const all = await events();
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
  });
});
