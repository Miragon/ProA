import {
  newId,
  type CreateProjectBody,
  type PageQuery,
  type Project,
  type ProjectPage,
} from '@proa/contracts';

import type { Actor } from '../actor.ts';
import { decodeCursor, toPage } from '../cursor.ts';
import { DomainError } from '../errors.ts';
import { effectiveScopes, policy } from '../policy.ts';
import { toProject } from '../views.ts';
import type { UseCaseDeps } from './deps.ts';

export function projectUseCases(deps: UseCaseDeps) {
  return {
    /**
     * Any user may create a project and owns it (CONCEPT §6). Agent tokens
     * are bound to one project and cannot create others.
     *
     * @throws {DomainError} `forbidden`, `insufficient-scope`, `conflict` (key taken)
     */
    async createProject(actor: Actor, body: CreateProjectBody): Promise<Project> {
      if (actor.kind !== 'user' || !actor.interactive) {
        throw new DomainError('forbidden', 'only users on an interactive client create projects');
      }
      if (!effectiveScopes(actor.scopes).has('proa:write')) {
        throw new DomainError('insufficient-scope', 'requires scope proa:write');
      }
      return deps.store.write(async (tx) => {
        const id = newId('project');
        const inserted = await tx.projects.insert({ id, key: body.key, name: body.name });
        if (!inserted) throw new DomainError('conflict', `project key ${body.key} already exists`);
        await tx.memberships.insert(id, actor.principalId, 'owner');
        await tx.events.append(id, {
          type: 'project.created',
          principalId: actor.principalId,
          clientId: actor.clientId,
          subjectRef: id,
          payload: { projectId: id, key: body.key, name: body.name, owner: actor.principalId },
        });
        const project = await tx.projects.findByRef(id);
        if (!project) throw new Error('project vanished inside its transaction');
        return toProject(project, 'owner');
      });
    },

    /** Projects visible to the caller: memberships, or the token's one project. */
    async listProjects(actor: Actor, query: PageQuery): Promise<ProjectPage> {
      const afterKey = query.cursor ? decodeCursor(query.cursor, ['string'])[0] : undefined;
      if (!effectiveScopes(actor.scopes).has('proa:read')) {
        throw new DomainError('insufficient-scope', 'requires scope proa:read');
      }
      return deps.store.read(async (tx) => {
        if (actor.binding) {
          const { role } = actor.binding;
          const project = await tx.projects.findByRef(actor.binding.projectId);
          const visible = project && (afterKey === undefined || project.key > afterKey);
          return { items: visible ? [toProject(project, role)] : [], nextCursor: null };
        }
        const rows = await tx.projects.listForPrincipal(actor.principalId, {
          afterKey,
          limit: query.limit + 1,
        });
        const page = toPage(rows, query.limit, (p) => [p.key]);
        return { items: page.items.map((p) => toProject(p, p.role)), nextCursor: page.nextCursor };
      });
    },

    async getProject(actor: Actor, projectRef: string): Promise<Project> {
      return deps.store.read(async (tx) => {
        const { project, role } = await policy.require(tx, actor, 'read', projectRef);
        return toProject(project, role);
      });
    },
  };
}
