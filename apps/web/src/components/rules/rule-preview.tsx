import type { AutoAcceptPreview } from '@proa/client';
import { cn } from 'cn';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatPercent, formatThreshold, historyText } from '@/lib/auto-accept-rules';

import { BlockedList } from './apply-dialog';

const ratio = (v: number | null) => (v === null ? '–' : formatPercent(v));

/**
 * The live preview of a rule (owner decision 19): what it would have accepted
 * in this project's history (with the precision of the human decisions; items
 * only a rule decided are no ground truth), what it would accept now, why
 * open proposals are held back, and the curve over minimum confidences.
 */
export function RulePreview({
  preview,
  minConfidence,
  stale = false,
}: {
  preview: AutoAcceptPreview;
  /** The rule's minimum confidence: its row of the curve is marked. */
  minConfidence: number | null;
  /** The criteria changed since this preview (a newer one is loading). */
  stale?: boolean;
}) {
  const h = preview.history;
  return (
    <div
      className={cn('flex flex-col gap-3 text-sm', stale && 'opacity-60')}
      data-testid="rule-preview"
      aria-busy={stale}
    >
      <p data-testid="preview-history">{historyText(h)}.</p>
      <p className="text-muted-foreground" data-testid="preview-unreviewed">
        Automatisch angenommen, nicht geprüft: {h.autoUnreviewed} · noch nicht entschieden:{' '}
        {h.undecided}
      </p>
      <p className="font-medium" data-testid="preview-open">
        Jetzt offen: {preview.open.count}{' '}
        {preview.open.count === 1 ? 'würde angenommen' : 'würden angenommen'}
      </p>
      <BlockedList blocked={preview.open.blocked} />
      <Table aria-label="Verlauf nach Konfidenz" className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead>ab Konfidenz</TableHead>
            <TableHead className="text-right">würde annehmen</TableHead>
            <TableHead className="text-right">richtig</TableHead>
            <TableHead className="text-right">falsch</TableHead>
            <TableHead className="text-right">Quote</TableHead>
            <TableHead className="text-right">offen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {preview.curve.map((c) => {
            const current =
              minConfidence !== null && Math.abs(c.minConfidence - minConfidence) < 1e-9;
            return (
              <TableRow
                key={c.minConfidence}
                data-testid="curve-row"
                data-current={current ? 'true' : undefined}
                className={cn(current && 'bg-primary/10 font-semibold')}
              >
                <TableCell>{formatThreshold(c.minConfidence)}</TableCell>
                <TableCell className="text-right tabular-nums">{c.wouldAccept}</TableCell>
                <TableCell className="text-right tabular-nums">{c.accepted}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {c.rejected + c.corrected}
                </TableCell>
                <TableCell className="text-right tabular-nums">{ratio(c.precision)}</TableCell>
                <TableCell className="text-right tabular-nums">{c.open}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        „richtig“: später von einem Menschen angenommen; „falsch“: abgelehnt oder korrigiert;
        „Quote“: die Trefferquote. Vorschläge, die nur eine Regel entschieden hat, zählen nicht als
        Prüfung.
      </p>
    </div>
  );
}
