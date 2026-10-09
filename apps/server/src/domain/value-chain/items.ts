/**
 * Validation of placement items (M4 §3.1), the per-item checks of
 * `propose_placement` and `POST …/placements` (and, in M4b, of the
 * `placement` pipeline's submissions): the checks run in the order of
 * {@link PLACEMENT_INVALID_REASONS} and the first failing one is the item's
 * `invalid:<reason>`, while the other items of the request still apply. A
 * valid item carries the server-computed tier. Pure.
 */
import {
  MAX_EVIDENCE_ITEMS,
  MAX_LIVE_STEPS_PER_PROCESS,
  MAX_QUESTION_CHARS,
  MAX_RATIONALE_CHARS,
  MAX_VALUE_CHAIN_ID_CHARS,
  OUTSIDE_STEP,
  hasControlCharacters,
  isRef,
  type PlacementInvalidReason,
  type SourceKind,
} from '@proa/contracts';

import type { ValidPlacementProposal } from './placements.ts';
import { placementTier } from './placements.ts';
import type { ChainStructure } from './structure.ts';

/** An item as parsed from a request (shape checked, limits not yet). */
export interface PlacementItemDraft {
  step: string;
  process: string;
  confidence: number;
  rationale: string;
  evidence: readonly string[];
  question: string | null;
}

/** The head state an item is checked against. */
export interface PlacementItemContext {
  structure: ChainStructure;
  /** The live generation of each element id, `@outside` included. */
  live: ReadonlyMap<string, number>;
  /** Refs of the head's `process` facts. */
  processes: ReadonlySet<string>;
  /** Refs of every head fact. */
  factRefs: ReadonlySet<string>;
  /** Ids of the project's relations. */
  relationIds: ReadonlySet<string>;
  /** Who proposes: the rule tier is exempt from the step limit; humans get `manual`. */
  sourceKind: SourceKind;
  /**
   * The step generations (`<element id>\0<generation>`) on which the
   * proposer has a live proposal for the process, as of now.
   */
  liveProposalSteps(processRef: string): ReadonlySet<string>;
  /** Whether a proposal of the process on the step is `lexical` (`lexicalMatcher`). */
  lexical(processRef: string, elementId: string): boolean;
}

export type PlacementItemValidation =
  { ok: true; value: ValidPlacementProposal } | { ok: false; reason: PlacementInvalidReason };

const CONTROL = /\p{Cc}/u;
const STEP_EVIDENCE = 'step:';
const RELATION_EVIDENCE = 'rel_';

/** `<element id>\0<generation>`: a step generation as {@link PlacementItemContext.liveProposalSteps} lists it. */
export function stepGenerationKey(elementId: string, generation: number): string {
  return `${elementId}\u0000${generation}`;
}

/** Whether an evidence entry names something that exists (a fact ref, a relation, a live step). */
function knownEvidence(entry: string, ctx: PlacementItemContext): boolean {
  if (entry.startsWith(STEP_EVIDENCE)) {
    const id = entry.slice(STEP_EVIDENCE.length);
    return ctx.structure.byId.has(id) && ctx.live.has(id);
  }
  if (entry.startsWith(RELATION_EVIDENCE)) return ctx.relationIds.has(entry);
  return ctx.factRefs.has(entry);
}

/**
 * The per-item checks, in this order: `malformed-step` (1–128 characters, no
 * control characters), `malformed-ref` (process), `confidence-out-of-range`,
 * `rationale-too-long` (> 1,000), `question-too-long` (> 500),
 * `too-much-evidence` (> 20), `control-characters` (other than tab and line
 * breaks, in rationale, question and evidence), `rationale-required`
 * (`@outside` without a reason), `unknown-step` (not a live step of the head,
 * nor `@outside`), `unknown-process` (not a head `process` fact),
 * `unknown-evidence` (each entry a head fact ref, a `rel_` id of the
 * project, or `step:<element id>` of a live step), `too-many-steps` (the
 * proposer already has live proposals for the process on 3 other live step
 * generations; not for the rule tier).
 */
export function validatePlacementItem(
  item: PlacementItemDraft,
  ctx: PlacementItemContext,
): PlacementItemValidation {
  const step = item.step;
  if (step.length < 1 || step.length > MAX_VALUE_CHAIN_ID_CHARS || CONTROL.test(step)) {
    return { ok: false, reason: 'malformed-step' };
  }
  if (!isRef(item.process)) return { ok: false, reason: 'malformed-ref' };
  if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
    return { ok: false, reason: 'confidence-out-of-range' };
  }
  if (item.rationale.length > MAX_RATIONALE_CHARS)
    return { ok: false, reason: 'rationale-too-long' };
  if (item.question !== null && item.question.length > MAX_QUESTION_CHARS) {
    return { ok: false, reason: 'question-too-long' };
  }
  if (item.evidence.length > MAX_EVIDENCE_ITEMS) return { ok: false, reason: 'too-much-evidence' };
  if (
    hasControlCharacters(item.rationale) ||
    (item.question !== null && hasControlCharacters(item.question)) ||
    item.evidence.some(hasControlCharacters)
  ) {
    return { ok: false, reason: 'control-characters' };
  }
  const toOutside = step === OUTSIDE_STEP;
  if (toOutside && item.rationale.trim() === '') return { ok: false, reason: 'rationale-required' };
  const generation = ctx.live.get(step);
  if (generation === undefined || (!toOutside && !ctx.structure.byId.has(step))) {
    return { ok: false, reason: 'unknown-step' };
  }
  if (!ctx.processes.has(item.process)) return { ok: false, reason: 'unknown-process' };
  if (!item.evidence.every((e) => knownEvidence(e, ctx))) {
    return { ok: false, reason: 'unknown-evidence' };
  }
  if (ctx.sourceKind !== 'rule') {
    const target = stepGenerationKey(step, generation);
    const others = [...ctx.liveProposalSteps(item.process)].filter((k) => k !== target);
    if (others.length >= MAX_LIVE_STEPS_PER_PROCESS) return { ok: false, reason: 'too-many-steps' };
  }
  return {
    ok: true,
    value: {
      elementId: step,
      generation,
      processRef: item.process,
      tier: placementTier({
        sourceKind: ctx.sourceKind,
        toOutside,
        lexicalMatch: !toOutside && ctx.lexical(item.process, step),
      }),
      confidence: item.confidence,
      rationale: item.rationale,
      evidence: [...item.evidence],
      question: item.question === '' ? null : item.question,
    },
  };
}
