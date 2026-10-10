import type { UnplacedProcess } from '@proa/client';
import { Link } from '@tanstack/react-router';
import { LocateIcon, MapPinIcon } from 'lucide-react';
import { useRef, useState } from 'react';

import { PlainText } from '@/components/review/plain-text';
import { Button } from '@/components/ui/button';
import { splitRef } from '@/lib/refs';
import type { StepOption } from '@/lib/value-chain';

import { ManualPlacementForm } from './manual-placement-form';

const FIRST = 8;

export interface UnplacedListProps {
  project: string;
  processes: readonly UnplacedProcess[];
  steps: readonly StepOption[];
  canReview: boolean;
  onSelectStep: (elementId: string) => void;
}

/**
 * "Prozesse ohne Schritt" (M4 §4): processes with no accepted, held or
 * proposed placement, with up to three `baseline-prefix/1` hints (a click
 * selects the step) and "Platzieren" (a manual placement).
 */
export function UnplacedList({
  project,
  processes,
  steps,
  canReview,
  onSelectStep,
}: UnplacedListProps) {
  const [all, setAll] = useState(false);
  const [placing, setPlacing] = useState<string | null>(null);
  /** The process whose "Platzieren" gets the focus back when its form closes. */
  const refocus = useRef<string | null>(null);
  const closeForm = () => {
    refocus.current = placing;
    setPlacing(null);
  };
  if (processes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Jeder Prozess hat einen Schritt oder einen offenen Vorschlag.
      </p>
    );
  }
  const shown = all ? processes : processes.slice(0, FIRST);
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2" aria-label="Prozesse ohne Schritt">
        {shown.map((u) => {
          const { elementId: processId } = splitRef(u.process);
          return (
            <li
              key={u.process}
              data-testid="unplaced-process"
              data-process={u.process}
              className="flex flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-sm"
            >
              <div className="flex items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <PlainText as="span" className="font-medium" text={u.name ?? processId} />
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {u.process}
                  </span>
                </div>
                <Button variant="ghost" size="icon-xs" asChild>
                  <Link
                    to="/projects/$project/models/$"
                    params={{ project, _splat: u.modelKey }}
                    search={{ element: processId }}
                    aria-label="Im Modell zeigen"
                    title="Im Modell zeigen"
                  >
                    <LocateIcon />
                  </Link>
                </Button>
              </div>
              {u.hints.length > 0 ? (
                <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  <span>Passt vielleicht zu:</span>
                  {u.hints.map((h) => (
                    <button
                      key={h.step}
                      type="button"
                      className="rounded-sm bg-muted px-1.5 text-foreground hover:bg-accent"
                      onClick={() => onSelectStep(h.step)}
                      data-testid="unplaced-hint"
                    >
                      <PlainText as="span" text={h.name} />
                    </button>
                  ))}
                </p>
              ) : null}
              {canReview ? (
                placing === u.process ? (
                  <ManualPlacementForm
                    project={project}
                    target={{
                      kind: 'step',
                      process: u.process,
                      processName: u.name ?? processId,
                      steps,
                      hints: u.hints.map((h) => h.step),
                    }}
                    onDone={closeForm}
                    onCancel={closeForm}
                  />
                ) : (
                  <div>
                    <Button
                      ref={(button) => {
                        if (button && refocus.current === u.process) {
                          refocus.current = null;
                          button.focus();
                        }
                      }}
                      variant="outline"
                      size="xs"
                      onClick={() => setPlacing(u.process)}
                    >
                      <MapPinIcon data-icon="inline-start" />
                      Platzieren
                    </Button>
                  </div>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
      {processes.length > FIRST ? (
        <Button variant="ghost" size="sm" onClick={() => setAll((a) => !a)}>
          {all ? 'Weniger zeigen' : `Alle ${processes.length} zeigen`}
        </Button>
      ) : null}
    </div>
  );
}
