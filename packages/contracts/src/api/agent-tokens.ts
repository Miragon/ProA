import { z } from 'zod';

import { AgentTokenId, PrincipalId } from '../ids.ts';
import { orNull, plainName } from '../zod-utils.ts';
import { AgentScope } from './auth.ts';
import { Timestamp } from './common.ts';

/** Every agent token secret starts with this prefix, so secret scanners recognize it. */
export const AGENT_TOKEN_PREFIX = 'proa_at_';

export const AGENT_TOKEN_DEFAULT_DAYS = 90;
export const AGENT_TOKEN_MAX_DAYS = 365;

/** An agent token without its secret (CONCEPT §6). */
export const AgentToken = z
  .object({
    id: AgentTokenId,
    /**
     * The token's own service principal: the agent its proposals are recorded
     * under (what an auto-accept rule is narrowed to).
     */
    principalId: PrincipalId,
    name: z.string().min(1).max(100),
    /** First 8 characters after `proa_at_`, for recognition. */
    prefix: z.string().length(8),
    scopes: z.array(AgentScope).min(1),
    expiresAt: Timestamp,
    revokedAt: orNull(Timestamp),
    lastUsedAt: orNull(Timestamp),
    createdAt: Timestamp,
  })
  .meta({
    id: 'AgentToken',
    description: 'An API key for one project, used by MCP clients and scripts.',
  });
export type AgentToken = z.infer<typeof AgentToken>;

export const AgentTokenList = z
  .object({ items: z.array(AgentToken) })
  .meta({ id: 'AgentTokenList', description: "A project's agent tokens." });
export type AgentTokenList = z.infer<typeof AgentTokenList>;

export const CreateAgentTokenBody = z
  .object({
    name: plainName(100),
    scopes: z.array(AgentScope).min(1).default(['proa:read', 'proa:propose']),
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(AGENT_TOKEN_MAX_DAYS)
      .default(AGENT_TOKEN_DEFAULT_DAYS),
  })
  .meta({ id: 'CreateAgentTokenBody', description: 'Request body to create an agent token.' });
export type CreateAgentTokenBody = z.infer<typeof CreateAgentTokenBody>;

/** Returned once on creation: the only time the secret is shown. */
export const CreatedAgentToken = AgentToken.extend({
  secret: z.string().startsWith(AGENT_TOKEN_PREFIX),
}).meta({
  id: 'CreatedAgentToken',
  description: 'A new agent token including its secret (shown once).',
});
export type CreatedAgentToken = z.infer<typeof CreatedAgentToken>;
