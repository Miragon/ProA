import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import type { ReactNode } from 'react';

import { healthQuery } from '@/lib/queries';

/** The official Miragon app icon (green comet on blue), unchanged from the CI. */
export function MiragonMark({ className }: { className?: string }) {
  return <img src="/favicon.svg" alt="" aria-hidden className={cn('size-6', className)} />;
}

function ServerStatus() {
  const health = useQuery(healthQuery);
  const state = health.isPending
    ? { dot: 'bg-contour', text: 'Server wird geprüft…' }
    : health.isError
      ? { dot: 'bg-danger', text: 'Server nicht erreichbar' }
      : health.data.status === 'ok'
        ? { dot: 'bg-success', text: `Server verbunden · ${health.data.version}` }
        : { dot: 'bg-warning', text: 'Datenbank nicht erreichbar' };
  return (
    <span
      className="inline-flex items-center gap-2 text-xs text-muted-foreground"
      data-testid="server-status"
      role="status"
    >
      <span aria-hidden className={cn('size-2 rounded-full', state.dot)} />
      {state.text}
    </span>
  );
}

/**
 * Page frame for list and settings pages: brand mark, breadcrumbs and the
 * server state, content on the 1152px grid. The model view has its own
 * borderless canvas layout instead.
 */
export function PageShell({ crumbs, children }: { crumbs?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-app-viewport flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center gap-3 px-6 pt-5 pb-2">
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-lg font-semibold focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <MiragonMark />
          ProA
        </Link>
        {crumbs ? (
          <nav
            aria-label="Brotkrumen"
            className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
          >
            {crumbs}
          </nav>
        ) : null}
        <div className="ml-auto">
          <ServerStatus />
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 pt-4 pb-12">
        {children}
      </main>
    </div>
  );
}
