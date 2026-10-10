/**
 * The lexical tier of placement proposals (M4 §2 "Tiers"): an agent's
 * proposal is `lexical` when its step is among the top 3 of
 * `baseline-prefix/1` for the process, or shares a name stem with it (the
 * derived `name-match` rule of eval/value-chains/README.md; an equal
 * `name_norm` counts as a shared stem, a matching `link` alone does not);
 * otherwise it is `semantic`, and always so for `@outside`. Neighbours are
 * processes joined by an accepted relation and votes come from accepted
 * placements on live step generations, so the tier never rests on unreviewed
 * agent output. Computed lazily per process; the same baseline gives the
 * hints of `list_unplaced_processes`.
 */
import { normalizeKey } from '@proa/bpmn-facts';
import type { Fact, RelationStatus } from '@proa/contracts';
import { PREFIX_TOP, baselinePrefix, sharesNameStem, type PrefixHint } from '@proa/relations';

import type { PlacementRecord } from '../ports.ts';
import { OUTSIDE } from './steps.ts';
import { siblingsOf, type ChainStructure } from './structure.ts';

/** A head process as the matchers see it. */
export interface TierProcess {
  name: string | null;
  modelKey: string;
}

export interface LexicalInput {
  structure: ChainStructure;
  /** Head processes by ref. */
  processes: ReadonlyMap<string, TierProcess>;
  /** Processes joined by an accepted relation, by process ref. */
  neighbours: ReadonlyMap<string, readonly string[]>;
  /** Steps each process is accepted on (live generations), by process ref. */
  known: ReadonlyMap<string, readonly string[]>;
}

export interface LexicalMatcher {
  /** Whether a proposal of `processRef` on step `elementId` is `lexical`. */
  (processRef: string, elementId: string): boolean;
  /** The top `baseline-prefix/1` steps for the process (score > 0). */
  hints(processRef: string): PrefixHint[];
}

/** Builds the lexical matcher; each process's baseline is computed on first use. */
export function lexicalMatcher(input: LexicalInput): LexicalMatcher {
  const steps = input.structure.steps.map((s) => ({
    id: s.elementId,
    name: s.name,
    parentId: s.parentId,
  }));
  const cache = new Map<string, PrefixHint[]>();
  const hints = (processRef: string): PrefixHint[] => {
    const cached = cache.get(processRef);
    if (cached) return cached;
    const process = input.processes.get(processRef);
    const result = process
      ? (baselinePrefix(
          {
            steps,
            processes: [{ ref: processRef, name: process.name, modelKey: process.modelKey }],
            neighbours: input.neighbours,
            known: input.known,
          },
          { top: PREFIX_TOP },
        ).get(processRef) ?? [])
      : [];
    cache.set(processRef, result);
    return result;
  };
  const match = (processRef: string, elementId: string): boolean => {
    if (elementId === OUTSIDE) return false;
    const step = input.structure.byId.get(elementId);
    const process = input.processes.get(processRef);
    if (!step || !process) return false;
    if (hints(processRef).some((h) => h.stepId === elementId)) return true;
    if (step.nameNorm !== '' && step.nameNorm === normalizeKey(process.name ?? '')) return true;
    return sharesNameStem(process, step, siblingsOf(input.structure, elementId)) !== null;
  };
  return Object.assign(match, { hints });
}

/** `<model_key>#<process_id>` of every head fact's process, by fact ref. */
export function processOfRefs(
  facts: readonly Pick<Fact, 'ref' | 'modelKey' | 'processId'>[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of facts) if (f.processId !== null) out.set(f.ref, `${f.modelKey}#${f.processId}`);
  return out;
}

/**
 * Processes joined by an accepted relation, both directions, by process ref.
 *
 * @param processOf the process of a head fact ref ({@link processOfRefs})
 */
export function acceptedNeighbours(
  relations: readonly { status: RelationStatus; fromRef: string; toRef: string }[],
  processOf: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const r of relations) {
    if (r.status !== 'accepted') continue;
    const a = processOf.get(r.fromRef);
    const b = processOf.get(r.toRef);
    if (a === undefined || b === undefined || a === b) continue;
    out.set(a, (out.get(a) ?? new Set()).add(b));
    out.set(b, (out.get(b) ?? new Set()).add(a));
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
}

/** The steps each process is accepted on (live generations, `@outside` aside), by process ref. */
export function acceptedSteps(
  placements: readonly Pick<
    PlacementRecord,
    'status' | 'elementId' | 'generation' | 'processRef'
  >[],
  live: ReadonlyMap<string, number>,
): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const p of placements) {
    if (p.status !== 'accepted' || p.elementId === OUTSIDE) continue;
    if (live.get(p.elementId) !== p.generation) continue;
    out.set(p.processRef, (out.get(p.processRef) ?? new Set()).add(p.elementId));
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
}
