import type { AnalysisTask, Fact, Model, ModelStage, Tier } from '@proa/client';
import { useQuery } from '@tanstack/react-query';
import { Link, createRoute } from '@tanstack/react-router';
import { CheckCheckIcon, FilterXIcon, PlugIcon, RotateCcwIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

import { StageBadge } from '@/components/badges';
import { BulkAcceptDialog } from '@/components/review/bulk-accept-dialog';
import { HeldList } from '@/components/review/held-list';
import { PlainText } from '@/components/review/plain-text';
import { QueueTable } from '@/components/review/queue-table';
import { StageBar } from '@/components/review/stage-bar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorMessage } from '@/lib/api';
import { nameUsage } from '@/lib/generic-names';
import { STAGES, TIERS, TIER_ORDER, formatDateTime } from '@/lib/labels';
import { analysesQuery, landscapeQuery, modelsQuery } from '@/lib/queries';
import {
  heldList,
  parseQueueFilters,
  proposalsByTier,
  reviewQueue,
  stageCounts,
  type QueueFilters,
} from '@/lib/review';
import { useRequeue } from '@/lib/review-actions';
import { toast } from '@/lib/toast';
import { useProjectFacts } from '@/lib/use-project-facts';

import { projectRoute } from './project';

interface ReviewSearch extends QueueFilters {
  /** `held`: the list of held relations instead of the proposals. */
  view?: 'held';
}

export const projectReviewRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'review',
  validateSearch: (search: Record<string, unknown>): ReviewSearch => ({
    ...parseQueueFilters(search),
    ...(search['view'] === 'held' ? { view: 'held' as const } : {}),
  }),
  component: ReviewInbox,
});

/** Tasks of the stages where the task says more than the model (who works, why it failed). */
const TASK_STATE: Partial<Record<ModelStage, AnalysisTask['state']>> = {
  waiting_for_agent: 'queued',
  agent_working: 'claimed',
  agent_failed: 'failed',
};

function StageModels({
  project,
  stage,
  models,
  onModel,
}: {
  project: string;
  stage: ModelStage;
  models: readonly Model[];
  onModel: (key: string) => void;
}) {
  const state = TASK_STATE[stage];
  const tasks = useQuery({ ...analysesQuery(project, state ?? 'queued'), enabled: !!state });
  const requeue = useRequeue(project);
  const inStage = models
    .filter((m) => m.stage === stage)
    .sort((a, b) => a.key.localeCompare(b.key));
  const taskOf = new Map<string, AnalysisTask>();
  for (const t of tasks.data ?? []) if (!taskOf.has(t.modelKey)) taskOf.set(t.modelKey, t);

  if (inStage.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="stage-models">
        Kein Modell in der Phase „{STAGES[stage].label}“.
      </p>
    );
  }
  return (
    <div className="rounded-xl border bg-card" data-testid="stage-models">
      <Table aria-label={`Modelle: ${STAGES[stage].label}`}>
        <TableHeader>
          <TableRow>
            <TableHead>Modell</TableHead>
            <TableHead>Phase</TableHead>
            <TableHead className="text-right">Offen</TableHead>
            <TableHead>Analyse</TableHead>
            <TableHead>
              <span className="sr-only">Aktion</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {inStage.map((m) => {
            const task = taskOf.get(m.key);
            // Nothing runs on a timer: until an agent asks for work again, an
            // expired lease still says "Agent arbeitet". Requeue it from here.
            const expired =
              stage === 'agent_working' &&
              task?.leaseUntil != null &&
              Date.parse(task.leaseUntil) < tasks.dataUpdatedAt;
            return (
              <TableRow key={m.id} data-testid="stage-model-row">
                <TableCell className="whitespace-normal">
                  <Link
                    to="/projects/$project/models/$"
                    params={{ project, _splat: m.key }}
                    className="font-mono text-[13px] text-link hover:underline"
                  >
                    {m.key}
                  </Link>
                  {m.name ? <p className="text-xs text-muted-foreground">{m.name}</p> : null}
                </TableCell>
                <TableCell>
                  <StageBadge stage={m.stage} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{m.openItems}</TableCell>
                <TableCell className="text-xs whitespace-normal text-muted-foreground">
                  {!state ? (
                    '–'
                  ) : !task ? (
                    tasks.isPending ? (
                      <Skeleton className="h-4 w-32" />
                    ) : (
                      '–'
                    )
                  ) : stage === 'agent_working' ? (
                    <>
                      <span className="font-mono">{task.claimedBy ?? 'Agent'}</span>, Versuch{' '}
                      {task.attempts},{' '}
                      {expired ? (
                        <span className="text-warning" data-testid="lease-expired">
                          Lease abgelaufen am{' '}
                          {task.leaseUntil ? formatDateTime(task.leaseUntil) : '–'}
                        </span>
                      ) : (
                        <>Lease bis {task.leaseUntil ? formatDateTime(task.leaseUntil) : '–'}</>
                      )}
                    </>
                  ) : stage === 'agent_failed' ? (
                    <>
                      Nach {task.attempts} Versuchen gescheitert
                      {task.lastError ? (
                        <>
                          : <PlainText as="span" text={task.lastError} />
                        </>
                      ) : null}
                    </>
                  ) : (
                    <>Eingeplant am {formatDateTime(task.createdAt)}</>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {stage === 'agent_failed' || expired ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={requeue.isPending}
                      onClick={() =>
                        requeue.mutate([m.key], {
                          onSuccess: () =>
                            toast({
                              tone: 'success',
                              title: 'Erneut eingeplant',
                              description: `${m.key} wartet wieder auf einen Agenten.`,
                            }),
                          onError: (error) =>
                            toast({
                              tone: 'danger',
                              title: 'Nicht eingeplant',
                              description: errorMessage(error),
                            }),
                        })
                      }
                    >
                      <RotateCcwIcon data-icon="inline-start" />
                      Erneut einplanen
                    </Button>
                  ) : m.openItems > 0 ? (
                    <Button variant="ghost" size="sm" onClick={() => onModel(m.key)}>
                      {stage === 'waiting_for_clarification'
                        ? 'Vorgemerkte zeigen'
                        : 'Vorschläge zeigen'}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

const ALL = '';

function ReviewInbox() {
  const { project } = projectReviewRoute.useParams();
  const search = projectReviewRoute.useSearch();
  const navigate = projectReviewRoute.useNavigate();
  const landscape = useQuery(landscapeQuery(project));
  const models = useQuery(modelsQuery(project));
  const { resolve, byModel } = useProjectFacts(project, models.data);
  const [bulkTier, setBulkTier] = useState<Tier | null>(null);

  const { stage, tier, model } = search;
  const filters = useMemo<QueueFilters>(
    () => ({
      ...(stage ? { stage } : {}),
      ...(tier ? { tier } : {}),
      ...(model ? { model } : {}),
    }),
    [stage, tier, model],
  );
  const modelList = useMemo(() => models.data ?? [], [models.data]);
  const relations = useMemo(() => landscape.data?.relations ?? [], [landscape.data]);
  const queue = useMemo(
    () => reviewQueue(relations, modelList, filters),
    [relations, modelList, filters],
  );
  const held = useMemo(
    () => heldList(relations, modelList, filters),
    [relations, modelList, filters],
  );
  const counts = useMemo(() => stageCounts(modelList), [modelList]);
  const facts = useMemo<Fact[]>(() => [...byModel.values()].flatMap((f) => f.facts), [byModel]);
  const usage = useMemo(() => nameUsage(facts), [facts]);
  const groups = proposalsByTier(queue);
  const bulkItems = groups.find((g) => g.tier === bulkTier)?.items ?? [];

  const set = (patch: Partial<ReviewSearch>) => {
    const next: ReviewSearch = { ...search, ...patch };
    for (const key of Object.keys(next) as (keyof ReviewSearch)[]) {
      if (next[key] === undefined) delete next[key];
    }
    void navigate({ search: next, replace: true });
  };

  if (landscape.isPending || models.isPending) return <Skeleton className="h-60 w-full" />;
  if (landscape.isError || models.isError)
    return (
      <Alert variant="destructive">
        <AlertTitle>Prüfliste konnte nicht geladen werden</AlertTitle>
        <AlertDescription>{errorMessage(landscape.error ?? models.error)}</AlertDescription>
      </Alert>
    );

  const filtered = filters.tier !== undefined || filters.model !== undefined;
  const modelKeys = modelList.map((m) => m.key).sort();

  return (
    <div className="flex flex-col gap-5">
      <StageBar counts={counts} selected={search.stage} onSelect={(stage) => set({ stage })} />
      {search.stage ? (
        <StageModels
          project={project}
          stage={search.stage}
          models={modelList}
          onModel={(model) =>
            // Models waiting for clarification have only held items: show those.
            set({ model, view: search.stage === 'waiting_for_clarification' ? 'held' : undefined })
          }
        />
      ) : null}

      <Tabs
        value={search.view ?? 'proposals'}
        onValueChange={(value) => set({ view: value === 'held' ? 'held' : undefined })}
      >
        <TabsList variant="line" aria-label="Prüfliste">
          <TabsTrigger value="proposals">
            Vorschläge <span className="tabular-nums">{queue.length}</span>
          </TabsTrigger>
          <TabsTrigger value="held">
            Vorgemerkt <span className="tabular-nums">{held.length}</span>
          </TabsTrigger>
        </TabsList>

        <div
          className="flex flex-wrap items-end gap-3 pt-2"
          role="search"
          aria-label="Prüfliste filtern"
        >
          <Field className="w-auto">
            <FieldLabel htmlFor="review-tier">Stufe</FieldLabel>
            <NativeSelect
              id="review-tier"
              value={search.tier ?? ALL}
              onChange={(e) =>
                set({ tier: e.target.value === ALL ? undefined : (e.target.value as Tier) })
              }
            >
              <NativeSelectOption value={ALL}>Alle Stufen</NativeSelectOption>
              {TIER_ORDER.map((t) => (
                <NativeSelectOption key={t} value={t}>
                  {TIERS[t].label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field className="w-auto min-w-56">
            <FieldLabel htmlFor="review-model">Modell</FieldLabel>
            <NativeSelect
              id="review-model"
              className="w-full"
              value={search.model ?? ALL}
              onChange={(e) => set({ model: e.target.value === ALL ? undefined : e.target.value })}
            >
              <NativeSelectOption value={ALL}>Alle Modelle</NativeSelectOption>
              {modelKeys.map((key) => (
                <NativeSelectOption key={key} value={key}>
                  {key}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          {filtered || search.stage ? (
            <Button
              variant="ghost"
              onClick={() => set({ tier: undefined, model: undefined, stage: undefined })}
            >
              <FilterXIcon data-icon="inline-start" />
              Filter zurücksetzen
            </Button>
          ) : null}
          {search.view !== 'held' && groups.length > 0 ? (
            <div
              className="ml-auto flex flex-wrap items-center gap-2"
              role="group"
              aria-label="Sammelannahme je Stufe"
            >
              {groups.map((g) => (
                <Button
                  key={g.tier}
                  variant={g.tier === 'key' ? 'default' : 'outline'}
                  onClick={() => setBulkTier(g.tier)}
                  data-testid="bulk-open"
                  data-tier={g.tier}
                >
                  <CheckCheckIcon data-icon="inline-start" />
                  {TIERS[g.tier].label}: {g.items.length} annehmen…
                </Button>
              ))}
            </div>
          ) : null}
        </div>

        <TabsContent value="proposals" className="pt-2">
          {queue.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border bg-card">
              <QueueTable project={project} items={queue} resolve={resolve} filters={filters} />
            </div>
          ) : (
            <Empty className="border bg-card py-10">
              <EmptyHeader>
                <EmptyTitle className="text-base font-semibold">
                  {filtered || search.stage
                    ? 'Kein offener Vorschlag passt zu den Filtern'
                    : 'Keine offenen Vorschläge'}
                </EmptyTitle>
                <EmptyDescription>
                  {counts.waiting_for_agent > 0
                    ? `${counts.waiting_for_agent} ${counts.waiting_for_agent === 1 ? 'Modell wartet' : 'Modelle warten'} auf einen Agenten. Verbinde einen Agenten, der die Analyse-Pipeline abarbeitet; seine Vorschläge erscheinen hier.`
                    : 'Alles geprüft. Neue Vorschläge erscheinen hier, sobald ein Agent oder eine Regel sie macht.'}
                </EmptyDescription>
              </EmptyHeader>
              {counts.waiting_for_agent > 0 ? (
                <EmptyContent>
                  <Button variant="outline" asChild>
                    <Link to="/projects/$project/agents" params={{ project }}>
                      <PlugIcon data-icon="inline-start" />
                      Agent verbinden
                    </Link>
                  </Button>
                </EmptyContent>
              ) : null}
            </Empty>
          )}
        </TabsContent>
        <TabsContent value="held" className="pt-2">
          <HeldList project={project} relations={held} resolve={resolve} filters={filters} />
        </TabsContent>
      </Tabs>

      {bulkTier ? (
        <BulkAcceptDialog
          project={project}
          tier={bulkTier}
          relations={bulkItems}
          resolve={resolve}
          usage={usage}
          open={bulkTier !== null}
          onOpenChange={(open) => {
            if (!open) setBulkTier(null);
          }}
        />
      ) : null}
    </div>
  );
}
