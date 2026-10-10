import type { AutoAcceptLedgerEntry } from '@proa/client';
import { WandSparklesIcon } from 'lucide-react';

import { ToneBadge } from '@/components/badges';
import { autoAcceptLabel, formatDecimal } from '@/lib/auto-accept';

/**
 * The mark of an item an owner's auto-accept rule accepted (owner decision
 * 19): „Automatisch angenommen – Regel „…““, the details in the tooltip.
 */
export function AutoAcceptMark({
  entry,
  wrap = false,
}: {
  entry: AutoAcceptLedgerEntry;
  /** Wrap the text instead of truncating it (narrow table columns). */
  wrap?: boolean;
}) {
  return (
    <ToneBadge
      tone="info"
      icon={WandSparklesIcon}
      className={wrap ? 'h-auto max-w-full text-left whitespace-normal' : 'max-w-full'}
      title={`Revision ${entry.revision}, entschieden unter ${entry.decidedBy.handle}; ausgelöst von ${entry.agent.handle}${entry.confidence === null ? '' : ` mit ${formatDecimal(entry.confidence)}`}`}
    >
      <span className={wrap ? undefined : 'truncate'} data-testid="auto-accept-mark">
        {autoAcceptLabel(entry.ruleName)}
      </span>
    </ToneBadge>
  );
}
