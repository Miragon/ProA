import { BookmarkIcon, XIcon } from 'lucide-react';
import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { MAX_LABEL_CHARS, MAX_NOTE_CHARS, MAX_QUESTION_CHARS } from '@/lib/limits';

/**
 * The reject and hold forms of a review decision, shared by the relation
 * review screen and the placement cards of the value chain page.
 */

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

export function RejectForm({
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

const HOLD_HINT =
  'Vorgemerkte Relationen stehen in einer eigenen Liste; Antworten erreichen den nächsten Agent-Lauf.';

export function HoldForm({
  pending,
  onSubmit,
  onCancel,
  hint = HOLD_HINT,
}: {
  pending: boolean;
  onSubmit: (hold: { note: string; question?: string; label?: string }) => void;
  onCancel: () => void;
  /** What happens to a held item (relation or placement). */
  hint?: string;
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
          <FieldDescription>{hint}</FieldDescription>
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
