/**
 * The `placement` pipeline kind (M4 §3.2), pure part: judge each process
 * once. A process's input hash covers what a placement claim shows of it and
 * an agent judges it on, and nothing the claim does not show; a placement
 * task offers an open process only while that hash differs from the agent's
 * last verdict (`placement_input`), so the same input is never judged twice.
 * Agent assertions are no part of the hash, so the pipeline never
 * re-triggers itself; the human decisions and notes and the rule tier's
 * proposals the claim shows, the chain's steps as the claim lists them and
 * their generations, the process's own fields and its accepted neighbours'
 * steps are.
 *
 * Also here: which processes are open and due, which of them fit one claim,
 * the claim input, and which pipeline proposals a submission supersedes.
 */
import { createHash } from 'node:crypto';

import { normalizeKey } from '@proa/bpmn-facts';
import {
  CLAIM_PLACEMENT_EXAMPLES,
  CLAIM_PLACEMENT_FORMAT,
  CLAIM_PLACEMENT_MAX_BYTES,
  CLAIM_PLACEMENT_NEIGHBOURS,
  CLAIM_PLACEMENT_NOTE_CHARS,
  CLAIM_PLACEMENT_RATIONALE_CHARS,
  CLAIM_PLACEMENT_VIA,
  MAX_CLAIM_PLACEMENT_PROCESSES,
  type ClaimPlacementDecision,
  type ClaimPlacementProcess,
  type ClaimPlacementProposal,
  type ClaimPlacementStep,
  type DeclaredProcedure,
  type PlacementClaimInput,
  type PlacementId,
  type PrincipalId,
  type Ref,
  type UnplacedProcess,
} from '@proa/contracts';

import type {
  PlacementAssertionRecord,
  PlacementRecord,
  StoredPlacementAssertion,
  StoredPlacementInput,
  ValueChainRecord,
  ValueChainRevisionRecord,
} from '../ports.ts';
import { jsonBytes } from '../payload.ts';
import { currentStances, decisionsInForce, sameProcedure } from '../status.ts';
import { processHomes } from './findings.ts';
import { linkTarget, type ChainStructure } from './structure.ts';
import type { ProcessOwnFields } from './unplaced.ts';

/** Version prefix of the input hash; a change to what it covers needs a new one. */
export const PLACEMENT_INPUT_VERSION = 'proa-placement-input/1';
/** Version prefix of {@link chainInputDigest}. */
export const CHAIN_INPUT_VERSION = 'proa-placement-chain/1';
/** Version prefix of {@link processInputDigest}. */
export const PROCESS_INPUT_VERSION = 'proa-placement-process/1';

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Digest of what a placement claim shows of the chain: every step as
 * {@link claimSteps} lists it (id, name, path, kind, depth, parent, children,
 * resolved process link), with names and path normalized as for
 * `structure_hash` (a change of case or umlaut spelling does not count), the
 * `sequence` connections between steps (the order of the core chain and of
 * connected sub-steps; `rank` beyond that follows the position, so a step
 * dragged past an unconnected sibling counts as a layout change), and the
 * live step generations, `@outside` included (a revived chain or a re-added
 * id offers its processes again). What the claim does not show (org units
 * and their `assignment` connections, links to no head process, geometry,
 * colours apart from the kind) does not count. It is also the `step_hash`
 * basis of a pipeline proposal.
 */
export function chainInputDigest(
  structure: ChainStructure,
  headProcesses: ReadonlySet<string>,
  live: ReadonlyMap<string, number>,
): string {
  const shown = claimSteps(structure, headProcesses).map((s) => [
    s.id,
    normalizeKey(s.name),
    s.path.map((name) => normalizeKey(name)),
    s.kind,
    s.depth,
    s.parentId,
    [...s.children].sort(byCodePoint),
    s.link ?? null,
  ]);
  const generations = [...live].sort(([a], [b]) => byCodePoint(a, b));
  return sha256(JSON.stringify([CHAIN_INPUT_VERSION, shown, structure.sequences, generations]));
}

/**
 * Digest of what a placement claim shows of a process itself: its name,
 * lanes, start and end labels and its documentation as cut
 * ({@link ProcessOwnFields}). A change elsewhere in its model (another
 * process, a task label) does not count. It is also the `process_hash` basis
 * of a pipeline proposal.
 */
export function processInputDigest(fields: ProcessOwnFields): string {
  return sha256(
    JSON.stringify([
      PROCESS_INPUT_VERSION,
      fields.name,
      fields.lanes,
      fields.starts,
      fields.ends,
      fields.doc ?? null,
    ]),
  );
}

/** What every process's input hash shares, and where its own parts come from. */
export interface InputHashContext {
  /** The procedure placement claims name (a release offers every open process again). */
  procedure: DeclaredProcedure;
  /** {@link chainInputDigest} of the head. */
  chainDigest: string;
  /** {@link processInputDigest} of each head process, by ref. */
  processDigests: ReadonlyMap<string, string>;
  /** Processes joined by an accepted relation (`acceptedNeighbours`). */
  neighbours: ReadonlyMap<string, readonly string[]>;
  /** Steps each process is accepted on, live generations (`acceptedSteps`). */
  acceptedSteps: ReadonlyMap<string, readonly string[]>;
  /** Highest seq of a non-agent assertion per process ({@link lastNonAgentSeqs}). */
  lastNonAgentSeq: ReadonlyMap<string, number>;
}

/**
 * The input hash of a process (`proa-placement-input/1`): sha256 of the
 * canonical JSON of the expected procedure, the process ref, its
 * {@link processInputDigest}, the chain's {@link chainInputDigest}, its
 * accepted neighbours with the steps they are accepted on, and the last seq
 * of the non-agent placement assertions the claim shows
 * ({@link lastNonAgentSeqs}: human decisions and notes, rule proposals and
 * withdrawals).
 */
export function placementInputHash(ctx: InputHashContext, processRef: string): string {
  const neighbours = [...(ctx.neighbours.get(processRef) ?? [])]
    .sort(byCodePoint)
    .map((n) => [n, [...(ctx.acceptedSteps.get(n) ?? [])].sort(byCodePoint)]);
  return sha256(
    JSON.stringify([
      PLACEMENT_INPUT_VERSION,
      `${ctx.procedure.id}@${ctx.procedure.version}`,
      processRef,
      ctx.processDigests.get(processRef) ?? null,
      ctx.chainDigest,
      neighbours,
      ctx.lastNonAgentSeq.get(processRef) ?? 0,
    ]),
  );
}

/**
 * The highest seq of each process's non-agent placement assertions on the
 * chain that a claim shows: human decisions and notes, the rule tier's
 * proposals and withdrawals (a withdrawal that left a placement obsolete
 * removed a proposal the claim showed). Agent proposals and their
 * withdrawals are left out, so agents never make a process due; so are notes
 * on obsolete placements, which no claim shows.
 *
 * So are an auto-accept rule's acceptances and their revocations (owner
 * decision 19): while in force such an acceptance homes the process (no
 * claim lists it; neighbours see it through their accepted steps), and its
 * revocation leaves the process's hash as it was before the acceptance, so
 * the agent's verdict still matches and nothing is judged twice.
 */
export function lastNonAgentSeqs(
  placements: readonly Pick<PlacementRecord, 'id' | 'processRef' | 'status'>[],
  histories: ReadonlyMap<
    PlacementId,
    readonly { seq: number; sourceKind: string; kind: string; autoAcceptRuleId?: string | null }[]
  >,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of placements) {
    for (const a of histories.get(p.id) ?? []) {
      if (a.sourceKind === 'agent') continue;
      if ((a.autoAcceptRuleId ?? null) !== null) continue;
      if (a.kind === 'note' && p.status === 'obsolete') continue;
      out.set(p.processRef, Math.max(out.get(p.processRef) ?? 0, a.seq));
    }
  }
  return out;
}

/**
 * Open processes, by ref: head processes without an accepted or held
 * placement on a live step generation (`@outside` included). An accepted
 * placement on a removed step does not home a process, as for the findings.
 */
export function openProcesses(
  processRefs: Iterable<string>,
  placements: readonly Pick<
    PlacementRecord,
    'elementId' | 'generation' | 'processRef' | 'status'
  >[],
  live: ReadonlyMap<string, number>,
): string[] {
  const homes = processHomes(placements, live);
  return [...new Set(processRefs)]
    .filter((ref) => !homes.accepted.has(ref) && !homes.held.has(ref))
    .sort(byCodePoint);
}

/** A process a placement task judges, with its current input hash. */
export interface DueProcess {
  process: string;
  inputHash: string;
}

/**
 * Due processes, by ref: open processes without a verdict on their current
 * input (no `placement_input` row, or one with another hash).
 */
export function dueProcesses(
  open: readonly string[],
  hashes: ReadonlyMap<string, string>,
  rows: ReadonlyMap<string, Pick<StoredPlacementInput, 'inputHash'>>,
): DueProcess[] {
  const out: DueProcess[] = [];
  for (const process of [...open].sort(byCodePoint)) {
    const inputHash = hashes.get(process);
    if (inputHash === undefined) continue;
    if (rows.get(process)?.inputHash === inputHash) continue;
    out.push({ process, inputHash });
  }
  return out;
}

/** Digest of a due set (the `input_hash` of a placement task): its processes and their hashes. */
export function dueDigest(due: readonly DueProcess[]): string {
  return sha256(
    JSON.stringify(
      [...due]
        .sort((a, b) => byCodePoint(a.process, b.process))
        .map((d) => [d.process, d.inputHash]),
    ),
  );
}

/**
 * The due processes one claim carries: in order, at most
 * {@link MAX_CLAIM_PLACEMENT_PROCESSES}, and only while the input stays
 * within {@link CLAIM_PLACEMENT_MAX_BYTES} (the first always fits, so a claim
 * always makes progress). `truncated` and `remaining` tell how many are left.
 *
 * @param render the process as the input lists it
 * @param baseBytes size of the input without processes
 */
export function selectClaimProcesses<D, T>(
  due: readonly D[],
  render: (d: D) => T,
  baseBytes: number,
  limits: { maxProcesses?: number; maxBytes?: number } = {},
): { selected: { due: D; rendered: T }[]; truncated: boolean; remaining: number } {
  const maxProcesses = limits.maxProcesses ?? MAX_CLAIM_PLACEMENT_PROCESSES;
  const maxBytes = limits.maxBytes ?? CLAIM_PLACEMENT_MAX_BYTES;
  const selected: { due: D; rendered: T }[] = [];
  let bytes = baseBytes;
  for (const d of due) {
    if (selected.length >= maxProcesses) break;
    const rendered = render(d);
    // One comma per process after the first.
    const next = bytes + jsonBytes(rendered) + (selected.length > 0 ? 1 : 0);
    if (selected.length > 0 && next > maxBytes) break;
    selected.push({ due: d, rendered });
    bytes = next;
  }
  const remaining = due.length - selected.length;
  return { selected, truncated: remaining > 0, remaining };
}

const cut = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

/** The steps of the head as a claim lists them (code point order of their ids). */
export function claimSteps(
  structure: ChainStructure,
  headProcesses: ReadonlySet<string>,
): ClaimPlacementStep[] {
  return structure.steps.map((s) => {
    const target = linkTarget(s.link, headProcesses);
    return {
      id: s.elementId,
      name: s.name,
      path: s.path,
      kind: s.kind,
      rank: s.rank,
      depth: s.depth,
      parentId: s.parentId,
      children: s.childIds,
      ...(target.kind === 'process' && target.resolved && target.process
        ? { link: target.process }
        : {}),
    };
  });
}

/**
 * Up to {@link CLAIM_PLACEMENT_EXAMPLES} accepted placements per step on
 * live generations (`@outside` included), by step and process ref.
 */
export function claimExamples(
  placements: readonly Pick<
    PlacementRecord,
    'elementId' | 'generation' | 'processRef' | 'status'
  >[],
  live: ReadonlyMap<string, number>,
  names: ReadonlyMap<string, string | null>,
): PlacementClaimInput['examples'] {
  const byStep = new Map<string, string[]>();
  for (const p of placements) {
    if (p.status !== 'accepted' || live.get(p.elementId) !== p.generation) continue;
    byStep.set(p.elementId, [...(byStep.get(p.elementId) ?? []), p.processRef]);
  }
  return [...byStep]
    .sort(([a], [b]) => byCodePoint(a, b))
    .flatMap(([step, refs]) =>
      [...new Set(refs)]
        .sort(byCodePoint)
        .slice(0, CLAIM_PLACEMENT_EXAMPLES)
        .map((process) => ({ step, process: process as Ref, name: names.get(process) ?? null })),
    );
}

/** What the claim shows of a process beyond {@link UnplacedProcess}. */
export interface ClaimProcessSource {
  /** The process as `list_unplaced_processes` describes it. */
  unplaced: Omit<UnplacedProcess, 'judged' | 'inTask'>;
  /** The chain's non-obsolete placements of the process. */
  placements: readonly PlacementRecord[];
  histories: ReadonlyMap<PlacementId, readonly StoredPlacementAssertion[]>;
  live: ReadonlyMap<string, number>;
  /** The process's `placement_input` row, if any. */
  row: StoredPlacementInput | undefined;
  claimant: PrincipalId;
}

const iso = (d: Date): string => d.toISOString();

/**
 * A process as a claim lists it: the unplaced view with neighbours capped,
 * its live proposals on live generations (one per proposing principal, any
 * source; on an undecided placement with the human notes on it), the human
 * rejections, holds and acceptances on removed steps with their notes, and
 * an earlier `unsure` verdict. So every human note a process's input hash
 * counts reaches the agent.
 */
export function claimProcess(src: ClaimProcessSource): ClaimPlacementProcess {
  const proposals: ClaimPlacementProposal[] = [];
  const decisions: ClaimPlacementDecision[] = [];
  const ordered = [...src.placements].sort(
    (a, b) => byCodePoint(a.elementId, b.elementId) || a.generation - b.generation,
  );
  for (const p of ordered) {
    const history = src.histories.get(p.id) ?? [];
    const stepLive = src.live.get(p.elementId) === p.generation;
    const decided =
      p.status === 'rejected' || p.status === 'held' || (p.status === 'accepted' && !stepLive);
    const notes = history
      .filter((a) => a.kind === 'note' && a.rationale)
      .map((a) => ({
        text: cut(a.rationale ?? '', CLAIM_PLACEMENT_NOTE_CHARS),
        at: iso(a.createdAt),
      }));
    if (stepLive) {
      for (const a of currentStances(history)) {
        if (a.kind !== 'proposal' || a.tier === null) continue;
        proposals.push({
          placementId: p.id,
          step: p.elementId,
          status: p.status,
          tier: a.tier,
          confidence: a.confidence,
          by: a.handle,
          source: a.sourceKind,
          ...(a.principalId === src.claimant ? { mine: true as const } : {}),
          ...(a.question ? { question: a.question } : {}),
          ...(a.rationale ? { rationale: cut(a.rationale, CLAIM_PLACEMENT_RATIONALE_CHARS) } : {}),
          ...(!decided && notes.length > 0 ? { notes } : {}),
        });
      }
    }
    if (!decided) continue;
    const decision = decisionsInForce(history)
      .filter((a) => a.sourceKind === 'human')
      .at(-1);
    if (!decision?.verdict) continue;
    decisions.push({
      placementId: p.id,
      step: p.elementId,
      stepLive,
      verdict: decision.verdict,
      ...(decision.rationale ? { note: cut(decision.rationale, CLAIM_PLACEMENT_NOTE_CHARS) } : {}),
      ...(decision.question ? { question: decision.question } : {}),
      ...(decision.label ? { label: decision.label } : {}),
      at: iso(decision.createdAt),
      ...(notes.length > 0 ? { notes } : {}),
    });
  }
  const neighbours = src.unplaced.neighbours
    .slice(0, CLAIM_PLACEMENT_NEIGHBOURS)
    .map((n) => ({ ...n, via: n.via.slice(0, CLAIM_PLACEMENT_VIA) }));
  const row = src.row;
  return {
    ...src.unplaced,
    neighbours,
    proposals,
    decisions,
    ...(row?.outcome === 'unsure' && row.reason !== null
      ? {
          unsure: {
            reason: cut(row.reason, CLAIM_PLACEMENT_NOTE_CHARS),
            by: row.handle,
            at: iso(row.updatedAt),
          },
        }
      : {}),
  };
}

/** The input of a placement claim from its parts ({@link selectClaimProcesses} picks the processes). */
export function renderPlacementClaimInput(src: {
  chain: Pick<ValueChainRecord, 'id' | 'key' | 'name'>;
  head: Pick<ValueChainRevisionRecord, 'id' | 'rev' | 'contentHash' | 'structureHash'>;
  steps: ClaimPlacementStep[];
  processes: ClaimPlacementProcess[];
  examples: PlacementClaimInput['examples'];
  truncated: boolean;
  remaining: number;
}): PlacementClaimInput {
  return {
    format: CLAIM_PLACEMENT_FORMAT,
    valueChain: {
      id: src.chain.id,
      key: src.chain.key,
      name: src.chain.name,
      revisionId: src.head.id,
      rev: src.head.rev,
      contentHash: src.head.contentHash,
      structureHash: src.head.structureHash,
    },
    steps: src.steps,
    processes: src.processes,
    examples: src.examples,
    truncated: src.truncated,
    remaining: src.remaining,
  };
}

/** A live proposal stance on a placement of the chain, as supersession sees it. */
export interface LiveProposal {
  placement: Pick<PlacementRecord, 'id' | 'elementId' | 'generation' | 'processRef'>;
  stance: Pick<
    PlacementAssertionRecord,
    'principalId' | 'submissionId' | 'stepHash' | 'processHash' | 'declared'
  >;
}

/** Why a submission withdraws a pipeline proposal. */
export type SupersessionReason = 'stale' | 'replaced';

/**
 * The pipeline proposals a placement submission withdraws (M4 §3.2, judge
 * each process once), for the processes of its claim only:
 * - `stale`: any principal's live pipeline proposal whose basis (the chain's
 *   and the process's input digests, what its claim showed) differs from
 *   the claim's, or that was made under another procedure;
 * - `replaced`: the caller's own live pipeline proposals on a process it gave
 *   a verdict (a valid placement or an unsure item) that this submission
 *   does not repeat.
 * Other principals' current proposals, ad-hoc and rule proposals and every
 * decision stay, so disagreements reach the reviewer. Ordered by natural key.
 */
export function planPlacementSupersession(src: {
  /** The claim's processes with the {@link processInputDigest} the claim showed. */
  inputProcesses: ReadonlyMap<string, { processDigest: string }>;
  /** The claim's {@link chainInputDigest}. */
  chainDigest: string;
  procedure: DeclaredProcedure;
  caller: PrincipalId;
  /** The stored submission: its own new proposals stay. */
  submissionId: string;
  proposals: readonly LiveProposal[];
  /** Placements a valid item of this submission names. */
  repeated: ReadonlySet<PlacementId>;
  /** Processes the caller gave a verdict in this submission. */
  verdicts: ReadonlySet<string>;
}): (LiveProposal & { reason: SupersessionReason })[] {
  const out: (LiveProposal & { reason: SupersessionReason })[] = [];
  for (const p of src.proposals) {
    const { stance, placement } = p;
    if (stance.submissionId === null || stance.submissionId === src.submissionId) continue;
    const input = src.inputProcesses.get(placement.processRef);
    if (!input) continue;
    const stale =
      stance.stepHash !== src.chainDigest ||
      stance.processHash !== input.processDigest ||
      !sameProcedure(stance.declared?.procedure ?? null, src.procedure);
    if (stale) {
      out.push({ ...p, reason: 'stale' });
      continue;
    }
    if (
      stance.principalId === src.caller &&
      src.verdicts.has(placement.processRef) &&
      !src.repeated.has(placement.id)
    ) {
      out.push({ ...p, reason: 'replaced' });
    }
  }
  return out.sort(
    (a, b) =>
      byCodePoint(a.placement.elementId, b.placement.elementId) ||
      a.placement.generation - b.placement.generation ||
      byCodePoint(a.placement.processRef, b.placement.processRef) ||
      byCodePoint(a.stance.principalId, b.stance.principalId),
  );
}

/** Live proposal stances (any source) on the given placements, as {@link planPlacementSupersession} takes them. */
export function liveProposals(
  placements: readonly PlacementRecord[],
  histories: ReadonlyMap<PlacementId, readonly PlacementAssertionRecord[]>,
): LiveProposal[] {
  const out: LiveProposal[] = [];
  for (const placement of placements) {
    if (placement.status === 'obsolete') continue;
    for (const stance of currentStances(histories.get(placement.id) ?? [])) {
      if (stance.kind === 'proposal') out.push({ placement, stance });
    }
  }
  return out;
}
