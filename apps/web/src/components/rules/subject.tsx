import type { AutoAcceptItem, AutoAcceptLedgerEntry } from '@proa/client';
import { ArrowRightIcon } from 'lucide-react';

import { PlainText } from '@/components/review/plain-text';
import { OUTSIDE_LABEL, RELATION_TYPES } from '@/lib/labels';
import { OUTSIDE_STEP } from '@/lib/limits';

type Subject = Pick<
  AutoAcceptItem | AutoAcceptLedgerEntry,
  'kind' | 'type' | 'from' | 'to' | 'process' | 'step'
>;

/** A relation (`Typ: von → nach`) or a placement (`Prozess → Schritt`) of a rule, as refs. */
export function SubjectText({ subject: s }: { subject: Subject }) {
  if (s.kind === 'relation') {
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
        <span className="font-medium">{s.type ? RELATION_TYPES[s.type].label : 'Relation'}</span>
        <PlainText as="span" className="truncate font-mono" text={s.from ?? ''} />
        <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        <PlainText as="span" className="truncate font-mono" text={s.to ?? ''} />
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
      <PlainText as="span" className="truncate font-mono" text={s.process ?? ''} />
      <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="font-medium">
        {s.step === OUTSIDE_STEP ? OUTSIDE_LABEL : <PlainText as="span" text={s.step ?? ''} />}
      </span>
    </span>
  );
}
