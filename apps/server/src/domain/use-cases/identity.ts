import type { InteractiveClient, Me, PrincipalId } from '@proa/contracts';

import {
  DEMO_ISSUER,
  DEMO_VISITOR_SUBJECT,
  LOCAL_ISSUER,
  RULES_SUBJECT,
  SYSTEM_ISSUER,
  type Actor,
} from '../actor.ts';
import { hashAgentTokenSecret, isWellFormedAgentToken } from '../agent-token-secret.ts';
import { tokenRole } from '../policy.ts';
import type { PrincipalRecord } from '../ports.ts';
import type { UseCaseDeps } from './deps.ts';

/** `last_used_at` is written at most once per minute per token. */
const TOUCH_INTERVAL_MS = 60_000;

/** Subject and handle of the single human of local mode. */
export const LOCAL_OWNER_SUBJECT = 'owner';

/** The read-only demo's visitor principal (issue #3). */
const DEMO_VISITOR = {
  kind: 'user',
  iss: DEMO_ISSUER,
  subject: DEMO_VISITOR_SUBJECT,
  handle: DEMO_VISITOR_SUBJECT,
} as const;

/** What {@link identityUseCases}' `grantDemoVisitor` did. */
export interface DemoVisitorGrant {
  principalId: PrincipalId;
  /** Project keys that got the viewer membership now. */
  granted: string[];
  /** Project keys where the visitor already was a member. */
  existing: string[];
}

function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () =>
    (value ??= load().catch((err: unknown) => {
      value = undefined;
      throw err;
    }));
}

export function identityUseCases(deps: UseCaseDeps) {
  const localOwner = memo<PrincipalRecord>(() =>
    deps.store.write((tx) =>
      tx.principals.ensure({
        kind: 'user',
        iss: LOCAL_ISSUER,
        subject: LOCAL_OWNER_SUBJECT,
        handle: LOCAL_OWNER_SUBJECT,
      }),
    ),
  );
  const rulesPrincipal = memo<PrincipalId>(async () => {
    const p = await deps.store.write((tx) =>
      tx.principals.ensure({
        kind: 'system',
        iss: SYSTEM_ISSUER,
        subject: RULES_SUBJECT,
        handle: RULES_SUBJECT,
      }),
    );
    return p.id;
  });

  const demoVisitor = memo<PrincipalRecord>(async () => {
    const found = await deps.store.read((tx) => tx.principals.find(DEMO_VISITOR));
    if (!found) {
      throw new Error(
        'the read-only demo has no visitor: run apps/server/src/demo-bootstrap.ts against the seeded database first',
      );
    }
    return found;
  });

  return {
    /** The system principal `proa-rules`, created on first use. */
    rulesPrincipal,

    /**
     * Local mode (CONCEPT §6): the single owner, a human on an interactive
     * client. The auth layer calls this for a valid session cookie.
     */
    async localOwnerActor(client: InteractiveClient): Promise<Actor> {
      const owner = await localOwner();
      return {
        principalId: owner.id,
        kind: 'user',
        handle: owner.handle,
        clientId: client,
        interactive: true,
        scopes: ['proa:read', 'proa:propose', 'proa:write', 'proa:review'],
        binding: null,
      };
    },

    /**
     * Resolves `Bearer proa_at_…` (CONCEPT §6): well-formed, known, not
     * revoked, not expired; records `last_used_at`. The token acts as
     * `editor` (`viewer` if read-only) in its one project and is never
     * interactive.
     *
     * @returns the actor, or `null` for any invalid token
     */
    async authenticateAgentToken(secret: string): Promise<Actor | null> {
      if (!isWellFormedAgentToken(secret)) return null;
      const now = deps.clock.now();
      const token = await deps.store.write(async (tx) => {
        const found = await tx.agentTokens.findBySecretHash(hashAgentTokenSecret(secret));
        if (!found || found.revokedAt !== null || found.expiresAt.getTime() <= now.getTime()) {
          return null;
        }
        await tx.agentTokens.touch(found.id, now, TOUCH_INTERVAL_MS);
        return found;
      });
      if (!token) return null;
      return {
        principalId: token.principalId,
        kind: 'service',
        handle: token.handle,
        clientId: token.id,
        interactive: false,
        scopes: token.scopes,
        binding: { projectId: token.projectId, role: tokenRole(token.scopes) },
      };
    },

    /**
     * The read-only demo (`PROA_DEMO=readonly`, issue #3, CONCEPT §6): every
     * session is the visitor, a user on an interactive client with scope
     * `proa:read` only and the viewer role in every project
     * ({@link grantDemoVisitor}). The policy therefore denies every write by
     * scope and by role, behind the HTTP guard that refuses them first. A
     * lookup only: the demo's database is read-only.
     *
     * @throws if the visitor was never granted (the demo refuses to start)
     */
    async demoVisitorActor(client: InteractiveClient): Promise<Actor> {
      const visitor = await demoVisitor();
      return {
        principalId: visitor.id,
        kind: 'user',
        handle: visitor.handle,
        clientId: client,
        interactive: true,
        scopes: ['proa:read'],
        binding: null,
      };
    },

    /**
     * Prepares a seeded database for the read-only demo (issue #3): ensures
     * the visitor principal and makes it a viewer of every project. A system
     * operation without an actor, like `queueFirstPlacementTasks`: no route or
     * MCP tool reaches it; `demo-bootstrap.ts` runs it while the demo image is
     * built. The visitor is useless outside the demo, where no credential
     * resolves to it.
     */
    async grantDemoVisitor(): Promise<DemoVisitorGrant> {
      return deps.store.write(async (tx) => {
        const visitor = await tx.principals.ensure(DEMO_VISITOR);
        const granted: string[] = [];
        const existing: string[] = [];
        for (const project of await tx.projects.listAll()) {
          const outcome = await tx.memberships.ensure(project.id, visitor.id, 'viewer');
          (outcome === 'created' ? granted : existing).push(project.key);
        }
        return { principalId: visitor.id, granted, existing };
      });
    },

    /** `GET /me`. */
    me(actor: Actor): Me {
      return {
        principalId: actor.principalId,
        kind: actor.kind,
        handle: actor.handle,
        authMode: 'local',
        clientId: actor.clientId,
      };
    },
  };
}
