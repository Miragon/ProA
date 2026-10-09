import type { Placement, ValueChainStep } from '@proa/client';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon, LocateIcon, MapIcon, SearchCheckIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { EndpointStateBadge, StatusBadge, TierBadge, ToneBadge } from '@/components/badges';
import { PlainText } from '@/components/review/plain-text';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, errorMessage } from '@/lib/api';
import { LINK_KINDS, REACHED_BY_CALL_LABEL, STEP_KINDS, formatConfidence } from '@/lib/labels';
import { valueChainStepQuery } from '@/lib/queries';
import { splitRef } from '@/lib/refs';
import { isOpenPlacement, isWebUrl, processCount } from '@/lib/value-chain';

import { valueChainStepRoute } from './value-chain-step';

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">
        {title}{' '}
        <span className="text-sm font-normal text-muted-foreground tabular-nums">({count})</span>
      </h3>
      {children}
    </section>
  );
}

function ProcessRow({
  project,
  placement: p,
  showStep,
}: {
  project: string;
  placement: Placement;
  showStep?: boolean;
}) {
  const { modelKey, elementId } = splitRef(p.process);
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-card px-3 py-2 text-sm"
      data-testid="step-view-placement"
      data-placement-id={p.id}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <PlainText as="span" className="truncate font-medium" text={p.processName ?? elementId} />
        <span className="truncate font-mono text-xs text-muted-foreground">{p.process}</span>
        {showStep ? (
          <span className="text-xs text-muted-foreground">
            auf <PlainText as="span" text={p.stepName ?? p.elementId} />
          </span>
        ) : null}
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={p.status} />
        <TierBadge tier={p.tier} />
        <EndpointStateBadge state={p.endpointState} />
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatConfidence(p.confidence)}
        </span>
      </span>
      <span className="flex gap-1">
        <Button variant="ghost" size="xs" asChild>
          <Link
            to="/projects/$project/models/$"
            params={{ project, _splat: modelKey }}
            search={{ element: elementId }}
          >
            <LocateIcon data-icon="inline-start" />
            Im Modell
          </Link>
        </Button>
        <Button variant="ghost" size="xs" asChild>
          <Link
            to="/projects/$project/value-chain"
            params={{ project }}
            search={{ placement: p.id }}
          >
            <MapIcon data-icon="inline-start" />
            Auf der Kette zeigen
          </Link>
        </Button>
      </span>
    </li>
  );
}

/**
 * A sub-step card: the processes homed on it (accepted or held) and its open
 * items (proposals and accepted placements to re-confirm), counted like the
 * canvas badges and the step tree.
 */
function SubStep({
  project,
  step,
  placements,
}: {
  project: string;
  step: ValueChainStep;
  /** The placements below the viewed step (`placements.subtree`). */
  placements: readonly Placement[];
}) {
  const total = step.counts.accepted + step.counts.held;
  const open = placements.filter(
    (p) => p.elementId === step.elementId && p.stepLive && isOpenPlacement(p),
  ).length;
  return (
    <li>
      <Link
        to="/projects/$project/value-chain/steps/$elementId"
        params={{ project, elementId: step.elementId }}
        className="flex flex-col gap-1 rounded-xl border bg-card p-3 text-sm transition-colors hover:border-primary focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        data-testid="sub-step"
      >
        <PlainText as="span" className="font-semibold" text={step.name || step.elementId} />
        <span className="text-xs text-muted-foreground">
          {[
            total > 0 || open === 0 ? processCount(total) : '',
            open > 0 ? `${open} offen` : '',
            step.childIds.length > 0 ? `${step.childIds.length} Unterschritte` : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </Link>
    </li>
  );
}

/** The step view of `valueChainStepRoute` (loaded with the route). */
export function StepView() {
  const { project, elementId } = valueChainStepRoute.useParams();
  const q = useQuery(valueChainStepQuery(project, elementId));
  const notFound = q.error instanceof ApiError && q.error.status === 404;

  if (q.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-80" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (notFound) {
    return (
      <Alert data-testid="step-not-found">
        <AlertTitle>Den Schritt „{elementId}“ gibt es in der aktuellen Revision nicht.</AlertTitle>
        <AlertDescription>
          Er wurde entfernt, oder die Kette fehlt.{' '}
          <Link
            to="/projects/$project/value-chain"
            params={{ project }}
            className="text-link underline"
          >
            Zur Wertschöpfungskette
          </Link>
        </AlertDescription>
      </Alert>
    );
  }
  if (q.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Schritt konnte nicht geladen werden</AlertTitle>
        <AlertDescription>{errorMessage(q.error)}</AlertDescription>
      </Alert>
    );
  }
  const { step, breadcrumb, children, placements } = q.data;
  const kind = STEP_KINDS[step.kind];
  return (
    <div className="flex flex-col gap-8" data-testid="step-view">
      <div className="flex flex-col gap-3">
        <nav
          aria-label="Pfad"
          className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground"
          data-testid="step-breadcrumb"
        >
          <Link
            to="/projects/$project/value-chain"
            params={{ project }}
            className="hover:text-foreground"
          >
            Wertschöpfungskette
          </Link>
          {breadcrumb.map((b) => (
            <span key={b.elementId} className="inline-flex items-center gap-1.5">
              <ChevronRightIcon className="size-4" aria-hidden />
              <Link
                to="/projects/$project/value-chain/steps/$elementId"
                params={{ project, elementId: b.elementId }}
                className="hover:text-foreground"
              >
                <PlainText as="span" text={b.name || b.elementId} />
              </Link>
            </span>
          ))}
          <ChevronRightIcon className="size-4" aria-hidden />
          <span className="text-foreground" aria-current="page">
            <PlainText as="span" text={step.name || step.elementId} />
          </span>
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          {/* The project layout holds the page's h1 (the project name). */}
          <h2 className="text-2xl font-bold" data-testid="step-view-title">
            <PlainText as="span" text={step.name || step.elementId} />
          </h2>
          <ToneBadge tone={kind.tone} title={kind.hint}>
            {kind.label}
          </ToneBadge>
          <Button variant="outline" size="sm" asChild className="ml-auto">
            <Link
              to="/projects/$project/value-chain"
              params={{ project }}
              search={{ step: step.elementId }}
            >
              <MapIcon data-icon="inline-start" />
              Auf der Kette zeigen
            </Link>
          </Button>
        </div>
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Verantwortlich</dt>
          <dd>{step.owners.length === 0 ? '–' : step.owners.map((o) => o.name).join(', ')}</dd>
          <dt className="text-muted-foreground">Link</dt>
          <dd className="min-w-0">
            {step.link === null ? (
              '–'
            ) : step.linkKind === 'process' && step.linkResolved && step.linkProcess ? (
              <Link
                to="/projects/$project/models/$"
                params={{ project, _splat: splitRef(step.linkProcess).modelKey }}
                search={{ element: splitRef(step.linkProcess).elementId }}
                className="font-mono text-xs text-link hover:underline"
              >
                {step.linkProcess}
              </Link>
            ) : step.linkKind === 'url' && isWebUrl(step.link) ? (
              <a
                href={step.link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-link hover:underline"
              >
                <PlainText as="span" text={step.link} />
              </a>
            ) : (
              <>
                <PlainText as="span" className="font-mono text-xs break-all" text={step.link} />{' '}
                <span className="text-xs text-warning">
                  ({LINK_KINDS[step.linkKind].label}, nicht auflösbar)
                </span>
              </>
            )}
          </dd>
        </dl>
      </div>

      {children.length > 0 ? (
        <Group title="Unterschritte" count={children.length}>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {children.map((c) => (
              <SubStep
                key={c.elementId}
                project={project}
                step={c}
                placements={placements.subtree}
              />
            ))}
          </ul>
        </Group>
      ) : null}

      <Group title="Prozesse dieses Schritts" count={placements.own.length}>
        {placements.own.length === 0 ? (
          <p className="text-sm text-muted-foreground">Auf diesem Schritt liegt kein Prozess.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {placements.own.map((p) => (
              <ProcessRow key={p.id} project={project} placement={p} />
            ))}
          </ul>
        )}
      </Group>

      {placements.subtree.length > 0 ? (
        <Group title="In den Unterschritten" count={placements.subtree.length}>
          <ul className="flex flex-col gap-2">
            {placements.subtree.map((p) => (
              <ProcessRow key={p.id} project={project} placement={p} showStep />
            ))}
          </ul>
        </Group>
      ) : null}

      {placements.reachedByCall.length > 0 ? (
        <Group title={REACHED_BY_CALL_LABEL} count={placements.reachedByCall.length}>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-normal text-muted-foreground">
                Prozesse, die Prozesse dieses Schritts über angenommene Aufrufe erreichen. Nur
                angezeigt, keine Platzierung.
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2" data-testid="reached-by-call">
                {placements.reachedByCall.map((r) => {
                  const { modelKey, elementId: processId } = splitRef(r.process);
                  return (
                    <li
                      key={r.process}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <PlainText as="span" className="font-medium" text={r.name ?? processId} />
                        <span className="font-mono text-xs text-muted-foreground">{r.process}</span>
                      </span>
                      <Button variant="ghost" size="xs" asChild>
                        <Link
                          to="/projects/$project/models/$"
                          params={{ project, _splat: modelKey }}
                          search={{ element: processId }}
                        >
                          <LocateIcon data-icon="inline-start" />
                          Im Modell
                        </Link>
                      </Button>
                      {r.via.map((v) => (
                        <Button key={v.relationId} variant="ghost" size="xs" asChild>
                          <Link
                            to="/projects/$project/review/$relation"
                            params={{ project, relation: v.relationId }}
                            data-testid="via-relation"
                          >
                            <SearchCheckIcon data-icon="inline-start" />
                            via {splitRef(v.caller).elementId}
                          </Link>
                        </Button>
                      ))}
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        </Group>
      ) : null}
    </div>
  );
}
