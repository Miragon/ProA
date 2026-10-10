import type { EventDef, Fact, Relation, RelationType } from '@proa/client';

import { splitRef } from './refs';
import { nameWords } from './generic-names';

/**
 * Endpoint semantics of `@proa/relations` (`endpointRole`, CONCEPT §2),
 * mirrored for the correction dialog: which facts can stand at which end of
 * a relation type. The web bundle cannot import the library (it pulls in the
 * BPMN parser); `test/endpoints.test.ts` pins the rules. The server checks
 * every correction again (refs in the head facts, different processes).
 */

export type LinkType = Exclude<RelationType, 'manual'>;
export type Side = 'from' | 'to';

const ROLE_BY_KIND: Partial<Record<Fact['kind'], { type: LinkType; side: Side }>> = {
  call: { type: 'call', side: 'from' },
  process: { type: 'call', side: 'to' },
  msg_throw: { type: 'message', side: 'from' },
  msg_catch: { type: 'message', side: 'to' },
  sig_throw: { type: 'signal', side: 'from' },
  sig_catch: { type: 'signal', side: 'to' },
  evt_end: { type: 'trigger', side: 'from' },
  evt_start: { type: 'trigger', side: 'to' },
};

/** `EVENT_DEF_COMPATIBILITY` of `@proa/relations` (`null` = not an event). */
const EVENT_DEFS: Record<LinkType, Record<Side, readonly (EventDef | null)[]>> = {
  call: { from: [null], to: [null] },
  message: { from: ['message', 'multiple', null], to: ['message', 'multiple', null] },
  signal: { from: ['signal', 'multiple'], to: ['signal', 'multiple'] },
  trigger: { from: ['none'], to: ['none'] },
};

/** Starts/ends in embedded subprocesses and ends in event subprocesses are never endpoints. */
function inEndpointScope(fact: Pick<Fact, 'attrs' | 'scope' | 'eventDef'>): boolean {
  const type = fact.attrs.elementType;
  if (type === 'bpmn:StartEvent') {
    if (fact.scope === 'process') return true;
    return fact.scope === 'event_subprocess' && fact.eventDef !== null && fact.eventDef !== 'none';
  }
  if (type === 'bpmn:EndEvent') return fact.scope === 'process';
  return true;
}

/** The relation type and side a fact can take part in, or `null` (never an endpoint). */
export function endpointRole(
  fact: Pick<Fact, 'kind' | 'eventDef' | 'label' | 'scope' | 'attrs'>,
): { type: LinkType; side: Side } | null {
  const role = ROLE_BY_KIND[fact.kind];
  if (role === undefined) return null;
  if (!EVENT_DEFS[role.type][role.side].includes(fact.eventDef)) return null;
  if (role.type === 'trigger' && (fact.label.trim() === '' || fact.scope !== 'process')) {
    return null;
  }
  return inEndpointScope(fact) ? role : null;
}

/** Ref of the process a fact lies in; `null` for collaboration-level facts. */
export function processRefOf(fact: Pick<Fact, 'modelKey' | 'processId'>): string | null {
  return fact.processId === null ? null : `${fact.modelKey}#${fact.processId}`;
}

/** Token overlap of two labels, 0–1 (umlauts, case and camelCase ignored). */
export function labelSimilarity(a: string, b: string): number {
  const wa = new Set(nameWords(a));
  const wb = new Set(nameWords(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / (wa.size + wb.size - shared);
}

export interface CorrectionCandidate {
  fact: Fact;
  /** Similarity of its label to the replaced end or to the end that stays, whichever is higher (0–1). */
  score: number;
}

/**
 * Elements that can replace one end of `relation` in a correction (accepted
 * as a `manual` relation): the same endpoint role as the replaced end (for a
 * `manual` relation any endpoint), not the replaced element itself, and not
 * in the process of the end that stays. Labels most similar to either end
 * first.
 */
export function correctionCandidates(
  relation: Pick<Relation, 'type' | 'from' | 'to'>,
  replace: Side,
  facts: readonly Fact[],
): CorrectionCandidate[] {
  const replacedRef = replace === 'from' ? relation.from : relation.to;
  const keptRef = replace === 'from' ? relation.to : relation.from;
  const byRef = new Map(facts.map((f) => [f.ref, f]));
  const kept = byRef.get(keptRef);
  const keptProcess = kept
    ? (processRefOf(kept) ?? (kept.kind === 'process' ? kept.ref : null))
    : null;
  const replaced = byRef.get(replacedRef);
  const replacedLabel = replaced?.label || splitRef(replacedRef).elementId;
  // the right partner often shares words with the end that stays ("Rechnung versenden" → "Rechnung erhalten")
  const keptLabel = kept?.label ?? '';
  const seen = new Set<string>();
  const out: CorrectionCandidate[] = [];
  for (const fact of facts) {
    if (fact.ref === replacedRef || fact.ref === keptRef || seen.has(fact.ref)) continue;
    const role = endpointRole(fact);
    if (role === null) continue;
    if (relation.type !== 'manual' && (role.type !== relation.type || role.side !== replace)) {
      continue;
    }
    const process = processRefOf(fact) ?? (fact.kind === 'process' ? fact.ref : null);
    if (keptProcess !== null && process === keptProcess) continue;
    seen.add(fact.ref);
    const label = fact.label || fact.elementId;
    out.push({
      fact,
      score: Math.max(labelSimilarity(replacedLabel, label), labelSimilarity(keptLabel, label)),
    });
  }
  return out.sort(
    (a, b) =>
      b.score - a.score ||
      a.fact.modelKey.localeCompare(b.fact.modelKey) ||
      a.fact.ref.localeCompare(b.fact.ref),
  );
}
