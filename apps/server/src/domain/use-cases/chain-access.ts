/** Shared steps of the value chain and placement use cases (M4 §7). */
import { valueChainPath, type PrincipalId } from '@proa/contracts';

import type { Actor } from '../actor.ts';
import { DomainError } from '../errors.ts';
import { policy, type ProjectAccess } from '../policy.ts';
import type { Tx } from '../ports.ts';
import type { UseCaseDeps } from './deps.ts';

/** What the value chain and placement use cases get injected. */
export interface ValueChainDeps extends UseCaseDeps {
  /** The rule tier's system principal (`proa-rules`), for derived placement proposals. */
  rulesPrincipal: () => Promise<PrincipalId>;
}

/**
 * `policy.require(…, 'review', …)` for chain writes, decisions, manual
 * placements and notes: an agent's attempt fails with
 * `human-decision-required` carrying `reviewUrl`, the value chain page (or
 * the placement or step on it), a path the HTTP and MCP layers make absolute.
 */
export async function requireChainReview(
  tx: Tx,
  actor: Actor,
  projectRef: string,
  target: { placementId?: string; elementId?: string } = {},
): Promise<ProjectAccess> {
  try {
    return await policy.require(tx, actor, 'review', projectRef);
  } catch (err) {
    if (err instanceof DomainError && err.code === 'human-decision-required') {
      const project = await tx.projects.findByRef(projectRef);
      throw new DomainError(err.code, err.message, {
        reviewUrl: valueChainPath(project?.key ?? projectRef, target),
      });
    }
    throw err;
  }
}
