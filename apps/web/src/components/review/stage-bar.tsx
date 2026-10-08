import type { ModelStage } from '@proa/client';
import { cn } from 'cn';
import { ChevronRightIcon } from 'lucide-react';

import { STAGE_ICONS } from '@/components/badges';
import { STAGES, type Tone } from '@/lib/labels';
import { PIPELINE_ORDER } from '@/lib/review';

const TONE_TEXT: Record<Tone, string> = {
  success: 'text-success',
  info: 'text-info',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-muted-foreground',
  primary: 'text-primary',
};

/**
 * Models per pipeline stage (CONCEPT §3), left to right as a model moves
 * through the pipeline. A stage is a filter: the inbox then shows the
 * models in it and the proposals touching them.
 */
export function StageBar({
  counts,
  selected,
  onSelect,
}: {
  counts: Readonly<Record<ModelStage, number>>;
  selected: ModelStage | undefined;
  onSelect: (stage: ModelStage | undefined) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Modelle nach Phase"
      className="grid grid-cols-2 overflow-hidden rounded-xl border bg-card sm:grid-cols-3 lg:grid-cols-[repeat(6,minmax(0,1fr))]"
    >
      {PIPELINE_ORDER.map((stage, i) => {
        const p = STAGES[stage];
        const Icon = STAGE_ICONS[stage];
        const active = selected === stage;
        const count = counts[stage];
        return (
          <button
            key={stage}
            type="button"
            aria-pressed={active}
            data-testid="stage-filter"
            data-stage={stage}
            data-count={count}
            title={p.hint}
            onClick={() => onSelect(active ? undefined : stage)}
            className={cn(
              'relative flex min-w-0 flex-col gap-1 border-b px-4 py-3 text-left transition-colors focus-visible:z-10 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none lg:border-r lg:border-b-0 lg:last:border-r-0',
              active ? 'bg-accent' : 'hover:bg-muted',
              count === 0 && !active && 'text-muted-foreground',
            )}
          >
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <Icon className={cn('size-3.5 shrink-0', TONE_TEXT[p.tone])} aria-hidden />
              <span className="truncate">{p.label}</span>
              {i < PIPELINE_ORDER.length - 1 ? (
                <ChevronRightIcon
                  className="ml-auto hidden size-3.5 text-muted-foreground lg:block"
                  aria-hidden
                />
              ) : null}
            </span>
            <span className="text-[21px] leading-tight font-semibold tabular-nums">
              {count}
              <span className="sr-only"> Modelle</span>
            </span>
            {active ? (
              <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
