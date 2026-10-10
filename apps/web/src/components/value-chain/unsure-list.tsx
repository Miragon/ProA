import type { ValueChainUnsure } from '@proa/client';
import { MapPinIcon } from 'lucide-react';
import { useRef, useState } from 'react';

import { PlainText } from '@/components/review/plain-text';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/labels';
import { splitRef } from '@/lib/refs';
import type { StepOption } from '@/lib/value-chain';

import { ManualPlacementForm } from './manual-placement-form';

export interface UnsureListProps {
  project: string;
  items: readonly ValueChainUnsure[];
  steps: readonly StepOption[];
  canReview: boolean;
}

/**
 * „Agent unsicher“ (M4 §3.2, §4): open processes the placement agent could
 * not place, with its reason (plain text: an agent wrote it), who said so and
 * when, and „Platzieren“ (a manual placement). An item whose input changed
 * since (`current` false) is judged again by the next placement task.
 */
export function UnsureList({ project, items, steps, canReview }: UnsureListProps) {
  const [placing, setPlacing] = useState<string | null>(null);
  /** The process whose "Platzieren" gets the focus back when its form closes. */
  const refocus = useRef<string | null>(null);
  const closeForm = () => {
    refocus.current = placing;
    setPlacing(null);
  };
  return (
    <ul className="flex flex-col gap-2" aria-label="Agent unsicher">
      {items.map((u) => {
        const { elementId: processId } = splitRef(u.process);
        const name = u.name ?? processId;
        return (
          <li
            key={u.process}
            data-testid="unsure-process"
            data-process={u.process}
            className="flex flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-sm"
          >
            <div className="flex min-w-0 flex-col">
              <PlainText as="span" className="font-medium" text={name} />
              <span className="truncate font-mono text-xs text-muted-foreground">{u.process}</span>
            </div>
            <PlainText as="p" className="text-sm whitespace-pre-wrap" text={u.reason} />
            <p className="text-xs text-muted-foreground">
              <span className="font-mono">{u.by}</span> · {formatDateTime(u.at)}
              {u.current ? null : ' · Eingaben geändert, der Agent prüft erneut'}
            </p>
            {canReview ? (
              placing === u.process ? (
                <ManualPlacementForm
                  project={project}
                  target={{ kind: 'step', process: u.process, processName: name, steps }}
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
  );
}
