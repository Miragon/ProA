import type { Fact, Relation } from '@proa/client';
import { ArrowRightIcon } from 'lucide-react';
import { useId, useMemo, useState, type FormEvent } from 'react';

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
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { correctionCandidates, type Side } from '@/lib/endpoints';
import { MAX_NOTE_CHARS } from '@/lib/limits';
import type { RefLabel, RefResolver } from '@/lib/refs';

import { Endpoint } from '../relation-table';

export interface Correction {
  from: string;
  to: string;
  note: string;
}

export interface CorrectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  relation: Pick<Relation, 'type' | 'from' | 'to'>;
  facts: readonly Fact[];
  resolve: RefResolver;
  pending: boolean;
  onSubmit: (correction: Correction) => void;
}

function searchText(label: RefLabel): string {
  return [label.label ?? '', label.elementId, label.modelKey, label.processName ?? ''].join(' ');
}

/**
 * "Korrigieren" (CONCEPT §3): the reviewer keeps one end, picks the right
 * element for the other from the compatible endpoints of the landscape and
 * says why. The server accepts that pair as a `manual` relation linked to
 * the proposal and rejects the proposal with the same note.
 */
export function CorrectDialog({
  open,
  onOpenChange,
  relation,
  facts,
  resolve,
  pending,
  onSubmit,
}: CorrectDialogProps) {
  const id = useId();
  // A message usually reaches the wrong receiver; a call the wrong process.
  const [replace, setReplace] = useState<Side>('to');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const candidates = useMemo(
    () => (open ? correctionCandidates(relation, replace, facts) : []),
    [open, relation, replace, facts],
  );
  const kept = resolve(replace === 'to' ? relation.from : relation.to);
  const pickedLabel = picked ? resolve(picked) : null;
  const pair =
    picked === null
      ? null
      : replace === 'to'
        ? { from: relation.from, to: picked }
        : { from: picked, to: relation.to };

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pair === null || note.trim() === '') return;
    onSubmit({ ...pair, note: note.trim() });
  }

  /** Closing (Escape, the close button, "Abbrechen") starts the next correction afresh. */
  function close(next: boolean) {
    if (!next) {
      setPicked(null);
      setSearch('');
      setNote('');
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl" aria-describedby={`${id}-desc`}>
        <form
          onSubmit={submit}
          onKeyDown={(event) => {
            // Cmd/Ctrl+Enter submits, as in the other decision forms.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.requestSubmit();
            }
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Relation korrigieren</DialogTitle>
            <DialogDescription id={`${id}-desc`}>
              Wähle das richtige Element für ein Ende. ProA legt dieses Paar als manuelle Relation
              an und lehnt den Vorschlag mit deiner Begründung ab.
            </DialogDescription>
          </DialogHeader>

          <FieldSet>
            <FieldLegend variant="label">Welches Ende ist falsch?</FieldLegend>
            <ToggleGroup
              type="single"
              variant="outline"
              value={replace}
              onValueChange={(value) => {
                if (value === 'from' || value === 'to') {
                  setReplace(value);
                  setPicked(null);
                }
              }}
              aria-label="Zu ersetzendes Ende"
            >
              <ToggleGroupItem value="from">Von ersetzen</ToggleGroupItem>
              <ToggleGroupItem value="to">Nach ersetzen</ToggleGroupItem>
            </ToggleGroup>
            <FieldDescription>
              Bleibt: <span className="font-medium">{kept.label ?? kept.elementId}</span>{' '}
              <span className="font-mono text-xs">({kept.modelKey})</span>
            </FieldDescription>
          </FieldSet>

          <PickerList
            items={candidates}
            valueOf={(c) => c.fact.ref}
            searchText={(c) => searchText(resolve(c.fact.ref))}
            render={(c) => <Endpoint label={resolve(c.fact.ref)} />}
            value={picked}
            onChange={setPicked}
            search={search}
            onSearch={setSearch}
            searchLabel="Passendes Element suchen"
            placeholder="Bezeichnung, Modell oder Prozess"
            label="Kompatible Elemente"
            emptyText="Kein kompatibles Element in anderen Prozessen gefunden."
            testId="correction-candidate"
            valueAttribute="ref"
          />

          {pair && pickedLabel ? (
            <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="correction-pair">
              <span className="font-medium">{resolve(pair.from).label ?? pair.from}</span>
              <ArrowRightIcon className="size-4 text-muted-foreground" aria-hidden />
              <span className="font-medium">{resolve(pair.to).label ?? pair.to}</span>
            </p>
          ) : null}

          <Field>
            <FieldLabel htmlFor={`${id}-note`}>Begründung</FieldLabel>
            <Textarea
              id={`${id}-note`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={MAX_NOTE_CHARS}
              required
              placeholder="Warum gehört dieses Paar zusammen?"
            />
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Abbrechen
            </Button>
            <Button type="submit" disabled={pair === null || note.trim() === '' || pending}>
              Korrigieren
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
