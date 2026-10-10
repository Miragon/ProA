import type { AutoAcceptLedgerEntry, Relation, RelationAssertion } from '@proa/client';
import { Link } from '@tanstack/react-router';
import { CircleHelpIcon, CrosshairIcon, ExternalLinkIcon, UnlinkIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { EndpointStateBadge, StatusBadge, TierBadge, TypeLabel } from '@/components/badges';
import { AutoAcceptProvenance } from '@/components/rules/auto-accept-provenance';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { formatConfidence, formatDateTime, provenanceOf } from '@/lib/labels';
import type { TimelineMark } from '@/lib/auto-accept';
import type { RefResolver } from '@/lib/refs';
import { currentProposal, evidenceItems, type EvidenceItem } from '@/lib/review';

import { Endpoint } from '../relation-table';
import { PlainText } from './plain-text';
import { Principal, ProvenanceList } from './provenance';
import { AssertionTimeline, RelationLink } from './timeline';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

export interface ReviewDetailsProps {
  project: string;
  relation: Relation;
  /** The relation's history; `undefined` while loading. */
  assertions: readonly RelationAssertion[] | undefined;
  resolve: RefResolver;
  /** Model keys of the project: evidence refs into them are links. */
  modelKeys: ReadonlySet<string>;
  /**
   * The endpoints' models, shown on the review screen: evidence refs into
   * them go to `onEvidence`, refs into other models open the model view.
   * Without it, every ref into a project model goes to `onEvidence`.
   */
  paneModels?: ReadonlySet<string>;
  /** Shows a cited element in its canvas. */
  onEvidence?: (item: Extract<EvidenceItem, { kind: 'ref' }>) => void;
  /**
   * Owner decision 19, from the ledger (every reviewer): the relation's
   * auto-acceptances (oldest first), the marks of their assertions, and
   * whether the caller may revoke (owners).
   */
  autoAccept?: {
    entries: readonly AutoAcceptLedgerEntry[];
    marks: ReadonlyMap<string, TimelineMark>;
    canRevoke: boolean;
  };
}

/**
 * Everything a reviewer reads before deciding (CONCEPT §3): both endpoints,
 * the agent's rationale, evidence and question, the agents' current
 * no-links on the pair (judge each pair once), who the status rests on, and
 * the full history. All agent text is plain text.
 */
export function ReviewDetails({
  project,
  relation,
  assertions,
  resolve,
  modelKeys,
  paneModels,
  onEvidence,
  autoAccept,
}: ReviewDetailsProps) {
  const proposal = assertions ? currentProposal(relation, assertions) : null;
  const evidence = proposal ? evidenceItems(proposal.evidence, modelKeys) : [];
  const fallback = provenanceOf(relation);
  const question = proposal?.question ?? null;
  const holdQuestion =
    relation.status === 'held' && relation.provenance?.question
      ? relation.provenance.question
      : null;

  return (
    <div className="flex flex-col gap-5" data-testid="review-details">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <TypeLabel type={relation.type} />
          <StatusBadge status={relation.status} />
          <TierBadge tier={relation.tier} />
          <EndpointStateBadge state={relation.endpointState} />
          <span className="ml-auto text-sm tabular-nums" title="Konfidenz">
            {formatConfidence(relation.confidence)}
          </span>
        </div>
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
          <dt className="pt-0.5 text-muted-foreground">Von</dt>
          <dd>
            <Endpoint label={resolve(relation.from)} />
          </dd>
          <dt className="pt-0.5 text-muted-foreground">Nach</dt>
          <dd>
            <Endpoint label={resolve(relation.to)} />
          </dd>
        </dl>
        <p className="font-mono text-xs text-muted-foreground">
          {relation.id} · Version {relation.version}
        </p>
      </div>

      {question ? (
        <div
          className="flex gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm"
          data-testid="agent-question"
        >
          <CircleHelpIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">Frage des Agenten</p>
            <PlainText text={question} />
          </div>
        </div>
      ) : null}
      {relation.noLinks.length > 0 ? (
        <div
          className="flex gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm"
          data-testid="agent-no-links"
        >
          <UnlinkIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <p className="font-medium">Kein Zusammenhang laut Agent</p>
            <ul className="flex flex-col gap-2">
              {relation.noLinks.map((n) => (
                <li
                  key={n.id}
                  data-testid="agent-no-link"
                  data-no-link-id={n.id}
                  className="flex min-w-0 flex-col gap-0.5"
                >
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    <Principal sourceKind="agent" handle={n.handle} />
                    <span>{formatDateTime(n.at)}</span>
                    <span className="min-w-0 truncate" title={n.origin}>
                      Analyse von <span className="font-mono">{n.origin}</span>
                    </span>
                  </span>
                  {n.reason.trim() ? (
                    <PlainText text={n.reason} />
                  ) : (
                    <p className="text-muted-foreground">Ohne Begründung.</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      {holdQuestion && holdQuestion !== question ? (
        <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm">
          <CircleHelpIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">Offene Frage (vorgemerkt)</p>
            <PlainText text={holdQuestion} />
            {relation.provenance?.label ? (
              <Badge variant="outline" className="mt-1 bg-card">
                <PlainText as="span" text={relation.provenance.label} />
              </Badge>
            ) : null}
          </div>
        </div>
      ) : null}

      <Section title="Begründung">
        {assertions === undefined ? (
          <Skeleton className="h-10 w-full" />
        ) : proposal?.rationale ? (
          <PlainText className="text-sm" text={proposal.rationale} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Keine Begründung angegeben
            {fallback.source === 'rule' ? ` (Regel: ${fallback.detail})` : ''}.
          </p>
        )}
      </Section>

      {evidence.length > 0 ? (
        <Section title="Belege">
          <ul className="flex flex-col gap-1">
            {evidence.map((item, i) => (
              <li key={i} className="min-w-0 text-sm">
                {item.kind === 'ref' && paneModels && !paneModels.has(item.modelKey) ? (
                  <Link
                    to="/projects/$project/models/$"
                    params={{ project, _splat: item.modelKey }}
                    search={{ element: item.elementId }}
                    data-testid="evidence-link"
                    className="inline-flex max-w-full items-center gap-1.5 rounded-sm text-link hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    title="Im Modell öffnen"
                  >
                    <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{resolve(item.text).label ?? item.elementId}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {item.modelKey}
                    </span>
                  </Link>
                ) : item.kind === 'ref' && onEvidence ? (
                  <button
                    type="button"
                    data-testid="evidence-ref"
                    onClick={() => onEvidence(item)}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-sm text-left text-link hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    title="Im Diagramm zeigen"
                  >
                    <CrosshairIcon className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{resolve(item.text).label ?? item.elementId}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {item.modelKey}
                    </span>
                  </button>
                ) : (
                  <PlainText as="span" className="text-muted-foreground" text={item.text} />
                )}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Separator />
      <Section title="Herkunft">
        {autoAccept && autoAccept.entries.length > 0 ? (
          <AutoAcceptProvenance
            project={project}
            entries={autoAccept.entries}
            canRevoke={autoAccept.canRevoke}
          />
        ) : null}
        {relation.provenance ? (
          <ProvenanceList provenance={relation.provenance} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {fallback.label} · {fallback.detail}
          </p>
        )}
      </Section>

      <Separator />
      <Section title="Verlauf">
        {assertions === undefined ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <AssertionTimeline
            assertions={assertions}
            renderLink={(a) => <RelationLink project={project} assertion={a} />}
            basisId={relation.provenance?.assertionId ?? null}
            marks={autoAccept?.marks}
          />
        )}
      </Section>
    </div>
  );
}
