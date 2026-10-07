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
import { policy } from '../policy.ts';
import { toAgentToken } from '../views.ts';
import type { UseCaseDeps } from './deps.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

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

    /** Idempotent: revoking a revoked token changes nothing. */
    async revokeAgentToken(actor: Actor, projectRef: string, tokenId: AgentTokenId): Promise<void> {
      const now = deps.clock.now();
      await deps.store.write(async (tx) => {
        const { project } = await policy.require(tx, actor, 'admin', projectRef);
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
      });
    },
  };
}
