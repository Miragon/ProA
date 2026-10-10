import { Link, createRoute } from '@tanstack/react-router';

import { ReadOnlyNotice } from '@/components/read-only-notice';
import { Skeleton } from '@/components/ui/skeleton';
import { UploadPanel } from '@/components/upload-panel';
import { useProjectPermissions } from '@/lib/permissions';

import { projectRoute } from './project';

export const projectUploadRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'upload',
  component: UploadTab,
});

function UploadTab() {
  const { project } = projectUploadRoute.useParams();
  const can = useProjectPermissions(project);
  if (!can.known) return <Skeleton className="h-40 w-full" />;
  if (!can.canWrite) {
    return (
      <ReadOnlyNotice
        demo={can.demo}
        title="Hochladen nicht möglich"
        demoText="In der Demo kannst du keine Modelle hochladen."
        roleText="Modelle hochladen dürfen Bearbeiter und Inhaber dieses Projekts."
      />
    );
  }
  return (
    <UploadPanel
      project={project}
      renderModelLink={(modelKey) => (
        <Link
          to="/projects/$project/models/$"
          params={{ project, _splat: modelKey }}
          className="text-link hover:underline"
        >
          {modelKey}
        </Link>
      )}
    />
  );
}
