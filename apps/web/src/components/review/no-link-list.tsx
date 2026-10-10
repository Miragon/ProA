import type { NoLink } from '@proa/client';
import { ArrowRightIcon, UnlinkIcon } from 'lucide-react';

import { TypeLabel } from '@/components/badges';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { formatDateTime } from '@/lib/labels';
import type { RefResolver } from '@/lib/refs';

import { Endpoint } from '../relation-table';
import { PlainText } from './plain-text';
import { Principal } from './provenance';

/**
 * The inbox tab „Kein Zusammenhang“ (CONCEPT §3 "judge each pair once"):
 * every live, current no-link of an agent, also on pairs without a relation
 * (on a pair with one it shows as „Einwand“ in the queue as well). Read-only
 * for every role: a no-link needs no decision.
 */
export function NoLinkList({
  items,
  resolve,
  filtered,
}: {
  items: readonly NoLink[];
  resolve: RefResolver;
  /** A filter is set (the empty text says so). */
  filtered: boolean;
}) {
  if (items.length === 0) {
    return (
      <Empty className="border bg-card py-10">
        <EmptyHeader>
          <EmptyMedia>
            <UnlinkIcon className="size-6 text-muted-foreground" aria-hidden />
          </EmptyMedia>
          <EmptyTitle className="text-base font-semibold">
            {filtered ? 'Kein Paar passt zu den Filtern' : 'Kein Paar ohne Zusammenhang'}
          </EmptyTitle>
          <EmptyDescription>
            Hier stehen Paare, zwischen denen ein Agent keinen Zusammenhang sieht, mit seiner
            Begründung.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Paare, zwischen denen ein Agent keinen Zusammenhang sieht. Zu entscheiden gibt es hier
        nichts; hat ein Paar auch einen Vorschlag, steht der Einwand zusätzlich dort.
      </p>
      <ul className="flex flex-col gap-3" aria-label="Kein Zusammenhang laut Agent">
        {items.map((n) => (
          <li
            key={n.id}
            data-testid="no-link-item"
            data-no-link-id={n.id}
            className="flex flex-col gap-2 rounded-xl border bg-card p-4"
          >
            <div className="flex flex-wrap items-start gap-3">
              <TypeLabel type={n.type} />
              <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                <Endpoint label={resolve(n.from)} />
                <ArrowRightIcon className="size-4 text-muted-foreground" aria-hidden />
                <Endpoint label={resolve(n.to)} />
              </div>
            </div>
            <div className="flex flex-col gap-1 rounded-lg bg-muted px-3 py-2 text-sm">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <UnlinkIcon className="size-3.5" aria-hidden />
                <span>Kein Zusammenhang laut</span>
                <Principal sourceKind="agent" handle={n.handle} />
                <time dateTime={n.at}>{formatDateTime(n.at)}</time>
                <span className="min-w-0 truncate" title={n.origin}>
                  Analyse von <span className="font-mono">{n.origin}</span>
                </span>
              </span>
              {n.reason.trim() ? (
                <PlainText text={n.reason} />
              ) : (
                <p className="text-muted-foreground">Ohne Begründung.</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
