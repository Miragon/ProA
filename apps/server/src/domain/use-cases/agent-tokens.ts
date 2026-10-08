import {
  newId,
  type AgentTokenId,
  type AgentTokenList,
  type CreateAgentTokenBody,
  type CreatedAgentToken,
} from '@proa/contracts';

import { AGENT_TOKEN_ISSUER, type Actor } from '../actor.ts';
import { generateAgentTokenSecret } from '../agent-token-secret.ts';
import { DomainError } from '../errors.ts';
import { headFingerprints } from '../fingerprints.ts';
import { policy } from '../policy.ts';
import type { AgentTokenRecord, AssertionRecord, ProjectRecord, Tx } from '../ports.ts';
import { withdrawStance, type ProposalContext } from '../proposals.ts';
import { byRelation, naturalKey } from '../relation-state.ts';
import { currentStances } from '../status.ts';
import { toAgentToken } from '../views.ts';
import { ALL, type UseCaseDeps } from './deps.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a revoked token leaves behind (CONCEPT §6, "revoking a token or
 * service withdraws its proposals"): its live proposals are withdrawn under
 * its principal, by the revoking owner, and its claimed tasks are queued
 * again without counting the attempt. Decisions by others stay.
 */
async function retractToken(
  tx: Tx,
  actor: Actor,
  project: ProjectRecord,
  token: AgentTokenRecord,
): Promise<{ withdrawn: number; released: number }> {
  const reason = `agent token ${token.name} (${token.prefix}…) revoked`;
  const histories = byRelation<AssertionRecord>(await tx.assertions.listForProject(project.id));
  const own = (history: readonly AssertionRecord[]) =>
    currentStances(history).find(
      (a) => a.principalId === token.principalId && a.kind === 'proposal',
    );
  const affected = (await tx.relations.all(project.id)).filter((r) =>
    own(histories.get(r.id) ?? []),
  );

  let withdrawn = 0;
  if (affected.length > 0) {
    const ctx: ProposalContext = {
      tx,
      projectId: project.id,
      actor,
      fps: headFingerprints(await tx.facts.headProjectFacts(project.id)),
      relations: new Map(affected.map((r) => [naturalKey(r.type, r.fromRef, r.toRef), r])),
      histories,
      declared: null,
      submissionId: null,
    };
    for (const relation of affected) {
      const stance = own(ctx.histories.get(relation.id) ?? []);
      if (!stance) continue;
      await withdrawStance(ctx, relation, stance, reason, {
        principalId: actor.principalId,
        clientId: actor.clientId,
      });
      withdrawn++;
    }
  }

  let released = 0;
  const claimed = await tx.tasks.list(project.id, { state: 'claimed' }, { limit: ALL });
  for (const task of claimed.filter((t) => t.claimedBy === token.principalId)) {
    await tx.tasks.release(project.id, task.id, reason);
    await tx.events.append(project.id, {
      type: 'analysis.released',
      principalId: actor.principalId,
      clientId: actor.clientId,
      subjectRef: task.modelKey,
      payload: {
        taskId: task.id,
        kind: task.kind,
        modelId: task.modelId,
        modelKey: task.modelKey,
        reason,
      },
    });
    released++;
  }
  return { withdrawn, released };
}

/**
 * Agent tokens (CONCEPT §6): one project, scopes from read/propose/write,
 * mandatory expiry, revocation; created, listed and revoked only by an owner
 * on an interactive client (permission `admin`).
 */
export function agentTokenUseCases(deps: UseCaseDeps) {
  return {
    /** The secret is returned once and stored only as sha256. */
    async createAgentToken(
      actor: Actor,
      projectRef: string,
      body: CreateAgentTokenBody,
    ): Promise<CreatedAgentToken> {
      const now = deps.clock.now();
      return deps.store.write(async (tx) => {
        const { project } = await policy.require(tx, actor, 'admin', projectRef);
        const id = newId('agentToken');
        const principalId = newId('principal');
        const { secret, prefix, hash } = generateAgentTokenSecret();
        const scopes = [...new Set(body.scopes)].sort();
        const record = {
          id,
          projectId: project.id,
          principalId,
          name: body.name,
          prefix,
          scopes,
          expiresAt: new Date(now.getTime() + body.expiresInDays * DAY_MS),
          revokedAt: null,
          lastUsedAt: null,
          createdBy: actor.principalId,
          createdAt: now,
        };
        await tx.principals.insert({
          id: principalId,
          kind: 'service',
          iss: AGENT_TOKEN_ISSUER,
          subject: id,
          handle: `agent:${body.name}`,
        });
        await tx.agentTokens.insert({ ...record, secretHash: hash });
        await tx.events.append(project.id, {
          type: 'agent_token.created',
          principalId: actor.principalId,
          clientId: actor.clientId,
          subjectRef: id,
          payload: {
            tokenId: id,
            name: body.name,
            prefix,
            scopes,
            expiresAt: record.expiresAt.toISOString(),
          },
        });
        const stored = await tx.agentTokens.findInProject(project.id, id);
        if (!stored) throw new Error('agent token vanished inside its transaction');
        return { ...toAgentToken(stored), secret };
      });
    },

    async listAgentTokens(actor: Actor, projectRef: string): Promise<AgentTokenList> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'admin', projectRef);
        const tokens = await tx.agentTokens.listInProject(project.id);
        return { items: tokens.map(toAgentToken) };
      });
    },

    /**
     * Revokes a token and withdraws what it left open: its live proposals
     * and its claimed tasks ({@link retractToken}), in one transaction.
     * Idempotent: revoking a revoked token changes nothing.
     */
    async revokeAgentToken(actor: Actor, projectRef: string, tokenId: AgentTokenId): Promise<void> {
      const now = deps.clock.now();
      await deps.store.write(async (tx) => {
        const { project } = await policy.require(tx, actor, 'admin', projectRef);
        await tx.projects.lockForWrite(project.id);
        const token = await tx.agentTokens.findInProject(project.id, tokenId);
        if (!token) throw new DomainError('not-found', 'agent token not found');
        if (token.revokedAt) return;
        await tx.agentTokens.revoke(project.id, tokenId, now);
        await tx.events.append(project.id, {
          type: 'agent_token.revoked',
          principalId: actor.principalId,
          clientId: actor.clientId,
          subjectRef: tokenId,
          payload: { tokenId, name: token.name, prefix: token.prefix },
        });
        await retractToken(tx, actor, project, token);
      });
    },
  };
}
