import type { RelationProvenance } from '@proa/client';
import { PlugIcon, ScrollTextIcon, UserIcon, type LucideIcon } from 'lucide-react';

import { TierBadge } from '@/components/badges';
import { SOURCE_KINDS, formatConfidence, formatDateTime, procedureText } from '@/lib/labels';
import type { SourceKind } from '@proa/client';

export const SOURCE_ICONS: Record<SourceKind, LucideIcon> = {
  rule: ScrollTextIcon,
  agent: PlugIcon,
  human: UserIcon,
};

/** Principal and source of an assertion: icon, handle, kind. */
export function Principal({ sourceKind, handle }: { sourceKind: SourceKind; handle: string }) {
  const Icon = SOURCE_ICONS[sourceKind];
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={SOURCE_KINDS[sourceKind]}>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate font-mono text-xs">{handle}</span>
      <span className="sr-only">({SOURCE_KINDS[sourceKind]})</span>
    </span>
  );
}

/** Who made the assertion the status rests on, by its kind. */
const BY: Partial<Record<RelationProvenance['kind'], string>> = {
  proposal: 'Vorgeschlagen von',
  decision: 'Entschieden von',
  withdrawal: 'Zurückgezogen von',
};

/**
 * Who the relation's status rests on (CONCEPT §2 assertions): principal and
 * client from the credential; procedure and LLM model only as declared.
 */
export function ProvenanceList({ provenance }: { provenance: RelationProvenance }) {
  const procedure = procedureText(provenance.procedure);
  return (
    <dl
      aria-label="Herkunft"
      className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 text-sm"
    >
      <dt className="text-muted-foreground">{BY[provenance.kind] ?? 'Von'}</dt>
      <dd>
        <Principal sourceKind={provenance.sourceKind} handle={provenance.handle} />
      </dd>
      <dt className="text-muted-foreground">Client</dt>
      <dd className="truncate font-mono text-xs">{provenance.clientId ?? '–'}</dd>
      <dt className="text-muted-foreground">Verfahren</dt>
      <dd className="truncate font-mono text-xs" title="vom Agenten angegeben">
        {procedure ?? '–'}
      </dd>
      <dt className="text-muted-foreground">LLM-Modell</dt>
      <dd className="truncate font-mono text-xs" title="vom Agenten angegeben">
        {provenance.llmModel ?? '–'}
      </dd>
      <dt className="text-muted-foreground">Stufe</dt>
      <dd>{provenance.tier ? <TierBadge tier={provenance.tier} /> : '–'}</dd>
      <dt className="text-muted-foreground">Konfidenz</dt>
      <dd className="tabular-nums">{formatConfidence(provenance.confidence)}</dd>
      <dt className="text-muted-foreground">Zeitpunkt</dt>
      <dd>{formatDateTime(provenance.at)}</dd>
    </dl>
  );
}
