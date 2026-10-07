/**
 * `@proa/bpmn-facts`: deterministic fact extraction from Camunda 7 and
 * Camunda 8 BPMN (CONCEPT §2) with bpmn-moddle and the camunda/zeebe moddle
 * extensions. No I/O, no database, no LLM.
 *
 * - {@link extractFacts}: one BPMN file → processes, facts, message flows, warnings
 * - {@link assertSafeXml}: DOCTYPE/ENTITY rejection, UTF-8, size limit (run by `extractFacts`)
 * - {@link factFingerprint}, {@link factsHash}, {@link normalizeKey}: the hashing and
 *   normalization rules behind `fingerprint`, `facts_hash` and `key_norm`
 */
export { FACTS_VERSION } from './version.ts';
export { BpmnInputError } from './errors.ts';
export type { BpmnInputErrorCode } from './errors.ts';
export { DEFAULT_PARSE_LIMITS, assertSafeXml } from './input.ts';
export type { ParseLimits } from './input.ts';
export { BPMN_MODEL_NAMESPACE, MAX_WARNINGS, extractFacts } from './extract.ts';
export type { Engine, ExtractOptions, ExtractResult, ExtractWarning } from './extract.ts';
export { factFingerprint, factsHash } from './fingerprint.ts';
export type { FingerprintInput } from './fingerprint.ts';
export { normalizeKey } from './normalize.ts';
export { compareFacts } from './order.ts';
export {
  MAX_DOCUMENTATION_LENGTH,
  MAX_KEY_LENGTH,
  MAX_LABEL_LENGTH,
  sanitizeLine,
} from './sanitize.ts';
export type { Sanitized } from './sanitize.ts';
