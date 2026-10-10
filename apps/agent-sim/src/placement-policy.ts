/**
 * The placement part of the simulation agent's policy (`sim-policy-1`, M4
 * §3.2): deterministic and LLM-free, a function of the claim input alone
 * (`proa-claim-placement/1`). Every process of the input gets exactly one
 * verdict (judge each process once):
 *
 * - **rule**: the process has a live `proa-rules` proposal (the step's link
 *   or name names the process) that no reviewer rejected: propose the same
 *   step at confidence {@link RULE_CONFIDENCE};
 * - otherwise the top `baseline-prefix/1` hint, skipping steps a reviewer
 *   rejected for the process. The bands follow the hint's score alone: the
 *   claim carries no breakdown, so a score of 3 may come from one name word
 *   on the step's own name, but also from a folder word plus a parent-step
 *   word or from neighbours accepted on the step (votes, once reviewers
 *   decided), and the rationale states only the score:
 *   - **hint**: score ≥ {@link STRONG_HINT_SCORE}: propose it at
 *     min(0.9, 0.5 + 0.1 · score), rounded to two decimals; **hint-tie** when
 *     the next remaining hint has the same score: the same, with a question;
 *   - **weak-hint**: a lower score (no name word on the step's own name, which
 *     alone scores 3; folder or parent-step words, neighbours' votes): propose
 *     it at {@link WEAK_HINT_CONFIDENCE} with a question;
 * - **unsure**: no hint left: "no lexical evidence for any step".
 *
 * One home step per process, never `@outside` (archived copies need meaning
 * the policy does not have). Evidence is the process ref and `step:<id>`.
 * Texts are English, as the relation part's. The bands were set on the dev
 * landscape (`nordwind-handel`) only.
 */
import {
  MAX_QUESTION_CHARS,
  MAX_RATIONALE_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_UNSURE_REASON_CHARS,
  type ClaimPlacementProcess,
  type ClaimPlacementStep,
  type PlacementClaimInput,
} from '@proa/contracts';

import { SIM_POLICY } from './policy.ts';

/** Confidence of a proposal that confirms the rule tier's key proposal. */
export const RULE_CONFIDENCE = 0.95;
/**
 * A hint scoring at least this is a strong hint: one name word on the step's
 * own name scores it alone, but folder and parent-step words and neighbours'
 * votes add up to it as well.
 */
export const STRONG_HINT_SCORE = 3;
/** Confidence of a proposal resting on a weak hint (always with a question). */
export const WEAK_HINT_CONFIDENCE = 0.5;
/** Upper bound of a hint's confidence. */
export const MAX_HINT_CONFIDENCE = 0.9;
/** The unsure reason when no hint is left. */
export const NO_EVIDENCE = 'no lexical evidence for any step';

export type PlacementVerdict = 'rule' | 'hint' | 'hint-tie' | 'weak-hint' | 'unsure';

/** A proposed placement, as sent in `submit_analysis`. */
export interface PlacementProposal {
  step: string;
  process: string;
  confidence: number;
  rationale: string;
  evidence: string[];
  question: string | null;
}

/** A process the policy could not place, as sent in `submit_analysis` (`unsure`). */
export interface UnsureVerdict {
  process: string;
  reason: string;
}

export interface PlacementJudgement {
  process: string;
  verdict: PlacementVerdict;
  /** The proposed step; `null` for `unsure`. */
  step: string | null;
  /** The hint's score; `null` for `rule` and `unsure`. */
  score: number | null;
}

export interface PlacementDecision {
  placements: PlacementProposal[];
  unsure: UnsureVerdict[];
  summary: string;
  /** One verdict per process, in input order. */
  judgements: PlacementJudgement[];
  counts: Record<PlacementVerdict, number>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Control characters (tab and line breaks included) as spaces: rationales stay one line. */
function plain(text: string): string {
  return text.replace(/\p{Cc}/gu, ' ');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function processName(p: ClaimPlacementProcess): string {
  return p.name ?? p.process.slice(p.process.indexOf('#') + 1);
}

function stepText(steps: ReadonlyMap<string, ClaimPlacementStep>, id: string): string {
  const s = steps.get(id);
  if (!s) return `"${id}"`;
  return s.path.length > 1 ? `"${s.name}" (${s.path.join(' > ')})` : `"${s.name}"`;
}

/** The hint confidence of a strong hint: 0.5 + 0.1 per score point, at most 0.9. */
export function hintConfidence(score: number): number {
  return round2(Math.min(MAX_HINT_CONFIDENCE, 0.5 + 0.1 * score));
}

/**
 * Decides on a placement claim input: one placement or one unsure item per
 * process, and a summary, ready for `submit_analysis`. Pure and deterministic.
 */
export function decidePlacements(input: PlacementClaimInput): PlacementDecision {
  const steps = new Map(input.steps.map((s) => [s.id, s]));
  const placements: PlacementProposal[] = [];
  const unsure: UnsureVerdict[] = [];
  const judgements: PlacementJudgement[] = [];
  const counts: Record<PlacementVerdict, number> = {
    rule: 0,
    hint: 0,
    'hint-tie': 0,
    'weak-hint': 0,
    unsure: 0,
  };
  const judge = (j: PlacementJudgement) => {
    judgements.push(j);
    counts[j.verdict]++;
  };

  for (const p of input.processes) {
    const name = processName(p);
    const rejected = new Set(p.decisions.filter((d) => d.verdict === 'reject').map((d) => d.step));
    const propose = (
      step: string,
      confidence: number,
      rationale: string,
      question: string | null,
    ) =>
      placements.push({
        step,
        process: p.process,
        confidence,
        rationale: clip(plain(rationale), MAX_RATIONALE_CHARS),
        evidence: [p.process, `step:${step}`],
        question: question === null ? null : clip(plain(question), MAX_QUESTION_CHARS),
      });

    const rule = p.proposals.find(
      (x) =>
        x.source === 'rule' &&
        x.status === 'proposed' &&
        !rejected.has(x.step) &&
        steps.has(x.step),
    );
    if (rule) {
      propose(
        rule.step,
        RULE_CONFIDENCE,
        `The rule tier proposes ${stepText(steps, rule.step)} for "${name}" (${p.process}): the step's link or name names this process.`,
        null,
      );
      judge({ process: p.process, verdict: 'rule', step: rule.step, score: null });
      continue;
    }

    const hints = p.hints.filter((h) => !rejected.has(h.step) && steps.has(h.step));
    const [top, next] = hints;
    if (!top) {
      const reason =
        p.hints.length > 0 ? `${NO_EVIDENCE} (a reviewer rejected the hinted steps)` : NO_EVIDENCE;
      unsure.push({ process: p.process, reason: clip(reason, MAX_UNSURE_REASON_CHARS) });
      judge({ process: p.process, verdict: 'unsure', step: null, score: null });
      continue;
    }
    const where = `${stepText(steps, top.step)} scores ${fmt(top.score)} in the lexical baseline for "${name}" (${p.process})`;
    if (top.score >= STRONG_HINT_SCORE) {
      const tie = next !== undefined && next.score === top.score;
      propose(
        top.step,
        hintConfidence(top.score),
        tie
          ? `${where}; ${stepText(steps, next.step)} scores the same.`
          : `${where}, at least ${STRONG_HINT_SCORE} from name, folder, parent-step or neighbour evidence.`,
        tie
          ? `Is "${name}" placed on ${stepText(steps, top.step)} or on ${stepText(steps, next.step)}? Both score ${fmt(top.score)}.`
          : null,
      );
      judge({
        process: p.process,
        verdict: tie ? 'hint-tie' : 'hint',
        step: top.step,
        score: top.score,
      });
      continue;
    }
    propose(
      top.step,
      WEAK_HINT_CONFIDENCE,
      `${where}: only folder or parent-step words or neighbours' steps match, not the step's own name.`,
      `Does "${name}" belong on ${stepText(steps, top.step)}? The evidence is weak (score ${fmt(top.score)}).`,
    );
    judge({ process: p.process, verdict: 'weak-hint', step: top.step, score: top.score });
  }

  const questions = placements.filter((x) => x.question !== null).length;
  const summary = clip(
    `${SIM_POLICY} (placements): ${placements.length} placed (${counts.rule} confirming the rule tier, ` +
      `${questions} with a question); ${unsure.length} unsure` +
      `${input.truncated ? `; ${input.remaining} processes left for a follow-up task` : ''}.`,
    MAX_SUMMARY_CHARS,
  );
  return { placements, unsure, summary, judgements, counts };
}
