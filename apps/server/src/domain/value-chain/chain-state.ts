/**
 * The state of a live value chain that reads and writes work on: the head
 * revision, its structure (from the cache), the step generations, the head
 * processes and the endpoints of placements. Runs inside the caller's
 * transaction.
 */
import { VALUE_CHAIN_KEY, type ProjectId } from '@proa/contracts';

import { DomainError } from '../errors.ts';
import type {
  HeadFact,
  Tx,
  ValueChainRecord,
  ValueChainRevisionRecord,
  ValueChainStepRecord,
} from '../ports.ts';
import {
  placementEndpoints,
  processFingerprints,
  type PlacementEndpoints,
} from './placement-state.ts';
import { liveGenerations } from './steps.ts';
import { structureOf, type ChainStructure } from './structure.ts';

export interface ChainState {
  chain: ValueChainRecord;
  head: ValueChainRevisionRecord;
  structure: ChainStructure;
  /** Every generation, tombstones included. */
  steps: ValueChainStepRecord[];
  /** The live generation of each element id, `@outside` included. */
  live: Map<string, number>;
  /** The head's `process` facts. */
  processFacts: HeadFact[];
  endpoints: PlacementEndpoints;
}

/**
 * The message of a 404 for a project without a (live) chain: where a human
 * creates one (the web page since M4 S3, or the CLI). Agents relay it.
 */
export const NO_VALUE_CHAIN =
  'the project has no value chain yet; a human creates it on the value chain page of the ProA web UI (tab Wertschöpfungskette, /projects/<project key>/value-chain) or with proa value-chain push';

/**
 * The live chain with this key.
 *
 * @throws {DomainError} `not-found` for an unknown or deleted key (M4: only `main` exists)
 */
export async function liveChain(
  tx: Tx,
  projectId: ProjectId,
  key: string = VALUE_CHAIN_KEY,
): Promise<ValueChainRecord> {
  const chain = await tx.valueChains.findByKey(projectId, key);
  if (!chain || chain.deletedSeq !== null || chain.headRevisionId === null) {
    throw new DomainError(
      'not-found',
      key === VALUE_CHAIN_KEY ? NO_VALUE_CHAIN : `no value chain ${key}`,
    );
  }
  return chain;
}

/** The head revision of a live chain. */
export async function headRevision(
  tx: Tx,
  chain: ValueChainRecord,
): Promise<ValueChainRevisionRecord> {
  if (chain.headRevisionId === null) throw new Error(`value chain ${chain.id} has no head`);
  const head = await tx.valueChainRevisions.findInProject(
    chain.projectId,
    chain.id,
    chain.headRevisionId,
  );
  if (!head) throw new Error(`head of value chain ${chain.id} not found`);
  return head;
}

/** The structure of a revision (cached per `content_hash`). */
export function revisionStructure(
  tx: Tx,
  revision: ValueChainRevisionRecord,
): Promise<ChainStructure> {
  return structureOf(revision.contentHash, () =>
    tx.valueChainRevisions.content(revision.projectId, revision.valueChainId, revision.id),
  );
}

/** Loads the state of a live chain. */
export async function loadChainState(tx: Tx, chain: ValueChainRecord): Promise<ChainState> {
  const head = await headRevision(tx, chain);
  const structure = await revisionStructure(tx, head);
  const steps = await tx.valueChainSteps.list(chain.projectId, chain.id);
  const live = liveGenerations(steps);
  const processFacts = await tx.facts.head(chain.projectId, { kinds: ['process'] });
  return {
    chain,
    head,
    structure,
    steps,
    live,
    processFacts,
    endpoints: placementEndpoints(
      live,
      structure.stepFingerprints,
      processFingerprints(processFacts),
    ),
  };
}
