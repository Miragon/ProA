import type { PlacementAssertion, RelationAssertion } from '@proa/client';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import {
  BookmarkIcon,
  CircleCheckIcon,
  WandSparklesIcon,
  CircleDashedIcon,
  CircleXIcon,
  MessageSquareTextIcon,
  Undo2Icon,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { TierBadge } from '@/components/badges';
import { Badge } from '@/components/ui/badge';
import type { TimelineMark } from '@/lib/auto-accept';
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

/** What relation and placement assertions share: the timeline shows these. */
export type TimelineAssertion = Pick<
  RelationAssertion | PlacementAssertion,
  | 'id'
  | 'kind'
  | 'verdict'
  | 'sourceKind'
  | 'handle'
  | 'clientId'
  | 'procedure'
  | 'llmModel'
  | 'tier'
  | 'confidence'
  | 'rationale'
  | 'evidence'
  | 'question'
  | 'label'
  | 'at'
>;

function lookOf(a: TimelineAssertion, mark: TimelineMark | undefined): EntryLook {
  // Owner decision 19: a decision an auto-accept rule recorded, and its revocation.
  if (mark?.kind === 'decision') {
    return {
      icon: WandSparklesIcon,
      title: 'Automatisch angenommen',
      textLabel: 'Notiz',
      tone: 'text-success',
    };
  }
  if (mark?.kind === 'revocation') {
    return {
      icon: Undo2Icon,
      title: 'Automatische Annahme widerrufen',
      textLabel: 'Grund',
      tone: 'text-muted-foreground',
    };
  }
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

export interface AssertionTimelineProps<T extends TimelineAssertion> {
  assertions: readonly T[];
  /** The assertion the status rests on (`provenance.assertionId`). */
  basisId?: string | null;
  /** A link of an entry, e.g. between a correction and the corrected proposal. */
  renderLink?: (assertion: T) => ReactNode;
  /** Auto-accept decisions and revocations by assertion id (owner decision 19, owners only). */
  marks?: ReadonlyMap<string, TimelineMark> | undefined;
}

/** The link between a corrected relation proposal and the manual relation that replaced it. */
export function RelationLink({
  project,
  assertion: a,
}: {
  project: string;
  assertion: RelationAssertion;
}) {
  if (!a.linkedRelationId) return null;
  return (
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
  );
}

/**
 * The history of a relation or placement (append-only assertions, oldest
 * first): who proposed, withdrew, decided or noted what, with declared
 * procedure and model, tier, confidence, the texts and links to a correction.
 */
export function AssertionTimeline<T extends TimelineAssertion>({
  assertions,
  basisId,
  renderLink,
  marks,
}: AssertionTimelineProps<T>) {
  if (assertions.length === 0) {
    return <p className="text-sm text-muted-foreground">Noch keine Einträge.</p>;
  }
  return (
    <ol aria-label="Verlauf" className="flex flex-col">
      {assertions.map((a, i) => {
        const mark = marks?.get(a.id);
        const look = lookOf(a, mark);
        const Icon = look.icon;
        const procedure = procedureText(a.procedure);
        const last = i === assertions.length - 1;
        return (
          <li
            key={a.id}
            data-testid="timeline-entry"
            data-kind={a.kind}
            data-verdict={a.verdict ?? undefined}
            data-auto={mark?.kind}
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
                {mark ? (
                  <Badge variant="outline" data-testid="timeline-rule">
                    Regel „{mark.ruleName}“ (Revision {mark.revision})
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
              {renderLink?.(a)}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
