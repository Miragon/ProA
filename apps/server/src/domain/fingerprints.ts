/**
 * Head fingerprints of relation endpoints. One element can carry several
 * facts under the same ref (an event with a message and a signal definition
 * is a `msg_throw` and a `sig_throw`), so a fingerprint is looked up by the
 * fact kind that fits the relation type and side (`RELATION_ENDPOINT_KINDS`):
 * a message relation is anchored to the `msg_*` fact, never to the `sig_*`
 * fact of the same element.
 */
import {
  FactKind,
  RELATION_ENDPOINT_KINDS,
  type ProjectFacts,
  type RelationType,
} from '@proa/contracts';

export type EndpointSide = 'from' | 'to';

export interface HeadFingerprints {
  /**
   * Fingerprint of the head fact at `ref` whose kind fits `side` of `type`;
   * `undefined` if the head has no such fact (endpoint missing). `manual`
   * relations accept any kind; the first in `FactKind` order wins.
   */
  get(type: RelationType, side: EndpointSide, ref: string): string | undefined;
}

export function headFingerprints(projectFacts: ProjectFacts): HeadFingerprints {
  const byRef = new Map<string, Map<FactKind, string>>();
  for (const model of projectFacts.models) {
    for (const fact of model.facts) {
      let kinds = byRef.get(fact.ref);
      if (!kinds) {
        kinds = new Map();
        byRef.set(fact.ref, kinds);
      }
      kinds.set(fact.kind, fact.fingerprint);
    }
  }
  return {
    get(type, side, ref) {
      const kinds = byRef.get(ref);
      if (!kinds) return undefined;
      const allowed: readonly FactKind[] = RELATION_ENDPOINT_KINDS[type][side] ?? FactKind.options;
      for (const kind of allowed) {
        const fingerprint = kinds.get(kind);
        if (fingerprint !== undefined) return fingerprint;
      }
      return undefined;
    },
  };
}
