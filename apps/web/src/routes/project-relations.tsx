import { useQuery } from '@tanstack/react-query';
import { Link, createRoute } from '@tanstack/react-router';
import { LocateIcon } from 'lucide-react';

import { RelationsView } from '@/components/relation-table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api';
import { landscapeQuery, modelsQuery } from '@/lib/queries';
import { splitRef } from '@/lib/refs';
import { parseRelationFilters } from '@/lib/relation-filters';
import { useProjectFacts } from '@/lib/use-project-facts';

import { projectRoute } from './project';

export const projectRelationsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'relations',
  validateSearch: parseRelationFilters,
  component: RelationsTab,
});

function RelationsTab() {
  const { project } = projectRelationsRoute.useParams();
  const filters = projectRelationsRoute.useSearch();
  const navigate = projectRelationsRoute.useNavigate();
  const landscape = useQuery(landscapeQuery(project));
  const models = useQuery(modelsQuery(project));
  const { resolve } = useProjectFacts(project, models.data);

  if (landscape.isPending) return <Skeleton className="h-60 w-full" />;
  if (landscape.isError)
    return (
      <Alert variant="destructive">
        <AlertTitle>Relationen konnten nicht geladen werden</AlertTitle>
        <AlertDescription>{errorMessage(landscape.error)}</AlertDescription>
      </Alert>
    );

  const modelKeys = landscape.data.models.map((m) => m.key).sort();

  return (
    <RelationsView
      relations={landscape.data.relations}
      resolve={resolve}
      modelKeys={modelKeys}
      filters={filters}
      onFiltersChange={(next) => void navigate({ search: next, replace: true })}
      renderActions={(relation) => (
        // M2 adds the review actions (accept, reject, hold) next to this link.
        <Button variant="outline" size="sm" asChild>
          <Link
            to="/projects/$project/models/$"
            params={{ project, _splat: splitRef(relation.from).modelKey }}
            search={{ relation: relation.id }}
            aria-label={`Relation im Modell ${splitRef(relation.from).modelKey} zeigen`}
          >
            <LocateIcon data-icon="inline-start" />
            Im Modell
          </Link>
        </Button>
      )}
    />
  );
}
