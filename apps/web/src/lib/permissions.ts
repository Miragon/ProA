import type { Role } from '@proa/client';
import { useQuery } from '@tanstack/react-query';

import { projectQuery } from './queries';
import { useServerMode } from './server-mode';

export interface ProjectPermissions {
  /** The caller's role, once the project is loaded. */
  role: Role | null;
  /** The role is loaded: `false` permissions are final. */
  known: boolean;
  /** The server is the read-only demo. */
  demo: boolean;
  /** Upload models, requeue tasks (editor or owner; CONCEPT §6 `write`). */
  canWrite: boolean;
  /** Decide, answer held items, edit the value chain (editor or owner; `review`). */
  canReview: boolean;
  /** Agent tokens, auto-accept rules, revocations (owner; `admin`). */
  isOwner: boolean;
}

/**
 * What the caller may do in `project`, from the role the server reports
 * (`Project.role`): viewers get no write action, and neither does anyone on
 * the read-only demo (whose session is a viewer anyway; the demo flag is a
 * second guard). Every permission is `false` until the role is loaded, so a
 * write action never flashes up and leads to a refusal.
 */
export function useProjectPermissions(project: string): ProjectPermissions {
  const info = useQuery(projectQuery(project));
  const mode = useServerMode();
  const role = info.data?.role ?? null;
  const known = role !== null;
  const writer = known && !mode.demo && (role === 'owner' || role === 'editor');
  return {
    role,
    known,
    demo: mode.demo,
    canWrite: writer,
    canReview: writer,
    isOwner: writer && role === 'owner',
  };
}
