import type { AutoAcceptRevocationBody, AutoAcceptRevocationResult } from '@proa/client';
import { useQuery } from '@tanstack/react-query';
import { Undo2Icon } from 'lucide-react';
import { useId, useState } from 'react';

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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, errorMessage } from '@/lib/api';
import { formatDecimal, revocationSummary } from '@/lib/auto-accept';
import { useRevokeAutoAccepted } from '@/lib/auto-accept-actions';
import { MAX_AUTO_ACCEPT_REASON_CHARS } from '@/lib/limits';
import { autoAcceptRevokeDryRunQuery } from '@/lib/queries';
import { toast } from '@/lib/toast';

import { SubjectText } from './subject';

/** Items the dialog lists; the rest are counted. */
const LISTED = 20;

export type RevocationSelection = Omit<AutoAcceptRevocationBody, 'expectedCount' | 'reason'>;

export interface RevokeDialogProps {
  project: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What to revoke: a rule (and revision), an agent, a kind, ids. */
  selection: RevocationSelection;
  /** Dialog title, e.g. „Annahmen der Regel „…“ widerrufen“. */
  title: string;
  onDone?: (result: AutoAcceptRevocationResult) => void;
}

function RevokeBody({
  project,
  onOpenChange,
  selection,
  title,
  onDone,
}: Omit<RevokeDialogProps, 'open'>) {
  const id = useId();
  const dry = useQuery(autoAcceptRevokeDryRunQuery(project, selection));
  const real = useRevokeAutoAccepted(project);
  const [reason, setReason] = useState('');
  const [changed, setChanged] = useState(false);
  const result = dry.data;

  function confirm() {
    if (!result || result.count === 0) return;
    const text = reason.trim();
    real.mutate(
      {
        body: { ...selection, expectedCount: result.count, ...(text ? { reason: text } : {}) },
        dryRun: false,
      },
      {
        onSuccess: (done) => {
          toast({
            tone: 'success',
            title:
              done.count === 1
                ? 'Automatische Annahme widerrufen'
                : `${done.count} automatische Annahmen widerrufen`,
            description: revocationSummary({ ...done, alreadyRevoked: 0 }),
          });
          onDone?.(done);
          onOpenChange(false);
        },
        onError: (error) => {
          // The selection changed since the dry run: nothing was revoked; show the fresh one.
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
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          Ist noch ein Agentenvorschlag offen, steht das Element wieder in der Prüfung; sonst wird
          es veraltet und die Agenten beurteilen es neu. Was ein Mensch seither entschieden hat,
          bleibt, wie es ist.
        </DialogDescription>
      </DialogHeader>
      {changed ? (
        <Alert>
          <AlertTitle>Die Auswahl hat sich geändert</AlertTitle>
          <AlertDescription>
            Es wurde nichts widerrufen. Die Vorschau ist neu geladen; prüfe sie und bestätige noch
            einmal.
          </AlertDescription>
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
          <p data-testid="revoke-summary">{revocationSummary(result)}</p>
          {result.items.length > 0 ? (
            <ul className="flex max-h-56 flex-col gap-1.5 overflow-y-auto rounded-lg border p-2">
              {result.items.slice(0, LISTED).map((i) => (
                <li key={i.decisionId} className="flex flex-col gap-0.5" data-testid="revoke-item">
                  <SubjectText subject={i} />
                  <span className="text-xs text-muted-foreground">
                    Regel „{i.ruleName}“ (Revision {i.revision}) · {i.agent.handle}
                    {i.confidence === null ? '' : ` mit ${formatDecimal(i.confidence)}`} ·{' '}
                    {i.outcome === 'obsolete' ? 'wird veraltet' : 'zurück in die Prüfung'}
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
          {result.count > 0 ? (
            <Field>
              <FieldLabel htmlFor={`${id}-reason`}>Grund (optional)</FieldLabel>
              <Textarea
                id={`${id}-reason`}
                value={reason}
                maxLength={MAX_AUTO_ACCEPT_REASON_CHARS}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Warum widerrufst du?"
                className="min-h-12"
              />
              <FieldDescription>Steht im Verlauf der widerrufenen Vorschläge.</FieldDescription>
            </Field>
          ) : null}
        </div>
      )}
      {failed ? (
        <Alert variant="destructive">
          <AlertTitle>Widerruf fehlgeschlagen</AlertTitle>
          <AlertDescription>{errorMessage(real.error)}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Abbrechen
        </Button>
        <Button
          variant="destructive"
          disabled={!result || result.count === 0 || real.isPending || dry.isFetching}
          onClick={confirm}
          data-testid="revoke-confirm"
        >
          <Undo2Icon data-icon="inline-start" />
          {result ? `${result.count} widerrufen` : 'Widerrufen'}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Revokes auto-acceptances (owner decision 19): the dry run when the dialog
 * opens, then „N widerrufen“ with the dry run's count; when the selection
 * changed in between (409) the dialog shows the fresh dry run. A human
 * decision taken since an acceptance is never touched.
 */
export function RevokeDialog({ open, onOpenChange, ...props }: RevokeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="revoke-dialog">
        {open ? <RevokeBody onOpenChange={onOpenChange} {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}
