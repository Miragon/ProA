import { createRoute, lazyRouteComponent } from '@tanstack/react-router';

import { projectRoute } from './project';

/**
 * The tab „Regeln“ (owner decision 19): the project's auto-accept rules,
 * owners only. The page (`project-rules-page.tsx`) loads with the route, so
 * no other page carries its dialogs.
 */
export const projectRulesRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'rules',
  component: lazyRouteComponent(() => import('./project-rules-page'), 'RulesPage'),
});
