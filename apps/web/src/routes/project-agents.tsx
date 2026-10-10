import { createRoute } from '@tanstack/react-router';

import { ConnectAgent } from '@/components/connect-agent';
import { ReadOnlyNotice } from '@/components/read-only-notice';
import { Skeleton } from '@/components/ui/skeleton';
import { serverOrigin } from '@/lib/agent-config';
import { useAutoAcceptIndex } from '@/lib/auto-accept-actions';
import { useProjectPermissions } from '@/lib/permissions';

import { projectRoute } from './project';

export const projectAgentsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'agents',
  component: AgentsTab,
});

function AgentsTab() {
  const { project } = projectAgentsRoute.useParams();
  const can = useProjectPermissions(project);
  const autoIndex = useAutoAcceptIndex(project);
  if (!can.known) return <Skeleton className="h-40 w-full" />;
  // Agent tokens are the owners' (CONCEPT §6); nobody connects an agent to the demo.
  if (!can.isOwner) {
    return (
      <ReadOnlyNotice
        demo={can.demo}
        title="Agent verbinden nicht möglich"
        demoText="In der Demo verbindet sich kein Agent; die Vorschläge hat der Simulationsagent beim Aufsetzen gemacht."
        roleText="Agent-Tokens erstellen und widerrufen nur die Inhaber dieses Projekts."
      />
    );
  }
  return (
    <ConnectAgent
      project={project}
      origin={serverOrigin(window.location, import.meta.env.DEV)}
      autoIndex={autoIndex}
    />
  );
}
