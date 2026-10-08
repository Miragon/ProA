import type { PrincipalId, ProjectId, Role, Scope, SourceKind } from '@proa/contracts';

/**
 * The authenticated caller of a use case (CONCEPT §6). Built by the auth
 * layer from the credential; the domain never sees headers or cookies.
 */
export interface Actor {
  principalId: PrincipalId;
  kind: 'user' | 'service';
  /** Pseudonymous handle for events and the UI; never an e-mail address. */
  handle: string;
  /** Client the call came from: `proa-web`, `proa-cli`, `agt_…`. */
  clientId: string | null;
  /** A user on an interactive client (`proa-web`, `proa-cli`): counts as a human. */
  interactive: boolean;
  /** Granted scopes, before nesting (see `effectiveScopes`). */
  scopes: readonly Scope[];
  /**
   * Credentials bound to one project (agent tokens): the project and the role
   * the credential acts with. `null` for users, whose role comes from their
   * membership.
   */
  binding: { projectId: ProjectId; role: Role } | null;
}

/** Issuer of the local-mode owner principal. */
export const LOCAL_ISSUER = 'urn:proa:local';
/** Issuer of agent-token service principals (CONCEPT §2). */
export const AGENT_TOKEN_ISSUER = 'urn:proa:agent-token';
/** Issuer of system principals such as the rule tier. */
export const SYSTEM_ISSUER = 'urn:proa:system';
/** Subject (and handle) of the rule tier's system principal. */
export const RULES_SUBJECT = 'proa-rules';

/**
 * `source_kind` of an assertion, derived from the credential and never sent
 * by clients (CONCEPT §6): `human` is a user on an interactive client, `agent`
 * everything else. (`rule` is reserved for the system principal.)
 */
export function sourceKindOf(actor: Actor): Exclude<SourceKind, 'rule'> {
  return actor.kind === 'user' && actor.interactive ? 'human' : 'agent';
}
