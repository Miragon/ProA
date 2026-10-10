import type { Model } from '@proa/client';
import type { ReactNode } from 'react';

import { EngineBadge, StageBadge } from '@/components/badges';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/labels';

/** Models of a project: key, engine, head revision, pipeline stage, open items. */
export function ModelsTable({
  models,
  renderKey,
}: {
  models: readonly Model[];
  /** The key cell, e.g. a link into the model view. */
  renderKey?: (model: Model) => ReactNode;
}) {
  return (
    <Table aria-label="Modelle">
      <TableHeader>
        <TableRow>
          <TableHead>Modell</TableHead>
          <TableHead>Engine</TableHead>
          <TableHead className="text-right">Revision</TableHead>
          <TableHead>Phase</TableHead>
          <TableHead className="text-right">Offen</TableHead>
          <TableHead>Aktualisiert</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.map((m) => (
          <TableRow key={m.id} data-testid="model-row">
            <TableCell className="whitespace-normal">
              <div className="flex min-w-0 flex-col">
                <span className="font-mono text-[13px]">{renderKey?.(m) ?? m.key}</span>
                {m.name ? <span className="text-xs text-muted-foreground">{m.name}</span> : null}
              </div>
            </TableCell>
            <TableCell>
              <EngineBadge engine={m.engine} />
            </TableCell>
            <TableCell className="text-right tabular-nums">r{m.headRev}</TableCell>
            <TableCell>
              <StageBadge stage={m.stage} />
            </TableCell>
            <TableCell
              className="text-right tabular-nums"
              title="Relationen, die vorgeschlagen, vorgemerkt oder mit geändertem Endpunkt angenommen sind"
            >
              {m.openItems}
            </TableCell>
            <TableCell className="text-muted-foreground">{formatDateTime(m.updatedAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
