import type { Finding } from '@proa/client';
import { CircleCheckIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Endpoint } from '@/components/relation-table';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { groupFindings } from '@/lib/findings';
import { FINDING_KINDS } from '@/lib/labels';
import type { RefResolver } from '@/lib/refs';

/** Deterministic findings of the project head, grouped by kind. */
export function FindingsView({
  findings,
  resolve,
  renderRefAction,
}: {
  findings: readonly Finding[];
  resolve: RefResolver;
  /** E.g. a link that shows the element in the model view. */
  renderRefAction?: (ref: string) => ReactNode;
}) {
  if (findings.length === 0) {
    return (
      <Empty className="border bg-card">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleCheckIcon />
          </EmptyMedia>
          <EmptyTitle>Keine Befunde</EmptyTitle>
          <EmptyDescription>
            Alle Aufrufe treffen genau einen Prozess, und jede Nachricht hat einen Gegenpart.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {groupFindings(findings).map(([kind, items]) => (
        <section key={kind} aria-labelledby={`finding-${kind}`} className="flex flex-col gap-2">
          <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id={`finding-${kind}`} className="text-base font-semibold">
              {FINDING_KINDS[kind].label}{' '}
              <span className="font-normal text-muted-foreground tabular-nums">
                ({items.length})
              </span>
            </h2>
            <p className="text-sm text-muted-foreground">{FINDING_KINDS[kind].hint}</p>
          </header>
          <ul className="flex flex-col divide-y rounded-xl border bg-card">
            {items.map((f) => (
              <li
                key={`${f.kind}:${f.refs.join(',')}`}
                className="flex flex-col gap-2 px-4 py-3"
                data-testid="finding"
              >
                <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
                  {f.refs.map((ref) => (
                    <div key={ref} className="flex min-w-0 items-center gap-2">
                      <Endpoint label={resolve(ref)} />
                      {renderRefAction?.(ref)}
                    </div>
                  ))}
                </div>
                {f.detail ? <p className="text-sm text-muted-foreground">{f.detail}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
