import { Link } from '@tanstack/react-router';
import {
  ArrowRightIcon,
  CircleHelpIcon,
  FlagIcon,
  SearchCheckIcon,
  TriangleAlertIcon,
  Undo2Icon,
  UnlinkIcon,
} from 'lucide-react';

import { TierBadge, TypeLabel } from '@/components/badges';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ENDPOINT_STATES, formatConfidence, provenanceOf } from '@/lib/labels';
import type { RefResolver } from '@/lib/refs';
import type { QueueFilters, QueueItem } from '@/lib/review';

import { Endpoint } from '../relation-table';
import { SOURCE_ICONS } from './provenance';

/**
 * The review queue (CONCEPT §3): open proposals, and accepted relations
 * whose endpoint changed (to confirm again), highest confidence first, then
 * those that finish a model. An open agent question ("Frage") and agents'
 * no-links on the pair ("Einwand") show next to the provenance. "Prüfen"
 * opens the review screen, which walks the same queue with J/K.
 */
export function QueueTable({
  project,
  items,
  resolve,
  filters,
  revoked,
}: {
  project: string;
  items: readonly QueueItem[];
  resolve: RefResolver;
  filters: QueueFilters;
  /** Relations whose auto-acceptance an owner revoked (owner decision 19): marked „widerrufen“. */
  revoked?: ReadonlySet<string>;
}) {
  return (
    <Table aria-label="Vorschläge" className="min-w-[960px] table-fixed">
      <colgroup>
        <col className="w-28" />
        <col />
        <col className="w-6" />
        <col />
        <col className="w-28" />
        <col className="w-20" />
        <col className="w-48" />
        <col className="w-28" />
      </colgroup>
      <TableHeader>
        <TableRow>
          <TableHead>Typ</TableHead>
          <TableHead>Von</TableHead>
          <TableHead>
            <span className="sr-only">nach</span>
          </TableHead>
          <TableHead>Nach</TableHead>
          <TableHead>Stufe</TableHead>
          <TableHead className="text-right">Konfidenz</TableHead>
          <TableHead>Herkunft</TableHead>
          <TableHead>
            <span className="sr-only">Aktion</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map(({ relation: r, finishes }) => {
          const p = provenanceOf(r);
          const Icon = SOURCE_ICONS[p.source];
          const question = r.provenance?.question ?? null;
          return (
            <TableRow key={r.id} data-testid="queue-row" data-relation-id={r.id} data-tier={r.tier}>
              <TableCell>
                <TypeLabel type={r.type} />
              </TableCell>
              <TableCell className="whitespace-normal">
                <Endpoint label={resolve(r.from)} />
              </TableCell>
              <TableCell className="px-0 text-muted-foreground">
                <ArrowRightIcon className="size-4" aria-hidden />
              </TableCell>
              <TableCell className="whitespace-normal">
                <Endpoint label={resolve(r.to)} />
              </TableCell>
              <TableCell>
                <TierBadge tier={r.tier} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatConfidence(r.confidence)}
              </TableCell>
              <TableCell className="whitespace-normal">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs">
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate">{p.label}</span>
                  </span>
                  <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    {r.status === 'accepted' ? (
                      <span
                        className="inline-flex items-center gap-1 text-warning"
                        data-testid="queue-reconfirm"
                        title={ENDPOINT_STATES[r.endpointState].hint}
                      >
                        <TriangleAlertIcon className="size-3.5" aria-hidden />
                        Angenommen, {ENDPOINT_STATES[r.endpointState].label}
                      </span>
                    ) : null}
                    {revoked?.has(r.id) ? (
                      <span
                        className="inline-flex items-center gap-1"
                        data-testid="queue-revoked"
                        title="Eine automatische Annahme wurde widerrufen; der Vorschlag ist wieder zu prüfen."
                      >
                        <Undo2Icon className="size-3.5" aria-hidden />
                        widerrufen
                      </span>
                    ) : null}
                    {question ? (
                      <span className="inline-flex items-center gap-1 text-warning">
                        <CircleHelpIcon className="size-3.5" aria-hidden />
                        Frage
                      </span>
                    ) : null}
                    {r.noLinks.length > 0 ? (
                      <span
                        className="inline-flex items-center gap-1 text-warning"
                        data-testid="queue-no-link"
                        title={
                          r.noLinks.length === 1
                            ? 'Kein Zusammenhang laut Agent'
                            : `Kein Zusammenhang laut Agent (${r.noLinks.length} Einwände)`
                        }
                      >
                        <UnlinkIcon className="size-3.5" aria-hidden />
                        Einwand
                      </span>
                    ) : null}
                    {finishes > 0 ? (
                      <span
                        className="inline-flex items-center gap-1"
                        title="Letzter offener Punkt dieser Modelle"
                      >
                        <FlagIcon className="size-3.5" aria-hidden />
                        {finishes === 1
                          ? 'schließt 1 Modell ab'
                          : `schließt ${finishes} Modelle ab`}
                      </span>
                    ) : null}
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <Button variant="outline" size="sm" asChild>
                  <Link
                    to="/projects/$project/review/$relation"
                    params={{ project, relation: r.id }}
                    search={filters}
                  >
                    <SearchCheckIcon data-icon="inline-start" />
                    Prüfen
                  </Link>
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
