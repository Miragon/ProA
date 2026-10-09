/**
 * The value chain write path (M4 §2): create, save and delete a chain inside
 * the caller's transaction. Revisions are immutable and saved by humans only;
 * each one updates the step generations, the head and the chain's name,
 * withdraws the live proposals on the generations it tombstones and
 * refreshes the placements' endpoint state.
 *
 * The seam to S2 is {@link PreparedRevision}: S2's `prepareRevision`
 * canonicalizes the input with schema-model, applies the ProA rules, derives
 * kinds and step fingerprints and computes `structure_hash`. These functions
 * trust it, and revisions are append-only, so nothing may call them before
 * that exists (S1 has no REST, MCP or CLI entry). Every function assumes the
 * caller holds `tx.projects.lockForWrite(projectId)`.
 */
import {
  newId,
  type ProjectId,
  type ValueChainId,
  type ValueChainRevisionId,
} from '@proa/contracts';

import { sourceKindOf, type Actor } from '../actor.ts';
import { DomainError } from '../errors.ts';
import type { Tx, ValueChainRecord, ValueChainRevisionRecord } from '../ports.ts';
import {
  placementEndpoints,
  processFingerprints,
  refreshPlacements,
  type PlacementEndpoints,
} from './placement-state.ts';
import { withdrawProposalsOnRemovedSteps } from './placements.ts';
import { planStepGenerations, type GenerationMode, type StepKey } from './steps.ts';

/** The only chain key in M4 (one chain per project, M4 §11). */
export const MAIN_VALUE_CHAIN_KEY = 'main';

/** A revision ready to store: what S2's `prepareRevision` produces from the input. */
export interface PreparedRevision {
  /** Canonical bytes: UTF-8 of `serializeDocument(loadDocument(input))`. */
  content: Uint8Array;
  /** sha256 (hex) of `content`. */
  contentHash: string;
  structureHash: string;
  schemaVersion: number;
  /** `meta.name` of the document: the chain's name. */
  name: string;
  /** The fingerprint of every element of type `step`, by element id. */
  stepFingerprints: ReadonlyMap<string, string>;
}

/** A stored revision and the generations it added and tombstoned. */
export interface RevisionWritten {
  /** `revived`: the key's deleted chain was created again (same `vch_`). */
  outcome: 'created' | 'revived' | 'revised';
  chain: ValueChainRecord;
  revision: ValueChainRevisionRecord;
  steps: { added: StepKey[]; removed: StepKey[] };
}

/** `unchanged`: the content equals the head's; nothing was written. */
export type SaveResult =
  | RevisionWritten
  | { outcome: 'unchanged'; chain: ValueChainRecord; revision: ValueChainRevisionRecord };

/** Agents never edit the chain (M4 §7); the DB check backs this up. */
function requireHuman(actor: Actor): void {
  if (sourceKindOf(actor) !== 'human') {
    throw new DomainError('human-decision-required', 'only a human edits the value chain');
  }
}

async function headOf(tx: Tx, chain: ValueChainRecord): Promise<ValueChainRevisionRecord | null> {
  if (chain.headRevisionId === null) return null;
  return tx.valueChainRevisions.findInProject(chain.projectId, chain.id, chain.headRevisionId);
}

/**
 * Stores a revision: the next `rev` (numbering continues after a deletion and
 * revival, so the ETag `"r<rev>"` never repeats), its event, the step
 * generations, the head and name, the withdrawal of the live proposals on
 * removed generations, and the placements' endpoint state.
 */
async function appendRevision(
  tx: Tx,
  actor: Actor,
  chain: ValueChainRecord,
  prepared: PreparedRevision,
  options: {
    mode: Exclude<GenerationMode, 'delete'>;
    outcome: RevisionWritten['outcome'];
    baseRevisionId: ValueChainRevisionId | null;
  },
): Promise<RevisionWritten> {
  const projectId = chain.projectId;
  const rev = (await tx.valueChainRevisions.maxRev(projectId, chain.id)) + 1;
  const plan = planStepGenerations(
    await tx.valueChainSteps.list(projectId, chain.id),
    prepared.stepFingerprints.keys(),
    options.mode,
  );
  const id = newId('valueChainRevision');
  const seq = await tx.events.append(projectId, {
    type: options.mode === 'create' ? 'value_chain.created' : 'value_chain.revised',
    principalId: actor.principalId,
    clientId: actor.clientId,
    subjectRef: chain.id,
    payload: {
      outcome: options.outcome,
      valueChainId: chain.id,
      key: chain.key,
      revisionId: id,
      rev,
      contentHash: prepared.contentHash,
      structureHash: prepared.structureHash,
      stepsAdded: plan.added.length,
      stepsRemoved: plan.removed.length,
      ...(options.mode === 'revise' ? { baseRevisionId: options.baseRevisionId } : {}),
    },
  });
  await tx.valueChainRevisions.insert({
    id,
    projectId,
    valueChainId: chain.id,
    rev,
    content: prepared.content,
    contentHash: prepared.contentHash,
    structureHash: prepared.structureHash,
    schemaVersion: prepared.schemaVersion,
    baseRevisionId: options.baseRevisionId,
    principalId: actor.principalId,
    sourceKind: 'human',
    seq,
  });
  await tx.valueChainSteps.tombstone(projectId, chain.id, plan.removed, { rev, seq });
  await tx.valueChainSteps.insertMany(
    plan.added.map((k) => ({ ...k, projectId, valueChainId: chain.id, createdRev: rev })),
  );
  const stored = await tx.valueChains.update(projectId, chain.id, {
    headRevisionId: id,
    name: prepared.name,
    deletedSeq: null,
  });
  const revision = await tx.valueChainRevisions.findInProject(projectId, chain.id, id);
  if (!revision) throw new Error(`revision ${id} vanished inside its transaction`);
  const processes = processFingerprints(await tx.facts.head(projectId, { kinds: ['process'] }));
  const endpoints = placementEndpoints(plan.live, prepared.stepFingerprints, processes);
  await withdrawProposalsOnRemovedSteps(
    tx,
    projectId,
    actor,
    chain.id,
    endpoints,
    plan.removed,
    `step removed in revision ${rev}`,
  );
  await refreshPlacements(tx, projectId, chain.id, endpoints, {
    principalId: actor.principalId,
    clientId: actor.clientId,
  });
  return {
    outcome: options.outcome,
    chain: stored,
    revision,
    steps: { added: plan.added, removed: plan.removed },
  };
}

/**
 * Creates the chain `key` with its first revision, or revives the key's
 * deleted chain (same `vch_`, `rev` continues, new step generations, so none
 * of its placements comes back). The chain's name is `prepared.name`.
 *
 * @throws {DomainError} `human-decision-required` for agents; `validation-failed`
 *   for a key other than `main`; `conflict` if a live chain has the key
 */
export async function createValueChain(
  tx: Tx,
  actor: Actor,
  projectId: ProjectId,
  input: { key: string },
  prepared: PreparedRevision,
): Promise<RevisionWritten> {
  requireHuman(actor);
  if (input.key !== MAIN_VALUE_CHAIN_KEY) {
    throw new DomainError('validation-failed', 'a project has one value chain, key main', {
      reason: 'value-chain-key',
    });
  }
  const existing = await tx.valueChains.findByKey(projectId, input.key);
  if (existing && existing.deletedSeq === null) {
    throw new DomainError('conflict', `the value chain ${input.key} exists`, {
      valueChainId: existing.id,
    });
  }
  const chain =
    existing ??
    (await tx.valueChains.insert({
      id: newId('valueChain'),
      projectId,
      key: input.key,
      name: prepared.name,
    }));
  return appendRevision(tx, actor, chain, prepared, {
    mode: 'create',
    outcome: existing ? 'revived' : 'created',
    baseRevisionId: null,
  });
}

/**
 * Saves a new revision of a live chain; content equal to the head's is
 * `unchanged` (no row, no event).
 *
 * @param baseRevisionId the revision the editor started from (S2 checks it against the head with `If-Match`)
 * @throws {DomainError} `human-decision-required` for agents; `not-found` for
 *   a deleted or foreign chain; `validation-failed` for a base revision of
 *   another chain
 */
export async function saveValueChainRevision(
  tx: Tx,
  actor: Actor,
  projectId: ProjectId,
  valueChainId: ValueChainId,
  prepared: PreparedRevision,
  options: { baseRevisionId: ValueChainRevisionId | null },
): Promise<SaveResult> {
  requireHuman(actor);
  const chain = await tx.valueChains.findInProject(projectId, valueChainId);
  if (!chain) throw new DomainError('not-found', 'value chain not found');
  if (
    options.baseRevisionId !== null &&
    !(await tx.valueChainRevisions.findInProject(projectId, chain.id, options.baseRevisionId))
  ) {
    throw new DomainError('validation-failed', 'the base revision is not one of this chain', {
      reason: 'unknown-base-revision',
    });
  }
  const head = await headOf(tx, chain);
  if (head && head.contentHash === prepared.contentHash) {
    return { outcome: 'unchanged', chain, revision: head };
  }
  return appendRevision(tx, actor, chain, prepared, {
    mode: 'revise',
    outcome: 'revised',
    baseRevisionId: options.baseRevisionId,
  });
}

/**
 * Deletes a chain: marks it deleted and tombstones every live generation,
 * `@outside` included, so every placement turns `missing` and a re-created
 * chain revives none; the live proposals on them are withdrawn. Revisions,
 * placements and their history stay.
 *
 * @throws {DomainError} `human-decision-required` for agents; `not-found` for
 *   a deleted or foreign chain
 */
export async function deleteValueChain(
  tx: Tx,
  actor: Actor,
  projectId: ProjectId,
  valueChainId: ValueChainId,
): Promise<{ chain: ValueChainRecord; removed: StepKey[] }> {
  requireHuman(actor);
  const chain = await tx.valueChains.findInProject(projectId, valueChainId);
  if (!chain) throw new DomainError('not-found', 'value chain not found');
  const plan = planStepGenerations(
    await tx.valueChainSteps.list(projectId, chain.id),
    [],
    'delete',
  );
  const seq = await tx.events.append(projectId, {
    type: 'value_chain.deleted',
    principalId: actor.principalId,
    clientId: actor.clientId,
    subjectRef: chain.id,
    payload: { valueChainId: chain.id, key: chain.key, stepsRemoved: plan.removed.length },
  });
  const stored = await tx.valueChains.update(projectId, chain.id, { deletedSeq: seq });
  await tx.valueChainSteps.tombstone(projectId, chain.id, plan.removed, { rev: null, seq });
  const processes = processFingerprints(await tx.facts.head(projectId, { kinds: ['process'] }));
  const endpoints: PlacementEndpoints = {
    step: () => undefined,
    process: (ref) => processes.get(ref),
  };
  await withdrawProposalsOnRemovedSteps(
    tx,
    projectId,
    actor,
    chain.id,
    endpoints,
    plan.removed,
    'value chain deleted',
  );
  await refreshPlacements(tx, projectId, chain.id, endpoints, {
    principalId: actor.principalId,
    clientId: actor.clientId,
  });
  return { chain: stored, removed: plan.removed };
}
