/**
 * Judge each pair once (procedure `proa-relations@0.2.0`, CONCEPT §3): the
 * agent judgements on a typed pair, their basis and currency, and who judges
 * a candidate or relation pair at a claim. Pure: the use cases pass the live
 * data in.
 *
 * An agent judgement is a live pipeline proposal stance (a proposal from a
 * submission) or a live no-link. Its basis is the `facts_hash` of both
 * endpoint models as the judging agent saw them plus the declared procedure;
 * it is current while both hashes equal the heads and the procedure is the
 * one claims name now.
 */
import {
  parseRef,
  type Candidate,
  type CandidateBasis,
  type ClaimSkip,
  type DeclaredProcedure,
  type PrincipalId,
  type Ref,
  type RelationId,
  type TypedPair,
} from '@proa/contracts';

import type { AssertionRecord, RelationRecord, StoredAssertion, StoredNoLink } from './ports.ts';
import { naturalKey } from './relation-state.ts';
import { currentStances, sameProcedure } from './status.ts';

export type LinkType = TypedPair['type'];

/** `type\0from\0to` of a typed pair (the natural key of its relation). */
export const pairKey = (p: { type: string; from: string; to: string }): string =>
  naturalKey(p.type as LinkType, p.from, p.to);

/** Deterministic, never `localeCompare`. */
const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** One agent judgement on a typed pair. */
export interface Judgement {
  kind: 'link' | 'no-link';
  /** The assertion or no-link id. */
  id: string;
  /** The relation of a link verdict. */
  relationId: RelationId | null;
  type: LinkType;
  from: Ref;
  to: Ref;
  /** Key of the analysed model whose submission made it. */
  origin: string;
  principalId: PrincipalId;
  handle: string;
  /** A no-link's reason. */
  reason: string | null;
  fromHash: string | null;
  toHash: string | null;
  procedure: DeclaredProcedure | null;
  current: boolean;
}

/** The model key of a ref. */
export const modelOf = (ref: string): string => parseRef(ref).modelKey;

/**
 * Current: both basis hashes equal the head `facts_hash` of their model (a
 * deleted model has no head) and the procedure is the one claims name.
 */
export function isCurrent(
  j: { from: string; to: string; fromHash: string | null; toHash: string | null },
  declared: DeclaredProcedure | null,
  heads: ReadonlyMap<string, string>,
  procedure: DeclaredProcedure,
): boolean {
  return (
    j.fromHash !== null &&
    j.toHash !== null &&
    heads.get(modelOf(j.from)) === j.fromHash &&
    heads.get(modelOf(j.to)) === j.toHash &&
    sameProcedure(declared, procedure)
  );
}

/**
 * Stale on the side of `modelKey`: a judgement touching the model whose
 * hash on that side (both sides for an intra-model pair) differs from
 * `factsHash` or is missing, or that was made under another procedure.
 */
export function staleFor(
  modelKey: string,
  factsHash: string,
  procedure: DeclaredProcedure,
  j: {
    from: string;
    to: string;
    fromHash: string | null;
    toHash: string | null;
    procedure: DeclaredProcedure | null;
  },
): boolean {
  const fromSide = modelOf(j.from) === modelKey;
  const toSide = modelOf(j.to) === modelKey;
  if (!fromSide && !toSide) return false;
  if (!sameProcedure(j.procedure, procedure)) return true;
  return (fromSide && j.fromHash !== factsHash) || (toSide && j.toHash !== factsHash);
}

/** The live pipeline proposals (from earlier submissions) of a relation, one per principal. */
export function livePipelineProposals<T extends AssertionRecord>(history: readonly T[]): T[] {
  return currentStances(history).filter((a) => a.kind === 'proposal' && a.submissionId !== null);
}

/**
 * The link judgements on `relations`: their live pipeline proposals, with
 * the origin (the analysed model of the submission) and currency.
 */
export function linkJudgements(
  relations: readonly RelationRecord[],
  histories: ReadonlyMap<string, readonly StoredAssertion[]>,
  origins: ReadonlyMap<string, string>,
  heads: ReadonlyMap<string, string>,
  procedure: DeclaredProcedure,
): Judgement[] {
  const out: Judgement[] = [];
  for (const r of relations) {
    if (r.type === 'manual') continue;
    for (const a of livePipelineProposals(histories.get(r.id) ?? [])) {
      const declared = a.declared?.procedure ?? null;
      out.push({
        kind: 'link',
        id: a.id,
        relationId: r.id,
        type: r.type,
        from: r.fromRef,
        to: r.toRef,
        origin: (a.submissionId && origins.get(a.submissionId)) ?? '',
        principalId: a.principalId,
        handle: a.handle,
        reason: null,
        fromHash: a.fromHash,
        toHash: a.toHash,
        procedure: declared,
        current: isCurrent(
          { from: r.fromRef, to: r.toRef, fromHash: a.fromHash, toHash: a.toHash },
          declared,
          heads,
          procedure,
        ),
      });
    }
  }
  return out;
}

export function noLinkJudgement(n: StoredNoLink): Judgement {
  return {
    kind: 'no-link',
    id: n.id,
    relationId: null,
    type: n.type,
    from: n.fromRef,
    to: n.toRef,
    origin: n.origin,
    principalId: n.principalId,
    handle: n.handle,
    reason: n.reason,
    fromHash: n.fromHash,
    toHash: n.toHash,
    procedure: n.declared.procedure,
    current: n.current,
  };
}

/** Sorted by pair, then link before no-link, origin, principal and id. */
export function sortJudgements<T extends Judgement>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) =>
      compareStrings(a.from, b.from) ||
      compareStrings(a.to, b.to) ||
      compareStrings(a.type, b.type) ||
      compareStrings(a.kind, b.kind) ||
      compareStrings(a.origin, b.origin) ||
      compareStrings(a.handle, b.handle) ||
      compareStrings(a.id, b.id),
  );
}

/**
 * A pair a decision settles, which the procedure has agents leave alone
 * (CONCEPT §3): an accepted relation (by a human or the rule tier), or a
 * rejected one whose endpoints are unchanged. No claim is assigned it, so
 * `uncovered` lists only what an agent left out. Held pairs and rejections
 * with a changed endpoint are judged again.
 */
export function settles(r: RelationRecord): boolean {
  return r.status === 'accepted' || (r.status === 'rejected' && r.endpointState === 'ok');
}

/**
 * A relation a claim assigns like a systematic candidate, whatever its pair's
 * basis (procedure §4 "your pairs": the relations in neither `judged` nor
 * `skip`): not `manual` (humans made it), not obsolete, not settled
 * ({@link settles}) and with both endpoints in the head (a `missing` end can
 * take neither a proposal nor a no-link).
 */
export function isAssignedRelation(r: RelationRecord): boolean {
  return (
    r.type !== 'manual' && r.status !== 'obsolete' && !settles(r) && r.endpointState !== 'missing'
  );
}

/** The typed pair of a relation ({@link isAssignedRelation} excludes `manual` ones). */
export function relationPair(r: RelationRecord): TypedPair {
  if (r.type === 'manual') throw new Error(`a manual relation is no typed pair: ${r.id}`);
  return { type: r.type, from: r.fromRef, to: r.toRef };
}

/**
 * The candidate bases a claim assigns: the systematic ones (`rule`, `key`,
 * `lexical`; decisions normally settle `rule` pairs). `compatible`
 * candidates are the search space of the partner search: never assigned
 * (unless the pair is an assigned relation, {@link isAssignedRelation}),
 * never counted in `uncovered`; an agent that examines one records a
 * verdict, so partners skip it later.
 */
const ASSIGNED_BASES: ReadonlySet<CandidateBasis> = new Set(['rule', 'key', 'lexical']);

/** A candidate a claim assigns ({@link ASSIGNED_BASES}). */
export const isAssigned = (c: Pick<Candidate, 'basis'>): boolean => ASSIGNED_BASES.has(c.basis);

/** An open task of another model, as a claim sees it. */
export interface PartnerTask {
  state: 'queued' | 'claimed';
  /** Claimed: the lease has not expired. */
  live: boolean;
  /** Claimed: the pair keys its claim must judge. */
  assignment: ReadonlySet<string>;
  /**
   * Claimed: its claim saw the claimant's model as it is now (the
   * claimant's revision at the partner's `claimed_seq` has the head's
   * `facts_hash`), so its judgements will be current.
   */
  sawClaimant: boolean;
}

export interface ClaimPlan {
  /** Every current judgement on a pair touching the model. */
  judged: Judgement[];
  /** Candidate and relation pairs a partner analysis judges. */
  skip: ClaimSkip[];
  /**
   * The pairs this claim must judge: candidates in candidate order, then
   * the assigned relations that are no candidate, sorted by pair.
   */
  assignment: TypedPair[];
}

const comparePairs = (a: TypedPair, b: TypedPair) =>
  compareStrings(a.from, b.from) || compareStrings(a.to, b.to) || compareStrings(a.type, b.type);

/**
 * Who judges each candidate pair and each assigned relation
 * ({@link isAssignedRelation}) of `modelKey` that has no current agent
 * judgement and that no decision settles ({@link settles}; CONCEPT §3
 * "judge each pair once"):
 * 1. the partner model's claimed task with a live lease whose assignment
 *    holds the pair and whose claim saw this model as it is now (`skip`,
 *    `claimed`), whatever the pair's basis here;
 * 2. else, for an assigned pair (a candidate of an assigned basis,
 *    {@link isAssigned}, or an assigned relation), the partner's queued
 *    task, when the partner's key sorts first and the pair is among its
 *    assigned pairs (`skip`, `queued`): it judges the pair at its claim,
 *    where 1 and 3 apply symmetrically;
 * 3. else, for an assigned pair, this claim (the assignment). Intra-model
 *    pairs always go to it.
 *
 * A `compatible` pair that is no assigned relation and that rule 1 does not
 * skip is nobody's assignment: it stays among the candidates as the search
 * space (a basis is per focus model, so the partner may assign the pair at
 * its own claim).
 *
 * @param relations the pairs of the assigned relations touching the model
 * @param judgements the live judgements on pairs touching the model
 * @param settled pair keys of relations a decision settles
 * @param partners open tasks of other models by model key
 * @param partnerCandidates pair keys a partner's claim would assign: the
 *   assigned candidates of `generateCandidates(facts, partner)` and the
 *   assigned relations touching the partner
 */
export function planClaim(src: {
  modelKey: string;
  candidates: readonly Candidate[];
  relations: readonly TypedPair[];
  judgements: readonly Judgement[];
  settled: ReadonlySet<string>;
  partners: ReadonlyMap<string, PartnerTask>;
  partnerCandidates: (modelKey: string) => ReadonlySet<string>;
}): ClaimPlan {
  const judged = sortJudgements(src.judgements.filter((j) => j.current));
  const judgedKeys = new Set(judged.map(pairKey));
  const relationKeys = new Set(src.relations.map(pairKey));
  const seen = new Set<string>();
  const skip: ClaimSkip[] = [];
  const assignment: TypedPair[] = [];
  const plan = (pair: TypedPair, assigned: boolean) => {
    const key = pairKey(pair);
    if (seen.has(key)) return;
    seen.add(key);
    if (judgedKeys.has(key) || src.settled.has(key)) return;
    const fromModel = modelOf(pair.from);
    const partner = fromModel === src.modelKey ? modelOf(pair.to) : fromModel;
    const task = partner === src.modelKey ? undefined : src.partners.get(partner);
    if (task?.state === 'claimed' && task.live && task.sawClaimant && task.assignment.has(key)) {
      skip.push({ ...pair, model: partner, reason: 'claimed' });
    } else if (!assigned) {
      return;
    } else if (
      task?.state === 'queued' &&
      compareStrings(partner, src.modelKey) < 0 &&
      src.partnerCandidates(partner).has(key)
    ) {
      skip.push({ ...pair, model: partner, reason: 'queued' });
    } else {
      assignment.push(pair);
    }
  };
  for (const c of src.candidates) {
    plan({ type: c.type, from: c.from, to: c.to }, isAssigned(c) || relationKeys.has(pairKey(c)));
  }
  for (const r of [...src.relations].sort(comparePairs)) {
    plan({ type: r.type, from: r.from, to: r.to }, true);
  }
  skip.sort(comparePairs);
  return { judged, skip, assignment };
}
