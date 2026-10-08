// Assessment of one pair that an agent or a human proposes (CONCEPT §3
// "Validation", §2 "Assertions"): is it a possible relation at all, and which
// tier does the server record for it? No LLM, deterministic.
import type { CandidateSignals, ProjectFacts, Ref, Tier } from '@proa/contracts';

import { textsOf } from './candidates.ts';
import { canLink, indexLandscape, type Endpoint, type LinkType } from './endpoints.ts';
import { round4 } from './order.ts';
import { nameKey, rulesFromIndex } from './rules.ts';
import { bestSimilarity, hasLexicalEvidence, textForm, type TextForm } from './text.ts';

/** Why a pair can never be a relation of its type. */
export type PairRejection = 'unknown-ref' | 'type-mismatch' | 'same-process' | 'message-flow';

/** Tier of a proposal, computed by the server, never sent by agents. */
export type ProposalTier = Extract<Tier, 'key' | 'lexical' | 'semantic'>;

export type PairAssessment =
  | { ok: true; tier: ProposalTier; score: number; signals: CandidateSignals }
  | { ok: false; reason: PairRejection };

export interface PairQuery {
  type: LinkType;
  from: Ref;
  to: Ref;
}

/**
 * Prepares the landscape once and returns a function that assesses pairs:
 * - `unknown-ref`: an end is not an element of the head facts (no
 *   hallucinated elements);
 * - `type-mismatch`: an end cannot take that side of the type (fact kind,
 *   event definition, scope: `endpointRole`);
 * - `same-process`, `message-flow`: both ends in one process, or already
 *   joined by a message flow inside their file (a fact, not a relation);
 * - otherwise the tier: `key` for the rule tier's own pairs and identical
 *   names from real refs, `lexical` with lexical evidence (shared concept or
 *   relative Levenshtein ≥ 0.75), else `semantic`.
 */
export function createPairAssessor(
  projectFacts: ProjectFacts,
): (pair: PairQuery) => PairAssessment {
  const index = indexLandscape(projectFacts);
  const refs = new Set<string>();
  for (const model of index.models) for (const fact of model.facts) refs.add(fact.ref);
  const endpoints = new Map<string, Endpoint>();
  for (const [type, sides] of Object.entries(index.endpoints)) {
    for (const [side, list] of Object.entries(sides)) {
      for (const e of list) endpoints.set(`${type}|${side}|${e.ref}`, e);
    }
  }
  const ruleTiers = new Map<string, Tier>();
  for (const r of rulesFromIndex(index).relations)
    ruleTiers.set(`${r.type}|${r.from}|${r.to}`, r.tier);
  const forms = new Map<string, readonly TextForm[]>();
  const formsOf = (e: Endpoint): readonly TextForm[] => {
    const key = `${e.type}|${e.side}|${e.ref}`;
    let f = forms.get(key);
    if (f === undefined) {
      f = textsOf(index, e).map(textForm);
      forms.set(key, f);
    }
    return f;
  };

  return ({ type, from, to }) => {
    if (!refs.has(from) || !refs.has(to)) return { ok: false, reason: 'unknown-ref' };
    const f = endpoints.get(`${type}|from|${from}`);
    const t = endpoints.get(`${type}|to|${to}`);
    if (f === undefined || t === undefined) return { ok: false, reason: 'type-mismatch' };
    if (f.process === t.process) return { ok: false, reason: 'same-process' };
    if (!canLink(index, f, t)) return { ok: false, reason: 'message-flow' };

    const sim = bestSimilarity(formsOf(f), formsOf(t));
    const keyEqual = f.name !== null && t.name !== null && nameKey(f.name) === nameKey(t.name);
    const ruleTier = ruleTiers.get(`${type}|${from}|${to}`);
    const tier: ProposalTier =
      ruleTier === 'rule' || ruleTier === 'key' || keyEqual
        ? 'key'
        : ruleTier === 'lexical' || hasLexicalEvidence(sim)
          ? 'lexical'
          : 'semantic';
    return {
      ok: true,
      tier,
      score: round4(sim.score),
      signals: {
        keyEqual,
        jaccard: sim.jaccard,
        levenshtein: sim.levenshtein,
        eventDefCompatible: true,
      },
    };
  };
}
