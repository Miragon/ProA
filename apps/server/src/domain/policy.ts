import type { ProblemCode, Role, Scope } from '@proa/contracts';

import type { Actor } from './actor.ts';
import { DomainError } from './errors.ts';
import type { ProjectRecord, Tx } from './ports.ts';

/**
 * Capabilities (CONCEPT §6, "Permission = scope ∩ role ∩ principal rule"):
 *
 * | Permission | Capability | Scope | Min role | Principal |
 * |---|---|---|---|---|
 * | `read` | read | `proa:read` | viewer | any |
 * | `propose` | propose, claim, submit, release, withdraw own | `proa:propose` | editor | any |
 * | `write` | ingest, delete models, requeue | `proa:write` | editor | any |
 * | `review` | decide, create an accepted manual relation | `proa:review` | editor | user on an interactive client |
 * | `admin` | members, invitations, services, agent tokens, delete project | `proa:write` | owner | user on an interactive client |
 */
export type Permission = 'read' | 'propose' | 'write' | 'review' | 'admin';

export interface PermissionRule {
  scope: Scope;
  minRole: Role;
  /** Only a user on an interactive client may do this; the problem code otherwise. */
  humanOnly: ProblemCode | null;
}

export const PERMISSIONS: Readonly<Record<Permission, PermissionRule>> = {
  read: { scope: 'proa:read', minRole: 'viewer', humanOnly: null },
  propose: { scope: 'proa:propose', minRole: 'editor', humanOnly: null },
  write: { scope: 'proa:write', minRole: 'editor', humanOnly: null },
  review: { scope: 'proa:review', minRole: 'editor', humanOnly: 'human-decision-required' },
  admin: { scope: 'proa:write', minRole: 'owner', humanOnly: 'forbidden' },
};

const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 0, editor: 1, owner: 2 };

/** Scopes nest: review ⊇ propose ⊇ read, write ⊇ read. */
const IMPLIED: Readonly<Record<Scope, readonly Scope[]>> = {
  'proa:read': [],
  'proa:propose': ['proa:read'],
  'proa:write': ['proa:read'],
  'proa:review': ['proa:propose', 'proa:read'],
};

/** The scopes `granted` amount to after nesting. */
export function effectiveScopes(granted: readonly Scope[]): Set<Scope> {
  const out = new Set<Scope>();
  for (const s of granted) {
    out.add(s);
    for (const implied of IMPLIED[s]) out.add(implied);
  }
  return out;
}

/** The role an agent token acts with: `editor`, or `viewer` if it may only read. */
export function tokenRole(scopes: readonly Scope[]): Role {
  return scopes.some((s) => s === 'proa:propose' || s === 'proa:write') ? 'editor' : 'viewer';
}

/** Outcome of {@link evaluate}: `null` means allowed. */
export type Denial = { code: ProblemCode; detail: string } | null;

/**
 * The pure policy decision. `role` is the actor's role in the project, `null`
 * if the project is not visible to the actor at all (not a member, or a token
 * for another project); that case answers `not-found`, never 403, so foreign
 * ids cannot be probed.
 */
export function evaluate(actor: Actor, permission: Permission, role: Role | null): Denial {
  if (role === null) return { code: 'not-found', detail: 'project not found' };
  const rule = PERMISSIONS[permission];
  if (rule.humanOnly && !(actor.kind === 'user' && actor.interactive)) {
    return {
      code: rule.humanOnly,
      detail:
        rule.humanOnly === 'human-decision-required'
          ? 'only a human on an interactive client can decide; agents propose'
          : `${permission} requires a user on an interactive client`,
    };
  }
  if (!effectiveScopes(actor.scopes).has(rule.scope)) {
    return { code: 'insufficient-scope', detail: `requires scope ${rule.scope}` };
  }
  if (ROLE_RANK[role] < ROLE_RANK[rule.minRole]) {
    return { code: 'forbidden', detail: `requires role ${rule.minRole}` };
  }
  return null;
}

/** A project the actor may act on, with the actor's role in it. */
export interface ProjectAccess {
  project: ProjectRecord;
  role: Role;
}

/** Looks up the actor's role: the token binding, or the membership. */
export async function roleIn(tx: Tx, actor: Actor, project: ProjectRecord): Promise<Role | null> {
  if (actor.binding) return actor.binding.projectId === project.id ? actor.binding.role : null;
  return tx.memberships.roleOf(project.id, actor.principalId);
}

export const policy = {
  /**
   * Every use case starts here (CONCEPT §6, "Enforcement"): resolves the
   * project by id or key, checks `permission` for `actor`, and returns the
   * project. Unknown and foreign projects both raise `not-found`.
   *
   * @param tx the transaction the use case runs in
   * @throws {DomainError} `not-found`, `insufficient-scope`, `forbidden`, `human-decision-required`
   */
  async require(
    tx: Tx,
    actor: Actor,
    permission: Permission,
    projectRef: string,
  ): Promise<ProjectAccess> {
    const project = await tx.projects.findByRef(projectRef);
    if (!project) throw new DomainError('not-found', 'project not found');
    const role = await roleIn(tx, actor, project);
    const denial = evaluate(actor, permission, role);
    if (denial || role === null) {
      throw new DomainError(denial?.code ?? 'not-found', denial?.detail ?? 'project not found');
    }
    return { project, role };
  },
};
