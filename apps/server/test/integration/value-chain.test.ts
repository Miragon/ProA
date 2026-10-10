/**
 * Value chain storage and the placement lifecycle (M4 S1) against PostgreSQL:
 * revisions with step generations and tombstones, chain deletion and
 * revival, and placements proposed, decided, corrected and noted, with
 * endpoint state and events. The domain functions run inside `store.write`
 * after `lockForWrite`, as S2's use cases will call them. Every chain and
 * placement write is checked to leave the relation side (relations, their
 * assertions, no-links, tasks, findings, the pipeline view) untouched.
 * Synthetic chains only, plus the dev landscape's golden chain.
 */
import { readFile } from 'node:fs/promises';

import { loadDocument, serializeDocument } from '@miragon/value-chain-schema-model';
import type { PlacementId, ProjectId, Ref, ValueChainId } from '@proa/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createStore } from '../../src/db/store.ts';
import type { Actor } from '../../src/domain/actor.ts';
import { contentHash } from '../../src/domain/ingest.ts';
import type {
  EventRecord,
  PlacementAssertionRecord,
  PlacementRecord,
  Store,
  Tx,
} from '../../src/domain/ports.ts';
import { currentStances } from '../../src/domain/status.ts';
import {
  byPlacement,
  placementEndpoints,
  placementKey,
  processFingerprints,
  refreshPlacements,
  type PlacementEndpoints,
} from '../../src/domain/value-chain/placement-state.ts';
import {
  acceptManualPlacement,
  addPlacementNote,
  applyPlacementProposal,
  correctPlacement,
  placementTier,
  recordPlacementDecision,
  withdrawPlacementStance,
  type PlacementContext,
  type PlacementDecision,
  type ValidPlacementProposal,
} from '../../src/domain/value-chain/placements.ts';
import {
  createValueChain,
  deleteValueChain,
  saveValueChainRevision,
  type PreparedRevision,
} from '../../src/domain/value-chain/revisions.ts';
import {
  OUTSIDE,
  OUTSIDE_FINGERPRINT,
  liveGenerations,
} from '../../src/domain/value-chain/steps.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { fakeBpmn } from '../support/fake-analysis.ts';
import { chainDoc, prepare, prepareUnchecked } from '../support/value-chain.ts';

let database: TestDatabase;
let t: TestApp;
let store: Store;
let owner: Actor;
let agent: Actor;

const AUFTRAG = 'vertrieb/auftrag#P_Auftrag' as Ref;
const RECHNUNG = 'finanzen/rechnung#P_Rechnung' as Ref;
const VERSAND = 'lager/versand#P_Versand' as Ref;

const MODELS = {
  'vertrieb/auftrag': fakeBpmn({
    processes: [
      {
        id: 'P_Auftrag',
        name: 'Auftrag',
        elements: [
          { kind: 'call', id: 'Call_Versand', name: 'Versand', ref: 'P_Versand' },
          {
            kind: 'msg_throw',
            id: 'Throw_Rechnung',
            name: 'Rechnung fällig',
            ref: 'RechnungFaellig',
          },
        ],
      },
    ],
  }),
  'finanzen/rechnung': fakeBpmn({
    processes: [
      {
        id: 'P_Rechnung',
        name: 'Rechnung',
        elements: [
          {
            kind: 'msg_catch',
            id: 'Catch_Rechnung',
            name: 'Rechnung fällig',
            ref: 'RechnungFaellig',
          },
        ],
      },
    ],
  }),
  'lager/versand': fakeBpmn({ processes: [{ id: 'P_Versand', name: 'Versand' }] }),
};

/** A fingerprint of the relation side of a project; chain and placement writes must not move it. */
async function relationSide(projectId: ProjectId): Promise<string> {
  const r = await database.db.execute<{ digest: string }>(sql`
    select concat_ws('/',
      (select md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from relation x where x.project_id = ${projectId}),
      (select md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from relation_assertion x where x.project_id = ${projectId}),
      (select md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from no_link x where x.project_id = ${projectId}),
      (select md5(coalesce(string_agg(x::text, '|' order by x.no_link_id), '')) from no_link_withdrawal x where x.project_id = ${projectId}),
      (select md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from analysis_task x where x.project_id = ${projectId}),
      (select md5(coalesce(string_agg(x::text, '|' order by x.ord), '')) from finding x where x.project_id = ${projectId}),
      (select md5(coalesce(string_agg(x::text, '|' order by x.model_id), '')) from model_pipeline x where x.project_id = ${projectId}),
      (select md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from model x where x.project_id = ${projectId})
    ) as digest`);
  return r.rows[0]?.digest ?? '';
}

/** Runs `fn` like a use case (project locked) and checks the relation side did not move. */
async function write<T>(projectId: ProjectId, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const before = await relationSide(projectId);
  const result = await store.write(async (tx) => {
    await tx.projects.lockForWrite(projectId);
    return fn(tx);
  });
  expect(await relationSide(projectId)).toBe(before);
  return result;
}

async function endpointsIn(
  tx: Tx,
  projectId: ProjectId,
  chainId: ValueChainId,
  prepared: PreparedRevision,
): Promise<PlacementEndpoints> {
  return placementEndpoints(
    liveGenerations(await tx.valueChainSteps.list(projectId, chainId)),
    prepared.stepFingerprints,
    processFingerprints(await tx.facts.head(projectId, { kinds: ['process'] })),
  );
}

async function context(
  tx: Tx,
  projectId: ProjectId,
  actor: Actor,
  chainId: ValueChainId,
  prepared: PreparedRevision,
  extra: Partial<PlacementContext> = {},
): Promise<PlacementContext> {
  const placements = await tx.placements.forChain(projectId, chainId);
  return {
    tx,
    projectId,
    actor,
    valueChainId: chainId,
    endpoints: await endpointsIn(tx, projectId, chainId, prepared),
    placements: new Map(
      placements.map((p) => [placementKey(chainId, p.elementId, p.generation, p.processRef), p]),
    ),
    histories: byPlacement<PlacementAssertionRecord>(
      await tx.placementAssertions.listForChain(projectId, chainId),
    ),
    declared: null,
    submissionId: null,
    ...extra,
  };
}

function proposal(
  elementId: string,
  generation: number,
  processRef: Ref,
  extra: Partial<ValidPlacementProposal> = {},
): ValidPlacementProposal {
  return {
    elementId,
    generation,
    processRef,
    tier: placementTier({
      sourceKind: 'agent',
      toOutside: elementId === OUTSIDE,
      lexicalMatch: false,
    }),
    confidence: 0.8,
    rationale: 'Passt fachlich.',
    evidence: [processRef],
    question: null,
    ...extra,
  };
}

const decision = (
  verdict: PlacementDecision['verdict'],
  rationale: string | null,
  extra: Partial<PlacementDecision> = {},
): PlacementDecision => ({
  verdict,
  rationale,
  question: null,
  label: null,
  linkedPlacementId: null,
  tier: null,
  confidence: null,
  ...extra,
});

async function events(projectId: ProjectId, afterSeq = 0): Promise<EventRecord[]> {
  return store.read((tx) => tx.events.list(projectId, { afterSeq, limit: 1000 }));
}

async function placementOf(projectId: ProjectId, id: PlacementId): Promise<PlacementRecord> {
  const p = await store.read((tx) => tx.placements.findInProject(projectId, id));
  if (!p) throw new Error(`placement ${id} not found`);
  return p;
}

async function historyOf(projectId: ProjectId, id: PlacementId) {
  return store.read((tx) => tx.placementAssertions.listForPlacements(projectId, [id]));
}

async function setUpProject(key: string): Promise<ProjectId> {
  const projectId = (await t.createProject(key)).id;
  for (const [modelKey, xml] of Object.entries(MODELS)) {
    const res = await t.putModel(key, modelKey, xml);
    expect(res.status).toBe(201);
  }
  return projectId;
}

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database);
  store = createStore(database.db);
  owner = await t.useCases.localOwnerActor('proa-web');
});

afterAll(async () => {
  await database.drop();
});

async function agentIn(projectKey: string): Promise<Actor> {
  const token = await t.createToken(projectKey, ['proa:read', 'proa:propose']);
  const actor = await t.useCases.authenticateAgentToken(token.secret);
  if (!actor) throw new Error('agent token not accepted');
  return actor;
}

describe('revisions and step generations', () => {
  let P: ProjectId;
  let chainId: ValueChainId;
  const rev1 = prepare(
    chainDoc('Testkette', [
      ['step-a', 'Auftragseingang'],
      ['step-b', 'Fakturierung'],
    ]),
  );

  beforeAll(async () => {
    P = await setUpProject('vc-rev');
    agent = await agentIn('vc-rev');
  });

  it('creates rev 1 with head, name, steps and its event; identical content is unchanged', async () => {
    const seqBefore = (await events(P)).at(-1)?.seq ?? 0;
    const created = await write(P, (tx) => createValueChain(tx, owner, P, { key: 'main' }, rev1));
    chainId = created.chain.id;
    expect(chainId).toMatch(/^vch_/);
    expect(created).toMatchObject({
      outcome: 'created',
      chain: {
        key: 'main',
        name: 'Testkette',
        headRevisionId: created.revision.id,
        deletedSeq: null,
      },
      revision: {
        rev: 1,
        contentHash: rev1.contentHash,
        structureHash: rev1.structureHash,
        schemaVersion: 1,
        baseRevisionId: null,
        principalId: owner.principalId,
        sourceKind: 'human',
      },
      steps: {
        added: [
          { elementId: OUTSIDE, generation: 1 },
          { elementId: 'step-a', generation: 1 },
          { elementId: 'step-b', generation: 1 },
        ],
        removed: [],
      },
    });
    expect(created.revision.id).toMatch(/^vcr_/);
    const steps = await store.read((tx) => tx.valueChainSteps.list(P, chainId));
    expect(steps).toEqual(
      [OUTSIDE, 'step-a', 'step-b'].map((elementId) => ({
        projectId: P,
        valueChainId: chainId,
        elementId,
        generation: 1,
        createdRev: 1,
        deletedRev: null,
        deletedSeq: null,
      })),
    );
    const [e, ...rest] = await events(P, seqBefore);
    expect(rest).toEqual([]);
    expect(e).toMatchObject({
      type: 'value_chain.created',
      principalId: owner.principalId,
      clientId: 'proa-web',
      subjectRef: chainId,
      payload: {
        outcome: 'created',
        valueChainId: chainId,
        key: 'main',
        revisionId: created.revision.id,
        rev: 1,
        contentHash: rev1.contentHash,
        structureHash: rev1.structureHash,
        stepsAdded: 3,
        stepsRemoved: 0,
      },
    });
    expect(created.revision.seq).toBe(e?.seq);

    const unchanged = await write(P, (tx) =>
      saveValueChainRevision(tx, owner, P, chainId, rev1, { baseRevisionId: created.revision.id }),
    );
    expect(unchanged).toMatchObject({
      outcome: 'unchanged',
      revision: { id: created.revision.id },
    });
    expect((await events(P)).at(-1)?.seq).toBe(e?.seq);
    expect(await store.read((tx) => tx.valueChainRevisions.maxRev(P, chainId))).toBe(1);
  });

  it('round-trips the canonical bytes and their hash', async () => {
    const head = await store.read(async (tx) => {
      const chain = await tx.valueChains.findInProject(P, chainId);
      return chain?.headRevisionId
        ? tx.valueChainRevisions.content(P, chainId, chain.headRevisionId)
        : null;
    });
    expect(head).toEqual(rev1.content);
    expect(contentHash(head ?? new Uint8Array())).toBe(rev1.contentHash);
    const text = new TextDecoder().decode(head ?? new Uint8Array());
    expect(serializeDocument(loadDocument(JSON.parse(text)))).toBe(text);
  });

  it('refuses agents, a second chain, another key and a foreign base revision', async () => {
    const refused = async (fn: (tx: Tx) => Promise<unknown>) =>
      store.write(async (tx) => {
        await tx.projects.lockForWrite(P);
        return fn(tx);
      });
    await expect(
      refused((tx) => createValueChain(tx, agent, P, { key: 'main' }, rev1)),
    ).rejects.toMatchObject({ code: 'human-decision-required' });
    await expect(
      refused((tx) =>
        saveValueChainRevision(tx, agent, P, chainId, rev1, { baseRevisionId: null }),
      ),
    ).rejects.toMatchObject({ code: 'human-decision-required' });
    await expect(refused((tx) => deleteValueChain(tx, agent, P, chainId))).rejects.toMatchObject({
      code: 'human-decision-required',
    });
    await expect(
      refused((tx) => createValueChain(tx, owner, P, { key: 'main' }, rev1)),
    ).rejects.toMatchObject({ code: 'conflict', extras: { valueChainId: chainId } });
    await expect(
      refused((tx) => createValueChain(tx, owner, P, { key: 'second' }, rev1)),
    ).rejects.toMatchObject({ code: 'validation-failed', extras: { reason: 'value-chain-key' } });
    await expect(
      refused((tx) =>
        saveValueChainRevision(tx, owner, P, chainId, rev1, {
          baseRevisionId: 'vcr_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'validation-failed',
      extras: { reason: 'unknown-base-revision' },
    });
    // prepareRevision refuses the id (reserved-id); the generations refuse it too, behind it.
    expect(() => prepare(chainDoc('Testkette', [['@step', 'Reserviert']]))).toThrow(
      expect.objectContaining({ code: 'value-chain-invalid' }) as Error,
    );
    const reserved = prepareUnchecked(chainDoc('Testkette', [['@step', 'Reserviert']]));
    await expect(
      refused((tx) =>
        saveValueChainRevision(tx, owner, P, chainId, reserved, { baseRevisionId: null }),
      ),
    ).rejects.toMatchObject({
      code: 'validation-failed',
      extras: { reason: 'reserved-element-id' },
    });
    expect(await store.read((tx) => tx.valueChainRevisions.maxRev(P, chainId))).toBe(1);
  });

  let placementOnB: PlacementId;
  let placementOutside: PlacementId;

  it('rev 2 tombstones and adds steps; live proposals there are withdrawn, decisions stay missing', async () => {
    const rules = await t.useCases.rulesPrincipal();
    // On step-b: an accepted placement and one with an agent and a rule proposal;
    // on step-a and @outside: placements rev 2 does not touch.
    let proposedOnB: PlacementId;
    let proposedOnA: PlacementId;
    ({ placementOnB, placementOutside, proposedOnB, proposedOnA } = await write(P, async (tx) => {
      const ctx = await context(tx, P, agent, chainId, rev1);
      const onB = await applyPlacementProposal(ctx, proposal('step-b', 1, RECHNUNG));
      const outside = await applyPlacementProposal(ctx, proposal(OUTSIDE, 1, VERSAND));
      const proposed = await applyPlacementProposal(ctx, proposal('step-b', 1, AUFTRAG));
      await applyPlacementProposal(
        { ...ctx, proposer: { sourceKind: 'rule', principalId: rules } },
        proposal('step-b', 1, AUFTRAG, { tier: 'key', confidence: 1 }),
      );
      const onA = await applyPlacementProposal(ctx, proposal('step-a', 1, AUFTRAG));
      const history = await tx.placementAssertions.listForPlacements(P, [onB.placement.id]);
      await recordPlacementDecision(
        tx,
        P,
        owner,
        onB.placement,
        history,
        ctx.endpoints,
        decision('accept', null),
      );
      const h2 = await tx.placementAssertions.listForPlacements(P, [outside.placement.id]);
      await recordPlacementDecision(
        tx,
        P,
        owner,
        outside.placement,
        h2,
        ctx.endpoints,
        decision('accept', null),
      );
      return {
        placementOnB: onB.placement.id,
        placementOutside: outside.placement.id,
        proposedOnB: proposed.placement.id,
        proposedOnA: onA.placement.id,
      };
    }));
    expect(await placementOf(P, placementOnB)).toMatchObject({
      status: 'accepted',
      endpointState: 'ok',
    });
    expect(await placementOf(P, placementOutside)).toMatchObject({
      status: 'accepted',
      endpointState: 'ok',
      stepFp: OUTSIDE_FINGERPRINT,
      tier: 'semantic',
    });
    expect(await placementOf(P, proposedOnB)).toMatchObject({ status: 'proposed', tier: 'key' });
    const onABefore = await placementOf(P, proposedOnA);

    const rev2 = prepare(
      chainDoc('Testkette 2', [
        ['step-a', 'Auftragseingang'],
        ['step-c', 'Versand'],
      ]),
    );
    const head1 = (await store.read((tx) => tx.valueChains.findInProject(P, chainId)))
      ?.headRevisionId;
    const seqBefore = (await events(P)).at(-1)?.seq ?? 0;
    const saved = await write(P, (tx) =>
      saveValueChainRevision(tx, owner, P, chainId, rev2, { baseRevisionId: head1 ?? null }),
    );
    expect(saved).toMatchObject({
      outcome: 'revised',
      chain: { name: 'Testkette 2' },
      revision: { rev: 2, baseRevisionId: head1 },
      steps: {
        added: [{ elementId: 'step-c', generation: 1 }],
        removed: [{ elementId: 'step-b', generation: 1 }],
      },
    });
    // The withdrawals on step-b in natural key order (finanzen/… before vertrieb/…),
    // each placement refreshed once: no endpoint change for the one that turns obsolete.
    const evs = await events(P, seqBefore);
    expect(evs.map((e) => [e.type, e.subjectRef])).toEqual([
      ['value_chain.revised', chainId],
      ['placement.withdrawn', placementOnB],
      ['placement.endpoint_changed', placementOnB],
      ['placement.withdrawn', proposedOnB],
      ['placement.withdrawn', proposedOnB],
    ]);
    expect(evs[0]?.payload).toMatchObject({
      outcome: 'revised',
      rev: 2,
      baseRevisionId: head1,
      stepsAdded: 1,
      stepsRemoved: 1,
    });
    // Recorded under the proposer, caused by the saving human.
    expect(evs[1]).toMatchObject({
      principalId: owner.principalId,
      clientId: 'proa-web',
      payload: { sourceKind: 'agent', principalId: agent.principalId },
    });
    expect(evs[2]).toMatchObject({
      principalId: owner.principalId,
      payload: {
        placementId: placementOnB,
        valueChainId: chainId,
        elementId: 'step-b',
        generation: 1,
        process: RECHNUNG,
        previous: 'ok',
        endpointState: 'missing',
      },
    });
    expect(evs[4]?.payload).toMatchObject({ sourceKind: 'rule', principalId: rules });
    const b1 = (await store.read((tx) => tx.valueChainSteps.list(P, chainId))).find(
      (s) => s.elementId === 'step-b',
    );
    expect(b1).toMatchObject({ generation: 1, deletedRev: 2, deletedSeq: evs[0]?.seq });
    // The decision stays (an open item); the agent's proposal under it is withdrawn.
    expect(await placementOf(P, placementOnB)).toMatchObject({
      status: 'accepted',
      endpointState: 'missing',
    });
    expect((await historyOf(P, placementOnB)).at(-1)).toMatchObject({
      kind: 'withdrawal',
      sourceKind: 'agent',
      principalId: agent.principalId,
      clientId: 'proa-web',
      rationale: 'Schritt in Revision 2 entfernt',
      stepFp: null,
    });
    // Proposals only: obsolete, and no live proposal is left on the dead generation.
    expect(await placementOf(P, proposedOnB)).toMatchObject({
      status: 'obsolete',
      endpointState: 'missing',
    });
    const proposedHistory = await historyOf(P, proposedOnB);
    expect(proposedHistory.slice(-2)).toMatchObject([
      { kind: 'withdrawal', sourceKind: 'agent', principalId: agent.principalId },
      { kind: 'withdrawal', sourceKind: 'rule', principalId: rules },
    ]);
    expect(currentStances(proposedHistory)).toEqual([]);
    // Elsewhere nothing moved.
    expect(await placementOf(P, proposedOnA)).toEqual(onABefore);
    expect(await placementOf(P, placementOutside)).toMatchObject({ endpointState: 'ok' });

    await write(P, async (tx) => {
      const endpoints = await endpointsIn(tx, P, chainId, rev2);
      // No new proposal on the tombstoned generation.
      await expect(
        applyPlacementProposal(
          await context(tx, P, agent, chainId, rev2),
          proposal('step-b', 1, AUFTRAG),
        ),
      ).rejects.toMatchObject({ code: 'validation-failed', extras: { reason: 'unknown-step' } });
      // The accepted placement there cannot be re-confirmed or held, only rejected (or corrected).
      const decideOnB = async (d: PlacementDecision) => {
        const placement = await tx.placements.findInProject(P, placementOnB);
        if (!placement) throw new Error('placement not found');
        const history = await tx.placementAssertions.listForPlacements(P, [placementOnB]);
        return recordPlacementDecision(tx, P, owner, placement, history, endpoints, d);
      };
      await expect(decideOnB(decision('accept', null))).rejects.toMatchObject({
        code: 'validation-failed',
        extras: { reason: 'unknown-step' },
      });
      await expect(decideOnB(decision('hold', 'Später klären.'))).rejects.toMatchObject({
        code: 'validation-failed',
        extras: { reason: 'unknown-step' },
      });
      expect(await decideOnB(decision('reject', 'Den Schritt gibt es nicht mehr.'))).toMatchObject({
        status: 'rejected',
        endpointState: 'missing',
      });
    });
  });

  it('rev 3 re-adds a step as generation 2; the old placement stays missing', async () => {
    const rev3 = prepare(
      chainDoc('Testkette 2', [
        ['step-a', 'Auftragseingang'],
        ['step-b', 'Fakturierung'],
        ['step-c', 'Versand'],
      ]),
    );
    const saved = await write(P, (tx) =>
      saveValueChainRevision(tx, owner, P, chainId, rev3, { baseRevisionId: null }),
    );
    expect(saved).toMatchObject({
      outcome: 'revised',
      revision: { rev: 3 },
      steps: { added: [{ elementId: 'step-b', generation: 2 }], removed: [] },
    });
    expect(await placementOf(P, placementOnB)).toMatchObject({ endpointState: 'missing' });
    const steps = await store.read((tx) => tx.valueChainSteps.list(P, chainId));
    expect(
      steps
        .filter((s) => s.elementId === 'step-b')
        .map((s) => [s.generation, s.deletedSeq === null]),
    ).toEqual([
      [1, false],
      [2, true],
    ]);
    // A layout-only save is a revision without generation or endpoint changes.
    const moved = prepare(
      chainDoc(
        'Testkette 2',
        [
          ['step-a', 'Auftragseingang'],
          ['step-b', 'Fakturierung'],
          ['step-c', 'Versand'],
        ],
        40,
      ),
    );
    const seqBefore = (await events(P)).at(-1)?.seq ?? 0;
    const layout = await write(P, (tx) =>
      saveValueChainRevision(tx, owner, P, chainId, moved, { baseRevisionId: null }),
    );
    expect(layout).toMatchObject({
      outcome: 'revised',
      revision: { rev: 4 },
      steps: { added: [], removed: [] },
    });
    expect((await events(P, seqBefore)).map((e) => e.type)).toEqual(['value_chain.revised']);
  });

  it('lists revisions newest first and finds them by rev', async () => {
    const page = await store.read((tx) =>
      tx.valueChainRevisions.listForChain(P, chainId, { limit: 2 }),
    );
    expect(page.map((r) => r.rev)).toEqual([4, 3]);
    const older = await store.read((tx) =>
      tx.valueChainRevisions.listForChain(P, chainId, { beforeRev: 3, limit: 10 }),
    );
    expect(older.map((r) => r.rev)).toEqual([2, 1]);
    expect(await store.read((tx) => tx.valueChainRevisions.findByRev(P, chainId, 2))).toMatchObject(
      {
        rev: 2,
        valueChainId: chainId,
        sourceKind: 'human',
      },
    );
    expect(await store.read((tx) => tx.valueChainRevisions.findByRev(P, chainId, 9))).toBeNull();
    // Another project finds nothing.
    const other = (await t.createProject('vc-rev-other')).id;
    expect(
      await store.read((tx) => tx.valueChainRevisions.findByRev(other, chainId, 1)),
    ).toBeNull();
    expect(await store.read((tx) => tx.valueChains.findByKey(other, 'main'))).toBeNull();
    expect(await store.read((tx) => tx.placements.forChain(other, chainId))).toEqual([]);
  });

  it('delete, then revive: same vch_, rev continues, new generations, no placement comes back', async () => {
    const seqBefore = (await events(P)).at(-1)?.seq ?? 0;
    const onA = (await store.read((tx) => tx.placements.forChain(P, chainId))).find(
      (p) => p.elementId === 'step-a',
    );
    if (!onA) throw new Error('the placement on step-a is missing');
    const deleted = await write(P, (tx) => deleteValueChain(tx, owner, P, chainId));
    const evs = await events(P, seqBefore);
    // Every live proposal on the chain's generations is withdrawn ('@outside' before 'step-a').
    expect(evs.map((e) => [e.type, e.subjectRef])).toEqual([
      ['value_chain.deleted', chainId],
      ['placement.withdrawn', placementOutside],
      ['placement.endpoint_changed', placementOutside],
      ['placement.withdrawn', onA.id],
    ]);
    expect(evs[0]).toMatchObject({
      payload: { valueChainId: chainId, key: 'main', stepsRemoved: 4 },
    });
    expect(deleted.chain.deletedSeq).toBe(evs[0]?.seq);
    expect(evs[2]).toMatchObject({ payload: { endpointState: 'missing' } });
    expect((await historyOf(P, placementOutside)).at(-1)).toMatchObject({
      kind: 'withdrawal',
      principalId: agent.principalId,
      rationale: 'Wertschöpfungskette gelöscht',
    });
    expect(await placementOf(P, onA.id)).toMatchObject({
      status: 'obsolete',
      endpointState: 'missing',
    });
    const steps = await store.read((tx) => tx.valueChainSteps.list(P, chainId));
    expect(steps.every((s) => s.deletedSeq !== null)).toBe(true);
    expect(
      steps.filter((s) => s.deletedSeq === evs[0]?.seq).every((s) => s.deletedRev === null),
    ).toBe(true);
    expect(await store.read((tx) => tx.valueChains.findInProject(P, chainId))).toBeNull();
    expect(await store.read((tx) => tx.valueChains.list(P))).toEqual([]);
    expect(await store.read((tx) => tx.valueChains.findByKey(P, 'main'))).toMatchObject({
      id: chainId,
      deletedSeq: evs[0]?.seq,
    });
    expect(await placementOf(P, placementOutside)).toMatchObject({
      status: 'accepted',
      endpointState: 'missing',
    });
    const refused = (fn: (tx: Tx) => Promise<unknown>) =>
      store.write(async (tx) => {
        await tx.projects.lockForWrite(P);
        return fn(tx);
      });
    await expect(refused((tx) => deleteValueChain(tx, owner, P, chainId))).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(
      refused((tx) =>
        saveValueChainRevision(tx, owner, P, chainId, rev1, { baseRevisionId: null }),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });

    // Revive with the content of rev 1.
    const revived = await write(P, (tx) => createValueChain(tx, owner, P, { key: 'main' }, rev1));
    expect(revived).toMatchObject({
      outcome: 'revived',
      chain: { id: chainId, deletedSeq: null, name: 'Testkette' },
      revision: { rev: 5 },
      steps: {
        added: [
          { elementId: OUTSIDE, generation: 2 },
          { elementId: 'step-a', generation: 2 },
          { elementId: 'step-b', generation: 3 },
        ],
        removed: [],
      },
    });
    const created = (await events(P)).filter((e) => e.type === 'value_chain.created').at(-1);
    expect(created?.payload).toMatchObject({ outcome: 'revived', rev: 5 });
    // The @outside placement of the old generation stays missing.
    expect(await placementOf(P, placementOutside)).toMatchObject({ endpointState: 'missing' });
    expect(await placementOf(P, placementOnB)).toMatchObject({ endpointState: 'missing' });
  });
});

describe('the placement lifecycle', () => {
  let P: ProjectId;
  let chainId: ValueChainId;
  let head: PreparedRevision;
  const steps = (auftrag: string): [string, string][] => [
    ['step-auftrag', auftrag],
    ['step-rechnung', 'Rechnungsstellung'],
    ['step-versand', 'Versand'],
  ];

  beforeAll(async () => {
    P = await setUpProject('vc-life');
    agent = await agentIn('vc-life');
    head = prepare(chainDoc('Lebenszyklus', steps('Auftragseingang')));
    chainId = (await write(P, (tx) => createValueChain(tx, owner, P, { key: 'main' }, head))).chain
      .id;
  });

  const save = async (doc: PreparedRevision) => {
    head = doc;
    return write(P, (tx) =>
      saveValueChainRevision(tx, owner, P, chainId, doc, { baseRevisionId: null }),
    );
  };
  const propose = (
    actor: Actor,
    p: ValidPlacementProposal,
    extra: Partial<PlacementContext> = {},
  ) =>
    write(P, async (tx) =>
      applyPlacementProposal(await context(tx, P, actor, chainId, head, extra), p),
    );
  const decide = (id: PlacementId, d: PlacementDecision, actor = owner) =>
    write(P, async (tx) => {
      const placement = await tx.placements.findInProject(P, id);
      if (!placement) throw new Error('placement not found');
      const history = await tx.placementAssertions.listForPlacements(P, [id]);
      return recordPlacementDecision(
        tx,
        P,
        actor,
        placement,
        history,
        await endpointsIn(tx, P, chainId, head),
        d,
      );
    });

  let id: PlacementId;

  it('runs propose → duplicate → accept → changed → re-confirm → reject → suppressed → reopened → hold', async () => {
    const seqStart = (await events(P)).at(-1)?.seq ?? 0;
    // An agent proposal: semantic, ok.
    const first = await propose(agent, proposal('step-auftrag', 1, AUFTRAG));
    id = first.placement.id;
    expect(id).toMatch(/^plc_/);
    expect(first).toMatchObject({
      effect: 'applied',
      placement: {
        status: 'proposed',
        endpointState: 'ok',
        tier: 'semantic',
        confidence: 0.8,
        version: 1,
        stepFp: head.stepFingerprints.get('step-auftrag'),
      },
    });
    expect(first.placement.processFp).toMatch(/^[0-9a-f]{12}$/);
    // The same proposal again: a duplicate, nothing recorded.
    expect(await propose(agent, proposal('step-auftrag', 1, AUFTRAG))).toMatchObject({
      effect: 'duplicate',
      placement: { version: 1 },
    });
    expect(await historyOf(P, id)).toHaveLength(1);

    // A human accepts it.
    expect(await decide(id, decision('accept', 'Passt.'))).toMatchObject({
      status: 'accepted',
      endpointState: 'ok',
      version: 2,
    });
    // Agents cannot decide; the domain refuses before the DB check would.
    await expect(decide(id, decision('reject', 'nein'), agent)).rejects.toMatchObject({
      code: 'human-decision-required',
    });

    // A rename changes the step fingerprint: accepted, changed (an open item).
    await save(prepare(chainDoc('Lebenszyklus', steps('Auftragsannahme'))));
    expect(await placementOf(P, id)).toMatchObject({
      status: 'accepted',
      endpointState: 'changed',
      version: 3,
    });
    // Re-confirming anchors the acceptance on the new fingerprint.
    expect(await decide(id, decision('accept', null))).toMatchObject({
      status: 'accepted',
      endpointState: 'ok',
      stepFp: head.stepFingerprints.get('step-auftrag'),
      version: 4,
    });

    // A rejection needs a reason; a hold needs a note.
    await expect(decide(id, decision('reject', '  '))).rejects.toMatchObject({
      code: 'validation-failed',
      extras: { reason: 'rationale-required' },
    });
    await expect(decide(id, decision('hold', null))).rejects.toMatchObject({
      code: 'validation-failed',
    });
    expect(
      await decide(id, decision('reject', 'Gehört zur Annahme, nicht hierher.')),
    ).toMatchObject({
      status: 'rejected',
      version: 5,
    });
    // The same proposal with the same fingerprints is suppressed.
    expect(
      await propose(agent, proposal('step-auftrag', 1, AUFTRAG, { confidence: 0.9 })),
    ).toMatchObject({
      effect: 'suppressed',
      placement: { status: 'rejected', version: 5 },
    });
    // After another rename, a proposal reopens it.
    await save(prepare(chainDoc('Lebenszyklus', steps('Auftragserfassung'))));
    expect(await placementOf(P, id)).toMatchObject({
      status: 'rejected',
      endpointState: 'changed',
    });
    expect(
      await propose(agent, proposal('step-auftrag', 1, AUFTRAG, { confidence: 0.9 })),
    ).toMatchObject({
      effect: 'reopened',
      placement: { status: 'proposed', endpointState: 'ok', confidence: 0.9 },
    });

    // A hold with note, question and label.
    expect(
      await decide(
        id,
        decision('hold', 'Mit dem Vertrieb klären.', {
          question: 'Wer ist zuständig?',
          label: 'klären',
        }),
      ),
    ).toMatchObject({ status: 'held' });
    // A pipeline judgement (with a basis) under the hold is recorded; the hold stays.
    const procedure = { id: 'proa-placements', version: '0.1.0' };
    const judged = await propose(agent, proposal('step-auftrag', 1, AUFTRAG, { confidence: 0.7 }), {
      declared: { procedure, llmModel: 'test-model' },
      basisOf: () => ({ stepHash: head.structureHash, processHash: 'facts-hash' }),
    });
    expect(judged).toMatchObject({ effect: 'applied', placement: { status: 'held' } });
    const recorded = (await historyOf(P, id)).at(-1);
    expect(recorded).toMatchObject({
      kind: 'proposal',
      stepHash: head.structureHash,
      processHash: 'facts-hash',
      declared: { procedure, llmModel: 'test-model' },
    });
    // An ad-hoc proposal under the hold is suppressed.
    expect(
      await propose(agent, proposal('step-auftrag', 1, AUFTRAG, { confidence: 0.6 })),
    ).toMatchObject({
      effect: 'suppressed',
    });

    // A note keeps status and version.
    const before = await placementOf(P, id);
    const note = await write(P, (tx) =>
      addPlacementNote(tx, P, owner, before, 'Vertrieb ist zuständig.'),
    );
    expect(note).toMatchObject({ kind: 'note', sourceKind: 'human', stepFp: before.stepFp });
    expect(await placementOf(P, id)).toMatchObject({ status: 'held', version: before.version });
    await expect(
      write(P, (tx) => addPlacementNote(tx, P, agent, before, 'Agentennotiz')),
    ).rejects.toMatchObject({ code: 'human-decision-required' });

    // Every recorded assertion moved the version once; the events are typed and dense.
    const history = await historyOf(P, id);
    expect(history.map((a) => a.kind)).toEqual([
      'proposal',
      'decision',
      'decision',
      'decision',
      'proposal',
      'decision',
      'proposal',
      'note',
    ]);
    const evs = (await events(P, seqStart)).filter((e) => e.subjectRef === id);
    // A re-confirmation and a reopening move `changed` back to `ok`, as for relations.
    expect(evs.map((e) => e.type)).toEqual([
      'placement.proposed',
      'placement.decided',
      'placement.endpoint_changed',
      'placement.decided',
      'placement.endpoint_changed',
      'placement.decided',
      'placement.endpoint_changed',
      'placement.proposed',
      'placement.endpoint_changed',
      'placement.decided',
      'placement.proposed',
      'placement.noted',
    ]);
    expect(
      evs
        .filter((e) => e.type === 'placement.endpoint_changed')
        .map((e) => e.payload['endpointState']),
    ).toEqual(['changed', 'ok', 'changed', 'ok']);
    expect(history.map((a) => a.seq)).toEqual(
      evs.filter((e) => e.type !== 'placement.endpoint_changed').map((e) => e.seq),
    );
    expect(evs[0]?.payload).toEqual({
      placementId: id,
      valueChainId: chainId,
      elementId: 'step-auftrag',
      generation: 1,
      process: AUFTRAG,
      sourceKind: 'agent',
      tier: 'semantic',
      confidence: 0.8,
    });
    expect(evs[1]?.payload).toMatchObject({ verdict: 'accept', sourceKind: 'human' });
  });

  it('a withdrawal makes a proposal-only placement obsolete, which cannot be decided', async () => {
    const { placement } = await propose(agent, proposal('step-versand', 1, VERSAND));
    const withdrawn = await write(P, async (tx) => {
      const ctx = await context(tx, P, agent, chainId, head);
      return withdrawPlacementStance(
        ctx,
        placement,
        {
          principalId: agent.principalId,
          sourceKind: 'agent',
          clientId: agent.clientId,
        },
        null,
      );
    });
    expect(withdrawn).toMatchObject({ status: 'obsolete', version: 2 });
    expect((await events(P)).at(-1)).toMatchObject({
      type: 'placement.withdrawn',
      subjectRef: placement.id,
      principalId: agent.principalId,
    });
    await expect(decide(placement.id, decision('accept', null))).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('correct links the rejected placement and the manual one both ways', async () => {
    const { placement } = await propose(agent, proposal('step-auftrag', 1, RECHNUNG));
    const result = await write(P, async (tx) => {
      const history = await tx.placementAssertions.listForPlacements(P, [placement.id]);
      const endpoints = await endpointsIn(tx, P, chainId, head);
      await expect(
        correctPlacement(
          tx,
          P,
          owner,
          placement,
          history,
          endpoints,
          { elementId: 'step-auftrag', generation: 1 },
          'x',
        ),
      ).rejects.toMatchObject({ code: 'validation-failed', extras: { reason: 'same-step' } });
      return correctPlacement(
        tx,
        P,
        owner,
        placement,
        history,
        endpoints,
        { elementId: 'step-rechnung', generation: 1 },
        'Rechnungsstellung ist der Ort.',
      );
    });
    expect(result.placement).toMatchObject({ id: placement.id, status: 'rejected' });
    expect(result.corrected).toMatchObject({
      elementId: 'step-rechnung',
      processRef: RECHNUNG,
      status: 'accepted',
      tier: 'manual',
      endpointState: 'ok',
    });
    expect((await historyOf(P, placement.id)).at(-1)).toMatchObject({
      verdict: 'reject',
      linkedPlacementId: result.corrected.id,
    });
    expect(await historyOf(P, result.corrected.id)).toMatchObject([
      { kind: 'decision', verdict: 'accept', tier: 'manual', linkedPlacementId: placement.id },
    ]);
  });

  it('accepts manual placements, @outside included, once; both ends must exist', async () => {
    const manual = (item: Partial<Parameters<typeof acceptManualPlacement>[5]>, actor = owner) =>
      write(P, async (tx) =>
        acceptManualPlacement(
          tx,
          P,
          actor,
          chainId,
          await endpointsIn(tx, P, chainId, head),
          {
            elementId: OUTSIDE,
            generation: 1,
            processRef: VERSAND,
            rationale: 'Technischer Adapter.',
            confidence: null,
            ...item,
          },
          null,
        ),
      );
    const first = await manual({});
    expect(first).toMatchObject({
      recorded: true,
      placement: {
        status: 'accepted',
        tier: 'manual',
        stepFp: OUTSIDE_FINGERPRINT,
        endpointState: 'ok',
      },
    });
    expect(await manual({})).toMatchObject({
      recorded: false,
      placement: { id: first.placement.id },
    });
    await expect(manual({ rationale: '' })).rejects.toMatchObject({
      extras: { reason: 'rationale-required' },
    });
    await expect(manual({ elementId: 'step-unbekannt' })).rejects.toMatchObject({
      extras: { reason: 'unknown-step' },
    });
    await expect(manual({ elementId: 'step-versand', generation: 2 })).rejects.toMatchObject({
      extras: { reason: 'unknown-step' },
    });
    await expect(manual({ processRef: 'lager/versand#P_Fehlt' })).rejects.toMatchObject({
      extras: { reason: 'unknown-process' },
    });
    await expect(manual({}, agent)).rejects.toMatchObject({ code: 'human-decision-required' });
    // @outside needs a reason (M4 §2): nothing is recorded without one.
    const placementsBefore = await store.read((tx) => tx.placements.forChain(P, chainId));
    for (const rationale of ['', '  ']) {
      await expect(
        propose(agent, proposal(OUTSIDE, 1, AUFTRAG, { rationale })),
      ).rejects.toMatchObject({
        code: 'validation-failed',
        extras: { reason: 'rationale-required' },
      });
    }
    expect(await store.read((tx) => tx.placements.forChain(P, chainId))).toEqual(placementsBefore);
    // An agent proposal to @outside is semantic and anchored on the constant fingerprint.
    const outside = await propose(
      agent,
      proposal(OUTSIDE, 1, AUFTRAG, { rationale: 'Archivkopie.' }),
    );
    expect(outside.placement).toMatchObject({ tier: 'semantic', stepFp: OUTSIDE_FINGERPRINT });
  });

  it('records the rule tier’s key proposals under proa-rules with source kind rule', async () => {
    const rules = await t.useCases.rulesPrincipal();
    const asRules = { proposer: { sourceKind: 'rule' as const, principalId: rules } };
    const key = proposal('step-versand', 1, AUFTRAG, { tier: 'key', confidence: 1 });
    const seqBefore = (await events(P)).at(-1)?.seq ?? 0;
    const { effect, placement } = await propose(agent, key, asRules);
    expect(effect).toBe('applied');
    expect(placement).toMatchObject({ status: 'proposed', tier: 'key', confidence: 1 });
    expect(await historyOf(P, placement.id)).toMatchObject([
      { kind: 'proposal', sourceKind: 'rule', principalId: rules, clientId: null, tier: 'key' },
    ]);
    expect(await events(P, seqBefore)).toMatchObject([
      {
        type: 'placement.proposed',
        subjectRef: placement.id,
        principalId: rules,
        clientId: null,
        payload: { sourceKind: 'rule', tier: 'key', confidence: 1 },
      },
    ]);
    // Derived again unchanged: a duplicate of the rule's own proposal.
    expect((await propose(agent, key, asRules)).effect).toBe('duplicate');
    // Tier and source go together: `key` exactly for the rule tier.
    await expect(propose(agent, key)).rejects.toThrow(/key proposal/);
    await expect(propose(agent, proposal('step-versand', 1, AUFTRAG), asRules)).rejects.toThrow(
      /semantic proposal/,
    );
    expect(await historyOf(P, placement.id)).toHaveLength(1);
  });

  it('a deleted model makes the process side missing: deleteModel refreshes the placements (S2)', async () => {
    const rules = await t.useCases.rulesPrincipal();
    const versand = await store.read((tx) => tx.models.findByKey(P, 'lager/versand'));
    const del = await t.asOwner(`/api/v1/projects/vc-life/models/${versand?.id ?? ''}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(204);
    const refresh = () =>
      write(P, async (tx) =>
        refreshPlacements(tx, P, chainId, await endpointsIn(tx, P, chainId, head), {
          principalId: owner.principalId,
          clientId: owner.clientId,
        }),
      );
    // deleteModel refreshed them already (M4 S2): nothing is left to write.
    expect(await refresh()).toEqual({ written: 0, endpointChanges: 0 });
    const placements = await store.read((tx) => tx.placements.forChain(P, chainId));
    expect(
      placements
        .filter((p) => p.processRef === VERSAND)
        .map((p) => [p.elementId, p.status, p.endpointState])
        .sort(),
    ).toEqual([
      [OUTSIDE, 'accepted', 'missing'],
      ['step-versand', 'obsolete', 'missing'],
    ]);
    // The hand-made key proposal of P_Auftrag on step-versand is derived by no rule: the rule
    // tier withdrew it with the deletion's recomputation.
    const handMade = placements.find(
      (p) => p.processRef === AUFTRAG && p.elementId === 'step-versand',
    );
    expect(handMade?.status).toBe('obsolete');
    expect((await historyOf(P, handMade?.id ?? ('' as PlacementId))).at(-1)).toMatchObject({
      kind: 'withdrawal',
      sourceKind: 'rule',
      principalId: rules,
    });
    expect(await t.putModel('vc-life', 'lager/versand', MODELS['lager/versand'])).toHaveProperty(
      'status',
      201,
    );
    expect(await refresh()).toEqual({ written: 0, endpointChanges: 0 });
    const after = await store.read((tx) => tx.placements.forChain(P, chainId));
    expect(
      after
        .filter((p) => p.processRef === VERSAND)
        .map((p) => [p.elementId, p.status, p.endpointState, p.tier])
        .sort(),
    ).toEqual([
      [OUTSIDE, 'accepted', 'ok', 'manual'],
      // Step "Versand" and process "Versand": the rule tier proposes it again.
      ['step-versand', 'proposed', 'ok', 'key'],
    ]);
  });

  it('lists placements by filter, in natural key order, page by page', async () => {
    const list = (
      filter: Partial<Parameters<Tx['placements']['list']>[1]>,
      page: Parameters<Tx['placements']['list']>[2] = { limit: 100 },
    ) => store.read((tx) => tx.placements.list(P, { valueChainId: chainId, ...filter }, page));
    const key = (p: PlacementRecord) => `${p.elementId} ${p.generation} ${p.processRef}`;
    const all = await list({ includeObsolete: true });
    const live = await list({});
    expect(all.length).toBeGreaterThan(live.length);
    expect(live.every((p) => p.status !== 'obsolete')).toBe(true);
    // Code point order: '@outside' before 'step-…'.
    expect(all.map(key)).toEqual(
      [...all].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)).map(key),
    );
    expect(all[0]?.elementId).toBe(OUTSIDE);
    // Pages of two, following the cursor, give the same list.
    const paged: PlacementRecord[] = [];
    let after: readonly [string, number, string] | undefined;
    for (;;) {
      const page = await list({ includeObsolete: true }, { after, limit: 2 });
      paged.push(...page);
      const last = page.at(-1);
      if (!last || page.length < 2) break;
      after = [last.elementId, last.generation, last.processRef];
    }
    expect(paged.map(key)).toEqual(all.map(key));
    expect(
      (await list({ touchingModelKey: 'finanzen/rechnung' })).map((p) => p.processRef),
    ).toEqual([RECHNUNG, RECHNUNG]);
    expect((await list({ processRef: AUFTRAG })).every((p) => p.processRef === AUFTRAG)).toBe(true);
    expect((await list({ elementId: 'step-rechnung' })).map((p) => p.status)).toEqual(['accepted']);
    expect((await list({ status: 'obsolete' })).map((p) => p.processRef)).toEqual([AUFTRAG]);
  });

  it('keeps the event history dense and every event typed by its subject', async () => {
    const all = await events(P);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    const project = await store.read((tx) => tx.projects.findByRef(P));
    expect(project?.lastSeq).toBe(all.length);
    for (const e of all) {
      if (e.type.startsWith('placement.')) {
        expect(e.subjectRef).toMatch(/^plc_/);
        expect(e.payload).toMatchObject({ placementId: e.subjectRef, valueChainId: chainId });
      }
      if (e.type.startsWith('value_chain.')) expect(e.subjectRef).toBe(chainId);
    }
    expect(
      new Set(all.filter((e) => /^(placement|value_chain)\./.test(e.type)).map((e) => e.type)),
    ).toEqual(
      new Set([
        'value_chain.created',
        'value_chain.revised',
        'placement.proposed',
        'placement.decided',
        'placement.withdrawn',
        'placement.noted',
        'placement.endpoint_changed',
      ]),
    );
  });
});

describe('the dev landscape golden chain', () => {
  it('stores nordwind-handel verbatim with one generation per step', async () => {
    const P = (await t.createProject('vc-nordwind')).id;
    const bytes = await readFile(
      new URL('../../../../eval/value-chains/nordwind-handel/value-chain.vc.json', import.meta.url),
    );
    const prepared = prepare(JSON.parse(bytes.toString('utf8')));
    expect(prepared.content).toEqual(new Uint8Array(bytes));
    const created = await write(P, (tx) =>
      createValueChain(tx, owner, P, { key: 'main' }, prepared),
    );
    expect(created.chain.name).toBe('Nordwind Handel – Wertschöpfungskette');
    expect(created.steps.added).toHaveLength(prepared.stepFingerprints.size + 1);
    const stored = await store.read((tx) =>
      tx.valueChainRevisions.content(P, created.chain.id, created.revision.id),
    );
    expect(stored).toEqual(new Uint8Array(bytes));
  });
});
