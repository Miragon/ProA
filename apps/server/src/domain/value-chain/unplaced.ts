/**
 * What an agent needs to place a process (M4 §3.1): name, model key, lanes,
 * start and end labels, the documentation (cut), its relation neighbours
 * with their accepted steps, calls in both directions and the top
 * `baseline-prefix/1` steps as hints. `list_unplaced_processes` lists it, a
 * placement claim (M4 §3.2) carries it per process. Pure.
 */
import {
  UNPLACED_DOC_CHARS,
  UNPLACED_EVENT_LABELS,
  type Ref,
  type RelationId,
  type UnplacedProcess,
} from '@proa/contracts';

import type { HeadFact, RelationRecord } from '../ports.ts';
import type { ChainStructure } from './structure.ts';
import type { LexicalMatcher } from './tiers.ts';

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** What the claim and `list_unplaced_processes` show of a process itself (its own facts). */
export type ProcessOwnFields = Pick<UnplacedProcess, 'name' | 'lanes' | 'starts' | 'ends' | 'doc'>;

/** The head facts of each process (lanes, events, …), by process ref. */
export function factsByProcess(facts: readonly HeadFact[]): Map<string, HeadFact[]> {
  const out = new Map<string, HeadFact[]>();
  for (const f of facts) {
    if (f.processId === null) continue;
    const key = `${f.modelKey}#${f.processId}`;
    const list = out.get(key);
    if (list) list.push(f);
    else out.set(key, [f]);
  }
  return out;
}

/**
 * The process's own fields as an agent sees them: the name, lanes, up to 5
 * start and end labels and the documentation cut to 200 characters.
 *
 * @param own the head facts of the process ({@link factsByProcess})
 */
export function processOwnFields(process: HeadFact, own: readonly HeadFact[]): ProcessOwnFields {
  const labels = (elementType: string) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const f of own) {
      if (f.scope !== 'process' || f.attrs.elementType !== elementType) continue;
      if (seen.has(f.elementId) || f.label.trim() === '') continue;
      seen.add(f.elementId);
      out.push(f.label);
    }
    return out.slice(0, UNPLACED_EVENT_LABELS);
  };
  const lanes = [
    ...new Set(own.filter((f) => f.kind === 'lane' && f.label.trim() !== '').map((f) => f.label)),
  ];
  const doc = process.attrs.documentation?.slice(0, UNPLACED_DOC_CHARS);
  return {
    name: process.label === '' ? null : process.label,
    lanes,
    starts: labels('bpmn:StartEvent'),
    ends: labels('bpmn:EndEvent'),
    ...(doc ? { doc } : {}),
  };
}

/** The head state an unplaced process is described from. */
export interface UnplacedContext {
  /** Every head fact of the project. */
  facts: readonly HeadFact[];
  /** {@link factsByProcess} of `facts` (built from them when left out). */
  byProcess?: ReadonlyMap<string, readonly HeadFact[]>;
  /** The process of a head fact ref (`processOfRefs`). */
  processOf: ReadonlyMap<string, string>;
  /** The relations neighbours and calls come from (live, not rejected). */
  relations: readonly RelationRecord[];
  /** Steps each process is accepted on (live generations), by process ref. */
  known: ReadonlyMap<string, readonly string[]>;
  matcher: LexicalMatcher;
  structure: ChainStructure;
}

/** One process with what an agent needs to place it (without `judged` and `inTask`). */
export function unplacedProcess(
  process: HeadFact,
  ctx: UnplacedContext,
): Omit<UnplacedProcess, 'judged' | 'inTask'> {
  const ref = process.ref;
  // A process fact's ref is `<model key>#<process id>`, the key of factsByProcess.
  const own = ctx.byProcess
    ? (ctx.byProcess.get(ref) ?? [])
    : ctx.facts.filter((f) => f.modelKey === process.modelKey && f.processId === process.elementId);
  const fields = processOwnFields(process, own);
  const neighbours = new Map<
    string,
    { relationId: RelationId; type: RelationRecord['type']; direction: 'out' | 'in' }[]
  >();
  const out: UnplacedProcess['calls']['out'] = [];
  const into: UnplacedProcess['calls']['in'] = [];
  for (const r of ctx.relations) {
    const from = ctx.processOf.get(r.fromRef);
    const to = ctx.processOf.get(r.toRef);
    if (from === undefined || to === undefined || from === to) continue;
    if (from === ref) {
      neighbours.set(to, [
        ...(neighbours.get(to) ?? []),
        { relationId: r.id, type: r.type, direction: 'out' },
      ]);
      if (r.type === 'call') out.push({ process: to as Ref, relationId: r.id, status: r.status });
    } else if (to === ref) {
      neighbours.set(from, [
        ...(neighbours.get(from) ?? []),
        { relationId: r.id, type: r.type, direction: 'in' },
      ]);
      if (r.type === 'call')
        into.push({ process: from as Ref, relationId: r.id, status: r.status });
    }
  }
  const byRelation = <T extends { relationId: string }>(a: T, b: T) =>
    byCodePoint(a.relationId, b.relationId);
  return {
    process: ref,
    name: fields.name,
    modelKey: process.modelKey,
    lanes: fields.lanes,
    starts: fields.starts,
    ends: fields.ends,
    ...(fields.doc ? { doc: fields.doc } : {}),
    neighbours: [...neighbours]
      .sort(([a], [b]) => byCodePoint(a, b))
      .map(([q, via]) => ({
        process: q as Ref,
        via: via.sort(byRelation),
        steps: [...(ctx.known.get(q) ?? [])],
      })),
    calls: { out: out.sort(byRelation), in: into.sort(byRelation) },
    hints: ctx.matcher.hints(ref).map((h) => ({
      step: h.stepId,
      name: ctx.structure.byId.get(h.stepId)?.name ?? '',
      score: h.score,
    })),
  };
}
