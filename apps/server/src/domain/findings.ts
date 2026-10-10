/**
 * Findings as clients see them (M2): `dangling-throw` and `unmatched-catch`
 * mark message and signal endpoints that the rule tier (names only) found no
 * partner for. Once a live relation (proposed, accepted or held) connects
 * the endpoint, e.g. a semantic link an agent proposed, the finding is
 * answered and hidden. The stored findings stay those of the rule tier.
 */
import type { Finding, FindingKind, RelationStatus } from '@proa/contracts';

const ENDPOINT_FINDINGS: ReadonlySet<FindingKind> = new Set(['dangling-throw', 'unmatched-catch']);
const LIVE: ReadonlySet<RelationStatus> = new Set(['proposed', 'accepted', 'held']);

export function visibleFindings(
  findings: readonly Finding[],
  relations: readonly { fromRef: string; toRef: string; status: RelationStatus }[],
): Finding[] {
  const connected = new Set<string>();
  for (const r of relations) {
    if (!LIVE.has(r.status)) continue;
    connected.add(r.fromRef);
    connected.add(r.toRef);
  }
  return findings.filter(
    (f) => !ENDPOINT_FINDINGS.has(f.kind) || !f.refs.every((ref) => connected.has(ref)),
  );
}
