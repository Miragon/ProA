import type { Finding, FindingKind } from '@proa/client';

import { FINDING_ORDER } from './labels';

/** Findings grouped by kind, in the order of {@link FINDING_ORDER}. */
export function groupFindings(findings: readonly Finding[]): [FindingKind, Finding[]][] {
  const groups = new Map<FindingKind, Finding[]>();
  for (const f of findings) groups.set(f.kind, [...(groups.get(f.kind) ?? []), f]);
  return FINDING_ORDER.flatMap((kind) => {
    const items = groups.get(kind);
    return items ? [[kind, items] as [FindingKind, Finding[]]] : [];
  });
}
