import type { AutoAcceptLedgerEntry } from '@proa/client';
import { Undo2Icon, WandSparklesIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { LATER_VERDICTS, autoAcceptLabel, formatDecimal } from '@/lib/auto-accept';
import { TIERS, formatDateTime } from '@/lib/labels';

import { RevokeDialog } from './revoke-dialog';

/**
 * Who decided an auto-accepted item (owner decision 19): the rule and its
 * revision, the owner the decision is recorded under, the agent proposal
 * that triggered it; for an acceptance in force a single-item revoke. Older
 * acceptances show what became of them (revoked, or decided by a human).
 */
export function AutoAcceptProvenance({
  project,
  entries,
  canRevoke,
}: {
  project: string;
  /** The item's acceptances, oldest first (from the ledger). */
  entries: readonly AutoAcceptLedgerEntry[];
  canRevoke: boolean;
}) {
  const [open, setOpen] = useState(false);
  const latest = entries.at(-1);
  if (!latest) return null;
  const subject = latest.kind === 'relation' ? 'Relation' : 'Platzierung';
  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg border border-info/40 bg-info-soft px-3 py-2 text-sm"
      data-testid="auto-accept-provenance"
      data-state={latest.state}
    >
      <p className="flex items-center gap-1.5 font-medium">
        <WandSparklesIcon className="size-4 shrink-0 text-info" aria-hidden />
        {latest.state === 'in-force'
          ? autoAcceptLabel(latest.ruleName)
          : latest.state === 'revoked'
            ? `Automatische Annahme widerrufen – Regel „${latest.ruleName}“`
            : `Automatisch angenommen, dann ${latest.laterVerdict ? LATER_VERDICTS[latest.laterVerdict] : 'entschieden'}`}
      </p>
      <p className="text-xs">
        Entschieden durch Regel „{latest.ruleName}“ (Revision {latest.revision}), aktiviert von{' '}
        <span className="font-mono">{latest.decidedBy.handle}</span>; ausgelöst von{' '}
        <span className="font-mono">{latest.agent.handle}</span>
        {latest.confidence === null ? '' : ` mit ${formatDecimal(latest.confidence)}`}
        {latest.tier ? ` (${TIERS[latest.tier].label})` : ''}
        {latest.llmModel ? `, Modell ${latest.llmModel}` : ''} · {formatDateTime(latest.at)}
      </p>
      {latest.state === 'revoked' && latest.revokedAt ? (
        <p className="text-xs text-muted-foreground">
          Widerrufen am {formatDateTime(latest.revokedAt)};{' '}
          {latest.status === 'proposed'
            ? `die ${subject} steht wieder zur Prüfung.`
            : latest.status === 'obsolete'
              ? `kein Agentenvorschlag war mehr offen: die ${subject} ist veraltet, die Agenten beurteilen sie neu.`
              : `die ${subject} wurde seither entschieden.`}
        </p>
      ) : null}
      {latest.state === 'human-decided' && latest.laterAt ? (
        <p className="text-xs text-muted-foreground">
          Am {formatDateTime(latest.laterAt)} von einem Menschen{' '}
          {latest.laterVerdict ? LATER_VERDICTS[latest.laterVerdict] : 'entschieden'}.
        </p>
      ) : null}
      {latest.state === 'in-force' && canRevoke ? (
        <div>
          <Button
            size="xs"
            variant="outline"
            onClick={() => setOpen(true)}
            data-testid="revoke-one"
          >
            <Undo2Icon data-icon="inline-start" />
            Automatische Annahme widerrufen
          </Button>
          <RevokeDialog
            project={project}
            open={open}
            onOpenChange={setOpen}
            selection={{ ids: [latest.id] }}
            title={`Automatische Annahme dieser ${subject} widerrufen`}
          />
        </div>
      ) : null}
    </div>
  );
}
