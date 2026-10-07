import { z } from 'zod';

import type { FactKind } from './facts.ts';
import { Ref } from './refs.ts';

/**
 * Relation types (CONCEPT §2):
 *
 * | type | from → to | rule |
 * |---|---|---|
 * | `call` | `call` → `process` | `calledElement` = exactly one process id → accepted by `proa-rules/1.0.0` |
 * | `message` | `msg_throw` → `msg_catch` | same message name → proposed, tier `key`, confidence 1.0 |
 * | `signal` | `sig_throw` → `sig_catch` | same signal name → proposed, tier `key` |
 * | `trigger` | labelled none end → labelled none start | none; agents only |
 * | `manual` | any → any | humans only, rationale required |
 */
export const RelationType = z
  .enum(['call', 'message', 'signal', 'trigger', 'manual'])
  .meta({ id: 'RelationType', description: 'Type of a relation between two processes.' });
export type RelationType = z.infer<typeof RelationType>;

/**
 * How a relation (or assertion) was found: `rule` (unambiguous call,
 * auto-accepted), `key` (identical message/signal name or call target),
 * `lexical` (similar labels), `semantic` (same meaning, other words),
 * `manual` (added by a human).
 */
export const Tier = z
  .enum(['key', 'lexical', 'semantic', 'manual', 'rule'])
  .meta({ id: 'Tier', description: 'Evidence tier of a relation.' });
export type Tier = z.infer<typeof Tier>;

/** Review status, computed by `recomputeStatus` (CONCEPT §2). `obsolete` relations are hidden. */
export const RelationStatus = z
  .enum(['proposed', 'accepted', 'rejected', 'held', 'obsolete'])
  .meta({ id: 'RelationStatus', description: 'Review status of a relation.' });
export type RelationStatus = z.infer<typeof RelationStatus>;

/** Whether both endpoints still exist with the fingerprints stored at the decision. */
export const EndpointState = z.enum(['ok', 'changed', 'missing']).meta({
  id: 'EndpointState',
  description: 'State of the relation endpoints in the head revisions.',
});
export type EndpointState = z.infer<typeof EndpointState>;

/** Who made an assertion; derived from the credential, never sent by clients (CONCEPT §6). */
export const SourceKind = z
  .enum(['human', 'agent', 'rule'])
  .meta({ id: 'SourceKind', description: 'Origin of an assertion.' });
export type SourceKind = z.infer<typeof SourceKind>;

/** Identifier of the rule tier, recorded as procedure of rule assertions. */
export const RULES_PROCEDURE = 'proa-rules/1.0.0';

/** Fact kinds allowed at each end of a relation type (`manual`: any kind). */
export const RELATION_ENDPOINT_KINDS = {
  call: { from: ['call'], to: ['process'] },
  message: { from: ['msg_throw'], to: ['msg_catch'] },
  signal: { from: ['sig_throw'], to: ['sig_catch'] },
  trigger: { from: ['evt_end'], to: ['evt_start'] },
  manual: { from: null, to: null },
} as const satisfies Record<
  RelationType,
  { from: readonly FactKind[] | null; to: readonly FactKind[] | null }
>;

/**
 * A relation computed by code: the rule tier (`runRules`) or the 1.x
 * baseline (`baselineProa1`). The server turns it into a relation plus a
 * `rule` assertion; the eval compares it with `expected.yaml`.
 */
export const DerivedRelation = z
  .object({
    type: RelationType.exclude(['manual']),
    from: Ref,
    to: Ref,
    /** `accepted` only for unambiguous calls (rule tier); everything else is `proposed`. */
    status: z.enum(['accepted', 'proposed']),
    tier: Tier,
    confidence: z.number().min(0).max(1),
    /** E.g. call binding, version and tenant attributes, which never change the target. */
    attrs: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'DerivedRelation', description: 'A relation computed by code (rules or baseline).' });
export type DerivedRelation = z.infer<typeof DerivedRelation>;
