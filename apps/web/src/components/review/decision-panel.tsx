import type { DecisionBody, DecisionResult, Fact, Relation, Verdict } from '@proa/client';
import {
  BookmarkIcon,
  CheckIcon,
  PenLineIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api';
import { MAX_LABEL_CHARS, MAX_NOTE_CHARS, MAX_QUESTION_CHARS } from '@/lib/limits';
import type { RefResolver } from '@/lib/refs';
import { conflictOf, pairText, type Conflict } from '@/lib/review';
import { useDecide } from '@/lib/review-actions';
import { toast } from '@/lib/toast';
import { useShortcuts } from '@/lib/use-shortcuts';

import { CorrectDialog, type Correction } from './correct-dialog';

type Form = 'reject' | 'hold' | 'correct' | null;

/** What a decision did, for the caller (e.g. to move on to the next proposal). */
export type DecisionOutcome = Verdict | 'correct';

export interface DecisionPanelProps {
  project: string;
  relation: Relation;
  resolve: RefResolver;
  /** Head facts of the project, for the correction candidates. */
  facts: readonly Fact[];
  /** Single-key shortcuts A, R, H, C (off while another view owns the keyboard). */
  shortcuts?: boolean;
  onDecided?: (outcome: DecisionOutcome, result: DecisionResult) => void;
  /** Reloads the relation after a conflict. */
  onReload?: () => void;
}

const TOAST_TITLES: Record<DecisionOutcome, string> = {
  accept: 'Angenommen',
  reject: 'Abgelehnt',
  hold: 'Vorgemerkt',
  correct: 'Korrigiert',
};

function labelText(resolve: RefResolver) {
  return (ref: string) => {
    const l = resolve(ref);
    return l.label ?? l.elementId;
  };
}

/** Cmd/Ctrl+Enter submits a form from its textarea; Escape cancels. */
function formKeys(onCancel: () => void) {
  return (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  };
}

function RejectForm({
  pending,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    if (reason.trim() !== '') onSubmit(reason.trim());
  }
  return (
    <form
      aria-label="Ablehnen"
      onSubmit={submit}
      onKeyDown={formKeys(onCancel)}
      className="flex flex-col gap-3"
    >
      <Field>
        <FieldLabel htmlFor={`${id}-reason`}>Grund der Ablehnung</FieldLabel>
        <Textarea
          id={`${id}-reason`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={MAX_NOTE_CHARS}
          required
          autoFocus
          placeholder="z. B. Gleicher Name, aber anderer Vorgang"
        />
        <FieldDescription>Agenten sehen den Grund bei ihrer nächsten Analyse.</FieldDescription>
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Abbrechen
        </Button>
        <Button type="submit" variant="destructive" disabled={reason.trim() === '' || pending}>
          <XIcon data-icon="inline-start" />
          Ablehnen
        </Button>
      </div>
    </form>
  );
}

function HoldForm({
  pending,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  onSubmit: (hold: { note: string; question?: string; label?: string }) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [note, setNote] = useState('');
  const [question, setQuestion] = useState('');
  const [label, setLabel] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    if (note.trim() === '') return;
    onSubmit({
      note: note.trim(),
      ...(question.trim() === '' ? {} : { question: question.trim() }),
      ...(label.trim() === '' ? {} : { label: label.trim() }),
    });
  }
  return (
    <form
      aria-label="Vormerken"
      onSubmit={submit}
      onKeyDown={formKeys(onCancel)}
      className="flex flex-col gap-3"
    >
      <FieldGroup className="gap-3">
        <Field>
          <FieldLabel htmlFor={`${id}-note`}>Notiz</FieldLabel>
          <Textarea
            id={`${id}-note`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={MAX_NOTE_CHARS}
            required
            autoFocus
            placeholder="Was ist offen?"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-question`}>Frage (optional)</FieldLabel>
          <Input
            id={`${id}-question`}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={MAX_QUESTION_CHARS}
            placeholder="z. B. Wird die Gutschrift auch bei Teilretouren erstellt?"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-label`}>Label (optional)</FieldLabel>
          <Input
            id={`${id}-label`}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={MAX_LABEL_CHARS}
            placeholder="z. B. mit Fachbereich Finanzen klären"
          />
          <FieldDescription>
            Vorgemerkte Relationen stehen in einer eigenen Liste; Antworten erreichen den nächsten
            Agent-Lauf.
          </FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Abbrechen
        </Button>
        <Button type="submit" disabled={note.trim() === '' || pending}>
          <BookmarkIcon data-icon="inline-start" />
          Vormerken
        </Button>
      </div>
    </form>
  );
}

/**
 * The reviewer's actions on one relation (CONCEPT §3): accept, reject with a
 * reason, hold with a note (question and label optional), or correct by
 * picking another endpoint. Every decision carries the relation version the
 * reviewer saw; a 409 says what happened instead of overwriting the newer
 * state, which is reloaded at once, so the reviewer checks it and decides
 * again. Another relation starts with a clean panel.
 */
export function DecisionPanel(props: DecisionPanelProps) {
  return <Panel key={props.relation.id} {...props} />;
}

function Panel({
  project,
  relation,
  resolve,
  facts,
  shortcuts = true,
  onDecided,
  onReload,
}: DecisionPanelProps) {
  const [form, setForm] = useState<Form>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const decide = useDecide(project);

  const obsolete = relation.status === 'obsolete';
  const busy = decide.isPending;

  function run(outcome: DecisionOutcome, body: DecisionBody) {
    if (busy) return;
    setConflict(null);
    decide.mutate(
      { relationId: relation.id, body },
      {
        onSuccess: (result) => {
          setForm(null);
          const pair = result.corrected ?? result.relation;
          toast({
            tone: 'success',
            title: TOAST_TITLES[outcome],
            description:
              outcome === 'correct'
                ? `Manuelle Relation ${pairText(pair, labelText(resolve))} angelegt.`
                : pairText(pair, labelText(resolve)),
          });
          onDecided?.(outcome, result);
        },
        onError: (error) => {
          const c = conflictOf(error, relation.version);
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

  const version = relation.version;
  const accept = () => run('accept', { verdict: 'accept', version });
  // An accepted relation whose endpoint changed is an open item: accepting it
  // again anchors the decision on the current endpoints. A missing endpoint
  // cannot be anchored; reject or correct it.
  const reconfirm = relation.status === 'accepted' && relation.endpointState === 'changed';
  const can = {
    accept: !obsolete && (relation.status !== 'accepted' || reconfirm),
    reject: !obsolete && relation.status !== 'rejected',
    hold: !obsolete,
    correct: !obsolete,
  };

  useShortcuts(
    {
      a: () => can.accept && accept(),
      r: () => can.reject && setForm('reject'),
      h: () => can.hold && setForm('hold'),
      c: () => can.correct && setForm('correct'),
    },
    shortcuts && form === null && conflict === null,
  );

  return (
    <section aria-label="Entscheidung" className="flex flex-col gap-3" data-testid="decision-panel">
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

      {!obsolete &&
      form === null &&
      relation.status === 'accepted' &&
      relation.endpointState !== 'ok' ? (
        <p className="text-sm text-muted-foreground" data-testid="reconfirm-hint">
          {reconfirm
            ? 'Angenommen, aber ein Endpunkt hat sich seitdem geändert. Prüfe die Endpunkte und nimm erneut an, oder lehne ab.'
            : 'Angenommen, aber ein Endpunkt fehlt im aktuellen Modell. Lehne ab oder korrigiere die Relation.'}
        </p>
      ) : null}

      {obsolete ? (
        <p className="text-sm text-muted-foreground">
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
          onCancel={() => setForm(null)}
          onSubmit={(hold) => run('hold', { verdict: 'hold', ...hold, version })}
        />
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={accept} disabled={!can.accept || busy} className="justify-between">
            <span className="inline-flex items-center gap-1.5">
              <CheckIcon />
              {reconfirm ? 'Erneut annehmen' : 'Annehmen'}
            </span>
            <Kbd className="border-transparent bg-white/20 text-current">A</Kbd>
          </Button>
          <Button
            variant="outline"
            onClick={() => setForm('reject')}
            disabled={!can.reject || busy}
            className="justify-between"
          >
            <span className="inline-flex items-center gap-1.5">
              <XIcon />
              Ablehnen
            </span>
            <Kbd>R</Kbd>
          </Button>
          <Button
            variant="outline"
            onClick={() => setForm('hold')}
            disabled={!can.hold || busy}
            className="justify-between"
          >
            <span className="inline-flex items-center gap-1.5">
              <BookmarkIcon />
              Vormerken
            </span>
            <Kbd>H</Kbd>
          </Button>
          <Button
            variant="outline"
            onClick={() => setForm('correct')}
            disabled={!can.correct || busy}
            className="justify-between"
          >
            <span className="inline-flex items-center gap-1.5">
              <PenLineIcon />
              Korrigieren
            </span>
            <Kbd>C</Kbd>
          </Button>
        </div>
      )}

      <CorrectDialog
        open={form === 'correct'}
        onOpenChange={(open) => setForm(open ? 'correct' : null)}
        relation={relation}
        facts={facts}
        resolve={resolve}
        pending={busy}
        onSubmit={(c: Correction) =>
          run('correct', { verdict: 'correct', from: c.from, to: c.to, note: c.note, version })
        }
      />
    </section>
  );
}
