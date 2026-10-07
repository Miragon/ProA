import { createRoute } from '@tanstack/react-router';

import { ConnectAgent } from '@/components/connect-agent';
import { serverOrigin } from '@/lib/agent-config';

import { projectRoute } from './project';

export const projectAgentsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'agents',
  component: AgentsTab,
});

function AgentsTab() {
  const { project } = projectAgentsRoute.useParams();
  return (
    <ConnectAgent project={project} origin={serverOrigin(window.location, import.meta.env.DEV)} />
  );
}
