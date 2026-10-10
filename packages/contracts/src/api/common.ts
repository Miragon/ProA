import { z } from 'zod';

import { ULID_PATTERN } from '../ids.ts';
import { orNull } from '../zod-utils.ts';

/** Prefix of every REST resource (CONCEPT §5). */
export const API_PREFIX = '/api/v1';

/** Path of the generated OpenAPI 3.1 document. */
export const OPENAPI_PATH = `${API_PREFIX}/openapi.json`;

/** RFC 3339 timestamp in UTC, e.g. `2026-10-06T12:00:00.000Z`. */
export const Timestamp = z.iso.datetime().meta({
  id: 'Timestamp',
  description: 'RFC 3339 timestamp (UTC).',
  example: '2026-10-06T12:00:00.000Z',
});
export type Timestamp = z.infer<typeof Timestamp>;

/** Lowercase hex SHA-256 digest. */
export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .meta({ id: 'Sha256Hex', description: 'Lowercase hex SHA-256 digest.' });

/** Opaque pagination cursor. */
export const Cursor = z
  .string()
  .max(512)
  .meta({ id: 'Cursor', description: 'Opaque pagination cursor.' });

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/** Query parameters of every paginated list. */
export const PageQuery = z.object({
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});
export type PageQuery = z.infer<typeof PageQuery>;

/**
 * A page of `item`s; `nextCursor` is `null` on the last page.
 * @param id component name of the page schema in the OpenAPI document
 */
export function pageOf<T extends z.ZodType>(item: T, id: string) {
  return z
    .object({ items: z.array(item), nextCursor: orNull(Cursor) })
    .meta({ id, description: `A page of ${id.replace(/Page$/, '')} items.` });
}

/**
 * Regex source of a project reference: a project id (`prj_` + ULID) or a
 * project key (lowercase slug, see `ProjectKey`).
 */
export const PROJECT_REF_PATTERN = `prj_${ULID_PATTERN}|[a-z0-9]+(?:-[a-z0-9]+)*`;

/**
 * A project id (`prj_…`) or project key, as REST `{project}` and MCP
 * `projectId` take it. Anything else (control characters included) fails
 * validation before a query runs.
 */
export const ProjectRef = z
  .string()
  .min(1)
  .max(64)
  .regex(
    new RegExp(`^(?:${PROJECT_REF_PATTERN})$`),
    'must be a project id (prj_…) or a project key (lowercase slug)',
  )
  .meta({ description: 'Project id (`prj_…`) or project key.', example: 'nordwind-handel' });

/** Path parameter `{project}`: a project id (`prj_…`) or a project key. */
export const ProjectParam = z.object({ project: ProjectRef });
export type ProjectParam = z.infer<typeof ProjectParam>;
