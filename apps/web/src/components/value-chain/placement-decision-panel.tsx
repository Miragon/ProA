import type { Placement, PlacementDecisionBody, PlacementDecisionResult } from '@proa/client';
import {
  BookmarkIcon,
  CheckIcon,
  PenLineIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { useState } from 'react';

import { HoldForm, RejectForm } from '@/components/review/decision-forms';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { errorMessage } from '@/lib/api';
import { conflictOf, type Conflict } from '@/lib/review';
import { toast } from '@/lib/toast';
import { useShortcuts } from '@/lib/use-shortcuts';
import { placementActions, placementStepLabel, type StepOption } from '@/lib/value-chain';
import { useDecidePlacement } from '@/lib/value-chain-actions';

import { CorrectStepDialog } from './correct-step-dialog';

type Form = 'reject' | 'hold' | 'correct' | null;

/** What a decision did, for the caller (move on to the next open placement). */
export type PlacementOutcome = 'accept' | 'reject' | 'hold' | 'correct';

const TITLES: Record<PlacementOutcome, string> = {
  accept: 'Angenommen',
  reject: 'Abgelehnt',
  hold: 'Vorgemerkt',
  correct: 'Korrigiert',
};

export interface PlacementDecisionPanelProps {
  project: string;
  placement: Placement;
  /** "Rechnungsstellung": the process, for texts. */
  processName: string;
  /** Steps to correct to (the placement's own step is left out here). */
  stepOptions: readonly StepOption[];
  /** A, R, H, C act on this placement (the active card, panel focus in edit mode). */
  shortcuts?: boolean;
  /** Show the keys on the buttons (the active card). */
  showKeys?: boolean;
  onDecided?: (outcome: PlacementOutcome, result: PlacementDecisionResult) => void;
  /** Reloads after a conflict. */
  onReload?: () => void;
}

/**
 * The reviewer's actions on one placement (M4 §4): accept (re-confirm a
 * changed one), reject with a reason, hold with a note (question and label
 * optional), or correct to another step. Every decision carries the version
 * the reviewer saw; a 409 says what happened and pauses the shortcuts until
 * "Neuen Stand prüfen". A placement on a removed step, or whose process left
 * the models, can only be rejected or corrected. Another placement starts
 * with a clean panel.
 */
export function PlacementDecisionPanel(props: PlacementDecisionPanelProps) {
  return <Panel key={props.placement.id} {...props} />;
}

function Panel({
  project,
  placement,
  processName,
  stepOptions,
  shortcuts = false,
  showKeys = false,
  onDecided,
  onReload,
}: PlacementDecisionPanelProps) {
  const [form, setForm] = useState<Form>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const decide = useDecidePlacement(project);
  const can = placementActions(placement);
  const busy = decide.isPending;
  const obsolete = placement.status === 'obsolete';
  const version = placement.version;

  function run(outcome: PlacementOutcome, body: PlacementDecisionBody) {
    if (busy) return;
    setConflict(null);
    decide.mutate(
      { placementId: placement.id, body },
      {
        onSuccess: (result) => {
          setForm(null);
          const target = result.corrected ?? result.placement;
          toast({
            tone: 'success',
            title: TITLES[outcome],
            description:
              outcome === 'correct'
                ? `${processName} liegt jetzt auf „${placementStepLabel(target)}“.`
                : `${processName} → ${placementStepLabel(result.placement)}`,
          });
          onDecided?.(outcome, result);
        },
        onError: (error) => {
          const c = conflictOf(error, version, 'placement');
          if (c) {
            setConflict(c);
            setForm(null);
          } else {
            toast({
              tone: 'danger',
              title: 'Entscheidung nicht gespeichert',
              description: errorMessage(error),
            });
          }
        },
      },
    );
  }

  const accept = () => run('accept', { verdict: 'accept', version });

  useShortcuts(
    {
      a: () => can.accept && accept(),
      r: () => can.reject && setForm('reject'),
      h: () => can.hold && setForm('hold'),
      c: () => can.correct && setForm('correct'),
    },
    shortcuts && form === null && conflict === null,
  );

  const key = (k: string) => (showKeys ? <Kbd>{k}</Kbd> : null);

  return (
    <section
      aria-label="Entscheidung"
      className="flex flex-col gap-2"
      data-testid="placement-decision"
    >
      {conflict ? (
        <Alert data-testid="decision-conflict" className="border-warning bg-warning-soft">
          <TriangleAlertIcon className="text-warning" />
          <AlertTitle>{conflict.title}</AlertTitle>
          <AlertDescription className="text-foreground">
            <p>{conflict.description}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => {
                setConflict(null);
                onReload?.();
              }}
            >
              <RefreshCwIcon data-icon="inline-start" />
              Neuen Stand prüfen
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!obsolete && form === null && can.limited ? (
        <p className="text-xs text-muted-foreground" data-testid="limited-hint">
          {can.limited === 'removed-step'
            ? 'Der Schritt ist nicht mehr in der Kette. Lehne die Platzierung ab oder korrigiere sie auf einen anderen Schritt.'
            : 'Der Prozess ist in keinem Modell mehr. Lehne die Platzierung ab oder korrigiere sie.'}
        </p>
      ) : !obsolete && form === null && can.reconfirm ? (
        <p className="text-xs text-muted-foreground" data-testid="reconfirm-hint">
          Angenommen, aber Schritt oder Prozess haben sich seitdem geändert. Prüfe und nimm erneut
          an, oder lehne ab.
        </p>
      ) : null}

      {obsolete ? (
        <p className="text-xs text-muted-foreground">
          Veraltet: Kein Vorschlag steht mehr dahinter, es gibt nichts zu entscheiden.
        </p>
      ) : form === 'reject' ? (
        <RejectForm
          pending={busy}
          onCancel={() => setForm(null)}
          onSubmit={(reason) => run('reject', { verdict: 'reject', reason, version })}
        />
      ) : form === 'hold' ? (
        <HoldForm
          pending={busy}
          hint="Vorgemerkte Platzierungen bleiben auf dem Schritt sichtbar; deine Antwort steht an der Platzierung."
          onCancel={() => setForm(null)}
          onSubmit={(hold) => run('hold', { verdict: 'hold', ...hold, version })}
        />
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            size="sm"
            onClick={accept}
            disabled={!can.accept || busy}
            className="justify-between"
          >
            <span className="inline-flex items-center gap-1.5">
              <CheckIcon />
              {can.reconfirm ? 'Erneut annehmen' : 'Annehmen'}
            </span>
            {showKeys ? <Kbd className="border-transparent bg-white/20 text-current">A</Kbd> : null}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setForm('reject')}
            disabled={!can.reject || busy}
            className="justify-between"
          >
            <span className="inline-flex items-center gap-1.5">
              <XIcon />
              Ablehnen
            </span>
            {key('R')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setForm('hold')}
            disabled={!can.hold || busy}
            className="justify-between"
          >
            <span className="inline-flex items-center gap-1.5">
              <BookmarkIcon />
              Vormerken
            </span>
            {key('H')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setForm('correct')}
            disabled={!can.correct || busy}
            className="justify-between"
          >
            <span className="inline-flex items-center gap-1.5">
              <PenLineIcon />
              Korrigieren
            </span>
            {key('C')}
          </Button>
        </div>
      )}

      <CorrectStepDialog
        open={form === 'correct'}
        onOpenChange={(open) => setForm(open ? 'correct' : null)}
        processName={processName}
        options={stepOptions.filter(
          (o) => !(placement.stepLive && o.elementId === placement.elementId),
        )}
        pending={busy}
        onSubmit={({ step, note }) => run('correct', { verdict: 'correct', step, note, version })}
      />
    </section>
  );
}
