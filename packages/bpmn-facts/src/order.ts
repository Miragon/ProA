import { FactKind } from '@proa/contracts';
import type { Fact } from '@proa/contracts';

const KIND_RANK: ReadonlyMap<string, number> = new Map(FactKind.options.map((k, i) => [k, i]));

/** Locale-independent string order (UTF-16 code units), stable across machines. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The canonical fact order: by kind in the order of the `FactKind` enum
 * (`process`, `call`, `msg_throw`, …), then by element id.
 */
export function compareFacts(
  a: Pick<Fact, 'kind' | 'elementId'>,
  b: Pick<Fact, 'kind' | 'elementId'>,
): number {
  const byKind = (KIND_RANK.get(a.kind) ?? 0) - (KIND_RANK.get(b.kind) ?? 0);
  return byKind !== 0 ? byKind : compareStrings(a.elementId, b.elementId);
}
