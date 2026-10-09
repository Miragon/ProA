import type { SaveValueChainResult, ValueChainViolation } from '@proa/client';
import { DownloadIcon, RotateCcwIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { useRef, type ReactNode } from 'react';

import { PlainText } from '@/components/review/plain-text';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDateTime } from '@/lib/labels';
import { impactSummary, violationLine, type ImpactSummary } from '@/lib/value-chain';

function counts(parts: [number, string, string][]): string {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => (n === 1 ? `1 ${one}` : `${n} ${many}`))
    .join(', ');
}

/** The steps a save removes or changes, with what happens to their placements. */
export function ImpactLists({ summary }: { summary: ImpactSummary }) {
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="impact-lists">
      {summary.removed.length > 0 ? (
        <section className="flex flex-col gap-1" aria-label="Entfernte Schritte">
          <h3 className="font-medium">Entfernte Schritte</h3>
          <ul className="flex flex-col gap-1">
            {summary.removed.map((r) => {
              const held = counts([
                [r.accepted, 'angenommene', 'angenommene'],
                [r.held, 'vorgemerkte', 'vorgemerkte'],
              ]);
              return (
                <li key={r.elementId} data-testid="impact-removed" data-element-id={r.elementId}>
                  <PlainText as="span" className="font-medium" text={r.name || r.elementId} />
                  {held
                    ? r.accepted + r.held === 1
                      ? ` – ${held} Platzierung bleibt als offener Punkt`
                      : ` – ${held} Platzierungen bleiben als offene Punkte`
                    : null}
                  {r.proposed > 0 ? (
                    <>
                      {held ? '; ' : ' – '}
                      {r.proposed === 1
                        ? '1 Vorschlag wird'
                        : `${r.proposed} Vorschläge werden`}{' '}
                      zurückgezogen
                    </>
                  ) : null}
                  {!held && r.proposed === 0 ? ' – ohne Platzierungen' : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {summary.changed.length > 0 ? (
        <section className="flex flex-col gap-1" aria-label="Umbenannte oder verschobene Schritte">
          <h3 className="font-medium">Umbenannt oder verschoben</h3>
          <ul className="flex flex-col gap-1">
            {summary.changed.map((c) => (
              <li key={c.elementId} data-testid="impact-changed" data-element-id={c.elementId}>
                {c.before === c.after ? (
                  <PlainText as="span" className="font-medium" text={c.after} />
                ) : (
                  <>
                    <PlainText as="span" text={c.before} /> →{' '}
                    <PlainText as="span" className="font-medium" text={c.after} />
                  </>
                )}
                {c.accepted > 0
                  ? ` – ${c.accepted === 1 ? '1 angenommene Platzierung musst du' : `${c.accepted} angenommene Platzierungen musst du`} erneut bestätigen`
                  : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {summary.kindOnly.length > 0 || summary.added.length > 0 ? (
        <p className="text-muted-foreground">
          {[
            summary.added.length > 0
              ? `${summary.added.length === 1 ? '1 neuer Schritt' : `${summary.added.length} neue Schritte`}`
              : '',
            summary.kindOnly.length > 0
              ? `${summary.kindOnly.length === 1 ? '1 Schritt ändert' : `${summary.kindOnly.length} Schritte ändern`} nur die Art`
              : '',
          ]
            .filter(Boolean)
            .join(', ')}
          .
        </p>
      ) : null}
    </div>
  );
}

/** The dry run's impact before saving (stranded, re-confirm, withdrawn proposals). */
export function ImpactDialog({
  dry,
  pending,
  onConfirm,
  onCancel,
}: {
  dry: SaveValueChainResult | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const summary = dry ? impactSummary(dry.impact) : null;
  return (
    <Dialog open={dry !== null} onOpenChange={(open) => !open && !pending && onCancel()}>
      <DialogContent className="sm:max-w-lg" data-testid="impact-dialog">
        <DialogHeader>
          <DialogTitle>Speichern betrifft Platzierungen</DialogTitle>
          <DialogDescription>
            {summary
              ? counts([
                  [
                    summary.stranded,
                    'Platzierung bleibt als offener Punkt',
                    'Platzierungen bleiben als offene Punkte',
                  ],
                  [
                    summary.toReconfirm,
                    'Platzierung musst du erneut bestätigen',
                    'Platzierungen musst du erneut bestätigen',
                  ],
                  [
                    summary.proposalsWithdrawn,
                    'Vorschlag wird zurückgezogen',
                    'Vorschläge werden zurückgezogen',
                  ],
                ]) + '.'
              : null}
          </DialogDescription>
        </DialogHeader>
        {summary ? <ImpactLists summary={summary} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Weiter bearbeiten
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            Trotzdem speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The save's own impact when it differs from the confirmed dry run (S2 checklist). */
export function ResultDialog({
  saved,
  onClose,
}: {
  saved: SaveValueChainResult | null;
  onClose: () => void;
}) {
  const summary = saved ? impactSummary(saved.impact) : null;
  return (
    <Dialog open={saved !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="result-dialog">
        <DialogHeader>
          <DialogTitle>Gespeichert, mit anderer Wirkung als angekündigt</DialogTitle>
          <DialogDescription>
            Zwischen Probelauf und Speichern hat sich an den Platzierungen etwas geändert. So hat
            das Speichern tatsächlich gewirkt.
          </DialogDescription>
        </DialogHeader>
        {summary ? <ImpactLists summary={summary} /> : null}
        <DialogFooter>
          <Button onClick={onClose}>Verstanden</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 412: someone saved meanwhile. Download and load the newer one, or keep editing. */
export function ConflictDialog({
  open,
  baseRev,
  headRev,
  onLoadNewer,
  onKeepEditing,
}: {
  open: boolean;
  baseRev: number;
  headRev: number | null;
  onLoadNewer: () => void;
  onKeepEditing: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onKeepEditing()}>
      <AlertDialogContent className="sm:max-w-md" data-testid="conflict-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Jemand hat inzwischen gespeichert</AlertDialogTitle>
          <AlertDialogDescription>
            {headRev === null
              ? `Inzwischen wurde eine neuere Revision gespeichert, du hast r${baseRev} bearbeitet.`
              : `Inzwischen wurde r${headRev} gespeichert, du hast r${baseRev} bearbeitet.`}{' '}
            Deine Änderungen werden nicht zusammengeführt. „Neuere Revision laden“ lädt deine
            Fassung zuerst als .vc.json herunter.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onKeepEditing}>Weiter bearbeiten</AlertDialogCancel>
          <AlertDialogAction onClick={onLoadNewer}>
            <DownloadIcon data-icon="inline-start" />
            Neuere Revision laden
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** 422 `value-chain-invalid`: what is wrong, where; a click selects the element. */
export function ViolationsPanel({
  violations,
  truncated,
  nameOf,
  onSelect,
  onClose,
}: {
  violations: readonly ValueChainViolation[];
  truncated: boolean;
  nameOf: (id: string) => string | null;
  onSelect: (elementId: string) => void;
  onClose: () => void;
}) {
  return (
    <Alert variant="destructive" data-testid="violations-panel" className="bg-card">
      <TriangleAlertIcon />
      <AlertTitle className="flex items-center gap-2">
        Nicht gespeichert: {violations.length === 1 ? '1 Fehler' : `${violations.length} Fehler`}
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          aria-label="Schließen"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </AlertTitle>
      <AlertDescription className="text-foreground">
        <ul className="flex flex-col gap-1.5">
          {violations.map((v, i) => {
            const line = violationLine(v, nameOf);
            const target = line.elementId ?? line.connectionId;
            return (
              <li key={i} data-testid="violation" data-reason={v.reason}>
                {line.text}
                {line.where && target ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="text-link hover:underline"
                      onClick={() => onSelect(target)}
                    >
                      {line.where}
                    </button>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
        {truncated ? (
          <p className="mt-1 text-xs">
            Weitere Fehler sind nicht aufgeführt; behebe diese und speichere erneut.
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** A refusal to read and dismiss (size, format version, internal, deleted chain). */
export function MessageDialog({
  message,
  onClose,
  extra,
}: {
  message: { title: string; description: string; reload: boolean } | null;
  onClose: () => void;
  extra?: ReactNode;
}) {
  return (
    <AlertDialog open={message !== null} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent className="sm:max-w-md" data-testid="save-message">
        <AlertDialogHeader>
          <AlertDialogTitle>{message?.title}</AlertDialogTitle>
          <AlertDialogDescription>{message?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {extra}
        <AlertDialogFooter>
          {message?.reload ? (
            <AlertDialogAction onClick={() => window.location.reload()}>
              <RotateCcwIcon data-icon="inline-start" />
              Seite neu laden
            </AlertDialogAction>
          ) : null}
          <AlertDialogCancel onClick={onClose}>Schließen</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * A draft found when entering edit mode: restore (current head) or download
 * (older base), or discard. The choice is explicit: Escape does not close it
 * (a dismissed draft would be overwritten by the next edit), and the focus
 * starts on the safe action, never on „Verwerfen“.
 */
export function DraftDialog({
  draft,
  onRestore,
  onDownload,
  onDiscard,
  onClose,
}: {
  draft: { kind: 'restore' | 'download'; baseRev: number; savedAt: string; headRev: number } | null;
  onRestore: () => void;
  onDownload: () => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const safe = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={draft !== null} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent
        className="sm:max-w-md"
        data-testid="draft-dialog"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          safe.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {draft?.kind === 'restore'
              ? 'Ungespeicherter Entwurf gefunden'
              : 'Alter Entwurf gefunden'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {draft
              ? draft.kind === 'restore'
                ? draft.baseRev > 0
                  ? `Du hast r${draft.baseRev} am ${formatDateTime(draft.savedAt)} bearbeitet und nicht gespeichert.`
                  : `Du hast am ${formatDateTime(draft.savedAt)} eine neue Kette gezeichnet und nicht gespeichert.`
                : `Der Entwurf vom ${formatDateTime(draft.savedAt)} beruht auf r${draft.baseRev}, inzwischen gibt es r${draft.headRev}. ProA führt nichts zusammen: Lade ihn herunter, wenn du ihn noch brauchst.`
              : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              onDiscard();
              onClose();
            }}
          >
            Verwerfen
          </AlertDialogAction>
          {draft?.kind === 'restore' ? (
            <AlertDialogAction
              ref={safe}
              onClick={() => {
                onRestore();
                onClose();
              }}
            >
              Entwurf wiederherstellen
            </AlertDialogAction>
          ) : (
            <AlertDialogAction
              ref={safe}
              onClick={() => {
                onDownload();
                onClose();
              }}
            >
              <DownloadIcon data-icon="inline-start" />
              Herunterladen
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Leaving with unsaved changes (navigation or „Fertig“); Escape stays. */
export function DiscardDialog({
  open,
  title,
  onDiscard,
  onStay,
}: {
  open: boolean;
  title: string;
  onDiscard: () => void;
  onStay: () => void;
}) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent
        className="sm:max-w-md"
        data-testid="discard-dialog"
        onEscapeKeyDown={() => onStay()}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            Deine Änderungen an der Wertschöpfungskette sind nicht gespeichert. Verwirfst du sie,
            sind sie weg (auch der Entwurf im Browser).
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onStay}>Weiter bearbeiten</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onDiscard}>
            Verwerfen
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
