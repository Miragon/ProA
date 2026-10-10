/**
 * Queueing of the value chain's `placement` task (M4 §3.2, judge each
 * process once). At most one placement task per chain is open (a partial
 * unique index backs this up), so no two claims ever judge the same process.
 * A task is queued only when an open process is due (its input hash differs
 * from the agent's last verdict); a trigger that arrives while a task is
 * claimed sets `requeue_after`, so the submission queues the follow-up and a
 * save never cancels an agent's work. Human decisions and notes never queue:
 * they make processes due for the next task. Runs inside the caller's
 * transaction, which holds the project lock.
 */
import { newId, type DeclaredProcedure, type PlacementId, type ProjectId } from '@proa/contracts';

import type { Actor } from '../actor.ts';
import type {
  ChainTaskRecord,
  HeadFact,
  PlacementRecord,
  RelationRecord,
  StoredPlacementAssertion,
  StoredPlacementInput,
  Tx,
  ValueChainRecord,
  ValueChainRevisionRecord,
} from '../ports.ts';
import { loadChainState, type ChainState } from './chain-state.ts';
import {
  chainInputDigest,
  dueDigest,
  dueProcesses,
  lastNonAgentSeqs,
  openProcesses,
  placementInputHash,
  processInputDigest,
  type DueProcess,
  type InputHashContext,
} from './pipeline.ts';
import { byPlacement } from './placement-state.ts';
import { acceptedNeighbours, acceptedSteps, processOfRefs } from './tiers.ts';
import { factsByProcess, processOwnFields } from './unplaced.ts';

/** Why a placement task is queued (the `reason` of `analysis.queued`). */
export type PlacementQueueReason =
  | 'value chain saved'
  | 'models changed'
  | 'judgement withdrawn'
  | 'follow-up'
  | 'requeue'
  | 'server start';

/** Triggers that a claimed task defers to its submission (`requeue_after`). */
const DEFERRED: ReadonlySet<PlacementQueueReason> = new Set([
  'value chain saved',
  'models changed',
  'judgement withdrawn',
]);

/** What the pipeline needs to know about a live chain to tell which processes are due. */
export interface PipelineInputs {
  state: ChainState;
  /** Every placement of the chain, obsolete ones included. */
  placements: PlacementRecord[];
  histories: Map<PlacementId, StoredPlacementAssertion[]>;
  /** Every head fact of the project. */
  facts: HeadFact[];
  /** The head facts of each process, by process ref (`factsByProcess`). */
  byProcess: Map<string, HeadFact[]>;
  /** Every relation of the project. */
  relations: RelationRecord[];
  /** The agent's last verdict per process. */
  rows: Map<string, StoredPlacementInput>;
  hashContext: InputHashContext;
  /** The current input hash of a process. */
  hashOf(processRef: string): string;
  /** Open processes, by ref. */
  open: string[];
  /** Due processes, by ref, with their input hashes. */
  due: DueProcess[];
}

/**
 * {@link chainInputDigest} of a chain state: its steps as a claim lists them
 * (links resolved against the head processes) and its live generations.
 */
export function chainDigestOf(
  state: Pick<ChainState, 'structure' | 'live' | 'processFacts'>,
): string {
  return chainInputDigest(
    state.structure,
    new Set(state.processFacts.map((f) => f.ref)),
    state.live,
  );
}

/**
 * Loads what the input hashes rest on and computes the open and due
 * processes of a live chain.
 *
 * @param procedure the procedure placement claims name
 */
export async function loadPipelineInputs(
  tx: Tx,
  state: ChainState,
  procedure: DeclaredProcedure,
): Promise<PipelineInputs> {
  const projectId = state.chain.projectId;
  const placements = await tx.placements.forChain(projectId, state.chain.id);
  const histories = byPlacement(
    await tx.placementAssertions.listForChain(projectId, state.chain.id),
  );
  const facts = await tx.facts.head(projectId);
  const byProcess = factsByProcess(facts);
  const relations = await tx.relations.all(projectId);
  const rows = new Map(
    (await tx.placementInputs.forChain(projectId, state.chain.id)).map((r) => [r.processRef, r]),
  );
  const hashContext: InputHashContext = {
    procedure,
    chainDigest: chainDigestOf(state),
    processDigests: new Map(
      state.processFacts.map((f) => [
        f.ref,
        processInputDigest(processOwnFields(f, byProcess.get(f.ref) ?? [])),
      ]),
    ),
    neighbours: acceptedNeighbours(relations, processOfRefs(facts)),
    acceptedSteps: acceptedSteps(placements, state.live),
    lastNonAgentSeq: lastNonAgentSeqs(placements, histories),
  };
  const memo = new Map<string, string>();
  const hashOf = (ref: string): string => {
    let hash = memo.get(ref);
    if (hash === undefined) {
      hash = placementInputHash(hashContext, ref);
      memo.set(ref, hash);
    }
    return hash;
  };
  const open = openProcesses(
    state.processFacts.map((f) => f.ref),
    placements,
    state.live,
  );
  const due = dueProcesses(open, new Map(open.map((ref) => [ref, hashOf(ref)])), rows);
  return {
    state,
    placements,
    histories,
    facts,
    byProcess,
    relations,
    rows,
    hashContext,
    hashOf,
    open,
    due,
  };
}

/**
 * Inserts a queued placement task for `due` (its `input_hash` is their
 * digest, its revision the head) and records `analysis.queued`.
 */
export async function insertPlacementTask(
  tx: Tx,
  actor: Actor,
  chain: ValueChainRecord,
  head: Pick<ValueChainRevisionRecord, 'id' | 'rev'>,
  due: readonly DueProcess[],
  reason: PlacementQueueReason,
): Promise<ChainTaskRecord> {
  const id = newId('analysisTask');
  const inputHash = dueDigest(due);
  const seq = await tx.events.append(chain.projectId, {
    type: 'analysis.queued',
    principalId: actor.principalId,
    clientId: actor.clientId,
    subjectRef: chain.id,
    payload: {
      taskId: id,
      kind: 'placement',
      valueChainId: chain.id,
      key: chain.key,
      revisionId: head.id,
      rev: head.rev,
      inputHash,
      due: due.length,
      reason,
    },
  });
  const task: ChainTaskRecord = {
    id,
    projectId: chain.projectId,
    subjectKind: 'value_chain',
    kind: 'placement',
    valueChainId: chain.id,
    valueChainRevisionId: head.id,
    inputHash,
    state: 'queued',
    seq,
  };
  await tx.tasks.insert(task);
  return task;
}

/** What {@link queuePlacementTask} did. */
export type QueueOutcome =
  | { outcome: 'queued'; task: ChainTaskRecord }
  /** A task is queued (its claim renders the head) or claimed (`deferred`: it got `requeue_after`). */
  | { outcome: 'open' | 'deferred'; task: ChainTaskRecord }
  | { outcome: 'nothing-due'; task: null };

/**
 * Queues the chain's placement task when an open process is due. A queued
 * task is left alone (its claim renders the head); a claimed one gets
 * `requeue_after` for the triggers that arrive during a lease (a save, a
 * model change, a lost judgement), so its submission queues the follow-up.
 */
export async function queuePlacementTask(
  tx: Tx,
  actor: Actor,
  chain: ValueChainRecord,
  reason: PlacementQueueReason,
  procedure: DeclaredProcedure,
): Promise<QueueOutcome> {
  const open = await tx.tasks.latestForChain(chain.projectId, chain.id, ['queued', 'claimed']);
  if (open?.state === 'queued') return { outcome: 'open', task: open };
  if (open) {
    if (!DEFERRED.has(reason)) return { outcome: 'open', task: open };
    await tx.tasks.setRequeueAfter(chain.projectId, open.id);
    return { outcome: 'deferred', task: open };
  }
  if (chain.deletedSeq !== null || chain.headRevisionId === null) {
    return { outcome: 'nothing-due', task: null };
  }
  const inputs = await loadPipelineInputs(tx, await loadChainState(tx, chain), procedure);
  if (inputs.due.length === 0) return { outcome: 'nothing-due', task: null };
  return {
    outcome: 'queued',
    task: await insertPlacementTask(tx, actor, chain, inputs.state.head, inputs.due, reason),
  };
}

/** {@link queuePlacementTask} for every live chain of the project (M4: at most `main`). */
export async function queuePlacementTasks(
  tx: Tx,
  actor: Actor,
  projectId: ProjectId,
  reason: PlacementQueueReason,
  procedure: DeclaredProcedure,
): Promise<void> {
  for (const chain of await tx.valueChains.list(projectId)) {
    if (chain.headRevisionId === null) continue;
    await queuePlacementTask(tx, actor, chain, reason, procedure);
  }
}

/** Cancels a chain's placement task and records `analysis.cancelled`. */
export async function cancelPlacementTask(
  tx: Tx,
  actor: Actor,
  chain: Pick<ValueChainRecord, 'id' | 'key' | 'projectId'>,
  task: Pick<ChainTaskRecord, 'id'>,
  reason: string,
): Promise<void> {
  await tx.tasks.setState(chain.projectId, task.id, 'cancelled', reason);
  await tx.events.append(chain.projectId, {
    type: 'analysis.cancelled',
    principalId: actor.principalId,
    clientId: actor.clientId,
    subjectRef: chain.id,
    payload: { taskId: task.id, kind: 'placement', valueChainId: chain.id, key: chain.key, reason },
  });
}

/** Cancels the chain's open placement task, if any (the chain's deletion). */
export async function cancelOpenPlacementTask(
  tx: Tx,
  actor: Actor,
  chain: Pick<ValueChainRecord, 'id' | 'key' | 'projectId'>,
  reason: string,
): Promise<void> {
  const open = await tx.tasks.latestForChain(chain.projectId, chain.id, ['queued', 'claimed']);
  if (open) await cancelPlacementTask(tx, actor, chain, open, reason);
}
