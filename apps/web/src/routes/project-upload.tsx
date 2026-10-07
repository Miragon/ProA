import { Link, createRoute } from '@tanstack/react-router';

import { UploadPanel } from '@/components/upload-panel';

import { projectRoute } from './project';

export const projectUploadRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'upload',
  component: UploadTab,
});

function UploadTab() {
  const { project } = projectUploadRoute.useParams();
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
