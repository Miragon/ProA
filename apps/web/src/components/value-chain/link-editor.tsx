import { CheckIcon, KeyRoundIcon } from 'lucide-react';
import { useId, useState } from 'react';

import { PickerList } from '@/components/picker-list';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { MAX_VALUE_CHAIN_LINK_CHARS } from '@/lib/limits';
import {
  linkProblem,
  parseLink,
  processLink,
  type LinkMode,
  type ProcessOption,
} from '@/lib/value-chain';

export interface LinkEditorProps {
  /** The step's link on the canvas (`null`: none). */
  link: string | null;
  processes: readonly ProcessOption[];
  /** Sets (or with `null` clears) the link: one undoable change on the canvas. */
  onChange: (link: string | null) => void;
}

/**
 * The link of a step in edit mode (M4 §2 "The link field", §4): none, a ProA
 * process (`proa:process/<model_key>#<process_id>`, which the save turns
 * into a key-tier proposal and the drill-down follows), or any other text
 * (a URL or a reference ProA keeps as it is).
 *
 * Picking only marks a process (a click, or the arrow keys moving the radio
 * choice); it becomes the link with „Übernehmen“ or with Enter on a process,
 * so browsing the list by keyboard writes nothing and every applied link is
 * one undoable command.
 * The editor stays mounted while the link changes on the canvas and takes
 * over a change it did not make (an undo).
 */
export function LinkEditor({ link, processes, onChange }: LinkEditorProps) {
  const id = useId();
  const parsed = parseLink(link);
  const [mode, setMode] = useState<LinkMode>(parsed.mode);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string | null>(
    parsed.mode === 'process' ? parsed.value : null,
  );
  const [other, setOther] = useState(parsed.mode === 'other' ? parsed.value : '');
  const [touched, setTouched] = useState(false);
  // The canvas link of the last render, and the link this editor applied and still waits for:
  // the canvas reports a change late, and only a change from elsewhere (an undo) resets the editor.
  const [prev, setPrev] = useState(link);
  const [applied, setApplied] = useState<{ link: string | null } | null>(null);
  if (link !== prev) {
    setPrev(link);
    if (applied === null || applied.link !== link) {
      setMode(parsed.mode);
      setPicked(parsed.mode === 'process' ? parsed.value : null);
      setOther(parsed.mode === 'other' ? parsed.value : '');
      setTouched(false);
    }
    setApplied(null);
  }
  const problem = linkProblem(other);
  const current = parsed.mode === 'process' ? parsed.value : null;
  const currentProcess = processes.find((p) => p.ref === current);
  const canApplyProcess = picked !== null && picked !== current;

  function apply(next: string | null) {
    setApplied({ link: next });
    onChange(next);
  }

  function applyProcess(ref: string | null = picked) {
    if (ref !== null && ref !== current) apply(processLink(ref));
  }

  return (
    <div className="flex flex-col gap-3" data-testid="link-editor">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        value={mode}
        aria-label="Art des Links"
        onValueChange={(value) => {
          if (value !== 'none' && value !== 'process' && value !== 'other') return;
          setMode(value);
          setTouched(false);
          if (value === 'none' && link !== null) apply(null);
        }}
      >
        <ToggleGroupItem value="none">Kein Link</ToggleGroupItem>
        <ToggleGroupItem value="process">ProA-Prozess</ToggleGroupItem>
        <ToggleGroupItem value="other">Anderer Link</ToggleGroupItem>
      </ToggleGroup>

      {mode === 'process' ? (
        <div
          className="flex flex-col gap-2"
          onKeyDown={(event) => {
            // Radix keeps Enter from "clicking" a radio; here it applies the focused process.
            const target = event.target;
            if (
              event.key === 'Enter' &&
              target instanceof HTMLElement &&
              target.getAttribute('role') === 'radio'
            ) {
              event.preventDefault();
              const ref = processes.find((p) => p.ref === target.getAttribute('value'))?.ref;
              if (ref === undefined) return;
              setPicked(ref);
              applyProcess(ref);
            }
          }}
        >
          <PickerList
            items={processes}
            valueOf={(p) => p.ref}
            searchText={(p) => `${p.name} ${p.ref}`}
            render={(p) => (
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{p.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{p.ref}</span>
              </span>
            )}
            value={picked}
            onChange={setPicked}
            search={search}
            onSearch={setSearch}
            searchLabel="Prozess suchen"
            placeholder="Name oder Modell"
            label="Prozesse"
            emptyText="Das Projekt hat noch keinen Prozess."
            testId="link-process-option"
            valueAttribute="ref"
          />
          <div className="flex items-start gap-2">
            <p className="flex flex-1 gap-2 text-xs text-muted-foreground">
              <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {currentProcess
                ? `Beim Speichern schlägt ProA „${currentProcess.name}“ für diesen Schritt vor (Stufe Schlüssel); die Entscheidung bleibt bei dir. Doppelklick auf den Schritt öffnet dann das Modell.`
                : 'Der übernommene Prozess wird beim Speichern für diesen Schritt vorgeschlagen (Stufe Schlüssel); die Entscheidung bleibt bei dir.'}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => applyProcess()}
              disabled={!canApplyProcess}
              data-testid="apply-process-link"
            >
              <CheckIcon data-icon="inline-start" />
              Übernehmen
            </Button>
          </div>
        </div>
      ) : mode === 'other' ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (problem === null) apply(other.trim());
          }}
        >
          <Field data-invalid={touched && problem !== null ? true : undefined}>
            <FieldLabel htmlFor={`${id}-other`}>Link (URL oder Text)</FieldLabel>
            <div className="flex gap-2">
              <Input
                id={`${id}-other`}
                value={other}
                onChange={(e) => setOther(e.target.value)}
                maxLength={MAX_VALUE_CHAIN_LINK_CHARS + 1}
                placeholder="https://… oder ein Verweis"
                aria-invalid={touched && problem !== null ? true : undefined}
              />
              <Button type="submit" variant="outline" size="sm" className="h-9">
                <CheckIcon data-icon="inline-start" />
                Übernehmen
              </Button>
            </div>
            {touched && problem ? (
              <FieldError>{problem}</FieldError>
            ) : (
              <FieldDescription>
                http(s)-Adressen öffnen sich in einem neuen Tab; anderen Text behält ProA
                unverändert und meldet ihn als „Link nicht auflösbar“.
              </FieldDescription>
            )}
          </Field>
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">
          Ohne Link öffnet der Doppelklick die Schrittansicht von ProA.
        </p>
      )}
    </div>
  );
}
