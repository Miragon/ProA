import type { QueryClient } from '@tanstack/react-query';
import { Link, Outlet, createRootRouteWithContext } from '@tanstack/react-router';

import { PageShell } from '@/components/page-shell';
import { Toaster } from '@/components/toaster';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';

export interface RouterContext {
  queryClient: QueryClient;
}

function RootLayout() {
  return (
    <>
      <Outlet />
      <Toaster />
    </>
  );
}

function NotFound() {
  return (
    <PageShell>
      <Empty className="border bg-card">
        <EmptyHeader>
          <EmptyTitle>Seite nicht gefunden</EmptyTitle>
          <EmptyDescription>Diese Adresse gibt es in ProA nicht.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link to="/">Zu den Projekten</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </PageShell>
  );
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
});
