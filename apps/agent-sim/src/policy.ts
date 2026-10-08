/**
 * The simulation agent's decision policy (`sim-policy-1`): deterministic and
 * LLM-free, a function of the claim input alone (`proa-claim/1`, CONCEPT §3).
 *
 * Every candidate `[type, from, to, basis, score]` gets one verdict:
 *
 * - **skip** when a relation for the pair is already decided: accepted (by
 *   the rule tier or a human), rejected by a human (unless an endpoint
 *   changed since, `endpointState: changed`, which the policy judges again)
 *   or held for clarification;
 * - **propose** when `score ≥ proposeAt` (default 0.65): identical message
 *   or signal names and unique call targets (`key`/`rule`, score 1.0), and
 *   labels that are lexically close;
 * - **ask**, i.e. propose with a question for the reviewer, when
 *   `askAt ≤ score < proposeAt` (default 0.5): the borderline cases, such
 *   as near-miss labels or a call target defined in two models (score 0.5);
 * - **no-link** for `key`, `rule` and `lexical` candidates below `askAt`:
 *   judged and found unrelated, recorded in `noLinks`;
 * - **not judged** for `compatible` candidates below `askAt` (type-compatible
 *   endpoints without lexical evidence; semantic judgement is what an LLM
 *   agent adds). The claim assigns a `compatible` pair only when it is a
 *   relation without a current judgement (in the simulation's runs only
 *   its own proposals, already judged, make such relations), so these never
 *   count as `uncovered`.
 *
 * The verdict depends on the score, never on the basis, so a pair would be
 * judged the same way in the tasks of both its models; since
 * `proa-relations@0.2.0` the server leaves the pairs in `judged` and `skip`
 * out of the candidates (judge each pair once), so only one of them judges
 * it. Confidence is the score rounded to two decimals; the rationale names
 * the basis, the score and both endpoints (label, kind, process, model);
 * evidence is both refs. No-links carry the relation type the pair was
 * judged for (the procedure requires it). The thresholds were set on the
 * dev landscape (`nordwind-handel`) only.
 */
import {
  MAX_QUESTION_CHARS,
  MAX_RATIONALE_CHARS,
  MAX_SUBMISSION_NO_LINKS,
  MAX_SUBMISSION_RELATIONS,
  MAX_SUMMARY_CHARS,
  RELATION_ENDPOINT_KINDS,
  type ClaimCandidate,
  type ClaimInput,
  type ClaimRelation,
  type FactKind,
} from '@proa/contracts';

/** Declared as `llmModel` by the simulation agent: the policy stands in for the model. */
export const SIM_POLICY = 'sim-policy-1';

export interface PolicyOptions {
  /** Propose without a question at or above this score. */
  proposeAt: number;
  /** Propose with a question at or above this score (and below `proposeAt`). */
  askAt: number;
}

export const DEFAULT_POLICY: Readonly<PolicyOptions> = { proposeAt: 0.65, askAt: 0.5 };

export type LinkType = ClaimCandidate[0];

/** A proposed relation, as sent in `submit_analysis`. */
export interface Proposal {
  type: LinkType;
  from: string;
  to: string;
  confidence: number;
  rationale: string;
  evidence: string[];
  question: string | null;
}

/** A typed pair judged unrelated, as sent in `submit_analysis` (`noLinks`). */
export interface NoLink {
  type: LinkType;
  from: string;
  to: string;
  reason: string;
}

export type Verdict =
  'propose' | 'ask' | 'no-link' | 'not-judged' | 'skip-accepted' | 'skip-rejected' | 'skip-held';

export interface Judgement {
  type: LinkType;
  from: string;
  to: string;
  basis: ClaimCandidate[3];
  score: number;
  verdict: Verdict;
}

export interface Decision {
  relations: Proposal[];
  noLinks: NoLink[];
  summary: string;
  /** Every distinct candidate with its verdict, in input order. */
  judgements: Judgement[];
  counts: Record<Verdict, number>;
}

/** What the input says about one endpoint. */
interface EndpointInfo {
  ref: string;
  kind: FactKind;
  eventDef: string | null;
  label: string;
  /** Matching key (message or signal name, `calledElement`, process id) if it differs from the label. */
  key: string | null;
  modelKey: string;
  processName: string | null;
}

const KIND_TEXT: Readonly<Record<FactKind, string>> = {
  process: 'process',
  call: 'call activity',
  msg_throw: 'message throw',
  msg_catch: 'message catch',
  sig_throw: 'signal throw',
  sig_catch: 'signal catch',
  evt_start: 'start event',
  evt_end: 'end event',
  data_store: 'data store',
  message_flow: 'message flow',
  lane: 'lane',
  task: 'task',
};

const pairKey = (type: string, from: string, to: string) => `${type}|${from}|${to}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => n.toFixed(2);

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Lowercase, umlauts transliterated, punctuation and separators collapsed. */
export function normalizeLabel(label: string): string {
  return label
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Looks up endpoints in the model's facts and the partners of the input. */
function endpointIndex(input: ClaimInput) {
  const processNames = new Map(
    input.model.processes.map((p) => [p.processId, p.name ?? p.participantName]),
  );
  const own = new Map<string, EndpointInfo[]>();
  for (const f of input.facts) {
    const list = own.get(f.ref) ?? [];
    list.push({
      ref: f.ref,
      kind: f.kind,
      eventDef: f.eventDef ?? null,
      label: f.label,
      key: f.key ?? null,
      modelKey: input.model.key,
      processName: f.process === undefined ? null : (processNames.get(f.process) ?? null),
    });
    own.set(f.ref, list);
  }
  return (ref: string, kinds: readonly FactKind[] | null): EndpointInfo => {
    const mine = own.get(ref);
    if (mine) return mine.find((e) => kinds === null || kinds.includes(e.kind)) ?? mine[0]!;
    const p = input.partners[ref];
    const modelKey = ref.slice(0, ref.indexOf('#'));
    if (p) {
      return {
        ref,
        kind: p.kind,
        eventDef: p.eventDef ?? null,
        label: p.label,
        key: p.key ?? null,
        modelKey,
        processName: p.processName ?? null,
      };
    }
    // Not described in the input (never happens for candidates): the ref alone.
    const id = ref.slice(ref.indexOf('#') + 1);
    return {
      ref,
      kind: kinds?.[0] ?? 'task',
      eventDef: null,
      label: id,
      key: null,
      modelKey,
      processName: null,
    };
  };
}

function describe(e: EndpointInfo): string {
  const base = KIND_TEXT[e.kind];
  // The event definition only where it adds something: "timer start event", not "message message throw".
  const def =
    e.eventDef && e.eventDef !== 'none' && !base.startsWith(e.eventDef) ? e.eventDef : null;
  const kind = def ? `${def} ${base}` : base;
  const where = e.processName ? `process "${e.processName}" in ${e.modelKey}` : e.modelKey;
  return `"${e.label}" (${kind}, ${where})`;
}

function basisPhrase(
  type: LinkType,
  basis: ClaimCandidate[3],
  score: number,
  from: EndpointInfo,
  to: EndpointInfo,
): string {
  const s = fmt(score);
  if (type === 'call' && (basis === 'key' || basis === 'rule')) {
    if (score >= 1) return `The call target "${from.key ?? from.label}" is the id of this process`;
    if (basis === 'key') {
      return `The call target "${from.key ?? from.label}" is the id of ${Math.round(1 / score)} processes, this one among them (score ${s})`;
    }
    return `The call target matches this process by file stem or name, not by id (rule tier, score ${s})`;
  }
  if (basis === 'key') {
    return `Same ${type} name "${from.key ?? from.label}" on both ends (key tier, score ${s})`;
  }
  if (basis === 'rule') return `Matched by the rule tier (score ${s})`;
  const same = normalizeLabel(from.label) === normalizeLabel(to.label);
  if (basis === 'lexical') {
    return same ? `Identical labels (lexical score ${s})` : `Similar labels (lexical score ${s})`;
  }
  return `Compatible endpoints with little lexical overlap (score ${s})`;
}

function questionFor(type: LinkType, score: number, from: EndpointInfo, to: EndpointInfo): string {
  const s = fmt(score);
  if (type === 'call') {
    return `Is "${to.processName ?? to.label}" (${to.ref}) the process that the call "${from.label}" in ${from.modelKey} starts? The target is not unique (score ${s}).`;
  }
  return `"${from.label}" (${from.modelKey}) and "${to.label}" (${to.modelKey}) are similar (score ${s}) but not the same wording. Do both mean the same business event?`;
}

/**
 * Decides on a claim input: proposals (some with questions), no-links and a
 * summary, ready for `submit_analysis`. Pure and deterministic.
 */
export function decide(input: ClaimInput, options: PolicyOptions = DEFAULT_POLICY): Decision {
  const { proposeAt, askAt } = options;
  if (!(askAt >= 0 && askAt <= proposeAt && proposeAt <= 1)) {
    throw new RangeError(
      `thresholds must satisfy 0 ≤ askAt ≤ proposeAt ≤ 1 (got ${askAt}, ${proposeAt})`,
    );
  }
  const endpoint = endpointIndex(input);
  const existing = new Map<string, ClaimRelation>(
    input.relations.map((r) => [pairKey(r.type, r.from, r.to), r]),
  );
  const counts: Record<Verdict, number> = {
    propose: 0,
    ask: 0,
    'no-link': 0,
    'not-judged': 0,
    'skip-accepted': 0,
    'skip-rejected': 0,
    'skip-held': 0,
  };
  const judgements: Judgement[] = [];
  const relations: Array<Proposal & { score: number }> = [];
  const noLinks: Array<NoLink & { score: number }> = [];
  const seen = new Set<string>();

  for (const [type, from, to, basis, score] of input.candidates) {
    const key = pairKey(type, from, to);
    if (seen.has(key)) continue;
    seen.add(key);
    const rel = existing.get(key);
    let verdict: Verdict;
    if (rel?.status === 'accepted') verdict = 'skip-accepted';
    else if (rel?.status === 'held') verdict = 'skip-held';
    else if (rel?.status === 'rejected' && rel.endpointState !== 'changed')
      verdict = 'skip-rejected';
    else if (score >= proposeAt) verdict = 'propose';
    else if (score >= askAt) verdict = 'ask';
    else verdict = basis === 'compatible' ? 'not-judged' : 'no-link';
    counts[verdict]++;
    judgements.push({ type, from, to, basis, score, verdict });

    if (verdict !== 'propose' && verdict !== 'ask' && verdict !== 'no-link') continue;
    const kinds = RELATION_ENDPOINT_KINDS[type];
    const a = endpoint(from, kinds.from);
    const b = endpoint(to, kinds.to);
    if (verdict === 'no-link') {
      noLinks.push({
        type,
        from,
        to,
        // Short: no-links are numerous (the endpoints are in the refs).
        reason: `Score ${fmt(score)} below ${fmt(askAt)}: "${a.label}" and "${b.label}" share too little.`,
        score,
      });
      continue;
    }
    const parts = [`${basisPhrase(type, basis, score, a, b)}: ${describe(a)} → ${describe(b)}.`];
    if (verdict === 'ask')
      parts.push(`Borderline: below the proposal threshold ${fmt(proposeAt)}.`);
    if (rel?.status === 'rejected') {
      parts.push('An endpoint changed since a reviewer rejected this pair, so it is judged again.');
    }
    relations.push({
      type,
      from,
      to,
      confidence: round2(score),
      rationale: clip(parts.join(' '), MAX_RATIONALE_CHARS),
      evidence: [from, to],
      question: verdict === 'ask' ? clip(questionFor(type, score, a, b), MAX_QUESTION_CHARS) : null,
      score,
    });
  }

  const byScore = (
    x: { score: number; type: string; from: string; to: string },
    y: { score: number; type: string; from: string; to: string },
  ) =>
    y.score - x.score || compare(x.type, y.type) || compare(x.from, y.from) || compare(x.to, y.to);
  relations.sort(byScore);
  noLinks.sort(byScore);
  const kept = relations.slice(0, MAX_SUBMISSION_RELATIONS);
  const keptNoLinks = noLinks.slice(0, MAX_SUBMISSION_NO_LINKS);
  const skipped = counts['skip-accepted'] + counts['skip-rejected'] + counts['skip-held'];
  const summary = clip(
    `${SIM_POLICY} (propose at ≥ ${fmt(proposeAt)}, ask at ≥ ${fmt(askAt)}): ` +
      `${kept.length} proposed, ${kept.filter((r) => r.question !== null).length} of them with a question; ` +
      `${keptNoLinks.length} no-links; ${skipped} skipped (accepted, rejected or held); ` +
      `${counts['not-judged']} compatible candidates not judged.`,
    MAX_SUMMARY_CHARS,
  );
  return {
    relations: kept.map(({ score: _score, ...p }) => p),
    noLinks: keptNoLinks.map(({ score: _score, ...n }) => n),
    summary,
    judgements,
    counts,
  };
}
