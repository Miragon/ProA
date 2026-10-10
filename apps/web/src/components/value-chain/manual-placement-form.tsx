import { PlusIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';

import { PickerList } from '@/components/picker-list';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api';
import { MAX_RATIONALE_CHARS } from '@/lib/limits';
import { toast } from '@/lib/toast';
import type { ProcessOption, StepOption } from '@/lib/value-chain';
import { useManualPlacement } from '@/lib/value-chain-actions';

import { StepOptionLabel } from './step-options';

const DEFAULT_RATIONALE = 'Manuell zugeordnet.';

type Target =
  /** "Prozess hinzufügen" on a step: pick the process. */
  | { kind: 'process'; step: string; stepName: string; processes: readonly ProcessOption[] }
  /** "Platzieren" an unplaced process: pick the step. */
  | {
      kind: 'step';
      process: string;
      processName: string;
      steps: readonly StepOption[];
      /** Steps to offer first (the baseline's hints). */
      hints?: readonly string[];
    };

export interface ManualPlacementFormProps {
  project: string;
  target: Target;
  onDone: () => void;
  onCancel: () => void;
}

/**
 * A manual placement (M4 §4 "Add process"): a human places a process on a
 * step (or outside the chain), accepted at once with the `manual` tier. The
 * rationale is required, prefilled, and editable. The form replaces the
 * button that opened it, so its search field takes the focus; the caller
 * returns it to that button when the form closes.
 */
export function ManualPlacementForm({
  project,
  target,
  onDone,
  onCancel,
}: ManualPlacementFormProps) {
  const id = useId();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [rationale, setRationale] = useState(DEFAULT_RATIONALE);
  const manual = useManualPlacement(project);

  const step = target.kind === 'process' ? target.step : picked;
  const process = target.kind === 'step' ? target.process : picked;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (step === null || process === null || rationale.trim() === '' || manual.isPending) return;
    manual.mutate(
      { step, process, rationale: rationale.trim() },
      {
        onSuccess: (result) => {
          toast({
            tone: 'success',
            title: result.result === 'duplicate' ? 'War schon angenommen' : 'Platziert',
            description: `${result.placement.processName ?? result.placement.process} → ${result.placement.stepName ?? 'Außerhalb der Kette'}`,
          });
          onDone();
        },
        onError: (error) =>
          toast({
            tone: 'danger',
            title: 'Nicht platziert',
            description: errorMessage(error),
          }),
      },
    );
  }

  const hinted =
    target.kind === 'step' && target.hints
      ? [
          ...target.hints.flatMap((h) => target.steps.filter((s) => s.elementId === h)),
          ...target.steps.filter((s) => !target.hints?.includes(s.elementId)),
        ]
      : target.kind === 'step'
        ? target.steps
        : [];

  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
      aria-label={target.kind === 'process' ? 'Prozess hinzufügen' : 'Prozess platzieren'}
      className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3"
      data-testid="manual-placement-form"
    >
      {target.kind === 'process' ? (
        <PickerList
          items={target.processes}
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
          searchLabel={`Prozess für „${target.stepName}“ suchen`}
          placeholder="Name oder Modell"
          label="Prozesse"
          emptyText="Das Projekt hat noch keinen Prozess."
          testId="manual-process-option"
          autoFocus
          valueAttribute="ref"
        />
      ) : (
        <PickerList
          items={hinted}
          valueOf={(s) => s.elementId}
          searchText={(s) => `${s.name} ${s.path} ${s.elementId}`}
          render={(s) => <StepOptionLabel option={s} />}
          value={picked}
          onChange={setPicked}
          search={search}
          onSearch={setSearch}
          searchLabel={`Schritt für „${target.processName}“ suchen`}
          placeholder="Name oder Pfad"
          label="Schritte"
          emptyText="Die Kette hat noch keinen Schritt."
          testId="manual-step-option"
          autoFocus
          valueAttribute="step"
        />
      )}
      <Field>
        <FieldLabel htmlFor={`${id}-rationale`}>Begründung</FieldLabel>
        <Textarea
          id={`${id}-rationale`}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          maxLength={MAX_RATIONALE_CHARS}
          required
          className="min-h-12"
        />
        <FieldDescription>Die Platzierung gilt sofort (Stufe Manuell).</FieldDescription>
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Abbrechen
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={
            step === null || process === null || rationale.trim() === '' || manual.isPending
          }
        >
          <PlusIcon data-icon="inline-start" />
          Platzieren
        </Button>
      </div>
    </form>
  );
}
