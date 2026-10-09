/**
 * The value chain side of a model change (M4 §2, S2): after an ingest that
 * stored new revisions and after a model deletion, the head's `process`
 * facts changed, so every placement's endpoint state is recomputed against
 * them (a renamed process turns an accepted placement `changed`, a deleted
 * one `missing`, a re-upload `ok` again) and the rule tier's key proposals
 * are derived again (a step named like a new process gets one, a deleted
 * process's one is withdrawn). Runs inside the ingest transaction, after the
 * relation side's `recomputeProject`; every event is recorded under
 * `proa-rules` without a client, as `recompute.ts` does for relations. A
 * project without a live chain costs one query.
 */
import type { PrincipalId, ProjectId } from '@proa/contracts';

import type { Tx } from '../ports.ts';
import { loadChainState } from './chain-state.ts';
import { refreshPlacements } from './placement-state.ts';
import { recomputeRulePlacements } from './rules.ts';

export interface ChainSync {
  /** Placements whose endpoint state changed. */
  endpointChanges: number;
  /** Rule proposals recorded. */
  proposed: number;
  /** Rule proposals withdrawn. */
  withdrawn: number;
}

/**
 * Recomputes the rule tier's placements of every live chain, then refreshes
 * its placements against the head's process fingerprints and the cached step
 * fingerprints of the chain's head. The caller holds the project lock.
 */
export async function syncValueChainAfterModels(
  tx: Tx,
  projectId: ProjectId,
  rulesPrincipalId: PrincipalId,
): Promise<ChainSync> {
  const summary: ChainSync = { endpointChanges: 0, proposed: 0, withdrawn: 0 };
  for (const chain of await tx.valueChains.list(projectId)) {
    if (chain.deletedSeq !== null || chain.headRevisionId === null) continue;
    const state = await loadChainState(tx, chain);
    // Rules first: a withdrawn rule proposal turns obsolete with its new endpoint state (no
    // `endpoint_changed` for it), a re-asserted one keeps `ok`; the refresh does the rest.
    const rules = await recomputeRulePlacements(tx, state, rulesPrincipalId);
    summary.proposed += rules.proposed;
    summary.withdrawn += rules.withdrawn;
    const refreshed = await refreshPlacements(tx, projectId, chain.id, state.endpoints, {
      principalId: rulesPrincipalId,
      clientId: null,
    });
    summary.endpointChanges += refreshed.endpointChanges;
  }
  return summary;
}
