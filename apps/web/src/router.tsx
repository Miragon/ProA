import type { QueryClient } from '@tanstack/react-query';
import { createRouter, type RouterHistory } from '@tanstack/react-router';

import { indexRoute } from './routes/index';
import { modelViewRoute } from './routes/model-view';
import { projectRoute } from './routes/project';
import { projectAgentsRoute } from './routes/project-agents';
import { projectFindingsRoute } from './routes/project-findings';
import { projectModelsRoute } from './routes/project-models';
import { projectRelationsRoute } from './routes/project-relations';
import { projectReviewRoute } from './routes/project-review';
import { projectUploadRoute } from './routes/project-upload';
import { reviewRoute } from './routes/review';
import { rootRoute } from './routes/root';

/** Code-based route tree: add a route file under src/routes and list it here. */
export const routeTree = rootRoute.addChildren([
  indexRoute,
  projectRoute.addChildren([
    projectModelsRoute,
    projectReviewRoute,
    projectRelationsRoute,
    projectFindingsRoute,
    projectUploadRoute,
    projectAgentsRoute,
  ]),
  modelViewRoute,
  reviewRoute,
]);

export function createAppRouter(options: { queryClient: QueryClient; history?: RouterHistory }) {
  return createRouter({
    routeTree,
    context: { queryClient: options.queryClient },
    defaultPreload: 'intent',
    scrollRestoration: true,
    ...(options.history ? { history: options.history } : {}),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
