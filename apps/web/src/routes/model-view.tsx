import type { Finding, Relation } from '@proa/client';
import { useQuery } from '@tanstack/react-query';
import { Link, createRoute } from '@tanstack/react-router';
import { cn } from 'cn';
import {
  ArrowDownLeftIcon,
  ArrowLeftIcon,
  ArrowRightLeftIcon,
  ArrowUpRightIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { lazy, Suspense, useMemo } from 'react';

import { EngineBadge, StageBadge, StatusBadge, TierBadge, TYPE_ICONS } from '@/components/badges';
import { MiragonMark } from '@/components/page-shell';
import { toast } from '@/lib/toast';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import type { CanvasHighlight } from '@/lib/bpmn-elements';
import { FINDING_KINDS, RELATION_TYPES, formatConfidence } from '@/lib/labels';
import { contentQuery, landscapeQuery, modelsQuery } from '@/lib/queries';
import { splitRef, type RefLabel, type RefResolver } from '@/lib/refs';
import { touchesModel } from '@/lib/relation-filters';
import { useProjectFacts } from '@/lib/use-project-facts';

import { rootRoute } from './root';

const BpmnCanvas = lazy(() => import('@/components/bpmn-canvas'));

interface ModelViewSearch {
  /** Selected relation (`rel_…`): its endpoints are highlighted. */
  relation?: string;
  /** Selected element id, e.g. from a finding or a click on the canvas. */
  element?: string;
}

export const modelViewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$project/models/$',
  validateSearch: (search: Record<string, unknown>): ModelViewSearch => {
    const out: ModelViewSearch = {};
    if (typeof search['relation'] === 'string' && search['relation'] !== '')
      out.relation = search['relation'];
    if (typeof search['element'] === 'string' && search['element'] !== '')
      out.element = search['element'];
    return out;
  },
  component: ModelView,
});

function shortLabel(label: RefLabel): string {
  return label.label ?? label.elementId;
}

/** The relation as seen from the model in view: local end, remote end, direction. */
function perspective(relation: Relation, modelKey: string, resolve: RefResolver) {
  const outgoing = splitRef(relation.from).modelKey === modelKey;
  const local = resolve(outgoing ? relation.from : relation.to);
  const remote = resolve(outgoing ? relation.to : relation.from);
  return { outgoing, local, remote };
}

function RelationItem({
  relation,
  modelKey,
  resolve,
  selected,
  project,
}: {
  relation: Relation;
  modelKey: string;
  resolve: RefResolver;
  selected: boolean;
  project: string;
}) {
  const { outgoing, local, remote } = perspective(relation, modelKey, resolve);
  const TypeIcon = TYPE_ICONS[relation.type];
  const Direction = outgoing ? ArrowUpRightIcon : ArrowDownLeftIcon;
  const sameModel = remote.modelKey === modelKey;
  return (
    <li
      data-testid="model-relation"
      data-relation-id={relation.id}
      data-selected={selected}
      className={cn(
        'rounded-lg border transition-colors',
        selected ? 'border-primary bg-accent' : 'border-transparent hover:bg-muted',
      )}
    >
      <Link
        from={modelViewRoute.fullPath}
        to="."
        search={selected ? {} : { relation: relation.id }}
        replace
        aria-current={selected ? 'true' : undefined}
        className="flex flex-col gap-1.5 rounded-lg p-2.5 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <TypeIcon className="size-3.5" aria-hidden />
          {RELATION_TYPES[relation.type].label}
          <Direction className="size-3.5" aria-hidden />
          {outgoing ? 'ausgehend' : 'eingehend'}
          <span className="ml-auto tabular-nums">{formatConfidence(relation.confidence)}</span>
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{shortLabel(local)}</span>
          <span className="truncate text-xs text-muted-foreground">
            {outgoing ? 'nach' : 'von'} {shortLabel(remote)} ·{' '}
            <span className="font-mono">{remote.modelKey}</span>
          </span>
        </span>
        <span className="flex flex-wrap gap-1">
          <StatusBadge status={relation.status} />
          <TierBadge tier={relation.tier} />
        </span>
      </Link>
      {selected && local.kind === 'process' ? (
        <p className="px-2.5 pb-2 text-xs text-muted-foreground">
          Endpunkt in diesem Modell ist der Prozess „{shortLabel(local)}“ als Ganzes.
        </p>
      ) : null}
      {selected && !sameModel ? (
        <div className="px-2.5 pb-2.5">
          <Button size="sm" asChild className="w-full">
            <Link
              to="/projects/$project/models/$"
              params={{ project, _splat: remote.modelKey }}
              search={{ relation: relation.id }}
              data-testid="switch-model"
            >
              <ArrowRightLeftIcon data-icon="inline-start" />
              Zu {remote.modelKey} wechseln
            </Link>
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function FindingItem({
  finding,
  elementId,
  selected,
}: {
  finding: Finding;
  elementId: string;
  selected: boolean;
}) {
  return (
    <li
      className={cn(
        'rounded-lg border',
        selected ? 'border-warning bg-warning-soft' : 'border-transparent hover:bg-muted',
      )}
    >
      <Link
        from={modelViewRoute.fullPath}
        to="."
        search={selected ? {} : { element: elementId }}
        replace
        className="flex flex-col gap-1 rounded-lg p-2.5 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="flex items-center gap-1.5 text-xs font-medium text-warning">
          <TriangleAlertIcon className="size-3.5" aria-hidden />
          {FINDING_KINDS[finding.kind].label}
        </span>
        <span className="font-mono text-xs break-all">{elementId}</span>
        {finding.detail ? (
          <span className="text-xs text-muted-foreground">{finding.detail}</span>
        ) : null}
      </Link>
    </li>
  );
}

function ModelView() {
  const { project, _splat } = modelViewRoute.useParams();
  const modelKey = (_splat ?? '').replace(/\/+$/, '');
  const search = modelViewRoute.useSearch();
  const navigate = modelViewRoute.useNavigate();

  const models = useQuery(modelsQuery(project));
  const landscape = useQuery(landscapeQuery(project));
  const model = models.data?.find((m) => m.key === modelKey);
  const content = useQuery({
    ...contentQuery({
      project,
      modelId: model?.id ?? '',
      revisionId: model?.headRevisionId ?? '',
    }),
    enabled: model !== undefined,
  });
  const { resolve } = useProjectFacts(project, models.data);

  const relations = useMemo(
    () => (landscape.data?.relations ?? []).filter((r) => touchesModel(r, modelKey)),
    [landscape.data, modelKey],
  );
  const findings = useMemo(
    () =>
      (landscape.data?.findings ?? []).flatMap((f) =>
        f.refs
          .filter((ref) => splitRef(ref).modelKey === modelKey)
          .map((ref) => ({ finding: f, elementId: splitRef(ref).elementId })),
      ),
    [landscape.data, modelKey],
  );
  const selected = relations.find((r) => r.id === search.relation);
  const listed = search.element
    ? relations.filter((r) => {
        const { from, to } = { from: splitRef(r.from), to: splitRef(r.to) };
        return (
          (from.modelKey === modelKey && from.elementId === search.element) ||
          (to.modelKey === modelKey && to.elementId === search.element)
        );
      })
    : relations;

  const highlights = useMemo<CanvasHighlight[]>(() => {
    if (selected) {
      const out: CanvasHighlight[] = [];
      const from = splitRef(selected.from);
      const to = splitRef(selected.to);
      if (from.modelKey === modelKey)
        out.push({ elementId: from.elementId, label: 'Von', tone: 'endpoint' });
      if (to.modelKey === modelKey)
        out.push({ elementId: to.elementId, label: 'Nach', tone: 'endpoint' });
      return out;
    }
    if (search.element) {
      const hasFinding = findings.some((f) => f.elementId === search.element);
      return [
        {
          elementId: search.element,
          label: hasFinding ? 'Befund' : 'Auswahl',
          tone: hasFinding ? 'finding' : 'endpoint',
        },
      ];
    }
    // Overview: every endpoint in this model, dashed, without labels.
    const ids = new Set<string>();
    for (const r of relations) {
      for (const ref of [r.from, r.to]) {
        const { modelKey: key, elementId } = splitRef(ref);
        if (key === modelKey) ids.add(elementId);
      }
    }
    return [...ids].map((elementId) => ({ elementId, label: '', tone: 'related' as const }));
  }, [selected, search.element, relations, findings, modelKey]);

  const focus = selected ? (highlights[0]?.elementId ?? null) : (search.element ?? null);

  const loadError = models.error ?? landscape.error ?? content.error;

  return (
    <div
      className="relative h-svh w-full overflow-hidden bg-paper bg-[radial-gradient(var(--cd-linie)_1px,transparent_1px)] [background-size:16px_16px]"
      data-testid="model-view"
    >
      {content.data ? (
        <div className="absolute inset-y-0 right-0 left-0 md:right-[400px]">
          <Suspense
            fallback={
              <div className="absolute inset-0 grid place-items-center">
                <Spinner />
              </div>
            }
          >
            <BpmnCanvas
              xml={content.data.xml}
              highlights={highlights}
              focus={focus}
              onElementClick={(elementId) => {
                if (elementId === search.element) return;
                void navigate({ search: { element: elementId }, replace: true });
              }}
              onImportError={(message) =>
                toast({
                  tone: 'danger',
                  title: 'Diagramm konnte nicht angezeigt werden',
                  description: message,
                })
              }
            />
          </Suspense>
        </div>
      ) : null}

      {/* top left: where am I */}
      <header className="absolute top-4 left-4 z-30 flex max-w-[min(480px,calc(100vw-440px))] flex-col gap-2 rounded-xl border bg-card/90 p-3 shadow-md backdrop-blur-sm">
        <div className="flex items-center gap-2 text-sm">
          <Link to="/" aria-label="Zu den Projekten">
            <MiragonMark className="size-5" />
          </Link>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/projects/$project/relations" params={{ project }}>
              <ArrowLeftIcon data-icon="inline-start" />
              Relationen
            </Link>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/projects/$project" params={{ project }}>
              Modelle
            </Link>
          </Button>
        </div>
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate font-mono text-base font-semibold" title={modelKey}>
            {modelKey}
          </h1>
          {model?.name ? (
            <p className="truncate text-sm text-muted-foreground">{model.name}</p>
          ) : null}
        </div>
        {model ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <EngineBadge engine={content.data?.engine} />
            <Badge variant="outline" title="Kopfrevision">
              r{model.headRev}
            </Badge>
            <StageBadge stage={model.stage} />
          </div>
        ) : null}
      </header>

      {/* right: relations and findings of this model */}
      <aside
        aria-label="Relationen und Befunde dieses Modells"
        className="absolute top-4 right-4 bottom-32 z-30 flex w-[380px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border bg-card/95 shadow-md backdrop-blur-sm"
      >
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <h2 className="font-semibold">Relationen</h2>
          <span className="text-sm text-muted-foreground tabular-nums">
            {listed.length === relations.length
              ? relations.length
              : `${listed.length} von ${relations.length}`}
          </span>
          {search.element ? (
            <Button
              variant="ghost"
              size="xs"
              className="ml-auto"
              onClick={() => void navigate({ search: {}, replace: true })}
            >
              <XIcon data-icon="inline-start" />
              <span className="max-w-32 truncate font-mono">{search.element}</span>
            </Button>
          ) : null}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {landscape.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : listed.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              {search.element
                ? 'Dieses Element hat keine Relation.'
                : 'Dieses Modell hat noch keine Relation zu anderen Modellen.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {listed.map((r) => (
                <RelationItem
                  key={r.id}
                  relation={r}
                  modelKey={modelKey}
                  resolve={resolve}
                  selected={r.id === selected?.id}
                  project={project}
                />
              ))}
            </ul>
          )}
          {findings.length > 0 ? (
            <>
              <Separator className="my-2" />
              <h3 className="px-2 pb-1 text-sm font-semibold">Befunde ({findings.length})</h3>
              <ul className="flex flex-col gap-1">
                {findings.map(({ finding, elementId }) => (
                  <FindingItem
                    key={`${finding.kind}:${elementId}`}
                    finding={finding}
                    elementId={elementId}
                    selected={search.element === elementId && !selected}
                  />
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </aside>

      {/* bottom left: legend */}
      <p className="absolute bottom-4 left-4 z-30 flex items-center gap-3 rounded-lg border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-4 rounded-sm border-2 border-primary" />
          gewählter Endpunkt
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-3 w-4 rounded-sm border-2 border-dashed border-link"
          />
          hat Relationen
        </span>
        <span>Klick auf ein Element filtert die Liste.</span>
      </p>

      {loadError ? (
        <div className="absolute inset-x-0 top-1/3 z-40 mx-auto w-[min(480px,calc(100vw-32px))]">
          <Alert variant="destructive" className="shadow-md">
            <AlertTitle>Modell konnte nicht geladen werden</AlertTitle>
            <AlertDescription>{errorMessage(loadError)}</AlertDescription>
          </Alert>
        </div>
      ) : models.data && !model ? (
        <div className="absolute inset-x-0 top-1/3 z-40 mx-auto w-[min(480px,calc(100vw-32px))]">
          <Alert className="shadow-md">
            <AlertTitle>Modell „{modelKey}“ gibt es nicht</AlertTitle>
            <AlertDescription>
              Es wurde gelöscht oder nie hochgeladen.{' '}
              <Link to="/projects/$project" params={{ project }} className="text-link underline">
                Zur Modellliste
              </Link>
            </AlertDescription>
          </Alert>
        </div>
      ) : !content.data ? (
        <div className="absolute inset-0 grid place-items-center">
          <Spinner className="size-6" />
        </div>
      ) : null}
    </div>
  );
}
