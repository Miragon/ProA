// Matching of processes to value chain steps (M4-VALUE-CHAIN.md §2 "Tiers",
// §6): the key-tier rule derivation (`derivePlacementRules`: a step's
// `proa:process/` link or its equal name), the frozen baseline
// `baseline-prefix/1` and the derived `name-match` stem rule of
// eval/value-chains/README.md. Pure and deterministic. The server uses them
// for the rule tier's key proposals, the `lexical` tier of placement
// proposals and the hints of unplaced processes; `eval:placements` (S4) gates
// the rule derivation on the golden chains and reports the baseline as the
// floor agents must beat.
//
// It lives here, next to the text normalization, the stopwords, the synonyms
// and baseline-proa1 it builds on, because both the server domain and
// eval/tools depend on @proa/relations: a sixth package would break CONCEPT
// principle 7, and eval/tools must not import from an app. Steps come in as
// plain `{id, name, parentId}`, so this package needs no schema-model.
import { normalizeKey } from '@proa/bpmn-facts';
import { PROA_PROCESS_LINK_PREFIX } from '@proa/contracts';

import { fileStem } from './endpoints.ts';
import { compareStrings } from './order.ts';
import { conceptOf, contentWords } from './text.ts';

/** Id of the prefix baseline in reports. Any change to the algorithm needs `/2`. */
export const BASELINE_PREFIX = 'baseline-prefix/1';

/** Weight of a process name or file stem token matching the step's own name. */
export const PREFIX_NAME_WEIGHT = 3;
/** Weight of a process name or file stem token matching an ancestor's name. */
export const PREFIX_ANCESTOR_WEIGHT = 1;
/** Weight of a model key folder token matching the step's or an ancestor's name. */
export const PREFIX_FOLDER_WEIGHT = 2;
/** Vote of a neighbour process known on the step itself. */
export const PREFIX_VOTE = 1;
/** Vote of a neighbour process known on a descendant of the step. */
export const PREFIX_ANCESTOR_VOTE = 0.5;
/** Hints per process by default. */
export const PREFIX_TOP = 3;
/** Tokens shorter than this match only when equal. */
const MIN_TOKEN = 4;
/** Two tokens match when they share a prefix this long (or the whole shorter token). */
const MIN_PREFIX = 5;

/** A value chain step as the baseline sees it. */
export interface PrefixStep {
  id: string;
  name: string;
  /** The `hierarchy` parent; `null` at the top level. */
  parentId: string | null;
}

/** A process as the baseline sees it. */
export interface PrefixProcess {
  /** `<model_key>#<process_id>`. */
  ref: string;
  /** Process name, else the pool name. */
  name: string | null;
  modelKey: string;
}

export interface PrefixInput {
  steps: readonly PrefixStep[];
  processes: readonly PrefixProcess[];
  /** Processes joined to a process by a relation (the server: accepted ones). */
  neighbours?: ReadonlyMap<string, readonly string[]>;
  /** Steps a process is known to belong to (the server: accepted placements on live steps). */
  known?: ReadonlyMap<string, readonly string[]>;
}

export interface PrefixHint {
  stepId: string;
  score: number;
}

/**
 * The words of a text (`contentWords`: normalization, camelCase split,
 * stopwords), each with its forms: the word and its synonym concept
 * (`conceptOf`), so "Rechnung" also meets "invoice" while the compound
 * "Auftragseingang" (concept `receive`) still meets "Auftragsannahme".
 */
function tokens(text: string): Word[] {
  const out = new Map<string, Word>();
  for (const w of contentWords(text)) {
    if (!out.has(w)) out.set(w, [...new Set([w, conceptOf(w)])]);
  }
  return [...out.values()];
}

/** The forms of one word: itself and, if different, its concept. */
type Word = readonly string[];

function wordsMatch(a: Word, b: Word): boolean {
  return a.some((x) => b.some((y) => prefixTokensMatch(x, y)));
}

/**
 * Two tokens match when they are equal, or when both have at least 4
 * characters and share a prefix of at least `min(5, |a|, |b|)` characters
 * (`kommissionierung` ~ `kommissioniert`, `versand` ~ `versandvorbereitung`).
 */
export function prefixTokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < MIN_TOKEN || b.length < MIN_TOKEN) return false;
  const need = Math.min(MIN_PREFIX, a.length, b.length);
  for (let i = 0; i < need; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return false;
  return true;
}

/** How many words of `from` match some word of `to`. */
function hits(from: readonly Word[], to: readonly Word[]): number {
  let n = 0;
  for (const a of from) if (to.some((b) => wordsMatch(a, b))) n++;
  return n;
}

/** The words of both lists, each once (by its first form). */
function union(a: readonly Word[], b: readonly Word[]): Word[] {
  const out = new Map<string, Word>();
  for (const w of [...a, ...b]) if (w[0] !== undefined && !out.has(w[0])) out.set(w[0], w);
  return [...out.values()];
}

const FOLDER_SEPARATOR = ' ';

/**
 * `baseline-prefix/1` (frozen): for every process, the steps whose names
 * match its name, file stem and model key folders, plus votes from its
 * neighbours' known steps; the `top` best steps with a score above 0.
 *
 * - Words: `contentWords` (normalization, camelCase split, stopwords), each
 *   with its `conceptOf` synonym concept as a second form; two words match
 *   when a form of one matches a form of the other ({@link prefixTokensMatch}).
 *   Name words = process name ∪ file stem, folder words = the model key's
 *   folders (without the file stem). Each word counts once.
 * - Score of a step: 3 × name words matching its name + 1 × name words
 *   matching an ancestor's name + 2 × folder words matching its or an
 *   ancestor's name + per neighbour q ≠ p: 1 if q is known on the step, else
 *   0.5 if q is known on a descendant of it.
 * - Order: score descending, then depth descending (the more specific step),
 *   then step id in code point order. `@outside` (and any id starting with
 *   `@`) is never a candidate.
 * - Leave-one-out by construction: `known(p)` is never read for `p` itself.
 */
export function baselinePrefix(
  input: PrefixInput,
  options: { top?: number } = {},
): Map<string, PrefixHint[]> {
  const top = options.top ?? PREFIX_TOP;
  const steps = input.steps.filter((s) => !s.id.startsWith('@'));
  const byId = new Map(steps.map((s) => [s.id, s]));
  const ancestorsOf = new Map<string, string[]>();
  for (const s of steps) {
    const chain: string[] = [];
    const seen = new Set([s.id]);
    let parent = s.parentId;
    while (parent !== null && byId.has(parent) && !seen.has(parent)) {
      chain.push(parent);
      seen.add(parent);
      parent = byId.get(parent)?.parentId ?? null;
    }
    ancestorsOf.set(s.id, chain);
  }
  const own = new Map(steps.map((s) => [s.id, tokens(s.name)]));
  const ancestorTokens = new Map(
    steps.map((s) => {
      let words: Word[] = [];
      for (const a of ancestorsOf.get(s.id) ?? []) words = union(words, own.get(a) ?? []);
      return [s.id, words];
    }),
  );
  const out = new Map<string, PrefixHint[]>();
  for (const p of input.processes) {
    const nameTokens = union(tokens(p.name ?? ''), tokens(fileStem(p.modelKey)));
    const folders = p.modelKey.split('/').slice(0, -1).join(FOLDER_SEPARATOR);
    const folderTokens = tokens(folders);
    const votes = new Map<string, number>();
    for (const q of new Set(input.neighbours?.get(p.ref) ?? [])) {
      if (q === p.ref) continue;
      const knownSteps = new Set(input.known?.get(q) ?? []);
      if (knownSteps.size === 0) continue;
      const covered = new Set<string>();
      for (const k of knownSteps) for (const a of ancestorsOf.get(k) ?? []) covered.add(a);
      for (const s of steps) {
        const vote = knownSteps.has(s.id)
          ? PREFIX_VOTE
          : covered.has(s.id)
            ? PREFIX_ANCESTOR_VOTE
            : 0;
        if (vote > 0) votes.set(s.id, (votes.get(s.id) ?? 0) + vote);
      }
    }
    const scored: (PrefixHint & { depth: number })[] = [];
    for (const s of steps) {
      const ownTokens = own.get(s.id) ?? [];
      const upTokens = ancestorTokens.get(s.id) ?? [];
      const score =
        PREFIX_NAME_WEIGHT * hits(nameTokens, ownTokens) +
        PREFIX_ANCESTOR_WEIGHT * hits(nameTokens, upTokens) +
        PREFIX_FOLDER_WEIGHT * hits(folderTokens, union(ownTokens, upTokens)) +
        (votes.get(s.id) ?? 0);
      if (score > 0) {
        scored.push({ stepId: s.id, score, depth: ancestorsOf.get(s.id)?.length ?? 0 });
      }
    }
    scored.sort(
      (a, b) => b.score - a.score || b.depth - a.depth || compareStrings(a.stepId, b.stepId),
    );
    out.set(
      p.ref,
      scored.slice(0, top).map(({ stepId, score }) => ({ stepId, score })),
    );
  }
  return out;
}

/** A shared word stem has at least this many letters (eval/value-chains/README.md, "Tags"). */
export const NAME_STEM_MIN = 4;

/**
 * The words of the README's derived tags: lowercase, ä/ö/ü/ß → ae/oe/ue/ss,
 * split on anything but `a-z`, words of at least {@link NAME_STEM_MIN} letters.
 */
export function stemWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .split(/[^a-z]+/)
    .filter((w) => w.length >= NAME_STEM_MIN);
}

/** The longest leading part (at least 4 letters) of one word that occurs in the other. */
export function sharedStem(a: string, b: string): string | null {
  for (let n = a.length; n >= NAME_STEM_MIN; n -= 1)
    if (b.includes(a.slice(0, n))) return a.slice(0, n);
  for (let n = b.length; n >= NAME_STEM_MIN; n -= 1)
    if (a.includes(b.slice(0, n))) return b.slice(0, n);
  return null;
}

/**
 * The derived `name-match` rule of eval/value-chains/README.md, exactly as
 * its validator applies it: a word stem of the process name or of its model
 * key (folders included) that occurs in the step's name and in no sibling
 * step's name. Returns the stem, or `null` (`semantic`). A matching `link`
 * does not count.
 *
 * @param siblings the other steps with the same parent (top-level steps for a top-level step)
 */
export function sharesNameStem(
  process: { name: string | null; modelKey: string },
  step: { name: string },
  siblings: readonly { name: string }[],
): string | null {
  const processWords = [...stemWords(process.name ?? ''), ...stemWords(process.modelKey)];
  const stepWords = stemWords(step.name);
  const siblingWords = siblings.map((s) => stemWords(s.name));
  for (const p of processWords) {
    for (const w of stepWords) {
      const stem = sharedStem(p, w);
      if (stem && !siblingWords.some((words) => words.some((x) => x.includes(stem)))) return stem;
    }
  }
  return null;
}

/** A value chain step as the rule tier sees it. */
export interface RuleStep {
  id: string;
  /** `normalizeKey` of the step's name (the server's `name_norm`). */
  nameNorm: string;
  /** The step's `link`, or `null`. */
  link: string | null;
}

/** A process as the rule tier sees it: a `process` fact. */
export interface RuleProcess {
  /** `<model_key>#<process_id>`. */
  ref: string;
  /** The fact's label: the process name, else the pool name, else empty. */
  label: string;
}

/** One key-tier placement the rules derive. */
export interface PlacementRuleMatch {
  stepId: string;
  processRef: string;
  /** The step's `link` is `proa:process/<processRef>`. */
  byLink: boolean;
  /** The step's normalized name equals the process's. */
  byName: boolean;
  /** The step's normalized name (the rationale names it). */
  nameNorm: string;
}

/**
 * The rule tier's key placements (M4 §2 "Tiers", S2): a step whose `link` is
 * {@link PROA_PROCESS_LINK_PREFIX} followed by the ref of a known process, or
 * whose non-empty `nameNorm` equals `normalizeKey(label)` of one or more
 * processes, yields one match per (step, process), with both reasons when
 * both hold. A link naming no known process, a malformed link and an empty
 * name yield nothing; a pasted step keeps its link, so a duplicated link
 * yields one match per step. Order: step id, then process ref, in code point
 * order. Pure; the server adds rationale and evidence, `eval:placements`
 * gates the result against the golden placements.
 */
export function derivePlacementRules(
  steps: readonly RuleStep[],
  processes: readonly RuleProcess[],
): PlacementRuleMatch[] {
  const known = new Set<string>();
  const byName = new Map<string, string[]>();
  for (const p of processes) {
    known.add(p.ref);
    const norm = normalizeKey(p.label);
    if (norm === '') continue;
    byName.set(norm, [...(byName.get(norm) ?? []), p.ref]);
  }
  const out: PlacementRuleMatch[] = [];
  for (const step of [...steps].sort((a, b) => compareStrings(a.id, b.id))) {
    const linked =
      step.link?.startsWith(PROA_PROCESS_LINK_PREFIX) === true
        ? step.link.slice(PROA_PROCESS_LINK_PREFIX.length)
        : null;
    const named = step.nameNorm === '' ? [] : (byName.get(step.nameNorm) ?? []);
    const refs = new Set<string>(named);
    if (linked !== null && known.has(linked)) refs.add(linked);
    for (const ref of [...refs].sort(compareStrings)) {
      out.push({
        stepId: step.id,
        processRef: ref,
        byLink: ref === linked,
        byName: named.includes(ref),
        nameNorm: step.nameNorm,
      });
    }
  }
  return out;
}
