/**
 * Token revocation on the value chain side (CONCEPT §6 "revoking a token or
 * service withdraws its proposals", M4 S2): every live placement proposal of
 * the revoked principal is withdrawn under that principal, caused by the
 * revoking owner; rule proposals, human decisions and other principals'
 * proposals stay. The caller (M4b) forgets the verdicts the lost pipeline
 * proposals stood for and queues the placement task again.
 */
import type { PrincipalId, ProjectId, ValueChainId } from '@proa/contracts';

import type { Actor } from '../actor.ts';
import type { PlacementAssertionRecord, Tx } from '../ports.ts';
import { currentStances } from '../status.ts';
import { loadChainState } from './chain-state.ts';
import { byPlacement, placementKey } from './placement-state.ts';
import { withdrawPlacementStance, type PlacementContext } from './placements.ts';

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Withdraws the live placement proposals of `principalId` on every live
 * chain of the project (the caller holds the project lock).
 *
 * @returns the number of withdrawals and, per chain, the processes whose
 *   withdrawn proposal came from a placement task's submission
 */
export async function withdrawPlacementProposalsOf(
  tx: Tx,
  actor: Actor,
  projectId: ProjectId,
  principalId: PrincipalId,
  reason: string,
): Promise<{ withdrawn: number; pipelineLost: Map<ValueChainId, Set<string>> }> {
  let withdrawn = 0;
  const pipelineLost = new Map<ValueChainId, Set<string>>();
  for (const chain of await tx.valueChains.list(projectId)) {
    if (chain.headRevisionId === null) continue;
    const placements = await tx.placements.forChain(projectId, chain.id);
    const histories = byPlacement<PlacementAssertionRecord>(
      await tx.placementAssertions.listForChain(projectId, chain.id),
    );
    const own = (id: PlacementAssertionRecord['placementId']) =>
      currentStances(histories.get(id) ?? []).find(
        (a) => a.principalId === principalId && a.kind === 'proposal',
      );
    const affected = placements
      .filter((p) => own(p.id))
      .sort(
        (a, b) =>
          byCodePoint(a.elementId, b.elementId) ||
          a.generation - b.generation ||
          byCodePoint(a.processRef, b.processRef),
      );
    if (affected.length === 0) continue;
    const state = await loadChainState(tx, chain);
    const ctx: PlacementContext = {
      tx,
      projectId,
      actor,
      valueChainId: chain.id,
      endpoints: state.endpoints,
      placements: new Map(
        placements.map((p) => [placementKey(chain.id, p.elementId, p.generation, p.processRef), p]),
      ),
      histories,
      declared: null,
      submissionId: null,
    };
    for (const placement of affected) {
      const stance = own(placement.id);
      if (!stance) continue;
      await withdrawPlacementStance(ctx, placement, stance, reason, {
        principalId: actor.principalId,
        clientId: actor.clientId,
      });
      withdrawn++;
      if (stance.submissionId !== null) {
        pipelineLost.set(
          chain.id,
          (pipelineLost.get(chain.id) ?? new Set()).add(placement.processRef),
        );
      }
    }
  }
  return { withdrawn, pipelineLost };
}
