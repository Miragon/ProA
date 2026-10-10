import { useId, useState, type FormEvent } from 'react';

import { PickerList } from '@/components/picker-list';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { MAX_NOTE_CHARS } from '@/lib/limits';
import type { StepOption } from '@/lib/value-chain';

import { StepOptionLabel } from './step-options';

export interface CorrectStepDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Rechnungsstellung" (the process being placed). */
  processName: string;
  /** Steps it may move to (without its current one), `@outside` included. */
  options: readonly StepOption[];
  pending: boolean;
  onSubmit: (correction: { step: string; note: string }) => void;
}

/**
 * "Korrigieren" for a placement (M4 §4): the process belongs on another step
 * (or outside the chain). The server accepts it there as a `manual` placement
 * and rejects this one with the same note.
 */
export function CorrectStepDialog({
  open,
  onOpenChange,
  processName,
  options,
  pending,
  onSubmit,
}: CorrectStepDialogProps) {
  const id = useId();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState('');

  function close(next: boolean) {
    if (!next) {
      setPicked(null);
      setSearch('');
      setNote('');
    }
    onOpenChange(next);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (picked === null || note.trim() === '') return;
    onSubmit({ step: picked, note: note.trim() });
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-xl" aria-describedby={`${id}-desc`}>
        <form
          onSubmit={submit}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.requestSubmit();
            }
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Platzierung korrigieren</DialogTitle>
            <DialogDescription id={`${id}-desc`}>
              Wähle den Schritt, auf den „{processName}“ gehört. ProA nimmt den Prozess dort als
              manuelle Platzierung an und lehnt diese mit deiner Begründung ab.
            </DialogDescription>
          </DialogHeader>
          <PickerList
            items={options}
            valueOf={(o) => o.elementId}
            searchText={(o) => `${o.name} ${o.path} ${o.elementId}`}
            render={(o) => <StepOptionLabel option={o} />}
            value={picked}
            onChange={setPicked}
            search={search}
            onSearch={setSearch}
            searchLabel="Schritt suchen"
            placeholder="Name oder Pfad"
            label="Schritte"
            emptyText="Die Kette hat keinen anderen Schritt."
            testId="correct-step-option"
            valueAttribute="step"
          />
          <Field>
            <FieldLabel htmlFor={`${id}-note`}>Begründung</FieldLabel>
            <Textarea
              id={`${id}-note`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={MAX_NOTE_CHARS}
              required
              placeholder="Warum gehört der Prozess dorthin?"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Abbrechen
            </Button>
            <Button type="submit" disabled={picked === null || note.trim() === '' || pending}>
              Korrigieren
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
