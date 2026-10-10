import { z } from 'zod';

/**
 * Prefixes of ProA's typed ULIDs (CONCEPT §2). `prj`, `prn`, `agt`, `mdl`,
 * `rev`, `rel` and `ana` come from the concept; `inv`, `asr`, `sbm` and `nlk`
 * are ProA 2.0 additions for invitations, relation assertions, analysis
 * submissions and stored no-links; `vch`, `vcr`, `plc` and `pas` are M4's
 * value chains, value chain revisions, placements and placement assertions
 * (M4-VALUE-CHAIN.md §2); `aar` are the owner's auto-accept rules (owner
 * decision 19).
 */
export const ID_PREFIXES = {
  project: 'prj',
  principal: 'prn',
  agentToken: 'agt',
  model: 'mdl',
  revision: 'rev',
  relation: 'rel',
  analysisTask: 'ana',
  invitation: 'inv',
  assertion: 'asr',
  submission: 'sbm',
  noLink: 'nlk',
  valueChain: 'vch',
  valueChainRevision: 'vcr',
  placement: 'plc',
  placementAssertion: 'pas',
  autoAcceptRule: 'aar',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

/** A typed ULID such as `prj_01J9Z3N4X5…`: prefix, underscore, 26 Crockford base32 characters. */
export type TypedId<P extends IdPrefix> = `${P}_${string}`;

/** Crockford base32 alphabet used by ULIDs (no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Regex source of a ULID body (26 characters, first one ≤ 7 so the timestamp fits 48 bits). */
export const ULID_PATTERN = '[0-7][0-9A-HJKMNP-TV-Z]{25}';

function typedId<P extends IdPrefix>(prefix: P, id: string, description: string) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${ULID_PATTERN}$`), `must be a ${prefix}_ id`)
    .meta({
      id,
      description,
      example: `${prefix}_01J9Z3N4X5Q6R7S8T9V0W1X2Y3`,
    }) as unknown as z.ZodType<TypedId<P>, TypedId<P>>;
}

export const ProjectId = typedId('prj', 'ProjectId', 'Project id (`prj_` + ULID).');
export type ProjectId = TypedId<'prj'>;
export const PrincipalId = typedId('prn', 'PrincipalId', 'Principal id (`prn_` + ULID).');
export type PrincipalId = TypedId<'prn'>;
export const AgentTokenId = typedId('agt', 'AgentTokenId', 'Agent token id (`agt_` + ULID).');
export type AgentTokenId = TypedId<'agt'>;
export const ModelId = typedId('mdl', 'ModelId', 'Model id (`mdl_` + ULID).');
export type ModelId = TypedId<'mdl'>;
export const RevisionId = typedId('rev', 'RevisionId', 'Model revision id (`rev_` + ULID).');
export type RevisionId = TypedId<'rev'>;
export const RelationId = typedId('rel', 'RelationId', 'Relation id (`rel_` + ULID).');
export type RelationId = TypedId<'rel'>;
export const AnalysisTaskId = typedId('ana', 'AnalysisTaskId', 'Analysis task id (`ana_` + ULID).');
export type AnalysisTaskId = TypedId<'ana'>;
export const AssertionId = typedId('asr', 'AssertionId', 'Relation assertion id (`asr_` + ULID).');
export type AssertionId = TypedId<'asr'>;
export const SubmissionId = typedId(
  'sbm',
  'SubmissionId',
  'Stored analysis submission id (`sbm_` + ULID); not the client-chosen `submissionId`.',
);
export type SubmissionId = TypedId<'sbm'>;
export const NoLinkId = typedId('nlk', 'NoLinkId', 'Stored no-link id (`nlk_` + ULID).');
export type NoLinkId = TypedId<'nlk'>;
export const ValueChainId = typedId('vch', 'ValueChainId', 'Value chain id (`vch_` + ULID).');
export type ValueChainId = TypedId<'vch'>;
export const ValueChainRevisionId = typedId(
  'vcr',
  'ValueChainRevisionId',
  'Value chain revision id (`vcr_` + ULID).',
);
export type ValueChainRevisionId = TypedId<'vcr'>;
export const PlacementId = typedId('plc', 'PlacementId', 'Placement id (`plc_` + ULID).');
export type PlacementId = TypedId<'plc'>;
export const PlacementAssertionId = typedId(
  'pas',
  'PlacementAssertionId',
  'Placement assertion id (`pas_` + ULID).',
);
export type PlacementAssertionId = TypedId<'pas'>;
export const AutoAcceptRuleId = typedId(
  'aar',
  'AutoAcceptRuleId',
  'Auto-accept rule id (`aar_` + ULID).',
);
export type AutoAcceptRuleId = TypedId<'aar'>;

/**
 * Creates a new typed ULID: 48-bit millisecond timestamp plus 80 random bits,
 * Crockford base32, prefixed (`newId('model')` → `mdl_01J…`). Ids sort by
 * creation time; within one millisecond the order is random.
 *
 * @param kind which entity the id is for
 * @param now  timestamp in ms since the epoch (tests pass a fixed value)
 */
export function newId<K extends IdKind>(
  kind: K,
  now: number = Date.now(),
): TypedId<(typeof ID_PREFIXES)[K]> {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new RangeError(`timestamp out of ULID range: ${now}`);
  }
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = '';
  for (const b of bytes) random += CROCKFORD.charAt(b % 32);
  return `${ID_PREFIXES[kind]}_${time}${random}`;
}

/** True if `value` is a well-formed typed id with the given prefix. */
export function isTypedId<P extends IdPrefix>(prefix: P, value: string): value is TypedId<P> {
  return new RegExp(`^${prefix}_${ULID_PATTERN}$`).test(value);
}
