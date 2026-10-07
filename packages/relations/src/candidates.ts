// Candidate generation for agents (CONCEPT §3 claim input, §7): per endpoint
// the rule and key matches, the top lexical matches and further compatible
// endpoints, in both directions. No LLM, deterministic.
import type {
  Candidate,
  CandidateBasis,
  CandidateSignals,
  DerivedRelation,
  ProjectFacts,
} from '@proa/contracts';

import {
  LINK_TYPES,
  canLink,
  fileStem,
  indexLandscape,
  type Endpoint,
  type LandscapeIndex,
} from './endpoints.ts';
import { compareStrings, compareTriples } from './order.ts';
import { nameKey, rulesFromIndex } from './rules.ts';
import {
  bestSimilarity,
  hasLexicalEvidence,
  textForm,
  type Similarity,
  type TextForm,
} from './text.ts';

export interface CandidateOptions {
  /** Top lexical matches per endpoint (default 5). */
  lexicalPerEndpoint?: number;
  /** Further compatible endpoints per endpoint, by descending similarity (default 30). */
  compatiblePerEndpoint?: number;
}

export const DEFAULT_LEXICAL_PER_ENDPOINT = 5;
export const DEFAULT_COMPATIBLE_PER_ENDPOINT = 30;

const BASIS_RANK: Readonly<Record<CandidateBasis, number>> = {
  rule: 0,
  key: 1,
  lexical: 2,
  compatible: 3,
};

function basisOf(relation: DerivedRelation): CandidateBasis {
  if (relation.tier === 'rule') return 'rule';
  return relation.tier === 'key' ? 'key' : 'lexical';
}

function pairKey(type: string, from: string, to: string): string {
  return `${type}|${from}|${to}`;
}

/** The texts an endpoint is known by: label and names from refs (and, for processes, ids and the file stem). */
function textsOf(index: LandscapeIndex, e: Endpoint): string[] {
  const f = e.fact;
  const texts = [f.label];
  if (e.type === 'call' && f.kind === 'process') {
    const p = index.processes.find((x) => x.ref === e.ref);
    texts.push(p?.name ?? '', p?.participantName ?? '', f.keyRaw, fileStem(e.modelKey));
  } else if (e.type !== 'trigger') {
    texts.push(e.name ?? f.keyRaw);
  }
  return [...new Set(texts.filter((t) => t.trim() !== ''))];
}

interface Context {
  readonly index: LandscapeIndex;
  readonly forms: Map<string, readonly TextForm[]>;
  /** Pairs fixed by the rule tier, with their basis and score. */
  readonly fixed: ReadonlyMap<string, { basis: CandidateBasis; score: number }>;
  readonly out: Map<string, Candidate>;
  readonly lexicalN: number;
  readonly compatibleN: number;
}

function formsOf(ctx: Context, e: Endpoint): readonly TextForm[] {
  const key = `${e.type}|${e.side}|${e.ref}`;
  let forms = ctx.forms.get(key);
  if (forms === undefined) {
    forms = textsOf(ctx.index, e).map(textForm);
    ctx.forms.set(key, forms);
  }
  return forms;
}

function signalsOf(from: Endpoint, to: Endpoint, sim: Similarity): CandidateSignals {
  return {
    keyEqual: from.fact.keyNorm !== '' && nameKey(from.fact.keyRaw) === nameKey(to.fact.keyRaw),
    jaccard: sim.jaccard,
    levenshtein: sim.levenshtein,
    eventDefCompatible: true,
  };
}

function emit(
  ctx: Context,
  from: Endpoint,
  to: Endpoint,
  basis: CandidateBasis,
  score: number,
  sim: Similarity,
): void {
  const key = pairKey(from.type, from.ref, to.ref);
  const existing = ctx.out.get(key);
  if (existing !== undefined && BASIS_RANK[existing.basis] <= BASIS_RANK[basis]) return;
  ctx.out.set(key, {
    type: from.type,
    from: from.ref,
    to: to.ref,
    basis,
    score,
    signals: signalsOf(from, to, sim),
  });
}

/**
 * Calls whose target is open: an expression, no `calledElement`, or a
 * constant no process has as id. Only these get lexical and compatible
 * partners; a call whose id matches is settled by the rule tier.
 */
function isOpenCall(index: LandscapeIndex, e: Endpoint): boolean {
  return e.name === null || !index.processesById.has(e.name);
}

/** Ranks the partners of one endpoint and emits its candidates. */
function perspective(ctx: Context, self: Endpoint, partners: readonly Endpoint[]): void {
  const ranked = partners
    .map((p) => {
      const [from, to] = self.side === 'from' ? [self, p] : [p, self];
      return { partner: p, from, to, sim: bestSimilarity(formsOf(ctx, from), formsOf(ctx, to)) };
    })
    .sort(
      (a, b) =>
        b.sim.score - a.sim.score ||
        b.sim.jaccard - a.sim.jaccard ||
        compareStrings(a.partner.ref, b.partner.ref),
    );
  let lexical = 0;
  let compatible = 0;
  for (const r of ranked) {
    const fixed = ctx.fixed.get(pairKey(r.from.type, r.from.ref, r.to.ref));
    if (fixed !== undefined) {
      emit(ctx, r.from, r.to, fixed.basis, fixed.score, r.sim);
    } else if (lexical < ctx.lexicalN && hasLexicalEvidence(r.sim)) {
      lexical++;
      emit(ctx, r.from, r.to, 'lexical', r.sim.score, r.sim);
    } else if (compatible < ctx.compatibleN) {
      compatible++;
      emit(ctx, r.from, r.to, 'compatible', r.sim.score, r.sim);
    }
  }
}

/**
 * Candidate pairs for agents (claim input, CONCEPT §3), per endpoint and in
 * both directions:
 * - `rule` and `key` pairs of {@link runRules} (score = rule confidence);
 * - the top `lexicalPerEndpoint` matches with lexical evidence (a shared
 *   concept after stopword removal, DE/EN synonyms and transliteration, or a
 *   relative Levenshtein ≥ 0.75), ranked by
 *   `0.6 · Jaccard + 0.4 · relative Levenshtein`;
 * - up to `compatiblePerEndpoint` further compatible endpoints, by the same
 *   score, so agents can find semantic links lexical similarity misses.
 *
 * Only compatible pairs appear (`EVENT_DEF_COMPATIBILITY`, endpoints in
 * different processes, scope rules, no message flow inside the file between
 * them). Calls get lexical and compatible partners only while their target is
 * open (expression, missing, or matching no process id).
 *
 * With `focusModelKey`, the perspectives of that model's endpoints only:
 * its throws, ends and calls towards every other process, and every other
 * process's throws, ends and calls towards its catches, starts and
 * processes. Without it, the union over all endpoints.
 *
 * Sorted by score descending, then `(type, from, to)`; deterministic.
 */
export function generateCandidates(
  projectFacts: ProjectFacts,
  focusModelKey?: string,
  options?: CandidateOptions,
): Candidate[] {
  const index = indexLandscape(projectFacts);
  const ruleRelations = rulesFromIndex(index).relations;
  const fixed = new Map<string, { basis: CandidateBasis; score: number }>();
  for (const r of ruleRelations) {
    fixed.set(pairKey(r.type, r.from, r.to), { basis: basisOf(r), score: r.confidence });
  }
  const ctx: Context = {
    index,
    forms: new Map(),
    fixed,
    out: new Map(),
    lexicalN: options?.lexicalPerEndpoint ?? DEFAULT_LEXICAL_PER_ENDPOINT,
    compatibleN: options?.compatiblePerEndpoint ?? DEFAULT_COMPATIBLE_PER_ENDPOINT,
  };
  const inFocus = (e: Endpoint): boolean =>
    focusModelKey === undefined || e.modelKey === focusModelKey;

  for (const type of LINK_TYPES) {
    const froms = index.endpoints[type].from;
    const tos = index.endpoints[type].to;
    const rankedFroms = type === 'call' ? froms.filter((c) => isOpenCall(index, c)) : froms;
    for (const from of rankedFroms) {
      if (!inFocus(from)) continue;
      perspective(
        ctx,
        from,
        tos.filter((to) => canLink(index, from, to)),
      );
    }
    for (const to of tos) {
      if (!inFocus(to)) continue;
      perspective(
        ctx,
        to,
        rankedFroms.filter((from) => canLink(index, from, to)),
      );
    }
    // Pairs of settled calls (accepted, or ambiguous ids) are not ranked above; add them directly.
    if (type === 'call') {
      const byRef = new Map([...froms, ...tos].map((e) => [`${e.side}|${e.ref}`, e]));
      for (const r of ruleRelations) {
        const from = byRef.get(`from|${r.from}`);
        const to = byRef.get(`to|${r.to}`);
        if (r.type !== 'call' || from === undefined || to === undefined) continue;
        if (isOpenCall(index, from) || (!inFocus(from) && !inFocus(to))) continue;
        const f = basisOf(r);
        emit(ctx, from, to, f, r.confidence, bestSimilarity(formsOf(ctx, from), formsOf(ctx, to)));
      }
    }
  }

  return [...ctx.out.values()].sort((a, b) => b.score - a.score || compareTriples(a, b));
}
