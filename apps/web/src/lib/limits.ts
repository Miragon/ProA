/**
 * Constants of `@proa/contracts` the UI needs at runtime. The web imports
 * only types from the contracts package (its zod schemas would end up in the
 * bundle); `test/limits.test.ts` keeps these copies equal to the originals.
 */

/** RFC 9457 `type` prefix of every ProA problem. */
export const PROBLEM_TYPE_BASE = 'urn:proa:problem:';

/** Limits of `POST …/imports` and `PUT …/models/by-key/{key}` (CONCEPT §3). */
export const MAX_IMPORT_FILES = 50;
export const MAX_MODEL_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

/** Largest page the list endpoints serve. */
export const MAX_PAGE_LIMIT = 200;

/** Agent tokens (CONCEPT §6). */
export const AGENT_TOKEN_PREFIX = 'proa_at_';
export const AGENT_TOKEN_DEFAULT_DAYS = 90;
export const AGENT_TOKEN_MAX_DAYS = 365;

/** Port of the ProA server in local mode (docker/compose.yaml, `pnpm dev`). */
export const PROA_DEFAULT_PORT = 7400;
