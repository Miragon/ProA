import type { Model, ModelStage } from '@proa/client';
import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Link, createRoute } from '@tanstack/react-router';
import { PlugIcon, UploadIcon } from 'lucide-react';
import { useMemo } from 'react';

import { ModelsTable } from '@/components/models-table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api';
import type { Engine } from '@/lib/engine';
import { STAGES, STAGE_ORDER } from '@/lib/labels';
import { contentQuery, modelsQuery, type RevisionContent } from '@/lib/queries';

import { projectRoute } from './project';
import { MiragonMark } from '@/components/page-shell';

interface ModelsSearch {
  stage?: ModelStage;
}

export const projectModelsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): ModelsSearch => {
    const stage = search['stage'];
    return typeof stage === 'string' && (STAGE_ORDER as readonly string[]).includes(stage)
      ? { stage: stage as ModelStage }
      : {};
  },
  component: ModelsTab,
});

function combineEngines(results: UseQueryResult<RevisionContent>[]) {
  return results.map((r) => (r.data ? r.data.engine : r.isError ? null : undefined));
}

function ModelsTab() {
  const { project } = projectModelsRoute.useParams();
  const { stage } = projectModelsRoute.useSearch();
  const navigate = projectModelsRoute.useNavigate();
  const models = useQuery(modelsQuery(project));
  const list = useMemo(() => models.data ?? [], [models.data]);
  // The API has no engine field yet: read it from each head revision's bytes (cached per revision).
  const engines = useQueries({
    queries: list.map((m) =>
      contentQuery({ project, modelId: m.id, revisionId: m.headRevisionId }),
    ),
    combine: combineEngines,
  });
  const engineById = useMemo(() => {
    const map = new Map<string, Engine | null | undefined>();
    list.forEach((m, i) => map.set(m.id, engines[i]));
    return map;
  }, [list, engines]);

  if (models.isPending) return <Skeleton className="h-40 w-full" />;
  if (models.isError)
    return (
      <Alert variant="destructive">
        <AlertTitle>Modelle konnten nicht geladen werden</AlertTitle>
        <AlertDescription>{errorMessage(models.error)}</AlertDescription>
      </Alert>
    );
  if (list.length === 0)
    return (
      <Empty className="border bg-card py-12">
        <EmptyHeader>
          <EmptyMedia>
            <MiragonMark className="size-12" />
          </EmptyMedia>
          <EmptyTitle className="text-base font-semibold">Noch keine Modelle</EmptyTitle>
          <EmptyDescription>
            Lade BPMN-Dateien hoch. ProA liest die Fakten, verknüpft eindeutige Aufrufe sofort und
            schlägt gleiche Nachrichtennamen als Relationen vor.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button asChild>
            <Link to="/projects/$project/upload" params={{ project }}>
              <UploadIcon data-icon="inline-start" />
              Modelle hochladen
            </Link>
          </Button>
          <Button variant="ghost" asChild>
            <Link to="/projects/$project/agents" params={{ project }}>
              <PlugIcon data-icon="inline-start" />
              Agent verbinden
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
    );

  const visible = stage ? list.filter((m) => m.stage === stage) : list;
  const sorted = [...visible].sort((a, b) => a.key.localeCompare(b.key));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-auto">
          <FieldLabel htmlFor="filter-stage">Stufe</FieldLabel>
          <NativeSelect
            id="filter-stage"
            value={stage ?? ''}
            onChange={(e) =>
              void navigate({
                search: e.target.value === '' ? {} : { stage: e.target.value as ModelStage },
              })
            }
          >
            <NativeSelectOption value="">Alle Stufen</NativeSelectOption>
            {STAGE_ORDER.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {STAGES[s].label} ({list.filter((m) => m.stage === s).length})
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <p className="ml-auto text-sm text-muted-foreground">
          {sorted.length === list.length
            ? `${list.length} Modelle`
            : `${sorted.length} von ${list.length} Modellen`}
        </p>
      </div>
      <div className="rounded-xl border bg-card">
        <ModelsTable
          models={sorted}
          engineOf={(m: Model) => engineById.get(m.id)}
          renderKey={(m) => (
            <Link
              to="/projects/$project/models/$"
              params={{ project, _splat: m.key }}
              className="text-link hover:underline"
            >
              {m.key}
            </Link>
          )}
        />
      </div>
    </div>
  );
}
