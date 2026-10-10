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

/** Review texts (CONCEPT §3): reasons and notes, hold labels, questions; bulk size. */
export const MAX_NOTE_CHARS = 2000;
export const MAX_LABEL_CHARS = 100;
export const MAX_QUESTION_CHARS = 500;
export const MAX_BULK_DECISIONS = 500;

/** Port of the ProA server in local mode (docker/compose.yaml, `pnpm dev`). */
export const PROA_DEFAULT_PORT = 7400;

/** Rationale of a manual placement (`ManualPlacementBody`), as for agent rationales. */
export const MAX_RATIONALE_CHARS = 1000;

/**
 * Value chain (M4 §2, §5; `packages/contracts/src/api/value-chains.ts`). M4
 * has one chain per project, key `main`; `@outside` is the pseudo-step
 * "deliberately outside this chain".
 */
export const VALUE_CHAIN_KEY = 'main';
export const OUTSIDE_STEP = '@outside';
export const RESERVED_ELEMENT_IDS = ['vc-root'] as const;
export const MAX_VALUE_CHAIN_BYTES = 1024 * 1024;
export const MAX_VALUE_CHAIN_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_VALUE_CHAIN_ELEMENTS = 500;
export const MAX_VALUE_CHAIN_CONNECTIONS = 1000;
export const MAX_VALUE_CHAIN_NAME_CHARS = 200;
export const MAX_VALUE_CHAIN_ID_CHARS = 128;
export const MAX_VALUE_CHAIN_LINK_CHARS = 2000;
export const MAX_VALUE_CHAIN_DEPTH = 2;
export const MAX_VALUE_CHAIN_COORDINATE = 10_000_000;
export const MAX_VALUE_CHAIN_ELEMENT_SIZE = 1_000_000;
export const MAX_VALUE_CHAIN_REV = 999_999_999;
export const MAX_VALUE_CHAIN_VIOLATIONS = 100;
/** A step `link` naming a ProA process: `proa:process/<model_key>#<process_id>`. */
export const PROA_PROCESS_LINK_PREFIX = 'proa:process/';
/** Colours of the modeler's picker that make a top-level step management or support (M4 §2). */
export const STEP_KIND_COLORS = {
  management: 'hsl(287, 65%, 44%)',
  support: 'hsl(150, 86%, 34%)',
} as const;
/** Bidirectional formatting characters (`BIDI_CHARACTERS`): refused in names and links. */
export const BIDI_CHARACTERS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/**
 * Auto-accept rules (owner decision 19; `packages/contracts/src/api/auto-accept.ts`):
 * the confidence floor, the tiers per kind, the text limits and the preview's curve.
 */
export const MIN_AUTO_ACCEPT_CONFIDENCE = 0.5;
export const AUTO_ACCEPT_TIERS = {
  relation: ['key', 'lexical', 'semantic'],
  placement: ['lexical', 'semantic'],
} as const;
export const MAX_AUTO_ACCEPT_NAME_CHARS = 100;
export const MAX_AUTO_ACCEPT_NOTE_CHARS = 500;
export const MAX_AUTO_ACCEPT_MODEL_CHARS = 100;
export const MAX_AUTO_ACCEPT_REASON_CHARS = 500;
export const AUTO_ACCEPT_PREVIEW_ITEMS = 50;
export const AUTO_ACCEPT_CURVE = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1] as const;
