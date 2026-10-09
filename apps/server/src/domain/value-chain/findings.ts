/**
 * Findings of the value chain (M4 §3.4): deterministic, recomputed on read
 * from the head structure, the step generations, the head processes, the
 * placements and the accepted calls; never stored and never blocking.
 * Separate from the relation findings (`FindingKind`), which the rule tier
 * stores. Pure.
 *
 * - `process-without-step`: a head process with no accepted placement on a
 *   live step generation (`@outside` counts). An accepted or held placement
 *   on a removed step stays `missing` for good, so it counts as unplaced.
 *   `state` is `held` (a held placement on a live step), `proposed` (one
 *   waiting for review on a live step) or `none`; `calledFrom` names the
 *   steps on which callers of the process (accepted `call` relations) are
 *   accepted, as a hint.
 * - `step-without-process`: no accepted placement of a head process on the
 *   step or below it; reported once, at the topmost such step.
 * - `unresolved-link`: a step `link` that is neither `proa:process/<ref>` of
 *   a head process nor an http(s) URL.
 */
import {
  PROA_PROCESS_LINK_PREFIX,
  type Ref,
  type UnplacedState,
  type ValueChainFinding,
} from '@proa/contracts';

import type { PlacementRecord } from '../ports.ts';
import { OUTSIDE } from './steps.ts';
import { linkTarget, type ChainStructure } from './structure.ts';

type PlacementView = Pick<PlacementRecord, 'elementId' | 'generation' | 'processRef' | 'status'>;

/** How each process is homed on the live step generations of a chain. */
export interface ProcessHomes {
  /** Live step generations (element ids, `@outside` included) each process is accepted on. */
  accepted: ReadonlyMap<string, readonly string[]>;
  /** Processes with a held placement on a live step generation. */
  held: ReadonlySet<string>;
  /** Processes with a placement waiting for review (`proposed`) on a live step generation. */
  proposed: ReadonlySet<string>;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Accepted, held and pending placements per process, on live step
 * generations only: a placement on a removed step is `missing` for good and
 * homes nothing.
 *
 * @param live the live generation of each element id, `@outside` included
 */
export function processHomes(
  placements: readonly PlacementView[],
  live: ReadonlyMap<string, number>,
): ProcessHomes {
  const accepted = new Map<string, Set<string>>();
  const held = new Set<string>();
  const proposed = new Set<string>();
  for (const p of placements) {
    if (live.get(p.elementId) !== p.generation) continue;
    if (p.status === 'accepted') {
      accepted.set(p.processRef, (accepted.get(p.processRef) ?? new Set()).add(p.elementId));
    } else if (p.status === 'held') held.add(p.processRef);
    else if (p.status === 'proposed') proposed.add(p.processRef);
  }
  return {
    accepted: new Map([...accepted].map(([k, v]) => [k, [...v].sort(byCodePoint)])),
    held,
    proposed,
  };
}

/** The review state of a process without an accepted home step. */
export function unplacedState(homes: ProcessHomes, processRef: string): UnplacedState {
  if (homes.held.has(processRef)) return 'held';
  return homes.proposed.has(processRef) ? 'proposed' : 'none';
}

/** An accepted `call` relation between two processes. */
export interface AcceptedCall {
  /** `<model_key>#<process_id>` of the calling process. */
  caller: string;
  /** The called process. */
  callee: string;
}

export interface FindingsInput {
  structure: ChainStructure;
  /** The live generation of each element id, `@outside` included. */
  live: ReadonlyMap<string, number>;
  /** Refs of the head's `process` facts. */
  processes: readonly string[];
  /** Every placement of the chain (obsolete ones are ignored). */
  placements: readonly PlacementView[];
  calls: readonly AcceptedCall[];
}

const STATE_DETAIL: Readonly<Record<UnplacedState, string>> = {
  none: 'no placement is proposed',
  proposed: 'a placement waits for review',
  held: 'a placement is on hold',
};

function processWithoutStep(input: FindingsInput, homes: ProcessHomes): ValueChainFinding[] {
  const callersOf = new Map<string, Set<string>>();
  for (const c of input.calls) {
    if (c.caller === c.callee) continue;
    callersOf.set(c.callee, (callersOf.get(c.callee) ?? new Set()).add(c.caller));
  }
  const out: ValueChainFinding[] = [];
  for (const ref of [...new Set(input.processes)].sort(byCodePoint)) {
    if (homes.accepted.has(ref)) continue;
    const state = unplacedState(homes, ref);
    const calledFrom = [...(callersOf.get(ref) ?? [])]
      .flatMap((caller) =>
        (homes.accepted.get(caller) ?? [])
          .filter((elementId) => elementId !== OUTSIDE)
          .map((elementId) => ({ elementId, process: caller as Ref })),
      )
      .sort((a, b) => byCodePoint(a.elementId, b.elementId) || byCodePoint(a.process, b.process));
    const hint =
      calledFrom.length > 0
        ? `; it is called from ${[...new Set(calledFrom.map((c) => c.elementId))].join(', ')}`
        : '';
    out.push({
      kind: 'process-without-step',
      elementId: null,
      process: ref as Ref,
      link: null,
      state,
      calledFrom,
      detail: `No accepted placement on a step of the value chain (${STATE_DETAIL[state]})${hint}.`,
    });
  }
  return out;
}

function stepWithoutProcess(input: FindingsInput, homes: ProcessHomes): ValueChainFinding[] {
  const heads = new Set(input.processes);
  const placedHere = new Set<string>();
  for (const [ref, steps] of homes.accepted) {
    if (!heads.has(ref)) continue;
    for (const id of steps) placedHere.add(id);
  }
  const { byId } = input.structure;
  const memo = new Map<string, boolean>();
  const placedBelow = (id: string, seen: ReadonlySet<string> = new Set()): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return false;
    const next = new Set(seen).add(id);
    const result =
      placedHere.has(id) || (byId.get(id)?.childIds ?? []).some((c) => placedBelow(c, next));
    memo.set(id, result);
    return result;
  };
  return input.structure.steps
    .filter((s) => !placedBelow(s.elementId) && (s.parentId === null || placedBelow(s.parentId)))
    .map((s) => ({
      kind: 'step-without-process' as const,
      elementId: s.elementId,
      process: null,
      link: null,
      state: null,
      calledFrom: [],
      detail:
        s.childIds.length > 0
          ? `No process is accepted on ${JSON.stringify(s.name)} or its sub-steps.`
          : `No process is accepted on ${JSON.stringify(s.name)}.`,
    }));
}

function unresolvedLinks(input: FindingsInput): ValueChainFinding[] {
  const heads = new Set(input.processes);
  const out: ValueChainFinding[] = [];
  for (const s of input.structure.steps) {
    const target = linkTarget(s.link, heads);
    if (target.kind === 'none' || target.kind === 'url' || target.resolved) continue;
    let detail: string;
    if (target.kind === 'opaque') {
      detail =
        'The link is neither a proa:process/<model key>#<process id> link nor an http(s) URL.';
    } else if (target.process === null) {
      detail = `The link does not name a process as ${PROA_PROCESS_LINK_PREFIX}<model key>#<process id>.`;
    } else {
      detail = `The linked process ${target.process} is not in the head revisions.`;
    }
    out.push({
      kind: 'unresolved-link',
      elementId: s.elementId,
      process: null,
      link: s.link,
      state: null,
      calledFrom: [],
      detail,
    });
  }
  return out;
}

/**
 * The findings of a chain's head, in a deterministic order: every
 * `process-without-step` by process ref, then every `step-without-process`
 * and `unresolved-link` by element id.
 */
export function valueChainFindings(input: FindingsInput): ValueChainFinding[] {
  const homes = processHomes(input.placements, input.live);
  return [
    ...processWithoutStep(input, homes),
    ...stepWithoutProcess(input, homes),
    ...unresolvedLinks(input),
  ];
}
