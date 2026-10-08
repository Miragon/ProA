import type { Fact, Relation } from '@proa/client';
import { cn } from 'cn';
import { ArrowRightIcon, SearchIcon } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { useId, useMemo, useState, type FormEvent } from 'react';

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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { correctionCandidates, type Side } from '@/lib/endpoints';
import { nameWords } from '@/lib/generic-names';
import { MAX_NOTE_CHARS } from '@/lib/limits';
import type { RefLabel, RefResolver } from '@/lib/refs';

import { Endpoint } from '../relation-table';

/** How many candidates the list shows at once; the search narrows the rest. */
const SHOWN = 60;

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

function matchesSearch(label: RefLabel, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const hay = nameWords(
    [label.label ?? '', label.elementId, label.modelKey, label.processName ?? ''].join(' '),
  ).join(' ');
  return words.every((w) => hay.includes(w));
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
  const words = nameWords(search);
  const visible = candidates.filter((c) => matchesSearch(resolve(c.fact.ref), words));
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

          <Field>
            <FieldLabel htmlFor={`${id}-search`}>Passendes Element suchen</FieldLabel>
            <div className="relative">
              <SearchIcon
                className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
                aria-hidden
              />
              <Input
                id={`${id}-search`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Bezeichnung, Modell oder Prozess"
                className="pl-8"
                autoComplete="off"
              />
            </div>
          </Field>

          {visible.length === 0 ? (
            <p className="rounded-lg border p-3 text-sm text-muted-foreground">
              {candidates.length === 0
                ? 'Kein kompatibles Element in anderen Prozessen gefunden.'
                : 'Kein Element passt zur Suche.'}
            </p>
          ) : (
            // One tab stop; the arrow keys move between the candidates (Radix roving focus).
            <RadioGroup.Root
              value={picked ?? ''}
              onValueChange={(value) => setPicked(value)}
              aria-label="Kompatible Elemente"
              className="max-h-64 overflow-y-auto rounded-lg border"
            >
              {visible.slice(0, SHOWN).map(({ fact }) => {
                const label = resolve(fact.ref);
                const checked = picked === fact.ref;
                return (
                  <RadioGroup.Item
                    key={fact.ref}
                    value={fact.ref}
                    data-testid="correction-candidate"
                    data-ref={fact.ref}
                    className={cn(
                      'flex w-full items-center gap-3 border-b px-3 py-2 text-left text-sm last:border-b-0 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                      checked ? 'bg-accent' : 'hover:bg-muted',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'size-3.5 shrink-0 rounded-full border',
                        checked ? 'border-4 border-primary' : 'border-contour',
                      )}
                    />
                    <Endpoint label={label} />
                  </RadioGroup.Item>
                );
              })}
            </RadioGroup.Root>
          )}
          {visible.length > SHOWN ? (
            <p className="-mt-2 text-xs text-muted-foreground">
              {SHOWN} von {visible.length} gezeigt; die Suche grenzt weiter ein.
            </p>
          ) : null}

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
