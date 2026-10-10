import { createHash } from 'node:crypto';

import type { Fact } from '@proa/contracts';

import { normalizeKey } from './normalize.ts';
import { compareFacts, compareStrings } from './order.ts';
import { FACTS_VERSION } from './version.ts';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Input of {@link factFingerprint}. */
export type FingerprintInput = Pick<Fact, 'kind' | 'eventDef' | 'keyRaw' | 'label' | 'scope'> & {
  /**
   * The referenced name: message or signal name, call target. `null` or
   * `''` for none. Omitted: `keyRaw` for `call` facts, none otherwise.
   */
  refName?: string | null;
};

/**
 * `fingerprint = sha256(kind|event_def|ref_name_norm|label_norm|scope)[:12]`
 * (CONCEPT §2): tells "same id, same meaning" apart from "same id, changed
 * meaning". `ref_name_norm` is the normalized message/signal name or call
 * target (empty if none), `label_norm` the normalized label, `event_def` is
 * empty for non-events. Ids, documentation, layout and attributes such as
 * the call binding do not count.
 */
export function factFingerprint(fact: FingerprintInput): string {
  const refName =
    fact.refName !== undefined ? (fact.refName ?? '') : fact.kind === 'call' ? fact.keyRaw : '';
  const input = [
    fact.kind,
    fact.eventDef ?? '',
    normalizeKey(refName),
    normalizeKey(fact.label),
    fact.scope,
  ].join('|');
  return sha256(input).slice(0, 12);
}

/** JSON with object keys sorted and `undefined` members left out: one text per value. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * `facts_hash`: SHA-256 (hex) over `FACTS_VERSION` and the canonical JSON of
 * the facts in canonical order (kind, element id). Independent of layout
 * (DI), of element order in the file and of the order of `facts`; changes
 * with any fact field, documentation included, and with `FACTS_VERSION`.
 * Same facts → same hash → no new analysis task.
 */
export function factsHash(facts: readonly Fact[]): string {
  const sorted = [...facts].sort(compareFacts);
  return sha256(canonicalJson({ factsVersion: FACTS_VERSION, facts: sorted }));
}
