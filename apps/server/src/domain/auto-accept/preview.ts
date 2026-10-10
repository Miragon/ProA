/**
 * Auto-accept rules (owner decision 19), pure part: what a rule would accept
 * now among the open proposals (the preview's "open now" and the "apply"
 * action, which evaluate the same way), and what it would have accepted in
 * the project's history so far, with the humans' verdicts on those items (an
 * empirical precision) and a curve over minimum confidences.
 *
 * The history replay walks each subject's assertions in seq order: a rule
 * "would have fired" at an agent proposal made before any human assertion on
 * the item (for placements: on any placement of the process) that matches
 * its criteria and passes the safeguards as of that proposal (status,
 * question, no-link liveness by seq, competing calls or steps from the other
 * subjects' history prefixes). It also applies what the rule's own earlier
 * firing would have done: a call it fired on stays accepted (until a human
 * decides it), so a later call from the same element never fires; a process
 * it fired on has a home step and a human assertion, so nothing else of the
 * process fires. Pipeline proposals count as current when made, and endpoint
 * changes in between are not reconstructed; the placements' other-agent-unsure
 * safeguard cannot be rebuilt either (`placement_input` is mutable memory):
 * documented approximations. The outcome is the first human decision that no
 * rule recorded; without one, an item counts as corrected when a human
 * accepted a competitor of it (another target of its call element, another
 * step of its process); acceptances an auto-accept rule recorded and nobody
 * reviewed are no ground truth and are counted apart.
 */
import {
  AUTO_ACCEPT_BLOCK_REASONS,
  AUTO_ACCEPT_CURVE,
  type AutoAcceptBlockReason,
  type AutoAcceptBlockedCount,
  type AutoAcceptCurvePoint,
  type AutoAcceptItem,
  type AutoAcceptPreviewHistory,
  type DeclaredProcedure,
  type PrincipalId,
} from '@proa/contracts';

import { isCurrent } from '../judgements.ts';
import type {
  NoLinkHistoryRecord,
  PlacementRecord,
  RelationRecord,
  StoredAssertion,
  StoredPlacementAssertion,
} from '../ports.ts';
import { naturalKey } from '../relation-state.ts';
import { currentStances, recomputeStatus, sameProcedure, type StanceView } from '../status.ts';
import { recomputePlacementStatus } from '../value-chain/placement-state.ts';
import { OUTSIDE } from '../value-chain/steps.ts';
import {
  evaluatePlacementAutoAccept,
  evaluateRelationAutoAccept,
  ruleMatches,
  triggerOf,
  type AutoAcceptRuleRev,
  type AutoAcceptVerdict,
  type HistoryView,
} from './evaluate.ts';

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isAgentProposal = (a: StanceView) => a.sourceKind === 'agent' && a.kind === 'proposal';
const marked = (a: StanceView) => (a.autoAcceptRuleId ?? null) !== null;
const asks = (a: HistoryView) => a.question !== null && a.question.trim() !== '';
const CALL_TAKEN: ReadonlySet<string> = new Set(['proposed', 'held', 'accepted']);

/** The relation side of a project as the preview and "apply" read it. */
export interface RelationSide {
  relations: readonly Pick<
    RelationRecord,
    'id' | 'type' | 'fromRef' | 'toRef' | 'status' | 'endpointState'
  >[];
  histories: ReadonlyMap<string, readonly StoredAssertion[]>;
  /** Every no-link of the project, withdrawn ones included. */
  noLinks: readonly NoLinkHistoryRecord[];
  /** Head `facts_hash` per model key. */
  heads: ReadonlyMap<string, string>;
  /** The procedure relations claims name. */
  procedure: DeclaredProcedure;
}

/** The placement side of a project's chain as the preview and "apply" read it. */
export interface PlacementSide {
  valueChainKey: string;
  /** Every placement of the chain. */
  placements: readonly PlacementRecord[];
  histories: ReadonlyMap<string, readonly StoredPlacementAssertion[]>;
  /** Every step generation (tombstones included). */
  steps: readonly { elementId: string; generation: number; deletedSeq: number | null }[];
  live: ReadonlyMap<string, number>;
  /** The `placement_input` rows by process. */
  rows: ReadonlyMap<string, { principalId: PrincipalId; outcome: string; inputHash: string }>;
  hashOf(processRef: string): string;
  chainDigest: string;
  processDigests: ReadonlyMap<string, string>;
  /** The procedure placement claims name. */
  procedure: DeclaredProcedure;
}

/** An open proposal a rule accepts now, with the proposal that meets it. */
export interface OpenRelation {
  relation: RelationSide['relations'][number];
  trigger: StoredAssertion;
  rule: AutoAcceptRuleRev;
}

export interface OpenPlacement {
  placement: PlacementRecord;
  trigger: StoredPlacementAssertion;
  rule: AutoAcceptRuleRev;
}

/** What a rule would do among the open proposals. */
export interface OpenOutcome<T> {
  accept: T[];
  /** Open proposals that meet the criteria but a safeguard blocks, per reason. */
  blocked: Map<AutoAcceptBlockReason, number>;
}

/** The criteria of a rule regardless of its minimum confidence (the curve varies it). */
function criteriaWithout(rule: AutoAcceptRuleRev): AutoAcceptRuleRev {
  return { ...rule, minConfidence: 0, enabled: true, authorIsOwner: true };
}

/**
 * The live agent proposal of a subject that would trigger the rule: among
 * those matching its criteria, the current ones first, then the highest
 * confidence, then the earliest.
 */
function pickTrigger<A extends StoredAssertion | StoredPlacementAssertion>(
  history: readonly A[],
  rule: AutoAcceptRuleRev,
  subject: { kind: 'relation' | 'placement'; relationType?: string },
  isCurrentProposal: (a: A) => boolean,
): { trigger: A; current: boolean } | null {
  const matching = currentStances(history)
    .filter(isAgentProposal)
    .filter((a) => ruleMatches(rule, triggerOf(a, true), subject))
    .map((a) => ({ trigger: a, current: isCurrentProposal(a) }))
    .sort(
      (x, y) =>
        Number(y.current) - Number(x.current) ||
        (y.trigger.confidence ?? 0) - (x.trigger.confidence ?? 0) ||
        x.trigger.seq - y.trigger.seq,
    );
  return matching[0] ?? null;
}

function count(blocked: Map<AutoAcceptBlockReason, number>, verdict: AutoAcceptVerdict): void {
  if (!verdict.accept) blocked.set(verdict.reason, (blocked.get(verdict.reason) ?? 0) + 1);
}

/** Live no-links per typed pair (any principal, current or stale). */
function liveNoLinkCounts(noLinks: readonly NoLinkHistoryRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of noLinks) {
    if (n.withdrawnSeq !== null) continue;
    const key = naturalKey(n.type, n.fromRef, n.toRef);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * What a relation rule would accept now: each proposed relation with a live
 * agent proposal meeting the rule's criteria, evaluated with every
 * safeguard ("apply" records exactly these). In natural key order.
 */
export function openRelationCandidates(
  side: RelationSide,
  rule: AutoAcceptRuleRev,
): OpenOutcome<OpenRelation> {
  const noLinks = liveNoLinkCounts(side.noLinks);
  const callsFrom = new Map<string, { id: string; status: string }[]>();
  for (const r of side.relations) {
    if (r.type !== 'call') continue;
    callsFrom.set(r.fromRef, [...(callsFrom.get(r.fromRef) ?? []), r]);
  }
  const accept: OpenRelation[] = [];
  const blocked = new Map<AutoAcceptBlockReason, number>();
  const ordered = [...side.relations]
    .filter((r) => r.status === 'proposed' && r.type !== 'manual')
    .sort(
      (a, b) =>
        byCodePoint(a.type, b.type) ||
        byCodePoint(a.fromRef, b.fromRef) ||
        byCodePoint(a.toRef, b.toRef),
    );
  for (const relation of ordered) {
    const history = side.histories.get(relation.id) ?? [];
    const picked = pickTrigger(
      history,
      rule,
      { kind: 'relation', relationType: relation.type },
      (a) =>
        a.submissionId === null ||
        isCurrent(
          { from: relation.fromRef, to: relation.toRef, fromHash: a.fromHash, toHash: a.toHash },
          a.declared?.procedure ?? null,
          side.heads,
          side.procedure,
        ),
    );
    if (!picked) continue;
    const verdict = evaluateRelationAutoAccept({
      relation,
      history,
      trigger: triggerOf(picked.trigger, picked.current),
      liveNoLinks: noLinks.get(naturalKey(relation.type, relation.fromRef, relation.toRef)) ?? 0,
      competingCall: (callsFrom.get(relation.fromRef) ?? []).some(
        (r) => r.id !== relation.id && CALL_TAKEN.has(r.status),
      ),
      rules: [rule],
    });
    if (verdict.accept) accept.push({ relation, trigger: picked.trigger, rule: verdict.rule });
    else count(blocked, verdict);
  }
  return { accept, blocked };
}

/**
 * What a placement rule would accept now: each proposed placement with a
 * live agent proposal meeting the rule's criteria, evaluated with every
 * safeguard. In natural key order.
 */
export function openPlacementCandidates(
  side: PlacementSide,
  rule: AutoAcceptRuleRev,
): OpenOutcome<OpenPlacement> {
  const byProcess = new Map<string, PlacementRecord[]>();
  for (const p of side.placements) {
    byProcess.set(p.processRef, [...(byProcess.get(p.processRef) ?? []), p]);
  }
  const accept: OpenPlacement[] = [];
  const blocked = new Map<AutoAcceptBlockReason, number>();
  const ordered = [...side.placements]
    .filter((p) => p.status === 'proposed')
    .sort(
      (a, b) =>
        byCodePoint(a.elementId, b.elementId) ||
        a.generation - b.generation ||
        byCodePoint(a.processRef, b.processRef),
    );
  for (const placement of ordered) {
    const history = side.histories.get(placement.id) ?? [];
    const picked = pickTrigger(
      history,
      rule,
      { kind: 'placement' },
      (a) =>
        a.submissionId === null ||
        (a.stepHash === side.chainDigest &&
          a.processHash === side.processDigests.get(placement.processRef) &&
          sameProcedure(a.declared?.procedure ?? null, side.procedure)),
    );
    if (!picked) continue;
    const row = side.rows.get(placement.processRef);
    const verdict = evaluatePlacementAutoAccept({
      placement,
      stepLive: side.live.get(placement.elementId) === placement.generation,
      processPlacements: (byProcess.get(placement.processRef) ?? []).map((p) => ({
        placement: p,
        history: side.histories.get(p.id) ?? [],
      })),
      trigger: triggerOf(picked.trigger, picked.current),
      priorVerdict: row
        ? {
            principalId: row.principalId,
            outcome: row.outcome,
            current: row.inputHash === side.hashOf(placement.processRef),
          }
        : null,
      rules: [rule],
    });
    if (verdict.accept) accept.push({ placement, trigger: picked.trigger, rule: verdict.rule });
    else count(blocked, verdict);
  }
  return { accept, blocked };
}

/** Blocked counts in the order of `AUTO_ACCEPT_BLOCK_REASONS`. */
export function blockedCounts(
  blocked: ReadonlyMap<AutoAcceptBlockReason, number>,
): AutoAcceptBlockedCount[] {
  return AUTO_ACCEPT_BLOCK_REASONS.flatMap((reason) => {
    const n = blocked.get(reason) ?? 0;
    return n > 0 ? [{ reason, count: n }] : [];
  });
}

/** An open relation as the API lists it. */
export function relationItem(o: OpenRelation): AutoAcceptItem {
  const { relation, trigger } = o;
  return {
    kind: 'relation',
    id: relation.id,
    status: relation.status,
    endpointState: relation.endpointState,
    type: relation.type === 'manual' ? null : relation.type,
    from: relation.fromRef,
    to: relation.toRef,
    valueChainKey: null,
    step: null,
    process: null,
    triggerId: trigger.id,
    agent: { principalId: trigger.principalId, handle: trigger.handle },
    llmModel: trigger.declared?.llmModel ?? null,
    tier: trigger.tier ?? 'semantic',
    confidence: trigger.confidence ?? 0,
  };
}

/** An open placement as the API lists it. */
export function placementItem(valueChainKey: string, o: OpenPlacement): AutoAcceptItem {
  const { placement, trigger } = o;
  return {
    kind: 'placement',
    id: placement.id,
    status: placement.status,
    endpointState: placement.endpointState,
    type: null,
    from: null,
    to: null,
    valueChainKey,
    step: placement.elementId,
    process: placement.processRef,
    triggerId: trigger.id,
    agent: { principalId: trigger.principalId, handle: trigger.handle },
    llmModel: trigger.declared?.llmModel ?? null,
    tier: trigger.tier ?? 'semantic',
    confidence: trigger.confidence ?? 0,
  };
}

/** The outcome of an item the rule would have fired on. */
type Outcome = 'accepted' | 'rejected' | 'corrected' | 'held' | 'autoUnreviewed' | 'undecided';

/** One subject of the history replay. */
interface Replayed {
  /** Whether the rule at this minimum confidence would have fired on the subject. */
  fires(minConfidence: number): boolean;
  /** A human decided the item after an agent proposal (the denominator). */
  decided: boolean;
  outcome: Outcome;
}

type HistoryEntry = StanceView & { linked: string | null };

const isHumanDecision = (a: StanceView) =>
  a.kind === 'decision' && a.sourceKind === 'human' && !marked(a);

/**
 * The outcome of a subject: the first human decision no rule recorded. Without
 * one, a subject counts as corrected when a human accepted a competitor of it
 * after its first agent proposal (another target of the same call element,
 * another step of the same process: there is room for one), else as
 * unreviewed (only a rule decided it) or undecided.
 *
 * @param competitors the histories of the subject's competitors, sorted by seq
 */
function outcomeOf(
  history: readonly HistoryEntry[],
  competitors: readonly (readonly StanceView[])[] = [],
): Pick<Replayed, 'decided' | 'outcome'> {
  const decision = history.find(isHumanDecision);
  const firstProposal = history.find(isAgentProposal)?.seq;
  const decided =
    decision !== undefined && firstProposal !== undefined && firstProposal < decision.seq;
  if (!decision?.verdict) {
    const chosenElsewhere =
      decision === undefined &&
      firstProposal !== undefined &&
      competitors.some((c) =>
        c.some((a) => isHumanDecision(a) && a.verdict === 'accept' && a.seq > firstProposal),
      );
    if (chosenElsewhere) return { decided: true, outcome: 'corrected' };
    return {
      decided,
      outcome: history.some((a) => a.kind === 'decision' && marked(a))
        ? 'autoUnreviewed'
        : 'undecided',
    };
  }
  const outcome: Outcome =
    decision.verdict === 'accept'
      ? 'accepted'
      : decision.verdict === 'hold'
        ? 'held'
        : decision.linked !== null
          ? 'corrected'
          : 'rejected';
  return { decided, outcome };
}

const sortedBySeq = <T extends { seq: number }>(xs: readonly T[]): T[] =>
  [...xs].sort((a, b) => a.seq - b.seq);
const upTo = <T extends { seq: number }>(xs: readonly T[], seq: number): T[] =>
  xs.filter((a) => a.seq <= seq);

/** A proposal the rule (at any minimum confidence) could fire on, by the subject's own checks. */
interface Candidate {
  id: string;
  seq: number;
  confidence: number;
}

/** Fires at `t` when some candidate reaches it (a subject without competitors). */
const firesAlone =
  (candidates: readonly Candidate[]) =>
  (t: number): boolean =>
    candidates.some((c) => c.confidence >= t);

/**
 * The relation history replay per relation of the rule's type. A call shares
 * its element with the other calls from it: once the rule fires on one, that
 * call is accepted from then on (until a human decides it), so a later call
 * from the same element is a competing call and the rule never fires on it.
 * Calls with competitors are therefore replayed together, per minimum
 * confidence, in seq order.
 */
function replayRelations(
  side: RelationSide,
  rule: AutoAcceptRuleRev,
  thresholds: readonly number[],
): Replayed[] {
  const criteria = criteriaWithout(rule);
  const histories = new Map<string, StoredAssertion[]>();
  for (const r of side.relations) histories.set(r.id, sortedBySeq(side.histories.get(r.id) ?? []));
  const callsFrom = new Map<string, string[]>();
  for (const r of side.relations) {
    if (r.type === 'call') callsFrom.set(r.fromRef, [...(callsFrom.get(r.fromRef) ?? []), r.id]);
  }
  const noLinksOf = new Map<string, NoLinkHistoryRecord[]>();
  for (const n of side.noLinks) {
    const key = naturalKey(n.type, n.fromRef, n.toRef);
    noLinksOf.set(key, [...(noLinksOf.get(key) ?? []), n]);
  }
  const takenInReality = (id: string, seq: number): boolean =>
    CALL_TAKEN.has(recomputeStatus(upTo(histories.get(id) ?? [], seq)).status);

  // 1. Per relation, the proposals that pass its own checks (and real competing calls).
  const replayed = side.relations.filter(
    (r) => r.type !== 'manual' && (rule.relationType === null || r.type === rule.relationType),
  );
  const candidatesOf = new Map<string, Candidate[]>();
  for (const relation of replayed) {
    const history = histories.get(relation.id) ?? [];
    const firstHuman = history.find((a) => a.sourceKind === 'human')?.seq ?? Infinity;
    const key = naturalKey(relation.type, relation.fromRef, relation.toRef);
    const others = (relation.type === 'call' ? (callsFrom.get(relation.fromRef) ?? []) : []).filter(
      (id) => id !== relation.id,
    );
    const candidates: Candidate[] = [];
    for (const p of history) {
      if (p.seq >= firstHuman) break;
      if (!isAgentProposal(p)) continue;
      if (
        !ruleMatches(criteria, triggerOf(p, true), {
          kind: 'relation',
          relationType: relation.type,
        })
      ) {
        continue;
      }
      const prefix = upTo(history, p.seq);
      if (recomputeStatus(prefix).status !== 'proposed') continue;
      if (others.some((id) => takenInReality(id, p.seq))) continue;
      if (currentStances(prefix).filter(isAgentProposal).some(asks)) continue;
      if (
        (noLinksOf.get(key) ?? []).some(
          (n) => n.seq <= p.seq && (n.withdrawnSeq === null || n.withdrawnSeq > p.seq),
        )
      ) {
        continue;
      }
      candidates.push({ id: relation.id, seq: p.seq, confidence: p.confidence ?? 0 });
    }
    candidatesOf.set(relation.id, candidates);
  }

  // 2. Calls with competitors, per minimum confidence: what the rule's own firing blocks.
  const firedAt = new Map<number, Set<string>>();
  for (const t of thresholds) {
    const fired = new Set<string>();
    for (const ids of callsFrom.values()) {
      if (ids.length < 2) continue;
      const firing = new Map<string, number>();
      const events = ids
        .flatMap((id) => (candidatesOf.get(id) ?? []).filter((c) => c.confidence >= t))
        .sort((a, b) => a.seq - b.seq);
      const takenAt = (id: string, seq: number): boolean => {
        const f = firing.get(id);
        if (f !== undefined && f < seq) {
          const decidedSince = (histories.get(id) ?? []).some(
            (a) => isHumanDecision(a) && a.seq > f && a.seq <= seq,
          );
          if (!decidedSince) return true;
        }
        return takenInReality(id, seq);
      };
      for (const c of events) {
        if (firing.has(c.id)) continue;
        if (ids.some((id) => id !== c.id && takenAt(id, c.seq))) continue;
        firing.set(c.id, c.seq);
      }
      for (const id of firing.keys()) fired.add(id);
    }
    firedAt.set(t, fired);
  }

  return replayed.map((relation) => {
    const history = histories.get(relation.id) ?? [];
    const competitors =
      relation.type === 'call'
        ? (callsFrom.get(relation.fromRef) ?? [])
            .filter((id) => id !== relation.id)
            .map((id) => histories.get(id) ?? [])
        : [];
    const candidates = candidatesOf.get(relation.id) ?? [];
    return {
      fires:
        competitors.length === 0
          ? firesAlone(candidates)
          : (t: number) => firedAt.get(t)?.has(relation.id) ?? firesAlone(candidates)(t),
      ...outcomeOf(
        history.map((a) => ({ ...a, linked: a.linkedRelationId })),
        competitors,
      ),
    };
  });
}

/**
 * The placement history replay per placement. Once the rule fires on one
 * placement of a process, the process has a human assertion (the rule's
 * decision) and a home step, so the rule fires on nothing else of it: per
 * process and minimum confidence, only the earliest candidate fires.
 */
function replayPlacements(side: PlacementSide, rule: AutoAcceptRuleRev): Replayed[] {
  const criteria = criteriaWithout(rule);
  const histories = new Map<string, StoredPlacementAssertion[]>();
  for (const p of side.placements) histories.set(p.id, sortedBySeq(side.histories.get(p.id) ?? []));
  const byProcess = new Map<string, PlacementRecord[]>();
  for (const p of side.placements) {
    byProcess.set(p.processRef, [...(byProcess.get(p.processRef) ?? []), p]);
  }
  const tombstones = new Map<string, number | null>();
  for (const s of side.steps) tombstones.set(`${s.elementId}\u0000${s.generation}`, s.deletedSeq);

  // 1. Per process, the proposals that pass the subject's and the process's own checks.
  const candidatesOf = new Map<string, Candidate[]>();
  for (const [processRef, process] of byProcess) {
    const firstHuman = Math.min(
      ...process.map(
        (q) => (histories.get(q.id) ?? []).find((a) => a.sourceKind === 'human')?.seq ?? Infinity,
      ),
    );
    const candidates: Candidate[] = [];
    for (const placement of process) {
      const history = histories.get(placement.id) ?? [];
      const deletedSeq =
        tombstones.get(`${placement.elementId}\u0000${placement.generation}`) ?? null;
      for (const p of history) {
        if (p.seq >= firstHuman) break;
        if (!isAgentProposal(p) || placement.elementId === OUTSIDE) continue;
        if (!ruleMatches(criteria, triggerOf(p, true), { kind: 'placement' })) continue;
        if (deletedSeq !== null && deletedSeq <= p.seq) continue;
        if (recomputePlacementStatus(upTo(history, p.seq)).status !== 'proposed') continue;
        let ok = true;
        for (const q of process) {
          const prefix = upTo(histories.get(q.id) ?? [], p.seq);
          if (q.id !== placement.id) {
            const status = recomputePlacementStatus(prefix).status;
            const elsewhere =
              q.elementId !== placement.elementId || q.generation !== placement.generation;
            if (
              status === 'accepted' ||
              status === 'held' ||
              (elsewhere && currentStances(prefix).some((a) => a.kind === 'proposal'))
            ) {
              ok = false;
              break;
            }
          }
          if (currentStances(prefix).filter(isAgentProposal).some(asks)) {
            ok = false;
            break;
          }
        }
        if (ok) candidates.push({ id: placement.id, seq: p.seq, confidence: p.confidence ?? 0 });
      }
    }
    candidatesOf.set(
      processRef,
      candidates.sort((a, b) => a.seq - b.seq),
    );
  }

  return side.placements.map((placement) => {
    const candidates = candidatesOf.get(placement.processRef) ?? [];
    const competitors = (byProcess.get(placement.processRef) ?? [])
      .filter((q) => q.elementId !== placement.elementId || q.generation !== placement.generation)
      .map((q) => histories.get(q.id) ?? []);
    return {
      // The earliest candidate of the process at this minimum confidence fires, no other.
      fires: (t: number) => candidates.find((c) => c.confidence >= t)?.id === placement.id,
      ...outcomeOf(
        (histories.get(placement.id) ?? []).map((a) => ({ ...a, linked: a.linkedPlacementId })),
        competitors,
      ),
    };
  });
}

const precisionOf = (accepted: number, rejected: number, corrected: number): number | null =>
  accepted + rejected + corrected === 0 ? null : accepted / (accepted + rejected + corrected);

/** The history block of a preview at one minimum confidence. */
function historyAt(replayed: readonly Replayed[], minConfidence: number): AutoAcceptPreviewHistory {
  const h = {
    decided: 0,
    wouldAccept: 0,
    accepted: 0,
    rejected: 0,
    corrected: 0,
    held: 0,
    autoUnreviewed: 0,
    undecided: 0,
  };
  for (const r of replayed) {
    if (r.decided) h.decided++;
    if (!r.fires(minConfidence)) continue;
    h[r.outcome]++;
    if (r.outcome !== 'autoUnreviewed' && r.outcome !== 'undecided') h.wouldAccept++;
  }
  return { ...h, precision: precisionOf(h.accepted, h.rejected, h.corrected) };
}

/** The history replay of a rule: its own minimum confidence and the curve. */
export interface HistoryPreview {
  history: AutoAcceptPreviewHistory;
  curve: (Omit<AutoAcceptCurvePoint, 'open'> & { open?: number })[];
}

/** Replays the project's history for a rule (the relation or the placement side). */
export function replayHistory(
  side:
    | { kind: 'relation'; relations: RelationSide }
    | { kind: 'placement'; placements: readonly PlacementSide[] },
  rule: AutoAcceptRuleRev,
): HistoryPreview {
  const thresholds = [...new Set([rule.minConfidence, ...AUTO_ACCEPT_CURVE])];
  const replayed =
    side.kind === 'relation'
      ? replayRelations(side.relations, rule, thresholds)
      : side.placements.flatMap((chain) => replayPlacements(chain, rule));
  return {
    history: historyAt(replayed, rule.minConfidence),
    curve: AUTO_ACCEPT_CURVE.map((minConfidence) => {
      const h = historyAt(replayed, minConfidence);
      return {
        minConfidence,
        wouldAccept: h.wouldAccept,
        accepted: h.accepted,
        rejected: h.rejected,
        corrected: h.corrected,
        held: h.held,
        precision: h.precision,
      };
    }),
  };
}
