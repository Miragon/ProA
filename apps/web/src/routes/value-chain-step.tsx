import { createRoute, lazyRouteComponent } from '@tanstack/react-router';

import { projectRoute } from './project';

/**
 * The drill-down of one step (M4 §4): breadcrumb, sub-steps with their
 * counts, and the step's processes in three groups: its own placements, those
 * of its sub-steps, and the processes its processes reach by accepted calls
 * (shown, never stored). Each process links to its model view, and its
 * placement to the card on the chain page. The view is loaded with the route
 * (`value-chain-step-page.tsx`), not with every page.
 */
export const valueChainStepRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'value-chain/steps/$elementId',
  component: lazyRouteComponent(() => import('./value-chain-step-page'), 'StepView'),
});
