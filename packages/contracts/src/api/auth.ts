import { z } from 'zod';

import { PrincipalId } from '../ids.ts';

/**
 * OAuth-style scopes (CONCEPT §6). Scopes nest: review ⊇ propose ⊇ read,
 * write ⊇ read. `proa:review` is never granted to agent tokens.
 */
export const Scope = z
  .enum(['proa:read', 'proa:propose', 'proa:write', 'proa:review'])
  .meta({ id: 'Scope', description: 'Permission scope.' });
export type Scope = z.infer<typeof Scope>;

/** Scopes an agent token may carry. */
export const AgentScope = Scope.exclude(['proa:review']).meta({
  id: 'AgentScope',
  description: 'Scope of an agent token (never `proa:review`).',
});
export type AgentScope = z.infer<typeof AgentScope>;

/** Project roles. An agent token acts as `editor` (`viewer` if read-only). */
export const Role = z
  .enum(['viewer', 'editor', 'owner'])
  .meta({ id: 'Role', description: 'Project role.' });
export type Role = z.infer<typeof Role>;

/** `local`: single owner on 127.0.0.1, agent tokens only (v1). `oidc`: server mode (R1). */
export const AuthMode = z
  .enum(['local', 'oidc'])
  .meta({ id: 'AuthMode', description: 'Authentication mode.' });
export type AuthMode = z.infer<typeof AuthMode>;

/** The authenticated caller. */
export const Me = z
  .object({
    principalId: PrincipalId,
    kind: z.enum(['user', 'service']),
    /** Pseudonymous handle; never an e-mail address. */
    handle: z.string(),
    authMode: AuthMode,
    /** Client the call came from (`proa-web`, `proa-cli`, `agt_…`, an OAuth client id). */
    clientId: z.string().nullable(),
  })
  .meta({ id: 'Me', description: 'The authenticated caller.' });
export type Me = z.infer<typeof Me>;
