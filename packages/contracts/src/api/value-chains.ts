import { z } from 'zod';

import { PrincipalId, ValueChainId, ValueChainRevisionId } from '../ids.ts';
import { orNull, plainName } from '../zod-utils.ts';
import { Sha256Hex, Timestamp, pageOf } from './common.ts';

// ------------------------------------------------------------------ limits

/** The only value chain key in M4: one chain per project (M4-VALUE-CHAIN.md §11). */
export const VALUE_CHAIN_KEY = 'main';
/** The pseudo-step "deliberately outside this chain" (M4 §2); never an element id. */
export const OUTSIDE_STEP = '@outside';
/** Element ids the renderer reserves (its root element); ids starting with `@` are ProA's. */
export const RESERVED_ELEMENT_IDS = ['vc-root'] as const;
/** Canonical bytes of a revision (`serializeDocument`, UTF-8): a ProA rule (422 `document-too-large`). */
export const MAX_VALUE_CHAIN_BYTES = 1024 * 1024;
/** Raw request body of a content save (413 above it). */
export const MAX_VALUE_CHAIN_BODY_BYTES = 2 * 1024 * 1024;
/** Elements (steps and org units) per document. */
export const MAX_VALUE_CHAIN_ELEMENTS = 500;
/** Connections per document. */
export const MAX_VALUE_CHAIN_CONNECTIONS = 1000;
/** Characters of `meta.name` and of every element name. */
export const MAX_VALUE_CHAIN_NAME_CHARS = 200;
/** Characters of an element or connection id. */
export const MAX_VALUE_CHAIN_ID_CHARS = 128;
/** Characters of a step `link`. */
export const MAX_VALUE_CHAIN_LINK_CHARS = 2000;
/** Deepest step level: 0 is the top level, so at most two levels of sub-steps. */
export const MAX_VALUE_CHAIN_DEPTH = 2;
/**
 * Largest absolute `x` or `y` of an element's bounds or of a waypoint. Keeps
 * the canonical form's rounding to 3 decimals exact and idempotent (a
 * coordinate near `Number.MAX_VALUE` would round to `Infinity`, which JSON
 * writes as `null`).
 */
export const MAX_VALUE_CHAIN_COORDINATE = 10_000_000;
/** Largest `width` or `height` of an element's bounds. */
export const MAX_VALUE_CHAIN_ELEMENT_SIZE = 1_000_000;
/**
 * Largest revision number: the ETag `"r<rev>"` has at most 9 digits, well
 * inside the `integer` column. A larger `rev` in a path or tool input is a
 * validation error, never a database error.
 */
export const MAX_VALUE_CHAIN_REV = 999_999_999;
/** Violations listed in one `value-chain-invalid` problem (`truncated` beyond). */
export const MAX_VALUE_CHAIN_VIOLATIONS = 100;
/** A step `link` naming a ProA process: `proa:process/<model_key>#<process_id>`. */
export const PROA_PROCESS_LINK_PREFIX = 'proa:process/';
/**
 * Colours of the modeler's colour picker that give a top-level step off the
 * core chain its kind (M4 §2, until the schema has a step category). They are
 * compared lowercased and without whitespace.
 */
export const STEP_KIND_COLORS = {
  management: 'hsl(287, 65%, 44%)',
  support: 'hsl(150, 86%, 34%)',
} as const;

/**
 * Path of the value chain page of a project in the web UI, of one placement
 * on it (`?placement=`), or of one step's drill-down. `human-decision-required`
 * problems of chain and placement writes carry it as `reviewUrl` (absolute,
 * on the server's origin). The page ships with M4 S3.
 */
export function valueChainPath(
  projectKey: string,
  target: { placementId?: string; elementId?: string } = {},
): string {
  const base = `/projects/${encodeURIComponent(projectKey)}/value-chain`;
  if (target.elementId !== undefined) {
    return `${base}/steps/${encodeURIComponent(target.elementId)}`;
  }
  if (target.placementId !== undefined) {
    return `${base}?placement=${encodeURIComponent(target.placementId)}`;
  }
  return base;
}

// --------------------------------------------------------------- the chain

/**
 * Key of a value chain: a lowercase slug. M4 allows `main` only: other keys
 * are 404 on reads and 422 `value-chain-key` on create.
 */
export const ValueChainKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase slug, e.g. main')
  .meta({ id: 'ValueChainKey', description: 'Value chain key (M4: `main`).', example: 'main' });
export type ValueChainKey = z.infer<typeof ValueChainKey>;

/**
 * A `.vc.json` document of `@miragon/value-chain-schema-model` (schemaVersion
 * 1: `meta`, `elements`, `connections`). The contracts type it as a JSON
 * object only; the server validates it with schema-model and the ProA rules
 * (422 `value-chain-invalid` with violations).
 */
export const ValueChainDocument = z.record(z.string(), z.unknown()).meta({
  id: 'ValueChainDocument',
  description: 'A value chain document (`.vc.json`, @miragon/value-chain-schema-model).',
});
export type ValueChainDocument = z.infer<typeof ValueChainDocument>;

export const ValueChain = z
  .object({
    id: ValueChainId,
    key: ValueChainKey,
    /** `meta.name` of the head revision. */
    name: z.string(),
    headRevisionId: ValueChainRevisionId,
    /** Revision number of the head; the content ETag is `"r<headRev>"`. */
    headRev: z.number().int().min(1),
    /** SHA-256 of the head's canonical bytes; an identical save is `unchanged`. */
    contentHash: Sha256Hex,
    /** SHA-256 over ids, types, normalized names, links, kinds and connections; ignores layout. */
    structureHash: Sha256Hex,
    schemaVersion: z.number().int().min(1),
    updatedAt: Timestamp,
  })
  .meta({ id: 'ValueChain', description: 'A value chain of a project.' });
export type ValueChain = z.infer<typeof ValueChain>;

export const ValueChainList = z
  .object({ items: z.array(ValueChain) })
  .meta({ id: 'ValueChainList', description: 'The live value chains of a project.' });
export type ValueChainList = z.infer<typeof ValueChainList>;

/** An immutable revision of a value chain, always saved by a human. */
export const ValueChainRevision = z
  .object({
    id: ValueChainRevisionId,
    rev: z.number().int().min(1),
    contentHash: Sha256Hex,
    structureHash: Sha256Hex,
    schemaVersion: z.number().int().min(1),
    /** The revision the editor started from (`If-Match`); `null` for a first revision. */
    baseRevisionId: orNull(ValueChainRevisionId),
    principalId: PrincipalId,
    /** Pseudonymous handle of the saving human. */
    handle: z.string(),
    /** Event sequence number of the save. */
    seq: z.number().int().min(1),
    createdAt: Timestamp,
  })
  .meta({ id: 'ValueChainRevision', description: 'An immutable value chain revision.' });
export type ValueChainRevision = z.infer<typeof ValueChainRevision>;

export const ValueChainRevisionPage = pageOf(ValueChainRevision, 'ValueChainRevisionPage');
export type ValueChainRevisionPage = z.infer<typeof ValueChainRevisionPage>;

/**
 * Kind of a step (M4 §2): top-level steps joined by `sequence` edges are
 * `core`; any other top-level step is `management` or `support` by its colour
 * ({@link STEP_KIND_COLORS}), else `other`; sub-steps inherit the kind of
 * their top-level step.
 */
export const StepKind = z
  .enum(['core', 'management', 'support', 'other'])
  .meta({ id: 'StepKind', description: 'Kind of a value chain step.' });
export type StepKind = z.infer<typeof StepKind>;

/**
 * What a step's `link` is: `none`; `process` (`proa:process/<ref>`, the
 * drill-down into that process's model); `url` (`http://` or `https://`);
 * `opaque` (anything else, kept verbatim).
 */
export const LinkKind = z
  .enum(['none', 'process', 'url', 'opaque'])
  .meta({ id: 'LinkKind', description: 'Kind of a step link.' });
export type LinkKind = z.infer<typeof LinkKind>;

/** Placements of a step by status (non-obsolete ones on its live generation). */
export const StepPlacementCounts = z
  .object({
    accepted: z.number().int().min(0),
    proposed: z.number().int().min(0),
    held: z.number().int().min(0),
  })
  .meta({ id: 'StepPlacementCounts', description: 'Placements of a step by status.' });
export type StepPlacementCounts = z.infer<typeof StepPlacementCounts>;

/** A step of the head revision, derived from the document on read (M4 §2). */
export const ValueChainStep = z
  .object({
    elementId: z.string(),
    /** The step's live generation: a deleted id that comes back is a new generation. */
    generation: z.number().int().min(1),
    name: z.string(),
    kind: StepKind,
    /** 0 = top level. */
    depth: z.number().int().min(0).max(MAX_VALUE_CHAIN_DEPTH),
    /** 0-based position among its siblings along the `sequence` edges, ties by x, then y. */
    rank: z.number().int().min(0),
    parentId: z.string().nullable(),
    /** Names from the top-level step down to this one. */
    path: z.array(z.string()),
    /** Sub-steps by rank. */
    childIds: z.array(z.string()),
    link: z.string().nullable(),
    linkKind: LinkKind,
    /** `proa:process/<ref>` links: the ref, if well-formed. */
    linkProcess: z.string().nullable(),
    /** A `process` link whose process is in the head revisions. */
    linkResolved: z.boolean(),
    /** Org units assigned to the step (its accountable area). */
    owners: z.array(z.object({ elementId: z.string(), name: z.string() })),
    /** `sha256(step|name_norm|parent_id)`, 12 hex characters: a rename or a new parent changes it. */
    fingerprint: z.string(),
    counts: StepPlacementCounts,
  })
  .meta({ id: 'ValueChainStep', description: 'A step of the head revision.' });
export type ValueChainStep = z.infer<typeof ValueChainStep>;

/** An org unit of the head revision and the steps it owns. */
export const ValueChainOrgUnit = z
  .object({ elementId: z.string(), name: z.string(), stepIds: z.array(z.string()) })
  .meta({ id: 'ValueChainOrgUnit', description: 'An org unit and the steps it owns.' });
export type ValueChainOrgUnit = z.infer<typeof ValueChainOrgUnit>;

/** Body of `POST …/value-chains`: the key and either a name (empty chain) or a document. */
export const CreateValueChainBody = z
  .object({
    key: ValueChainKey,
    /** Creates an empty chain with this `meta.name`. */
    name: plainName(MAX_VALUE_CHAIN_NAME_CHARS).optional(),
    /** The first revision's document. */
    content: ValueChainDocument.optional(),
  })
  .refine((b) => (b.name === undefined) !== (b.content === undefined), {
    message: 'send either name or content',
  })
  .meta({ id: 'CreateValueChainBody', description: 'Request body to create a value chain.' });
export type CreateValueChainBody = z.infer<typeof CreateValueChainBody>;

// -------------------------------------------------------------- validation

/**
 * Why a document is refused (422 `value-chain-invalid`), in the order the
 * server checks: the JSON (`not-json`, `not-an-object`), the schema-model
 * schema (`schema`), the cross-field rules of schema-model (`duplicate-id`,
 * `unknown-endpoint`, `self-connection`, `connection-not-allowed`), then the
 * ProA rules (size and counts first: above those limits nothing else is
 * checked; then names, ids, links, geometry, hierarchy, duplicate
 * connections, sequence cycles; M4 §2).
 */
export const VALUE_CHAIN_VIOLATIONS = [
  'not-json',
  'not-an-object',
  'schema',
  'duplicate-id',
  'unknown-endpoint',
  'self-connection',
  'connection-not-allowed',
  'document-too-large',
  'too-many-elements',
  'too-many-connections',
  'name-required',
  'name-too-long',
  'name-characters',
  'id-too-long',
  'id-characters',
  'reserved-id',
  'link-too-long',
  'link-characters',
  'geometry-out-of-range',
  'multiple-parents',
  'hierarchy-cycle',
  'hierarchy-too-deep',
  'duplicate-connection',
  'sequence-cycle',
] as const;

export const ValueChainViolationReason = z
  .enum(VALUE_CHAIN_VIOLATIONS)
  .meta({ id: 'ValueChainViolationReason', description: 'Why a value chain is refused.' });
export type ValueChainViolationReason = z.infer<typeof ValueChainViolationReason>;

/** One violation of a refused document, naming the element or connection where it can. */
export const ValueChainViolation = z
  .object({
    reason: ValueChainViolationReason,
    elementId: z.string().nullable(),
    connectionId: z.string().nullable(),
    /** JSON path of the offending value, e.g. `elements.3.name`. */
    path: z.string().nullable(),
    detail: z.string(),
  })
  .meta({ id: 'ValueChainViolation', description: 'One reason a value chain is refused.' });
export type ValueChainViolation = z.infer<typeof ValueChainViolation>;

// ------------------------------------------------------------------ impact

/** Placements on a step generation by status (non-obsolete ones). */
export const ImpactPlacementCounts = z
  .object({
    accepted: z.number().int().min(0),
    held: z.number().int().min(0),
    proposed: z.number().int().min(0),
  })
  .meta({ id: 'ImpactPlacementCounts', description: 'Placements on a step by status.' });
export type ImpactPlacementCounts = z.infer<typeof ImpactPlacementCounts>;

const StepShape = z.object({
  name: z.string(),
  parentId: z.string().nullable(),
  kind: StepKind,
});

/**
 * What a save does (or, as a dry run, would do) to the steps and their
 * placements (M4 §3.5, §4 "Save"):
 * - `steps.added`: new step generations;
 * - `steps.removed`: generations the save tombstones (a tombstone is final:
 *   their accepted and held placements stay `missing` for good, their live
 *   proposals are withdrawn);
 * - `steps.changed`: steps whose name, parent or kind changes;
 *   `fingerprintChanged` (another normalized name or parent) sends accepted
 *   placements to re-confirm, a kind-only change does not;
 * - `placements`: `stranded` (accepted and held placements on removed
 *   generations), `toReconfirm` (accepted placements that turn `changed`) and
 *   `proposalsWithdrawn` (live proposals on removed generations).
 */
export const ValueChainImpact = z
  .object({
    /** The new revision's `structure_hash` differs from the head's (always true on create). */
    structureChanged: z.boolean(),
    steps: z.object({
      added: z.array(z.object({ elementId: z.string(), name: z.string() })),
      removed: z.array(
        z.object({
          elementId: z.string(),
          generation: z.number().int().min(1),
          name: z.string(),
          placements: ImpactPlacementCounts,
        }),
      ),
      changed: z.array(
        z.object({
          elementId: z.string(),
          generation: z.number().int().min(1),
          before: StepShape,
          after: StepShape,
          fingerprintChanged: z.boolean(),
          placements: ImpactPlacementCounts,
        }),
      ),
    }),
    placements: z.object({
      stranded: z.number().int().min(0),
      toReconfirm: z.number().int().min(0),
      proposalsWithdrawn: z.number().int().min(0),
    }),
  })
  .meta({
    id: 'ValueChainImpact',
    description: 'What a value chain save does to steps and placements.',
  });
export type ValueChainImpact = z.infer<typeof ValueChainImpact>;

/**
 * Result of `POST …/value-chains` and `PUT …/content` (also as a dry run):
 * `created` or `revived` (201; a deleted chain created again keeps its
 * `vch_`), `revised` or `unchanged` (200; content equal to the head's writes
 * nothing). A dry run writes nothing: `revision` is `null` unless the content
 * is unchanged, and `valueChain` is `null` for a chain it would create.
 */
export const SaveValueChainResult = z
  .object({
    dryRun: z.boolean(),
    outcome: z.enum(['created', 'revived', 'revised', 'unchanged']),
    valueChain: orNull(ValueChain),
    revision: orNull(ValueChainRevision),
    impact: ValueChainImpact,
  })
  .meta({ id: 'SaveValueChainResult', description: 'Outcome of a value chain save.' });
export type SaveValueChainResult = z.infer<typeof SaveValueChainResult>;

/** Query of `PUT …/content`: `dryRun=true` returns the impact and writes nothing. */
export const SaveValueChainQuery = z.object({
  dryRun: z.enum(['true', 'false']).optional(),
});
export type SaveValueChainQuery = z.infer<typeof SaveValueChainQuery>;
