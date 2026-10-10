import type { Fact, Model } from '@proa/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createRoute } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  LocateIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { lazy, Suspense, useMemo, useState, useSyncExternalStore } from 'react';

import { EngineBadge, StageBadge } from '@/components/badges';
import { MiragonMark } from '@/components/page-shell';
import { DecisionPanel, type DecisionOutcome } from '@/components/review/decision-panel';
import { ReviewDetails } from '@/components/review/review-details';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ApiError, errorMessage } from '@/lib/api';
import { useAutoAcceptIndex } from '@/lib/auto-accept-actions';
import type { CanvasHighlight } from '@/lib/bpmn-elements';
import { useProjectPermissions } from '@/lib/permissions';
import {
  assertionsQuery,
  contentQuery,
  keys,
  landscapeQuery,
  modelsQuery,
  relationQuery,
} from '@/lib/queries';
import { splitRef } from '@/lib/refs';
import {
  heldList,
  neighbours,
  parseQueueFilters,
  reviewQueue,
  type QueueFilters,
} from '@/lib/review';
import { toast } from '@/lib/toast';
import { useProjectFacts } from '@/lib/use-project-facts';
import { useShortcuts } from '@/lib/use-shortcuts';

import { rootRoute } from './root';

const BpmnCanvas = lazy(() => import('@/components/bpmn-canvas'));

type PaneMode = 'both' | 'from' | 'to';

interface ReviewScreenSearch extends QueueFilters {
  /** Only one endpoint's model (narrow screens start with `from`). */
  pane?: 'from' | 'to';
  /** `held`: opened from the held list; J/K walk it and "Prüfliste" returns to it. */
  view?: 'held';
}

/**
 * The review screen of one relation (M2 item 7, `reviewUrl` of
 * `human-decision-required`): both endpoint models in bpmn-js side by side
 * (or one at a time), the details and history in the panel, the decision at
 * its foot. J/K (or the arrow keys) walk the inbox queue with its filters.
 */
export const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$project/review/$relation',
  validateSearch: (search: Record<string, unknown>): ReviewScreenSearch => ({
    ...parseQueueFilters(search),
    ...(search['pane'] === 'from' || search['pane'] === 'to' ? { pane: search['pane'] } : {}),
    ...(search['view'] === 'held' ? { view: 'held' as const } : {}),
  }),
  component: ReviewScreen,
});

const WIDE = '(min-width: 1280px)';

function subscribeWide(callback: () => void) {
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}

/** Side by side needs room; below 1280px the panes are switched instead. */
function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

interface FocusTarget {
  modelKey: string;
  elementId: string;
}

function Pane({
  project,
  relationId,
  side,
  modelKey,
  model,
  highlights,
  focus,
}: {
  project: string;
  relationId: string;
  side: 'from' | 'to' | 'both';
  /** Key of the endpoint's model, from the ref (the model may be deleted). */
  modelKey: string;
  model: Model | undefined;
  highlights: CanvasHighlight[];
  focus: string | null;
}) {
  const content = useQuery({
    ...contentQuery({
      project,
      modelId: model?.id ?? '',
      revisionId: model?.headRevisionId ?? '',
    }),
    enabled: model !== undefined,
  });
  const title = side === 'from' ? 'Von' : side === 'to' ? 'Nach' : 'Von und Nach';
  return (
    <section
      aria-label={`${title}: ${modelKey}`}
      data-testid="review-pane"
      data-side={side}
      className="relative min-w-0 flex-1 border-r border-border last:border-r-0"
    >
      {content.data ? (
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
            onImportError={(message) =>
              toast({
                tone: 'danger',
                title: 'Diagramm konnte nicht angezeigt werden',
                description: message,
              })
            }
          />
        </Suspense>
      ) : content.isError ? (
        <div className="absolute inset-x-4 top-1/3 z-20">
          <Alert variant="destructive">
            <AlertTitle>Modell konnte nicht geladen werden</AlertTitle>
            <AlertDescription>{errorMessage(content.error)}</AlertDescription>
          </Alert>
        </div>
      ) : !model ? (
        <div className="absolute inset-x-4 top-1/3 z-20" data-testid="pane-missing-model">
          <Alert>
            <TriangleAlertIcon />
            <AlertTitle>
              {title}: Modell „{modelKey}“ gibt es nicht mehr
            </AlertTitle>
            <AlertDescription>
              Das Modell wurde gelöscht, der Endpunkt fehlt. Lehne die Relation ab oder korrigiere
              sie.
            </AlertDescription>
          </Alert>
        </div>
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <Spinner className="size-6" />
        </div>
      )}
      {model ? (
        <div className="absolute bottom-4 left-4 z-30 flex max-w-[calc(100%-96px)] flex-wrap items-center gap-2 rounded-xl border bg-card/90 px-3 py-2 text-sm shadow-sm backdrop-blur-sm">
          <span className="font-semibold">{title}</span>
          <span className="truncate font-mono text-[13px]" title={model.key}>
            {model.key}
          </span>
          <EngineBadge engine={model.engine} />
          <StageBadge stage={model.stage} />
          <Button variant="ghost" size="xs" asChild>
            <Link
              to="/projects/$project/models/$"
              params={{ project, _splat: model.key }}
              search={{ relation: relationId }}
            >
              <LocateIcon data-icon="inline-start" />
              Im Modell
            </Link>
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function ReviewScreen() {
  const { project, relation: relationId } = reviewRoute.useParams();
  const search = reviewRoute.useSearch();
  const navigate = reviewRoute.useNavigate();
  const queryClient = useQueryClient();
  const wide = useWide();
  // A cited element belongs to one relation: another relation (J/K, a link,
  // the browser history) starts without it.
  const [cited, setCited] = useState<(FocusTarget & { relationId: string }) | null>(null);
  const evidence = cited?.relationId === relationId ? cited : null;

  const relationQ = useQuery(relationQuery(project, relationId));
  const assertions = useQuery(assertionsQuery(project, relationId));
  const landscape = useQuery(landscapeQuery(project));
  const models = useQuery(modelsQuery(project));
  const { resolve, byModel } = useProjectFacts(project, models.data);
  const can = useProjectPermissions(project);
  const owner = can.isOwner;
  const reviewer = can.canReview;
  const autoIndex = useAutoAcceptIndex(project);
  const facts = useMemo<Fact[]>(() => [...byModel.values()].flatMap((f) => f.facts), [byModel]);
  const modelKeys = useMemo(() => new Set((models.data ?? []).map((m) => m.key)), [models.data]);

  const { stage, tier, model: modelFilter } = search;
  const filters = useMemo<QueueFilters>(
    () => ({
      ...(stage ? { stage } : {}),
      ...(tier ? { tier } : {}),
      ...(modelFilter ? { model: modelFilter } : {}),
    }),
    [stage, tier, modelFilter],
  );
  const held = search.view === 'held';
  const queue = useMemo(
    () =>
      held
        ? heldList(landscape.data?.relations ?? [], models.data ?? [], filters).map((relation) => ({
            relation,
            finishes: 0,
          }))
        : reviewQueue(landscape.data?.relations ?? [], models.data ?? [], filters),
    [held, landscape.data, models.data, filters],
  );
  const listSearch = useMemo(
    () => ({ ...filters, ...(held ? { view: 'held' as const } : {}) }),
    [filters, held],
  );
  const nav = neighbours(queue, relationId);

  const relation = relationQ.data;
  const from = relation ? splitRef(relation.from) : null;
  const to = relation ? splitRef(relation.to) : null;
  const sameModel = from !== null && to !== null && from.modelKey === to.modelKey;
  const mode: PaneMode = sameModel ? 'both' : (search.pane ?? (wide ? 'both' : 'from'));
  const modelOf = (key: string | undefined) => models.data?.find((m) => m.key === key);
  /** Models with a pane on this screen: evidence into them is shown there. */
  const paneModels = new Set(from && to ? [from.modelKey, to.modelKey] : []);

  const goTo = (id: string) => {
    void navigate({
      to: '/projects/$project/review/$relation',
      params: { project, relation: id },
      search: { ...listSearch, ...(search.pane ? { pane: search.pane } : {}) },
    });
  };
  const toInbox = () =>
    void navigate({ to: '/projects/$project/review', params: { project }, search: listSearch });

  /** Shows a cited element; switches to its pane when only the other one is shown. */
  const showEvidence = (target: FocusTarget) => {
    setCited({ ...target, relationId });
    if (!from || !to || sameModel || mode === 'both') return;
    const side = target.modelKey === from.modelKey ? 'from' : 'to';
    if (side !== mode) {
      void navigate({ search: { ...listSearch, pane: side }, replace: true });
    }
  };

  useShortcuts({
    j: () => nav.next && goTo(nav.next.id),
    ArrowRight: () => nav.next && goTo(nav.next.id),
    k: () => nav.previous && goTo(nav.previous.id),
    ArrowLeft: () => nav.previous && goTo(nav.previous.id),
  });

  function onDecided(outcome: DecisionOutcome) {
    if (nav.index < 0) return; // not from the queue (held, decided): stay and show the result
    if (nav.next) goTo(nav.next.id);
    else {
      toast({
        tone: 'info',
        title: 'Liste abgearbeitet',
        description: held
          ? 'In dieser Liste ist nichts mehr vorgemerkt.'
          : outcome === 'hold'
            ? 'Vorgemerkte Relationen findest du unter „Vorgemerkt“.'
            : 'In dieser Liste ist kein Vorschlag mehr offen.',
      });
      toInbox();
    }
  }

  const highlightsFor = (modelKey: string): CanvasHighlight[] => {
    if (!from || !to) return [];
    const out: CanvasHighlight[] = [];
    if (from.modelKey === modelKey)
      out.push({ elementId: from.elementId, label: 'Von', tone: 'endpoint' });
    if (to.modelKey === modelKey)
      out.push({ elementId: to.elementId, label: 'Nach', tone: 'endpoint' });
    if (
      evidence &&
      evidence.modelKey === modelKey &&
      !out.some((h) => h.elementId === evidence.elementId)
    ) {
      out.push({ elementId: evidence.elementId, label: 'Beleg', tone: 'evidence' });
    }
    return out;
  };
  const focusFor = (modelKey: string, own: string | null): string | null =>
    evidence?.modelKey === modelKey ? evidence.elementId : own;

  const notFound = relationQ.error instanceof ApiError && relationQ.error.status === 404;
  const loadError = relationQ.error ?? models.error ?? landscape.error;

  return (
    <div
      className="relative h-app-viewport w-full overflow-hidden bg-paper bg-[radial-gradient(var(--cd-linie)_1px,transparent_1px)] [background-size:16px_16px]"
      data-testid="review-screen"
    >
      {relation && from && to && models.data ? (
        <div className="absolute inset-y-0 right-0 left-0 flex lg:right-[468px]">
          {mode === 'both' && sameModel ? (
            <Pane
              project={project}
              relationId={relation.id}
              side="both"
              modelKey={from.modelKey}
              model={modelOf(from.modelKey)}
              highlights={highlightsFor(from.modelKey)}
              focus={focusFor(from.modelKey, from.elementId)}
            />
          ) : null}
          {!sameModel && (mode === 'both' || mode === 'from') ? (
            <Pane
              key={`from:${from.modelKey}`}
              project={project}
              relationId={relation.id}
              side="from"
              modelKey={from.modelKey}
              model={modelOf(from.modelKey)}
              highlights={highlightsFor(from.modelKey)}
              focus={focusFor(from.modelKey, from.elementId)}
            />
          ) : null}
          {!sameModel && (mode === 'both' || mode === 'to') ? (
            <Pane
              key={`to:${to.modelKey}`}
              project={project}
              relationId={relation.id}
              side="to"
              modelKey={to.modelKey}
              model={modelOf(to.modelKey)}
              highlights={highlightsFor(to.modelKey)}
              focus={focusFor(to.modelKey, to.elementId)}
            />
          ) : null}
        </div>
      ) : null}

      {/* top left: where am I, queue position, pane mode */}
      <header className="absolute top-4 left-4 z-30 flex max-w-[calc(100vw-32px)] flex-wrap items-center gap-2 rounded-xl border bg-card/90 p-2 text-sm shadow-md backdrop-blur-sm lg:max-w-[calc(100vw-516px)]">
        <Link to="/" aria-label="Zu den Projekten" className="px-1">
          <MiragonMark className="size-5" />
        </Link>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/projects/$project/review" params={{ project }} search={listSearch}>
            <ArrowLeftIcon data-icon="inline-start" />
            {held ? 'Vorgemerkt' : 'Prüfliste'}
          </Link>
        </Button>
        <span className="text-muted-foreground tabular-nums" data-testid="queue-position">
          {nav.index >= 0
            ? `${nav.index + 1} von ${queue.length}`
            : queue.length > 0
              ? `nicht in der Liste (${queue.length} offen)`
              : held
                ? 'nichts vorgemerkt'
                : 'keine offenen Vorschläge'}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Vorheriger Vorschlag (K)"
            title="Vorheriger Vorschlag (K)"
            disabled={!nav.previous}
            onClick={() => nav.previous && goTo(nav.previous.id)}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Nächster Vorschlag (J)"
            title="Nächster Vorschlag (J)"
            disabled={!nav.next}
            onClick={() => nav.next && goTo(nav.next.id)}
          >
            <ChevronRightIcon />
          </Button>
        </div>
        {relation && !sameModel ? (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            value={mode}
            aria-label="Diagramme"
            onValueChange={(value) => {
              if (value !== 'both' && value !== 'from' && value !== 'to') return;
              void navigate({
                search: { ...listSearch, ...(value === 'both' ? {} : { pane: value }) },
                replace: true,
              });
            }}
          >
            <ToggleGroupItem value="both" disabled={!wide && mode !== 'both'}>
              Nebeneinander
            </ToggleGroupItem>
            <ToggleGroupItem value="from">Von</ToggleGroupItem>
            <ToggleGroupItem value="to">Nach</ToggleGroupItem>
          </ToggleGroup>
        ) : null}
      </header>

      {/* right: details, history and the decision */}
      <aside
        aria-label="Prüfung"
        className="absolute top-4 right-4 bottom-4 z-30 flex w-[440px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border bg-card/95 shadow-md backdrop-blur-sm"
      >
        <div className="flex-1 overflow-y-auto p-4">
          {relation ? (
            <ReviewDetails
              project={project}
              relation={relation}
              assertions={assertions.data}
              resolve={resolve}
              modelKeys={modelKeys}
              paneModels={paneModels}
              onEvidence={(item) =>
                showEvidence({ modelKey: item.modelKey, elementId: item.elementId })
              }
              autoAccept={
                reviewer
                  ? {
                      entries: autoIndex.bySubject.get(relation.id) ?? [],
                      marks: autoIndex.byAssertion,
                      canRevoke: owner,
                    }
                  : undefined
              }
            />
          ) : notFound ? (
            <Alert>
              <AlertTitle>Relation nicht gefunden</AlertTitle>
              <AlertDescription>
                Es gibt sie in „{project}“ nicht, oder du hast keinen Zugriff.{' '}
                <Link
                  to="/projects/$project/review"
                  params={{ project }}
                  className="text-link underline"
                >
                  Zur Prüfliste
                </Link>
              </AlertDescription>
            </Alert>
          ) : loadError ? (
            <Alert variant="destructive">
              <AlertTitle>Prüfung konnte nicht geladen werden</AlertTitle>
              <AlertDescription>{errorMessage(loadError)}</AlertDescription>
            </Alert>
          ) : (
            <div className="grid h-full place-items-center">
              <Spinner className="size-6" />
            </div>
          )}
        </div>
        {relation ? (
          <div className="flex flex-col gap-2 border-t bg-card p-4">
            {reviewer ? (
              <DecisionPanel
                project={project}
                relation={relation}
                resolve={resolve}
                facts={facts}
                onDecided={onDecided}
                onReload={() =>
                  void queryClient.invalidateQueries({ queryKey: keys.project(project) })
                }
              />
            ) : can.known ? (
              // Viewers and the read-only demo: no decision panel, so A/R/H/C do nothing.
              <p
                className="flex items-center gap-2 text-sm text-muted-foreground"
                data-testid="read-only-review"
              >
                <EyeIcon className="size-4 shrink-0" aria-hidden />
                {can.demo
                  ? 'Nur lesen – in der Demo entscheidest du nicht.'
                  : 'Nur lesen – entscheiden dürfen Bearbeiter und Inhaber.'}
              </p>
            ) : null}
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Kbd>J</Kbd>
                <Kbd>K</Kbd> weiter, zurück
              </span>
              {reviewer ? (
                <span className="inline-flex items-center gap-1">
                  <Kbd>A</Kbd> <Kbd>R</Kbd> <Kbd>H</Kbd> <Kbd>C</Kbd> entscheiden
                </span>
              ) : null}
            </p>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
