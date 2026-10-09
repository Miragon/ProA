import { OUTSIDE_STEP } from '@/lib/limits';
import type { StepOption } from '@/lib/value-chain';

/** One step in a picker: its name and where it sits. */
export function StepOptionLabel({ option }: { option: StepOption }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate font-medium">{option.name || 'Ohne Namen'}</span>
      <span className="truncate text-xs text-muted-foreground">
        {option.elementId === OUTSIDE_STEP ? 'bewusst nicht auf der Kette' : option.path}
      </span>
    </span>
  );
}
