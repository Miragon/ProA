import type { ApplyAutoAcceptResult, AutoAcceptRule } from '@proa/client';
import { useQuery } from '@tanstack/react-query';
import { CheckCheckIcon } from 'lucide-react';
import { useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, errorMessage } from '@/lib/api';
import { formatDecimal } from '@/lib/auto-accept';
import { AUTO_ACCEPT_BLOCK_LABELS } from '@/lib/auto-accept-rules';
import { useApplyRule } from '@/lib/auto-accept-rule-actions';
import { autoAcceptApplyDryRunQuery } from '@/lib/auto-accept-queries';
import { toast } from '@/lib/toast';

import { SubjectText } from './subject';

const LISTED = 20;

/** The blocked-reason histogram as a list (preview, dry runs). */
export function BlockedList({ blocked }: { blocked: ApplyAutoAcceptResult['blocked'] }) {
  if (blocked.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="blocked-reasons">
      <p className="text-xs font-medium text-muted-foreground">
        Erfüllen die Regel, aber eine Schutzregel hält sie zurück:
      </p>
      <ul className="flex flex-col gap-0.5 text-xs">
        {blocked.map((b) => (
          <li key={b.reason} className="flex justify-between gap-3">
            <span>{AUTO_ACCEPT_BLOCK_LABELS[b.reason]}</span>
            <span className="tabular-nums">{b.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface ApplyDialogProps {
  project: string;
  rule: AutoAcceptRule;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const proposals = (n: number) => (n === 1 ? '1 Vorschlag' : `${n} Vorschläge`);

function ApplyBody({ project, rule, onOpenChange }: Omit<ApplyDialogProps, 'open'>) {
  const dry = useQuery(autoAcceptApplyDryRunQuery(project, rule.id, rule.revision));
  const real = useApplyRule(project);
  const [changed, setChanged] = useState(false);
  const result = dry.data;
  // The dry run's view of the head wins over the (possibly older) table row.
  const enabled = result?.enabled ?? rule.enabled;
  const authorIsOwner = result?.authorIsOwner ?? rule.authorIsOwner;
  const blockedByRule = !enabled
    ? 'Die Regel ist aus. Aktiviere sie, um offene Vorschläge anzunehmen.'
    : !authorIsOwner
      ? 'Der Urheber der Regel ist kein Inhaber mehr. Speichere die Regel neu (Bearbeiten, Speichern), um sie zu übernehmen.'
      : null;

  function confirm() {
    if (!result || result.count === 0 || blockedByRule) return;
    real.mutate(
      { ruleId: rule.id, dryRun: false, revision: result.revision, expectedCount: result.count },
      {
        onSuccess: (done) => {
          toast({
            tone: 'success',
            title: `${proposals(done.count)} automatisch angenommen`,
            description: `Regel „${rule.name}“ (Revision ${done.revision}). Du kannst die Annahmen jederzeit widerrufen.`,
          });
          onOpenChange(false);
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 409) {
            setChanged(true);
            void dry.refetch();
          }
        },
      },
    );
  }

  const failed = real.error && !(real.error instanceof ApiError && real.error.status === 409);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Regel „{rule.name}“ auf offene Vorschläge anwenden</DialogTitle>
        <DialogDescription>
          Regeln wirken nur auf neue Vorschläge. Hier nimmst du die offenen an, die die Regel schon
          jetzt erfüllt; jede Annahme wird als deine Entscheidung durch diese Regel vermerkt.
        </DialogDescription>
      </DialogHeader>
      {changed ? (
        <Alert>
          <AlertTitle>Die offenen Vorschläge haben sich geändert</AlertTitle>
          <AlertDescription>
            Es wurde nichts angenommen. Die Vorschau ist neu geladen; prüfe sie und bestätige noch
            einmal.
          </AlertDescription>
        </Alert>
      ) : null}
      {blockedByRule ? (
        <Alert>
          <AlertDescription>{blockedByRule}</AlertDescription>
        </Alert>
      ) : null}
      {dry.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Vorschau fehlgeschlagen</AlertTitle>
          <AlertDescription>{errorMessage(dry.error)}</AlertDescription>
        </Alert>
      ) : !result ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <div className="flex flex-col gap-3">
          <p data-testid="apply-summary">
            {result.count === 0
              ? 'Kein offener Vorschlag erfüllt die Regel.'
              : result.count === 1
                ? '1 offener Vorschlag erfüllt die Regel.'
                : `${result.count} offene Vorschläge erfüllen die Regel.`}
          </p>
          {result.items.length > 0 ? (
            <ul className="flex max-h-56 flex-col gap-1.5 overflow-y-auto rounded-lg border p-2">
              {result.items.slice(0, LISTED).map((i) => (
                <li key={i.triggerId} className="flex flex-col gap-0.5" data-testid="apply-item">
                  <SubjectText subject={i} />
                  <span className="text-xs text-muted-foreground">
                    {i.agent.handle} mit {formatDecimal(i.confidence)}
                    {i.llmModel ? ` · ${i.llmModel}` : ''}
                  </span>
                </li>
              ))}
              {result.count > LISTED ? (
                <li className="text-xs text-muted-foreground">
                  … und {result.count - LISTED} weitere
                </li>
              ) : null}
            </ul>
          ) : null}
          <BlockedList blocked={result.blocked} />
        </div>
      )}
      {failed ? (
        <Alert variant="destructive">
          <AlertTitle>Anwenden fehlgeschlagen</AlertTitle>
          <AlertDescription>{errorMessage(real.error)}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Abbrechen
        </Button>
        <Button
          disabled={
            !result ||
            result.count === 0 ||
            blockedByRule !== null ||
            real.isPending ||
            dry.isFetching
          }
          onClick={confirm}
          data-testid="apply-confirm"
        >
          <CheckCheckIcon data-icon="inline-start" />
          {`${proposals(result?.count ?? 0)} annehmen`}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Applies a rule to the open proposals (rules are never retroactive
 * otherwise): the dry run when the dialog opens, then „N Vorschläge
 * annehmen“ with the head revision and the dry run's count; a 409 (the open
 * proposals or the rule changed) shows the fresh dry run.
 */
export function ApplyDialog({ open, onOpenChange, ...props }: ApplyDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="apply-dialog">
        {open ? <ApplyBody onOpenChange={onOpenChange} {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}
