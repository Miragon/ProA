import { useQuery } from '@tanstack/react-query';
import { Link, createRoute } from '@tanstack/react-router';
import { LocateIcon } from 'lucide-react';

import { FindingsView } from '@/components/findings-view';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api';
import { landscapeQuery, modelsQuery } from '@/lib/queries';
import { splitRef } from '@/lib/refs';
import { useProjectFacts } from '@/lib/use-project-facts';

import { projectRoute } from './project';

export const projectFindingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'findings',
  component: FindingsTab,
});

function FindingsTab() {
  const { project } = projectFindingsRoute.useParams();
  const landscape = useQuery(landscapeQuery(project));
  const models = useQuery(modelsQuery(project));
  const { resolve } = useProjectFacts(project, models.data);

  if (landscape.isPending) return <Skeleton className="h-40 w-full" />;
  if (landscape.isError)
    return (
      <Alert variant="destructive">
        <AlertTitle>Befunde konnten nicht geladen werden</AlertTitle>
        <AlertDescription>{errorMessage(landscape.error)}</AlertDescription>
      </Alert>
    );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground">
        Befunde berechnet ProA ohne LLM aus den Fakten. Sie blockieren nichts, zeigen aber, wo eine
        Relation fehlt oder ein Modell mehrdeutig ist.
      </p>
      <FindingsView
        findings={landscape.data.findings}
        resolve={resolve}
        renderRefAction={(ref) => {
          const { modelKey, elementId } = splitRef(ref);
          return (
            <Button variant="ghost" size="icon-sm" asChild>
              <Link
                to="/projects/$project/models/$"
                params={{ project, _splat: modelKey }}
                search={{ element: elementId }}
                aria-label={`${elementId} im Modell ${modelKey} zeigen`}
                title="Im Modell zeigen"
              >
                <LocateIcon />
              </Link>
            </Button>
          );
        }}
      />
    </div>
  );
}
