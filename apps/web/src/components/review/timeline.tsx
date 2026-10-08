import type { RelationAssertion } from '@proa/client';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import {
  BookmarkIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  MessageSquareTextIcon,
  Undo2Icon,
  type LucideIcon,
} from 'lucide-react';

import { TierBadge } from '@/components/badges';
import { Badge } from '@/components/ui/badge';
import { formatConfidence, formatDateTime, procedureText } from '@/lib/labels';

import { PlainText } from './plain-text';
import { Principal } from './provenance';

interface EntryLook {
  icon: LucideIcon;
  title: string;
  /** Heading of the text block (rationale, reason, note). */
  textLabel: string;
  tone: string;
}

function lookOf(a: RelationAssertion): EntryLook {
  switch (a.kind) {
    case 'proposal':
      return {
        icon: CircleDashedIcon,
        title: 'Vorgeschlagen',
        textLabel: 'Begründung',
        tone: 'text-info',
      };
    case 'withdrawal':
      return {
        icon: Undo2Icon,
        title: 'Vorschlag zurückgezogen',
        textLabel: 'Grund',
        tone: 'text-muted-foreground',
      };
    case 'note':
      return {
        icon: MessageSquareTextIcon,
        title: 'Notiz',
        textLabel: 'Notiz',
        tone: 'text-muted-foreground',
      };
    case 'decision':
      switch (a.verdict) {
        case 'accept':
          return {
            icon: CircleCheckIcon,
            title: 'Angenommen',
            textLabel: 'Notiz',
            tone: 'text-success',
          };
        case 'reject':
          return { icon: CircleXIcon, title: 'Abgelehnt', textLabel: 'Grund', tone: 'text-danger' };
        case 'hold':
        case null:
          return {
            icon: BookmarkIcon,
            title: 'Vorgemerkt',
            textLabel: 'Notiz',
            tone: 'text-warning',
          };
      }
  }
}

export interface AssertionTimelineProps {
  project: string;
  assertions: readonly RelationAssertion[];
  /** The assertion the status rests on (`Relation.provenance.assertionId`). */
  basisId?: string | null;
}

/**
 * The relation's history (append-only assertions, oldest first): who
 * proposed, withdrew, decided or noted what, with declared procedure and
 * model, tier, confidence, the texts and links to a correction.
 */
export function AssertionTimeline({ project, assertions, basisId }: AssertionTimelineProps) {
  if (assertions.length === 0) {
    return <p className="text-sm text-muted-foreground">Noch keine Einträge.</p>;
  }
  return (
    <ol aria-label="Verlauf" className="flex flex-col">
      {assertions.map((a, i) => {
        const look = lookOf(a);
        const Icon = look.icon;
        const procedure = procedureText(a.procedure);
        const last = i === assertions.length - 1;
        return (
          <li
            key={a.id}
            data-testid="timeline-entry"
            data-kind={a.kind}
            data-verdict={a.verdict ?? undefined}
            className="relative flex gap-3 pb-4"
          >
            {last ? null : (
              <span aria-hidden className="absolute top-6 bottom-0 left-[9px] w-px bg-border" />
            )}
            <Icon className={cn('mt-0.5 size-5 shrink-0', look.tone)} aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="font-semibold">{look.title}</span>
                {a.id === basisId ? (
                  <Badge variant="outline" title="Auf diesem Eintrag beruht der Status">
                    maßgeblich
                  </Badge>
                ) : null}
                {a.tier ? <TierBadge tier={a.tier} /> : null}
                {a.confidence !== null ? (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatConfidence(a.confidence)}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <Principal sourceKind={a.sourceKind} handle={a.handle} />
                {a.clientId ? <span className="font-mono">{a.clientId}</span> : null}
                {procedure ? <span className="font-mono">{procedure}</span> : null}
                {a.llmModel ? <span className="font-mono">{a.llmModel}</span> : null}
                <time dateTime={a.at}>{formatDateTime(a.at)}</time>
              </div>
              {a.rationale ? (
                <div className="text-sm">
                  <span className="sr-only">{look.textLabel}: </span>
                  <PlainText text={a.rationale} />
                </div>
              ) : null}
              {a.question ? (
                <div className="rounded-md bg-warning-soft px-2 py-1 text-sm">
                  <span className="font-medium">Frage: </span>
                  <PlainText as="span" text={a.question} />
                </div>
              ) : null}
              {a.label ? (
                <span>
                  <Badge variant="outline">
                    <PlainText as="span" text={a.label} />
                  </Badge>
                </span>
              ) : null}
              {a.evidence.length > 0 ? (
                <ul className="flex flex-wrap gap-1" aria-label="Belege">
                  {a.evidence.map((e, k) => (
                    <li key={k} className="rounded-sm bg-muted px-1.5 font-mono text-xs break-all">
                      <PlainText as="span" text={e} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {a.linkedRelationId ? (
                <Link
                  to="/projects/$project/review/$relation"
                  params={{ project, relation: a.linkedRelationId }}
                  className="text-sm text-link hover:underline"
                >
                  {a.kind === 'decision' && a.verdict === 'reject'
                    ? 'Korrigiert durch die manuelle Relation'
                    : 'Korrektur dieses Vorschlags'}{' '}
                  <span className="font-mono text-xs">{a.linkedRelationId}</span>
                </Link>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
