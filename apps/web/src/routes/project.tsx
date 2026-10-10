import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, createRoute } from '@tanstack/react-router';
import { ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { PageShell } from '@/components/page-shell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, errorMessage } from '@/lib/api';
import { landscapeQuery, modelsQuery, projectQuery, valueChainQuery } from '@/lib/queries';
import { isReviewItem } from '@/lib/review';
import { openPlacementCount } from '@/lib/value-chain';

import { rootRoute } from './root';

export const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$project',
  component: ProjectLayout,
});

function TabLink({
  to,
  children,
  count,
  hint,
  exact = false,
}: {
  to:
    | '/projects/$project'
    | '/projects/$project/review'
    | '/projects/$project/value-chain'
    | '/projects/$project/relations'
    | '/projects/$project/findings'
    | '/projects/$project/upload'
    | '/projects/$project/agents'
    | '/projects/$project/rules';
  children: ReactNode;
  count?: number | undefined;
  /** What the count counts, for screen readers. */
  hint?: string;
  exact?: boolean;
}) {
  const { project } = projectRoute.useParams();
  return (
    <Link
      to={to}
      params={{ project }}
      activeOptions={{ exact, includeSearch: false }}
      className="relative inline-flex items-center gap-1.5 rounded-md px-1 pt-1 pb-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none data-[status=active]:text-foreground data-[status=active]:after:absolute data-[status=active]:after:inset-x-0 data-[status=active]:after:-bottom-px data-[status=active]:after:h-0.5 data-[status=active]:after:bg-primary"
    >
      {children}
      {count === undefined ? null : (
        <span className="rounded-sm bg-muted px-1.5 text-xs tabular-nums">
          {count}
          {hint ? <span className="sr-only"> {hint}</span> : null}
        </span>
      )}
    </Link>
  );
}

function ProjectLayout() {
  const { project } = projectRoute.useParams();
  const info = useQuery(projectQuery(project));
  const models = useQuery(modelsQuery(project));
  const landscape = useQuery(landscapeQuery(project));
  // 404 while the project has no chain: then the tab shows no count.
  const chain = useQuery(valueChainQuery(project));
  const notFound = info.error instanceof ApiError && info.error.status === 404;

  return (
    <PageShell
      crumbs={
        <>
          <ChevronRightIcon className="size-4" aria-hidden />
          <Link to="/" className="hover:text-foreground">
            Projekte
          </Link>
          <ChevronRightIcon className="size-4" aria-hidden />
          <span className="truncate text-foreground" aria-current="page">
            {info.data?.name ?? project}
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-1">
        {info.isPending ? (
          <Skeleton className="h-9 w-64" />
        ) : (
          <h1 className="text-[28px] leading-tight font-bold">{info.data?.name ?? project}</h1>
        )}
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">{project}</span>
          {landscape.data ? <> · Stand s{landscape.data.seq}</> : null}
        </p>
      </div>
      {info.isError ? (
        <Alert variant="destructive">
          <AlertTitle>
            {notFound ? 'Projekt nicht gefunden' : 'Projekt konnte nicht geladen werden'}
          </AlertTitle>
          <AlertDescription>
            {notFound
              ? `Es gibt kein Projekt „${project}“, oder du hast keinen Zugriff.`
              : errorMessage(info.error)}
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <nav aria-label="Projektbereiche" className="flex flex-wrap gap-5 border-b">
            <TabLink to="/projects/$project" exact count={models.data?.length}>
              Modelle
            </TabLink>
            <TabLink
              to="/projects/$project/review"
              count={landscape.data?.relations.filter(isReviewItem).length}
              hint="zu prüfen"
            >
              Prüfen
            </TabLink>
            <TabLink
              to="/projects/$project/value-chain"
              count={chain.data ? openPlacementCount(chain.data) : undefined}
              hint="Platzierungen zu prüfen"
            >
              Wertschöpfungskette
            </TabLink>
            <TabLink to="/projects/$project/relations" count={landscape.data?.relations.length}>
              Relationen
            </TabLink>
            <TabLink to="/projects/$project/findings" count={landscape.data?.findings.length}>
              Befunde
            </TabLink>
            <TabLink to="/projects/$project/upload">Hochladen</TabLink>
            <TabLink to="/projects/$project/agents">Agent verbinden</TabLink>
            {info.data?.role === 'owner' ? (
              <TabLink to="/projects/$project/rules">Regeln</TabLink>
            ) : null}
          </nav>
          <Outlet />
        </>
      )}
    </PageShell>
  );
}
