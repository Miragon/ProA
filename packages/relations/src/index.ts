/**
 * `@proa/relations`: deterministic relation logic, no LLM (CONCEPT §2, §7):
 * - {@link runRules}: the rule tier (unambiguous calls accepted by
 *   `proa-rules/1.0.0`, `key`-tier proposals for identical message and
 *   signal names) and the findings `unresolved-call`, `dynamic-call`,
 *   `duplicate-process-id`, `dangling-throw`, `unmatched-catch`;
 * - {@link generateCandidates}: candidate pairs for agents (key, lexical,
 *   compatible), in both directions around a focus model;
 * - {@link baselineProa1}: the 1.x algorithm, for comparison in the eval;
 * - {@link baselinePrefix} (`baseline-prefix/1`) and {@link sharesNameStem}:
 *   lexical matching of processes to value chain steps (M4);
 * - the shared endpoint semantics, compatibility matrix and text similarity.
 */
import { normalizeKey } from '@proa/bpmn-facts';
import { RULES_PROCEDURE } from '@proa/contracts';

/** Procedure id recorded on rule assertions: `proa-rules/1.0.0`. */
export const RULES_VERSION = RULES_PROCEDURE;

export {
  FILE_STEM_CONFIDENCE,
  PROCESS_NAME_CONFIDENCE,
  keyPairs,
  nameKey,
  rulesFromIndex,
  runRules,
} from './rules.ts';
export type { RuleResult } from './rules.ts';
export {
  DEFAULT_COMPATIBLE_PER_ENDPOINT,
  DEFAULT_LEXICAL_PER_ENDPOINT,
  generateCandidates,
} from './candidates.ts';
export type { CandidateOptions } from './candidates.ts';
export { createPairAssessor } from './assess.ts';
export type { PairAssessment, PairQuery, PairRejection, ProposalTier } from './assess.ts';
export {
  BASELINE_PROA1,
  PROA1_MAX_DISTANCE,
  baselineEventsFromFacts,
  baselineProa1,
  proa1ProcessNames,
  searchLabel,
} from './baseline.ts';
export type { BaselineEvent, BaselineEventPosition, BaselineOptions } from './baseline.ts';
export {
  BASELINE_PREFIX,
  NAME_STEM_MIN,
  PREFIX_ANCESTOR_VOTE,
  PREFIX_ANCESTOR_WEIGHT,
  PREFIX_FOLDER_WEIGHT,
  PREFIX_NAME_WEIGHT,
  PREFIX_TOP,
  PREFIX_VOTE,
  baselinePrefix,
  prefixTokensMatch,
  sharedStem,
  sharesNameStem,
  stemWords,
} from './placement.ts';
export type { PrefixHint, PrefixInput, PrefixProcess, PrefixStep } from './placement.ts';
export {
  EVENT_DEF_COMPATIBILITY,
  LINK_TYPES,
  canLink,
  endpointRole,
  fileStem,
  inEndpointScope,
  indexLandscape,
  processRefOf,
} from './endpoints.ts';
export type { Endpoint, LandscapeIndex, LinkType, ProcessEntry, Side } from './endpoints.ts';
export {
  JACCARD_WEIGHT,
  LEXICAL_MIN_LEVENSHTEIN,
  STOPWORDS,
  SYNONYMS,
  bestSimilarity,
  conceptJaccard,
  conceptOf,
  contentWords,
  hasLexicalEvidence,
  levenshtein,
  relativeLevenshtein,
  similarity,
  splitCamelCase,
  textForm,
} from './text.ts';
export type { Similarity, TextForm } from './text.ts';

/**
 * Normalizes a label for lexical matching; the same transform as fact
 * `keyNorm` (`normalizeKey` from `@proa/bpmn-facts`): NFKC, lowercase,
 * ä/ö/ü/ß → ae/oe/ue/ss, diacritics folded, punctuation → space.
 */
export function normalizeLabel(label: string): string {
  return normalizeKey(label);
}
