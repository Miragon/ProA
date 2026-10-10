import type { Placement } from '@proa/client';
import { CheckCheckIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';

import { PlainText } from '@/components/review/plain-text';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { errorMessage } from '@/lib/api';
import { MAX_BULK_DECISIONS } from '@/lib/limits';
import { conflictOf, type Conflict } from '@/lib/review';
import { toast } from '@/lib/toast';
import { placementStepLabel, reconfirmCandidates } from '@/lib/value-chain';
import { useBulkDecidePlacements } from '@/lib/value-chain-actions';

export interface BulkReconfirmDialogProps {
  project: string;
  /** Every non-obsolete placement of the chain; the dialog picks the candidates. */
  placements: readonly Placement[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens a placement's card (the ones that can only be rejected or corrected). */
  onShowPlacement: (placementId: string) => void;
}

/**
 * "Alle erneut bestätigen" (S3 checklist): the accepted placements whose step
 * was renamed or re-parented, or whose process changed, accepted again in one
 * all-or-nothing request with ids, versions and `expectedCount`. Placements on
 * removed steps or with a missing process cannot be re-confirmed (the bulk
 * would answer `step-removed`); they are listed apart, with a link to their
 * card for a rejection or correction. A placement the reviewer unchecked
 * stays unchecked while the dialog lives, also when a refetch brings it with a
 * new version (as in the M2 bulk accept).
 */
export function BulkReconfirmDialog({
  project,
  placements,
  open,
  onOpenChange,
  onShowPlacement,
}: BulkReconfirmDialogProps) {
  const { selectable, apart } = reconfirmCandidates(placements);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const bulk = useBulkDecidePlacements(project);
  const chosen = selectable.filter((p) => !unchecked.has(p.id));
  const tooMany = chosen.length > MAX_BULK_DECISIONS;

  function confirm() {
    if (chosen.length === 0 || tooMany || bulk.isPending) return;
    setConflict(null);
    bulk.mutate(
      {
        verdict: 'accept',
        items: chosen.map((p) => ({ id: p.id, version: p.version })),
        expectedCount: chosen.length,
      },
      {
        onSuccess: (result) => {
          toast({
            tone: 'success',
            title: 'Erneut bestätigt',
            description:
              result.items.length === 1
                ? '1 Platzierung gilt wieder.'
                : `${result.items.length} Platzierungen gelten wieder.`,
          });
          setUnchecked(new Set());
          onOpenChange(false);
        },
        onError: (error) => {
          const c = conflictOf(error, undefined, 'placement');
          if (c) setConflict(c);
          else
            toast({
              tone: 'danger',
              title: 'Nicht bestätigt',
              description: errorMessage(error),
            });
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setConflict(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl" data-testid="bulk-reconfirm-dialog">
        <DialogHeader>
          <DialogTitle>Platzierungen erneut bestätigen</DialogTitle>
          <DialogDescription>
            Diese Platzierungen waren angenommen; seitdem wurde ihr Schritt umbenannt oder
            verschoben oder ihr Prozess geändert. Bestätige, dass sie weiter gelten.
          </DialogDescription>
        </DialogHeader>

        {conflict ? (
          <Alert className="border-warning bg-warning-soft" data-testid="bulk-reconfirm-conflict">
            <TriangleAlertIcon className="text-warning" />
            <AlertTitle>{conflict.title}</AlertTitle>
            <AlertDescription className="text-foreground">{conflict.description}</AlertDescription>
          </Alert>
        ) : null}

        {selectable.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nichts zu bestätigen.</p>
        ) : (
          <ul
            className="flex max-h-80 flex-col overflow-y-auto rounded-lg border"
            aria-label="Zu bestätigen"
          >
            {selectable.map((p) => {
              const checked = !unchecked.has(p.id);
              return (
                <li
                  key={p.id}
                  data-testid="reconfirm-row"
                  data-placement-id={p.id}
                  className="flex items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0"
                >
                  <Checkbox
                    checked={checked}
                    aria-label={`${p.processName ?? p.process} bestätigen`}
                    onCheckedChange={(on) =>
                      setUnchecked((prev) => {
                        const next = new Set(prev);
                        if (on === true) next.delete(p.id);
                        else next.add(p.id);
                        return next;
                      })
                    }
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <PlainText
                      as="span"
                      className="truncate font-medium"
                      text={p.processName ?? p.process}
                    />
                    <span className="truncate text-xs text-muted-foreground">
                      auf <PlainText as="span" text={placementStepLabel(p)} />
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {p.endpoints.step === 'changed' ? 'Schritt geändert' : 'Prozess geändert'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {apart.length > 0 ? (
          <div className="flex flex-col gap-1.5" data-testid="reconfirm-apart">
            <p className="text-sm font-medium">Nicht bestätigbar ({apart.length})</p>
            <p className="text-xs text-muted-foreground">
              Ihr Schritt ist entfernt oder ihr Prozess fehlt. Lehne sie ab oder korrigiere sie auf
              einen anderen Schritt.
            </p>
            <ul className="flex flex-col gap-1">
              {apart.map((p) => (
                <li key={p.id} data-testid="reconfirm-apart-row" data-placement-id={p.id}>
                  <button
                    type="button"
                    className="text-left text-sm text-link hover:underline"
                    onClick={() => {
                      onOpenChange(false);
                      onShowPlacement(p.id);
                    }}
                  >
                    <PlainText as="span" text={p.processName ?? p.process} /> ·{' '}
                    <PlainText as="span" text={placementStepLabel(p)} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button onClick={confirm} disabled={chosen.length === 0 || tooMany || bulk.isPending}>
            <CheckCheckIcon data-icon="inline-start" />
            {chosen.length === 1 ? '1 erneut bestätigen' : `${chosen.length} erneut bestätigen`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
