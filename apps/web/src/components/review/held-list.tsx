import type { Relation } from '@proa/client';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowRightIcon,
  BookmarkIcon,
  MessageSquareReplyIcon,
  SearchCheckIcon,
} from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';

import { TypeLabel } from '@/components/badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/labels';
import { MAX_NOTE_CHARS } from '@/lib/limits';
import { assertionsQuery } from '@/lib/queries';
import type { RefResolver } from '@/lib/refs';
import { answersSinceHold, type QueueFilters } from '@/lib/review';
import { useAddNote } from '@/lib/review-actions';
import { toast } from '@/lib/toast';

import { Endpoint } from '../relation-table';
import { PlainText } from './plain-text';
import { Principal } from './provenance';

function AnswerForm({ project, relationId }: { project: string; relationId: string }) {
  const id = useId();
  const [text, setText] = useState('');
  const add = useAddNote(project);
  function submit(event: FormEvent) {
    event.preventDefault();
    const answer = text.trim();
    if (answer === '' || add.isPending) return;
    add.mutate(
      { relationId, text: answer },
      {
        onSuccess: () => {
          setText('');
          toast({
            tone: 'success',
            title: 'Antwort gespeichert',
            description: 'Der nächste Agent-Lauf für diese Modelle sieht sie.',
          });
        },
        onError: (error) =>
          toast({
            tone: 'danger',
            title: 'Antwort nicht gespeichert',
            description: errorMessage(error),
          }),
      },
    );
  }
  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        // Cmd/Ctrl+Enter saves, as in the decision forms.
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
      aria-label="Antwort geben"
      className="flex flex-col gap-2"
    >
      <Field>
        <FieldLabel htmlFor={`${id}-answer`}>Antwort</FieldLabel>
        <Textarea
          id={`${id}-answer`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MAX_NOTE_CHARS}
          placeholder="Was hat die Klärung ergeben?"
          className="min-h-12"
        />
        <FieldDescription>
          Die Antwort ist eine Notiz an der Relation; entschieden wird, sobald sie feststeht.
        </FieldDescription>
      </Field>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={text.trim() === '' || add.isPending}>
          <MessageSquareReplyIcon data-icon="inline-start" />
          Antwort speichern
        </Button>
      </div>
    </form>
  );
}

function HeldItem({
  project,
  relation,
  resolve,
  filters,
}: {
  project: string;
  relation: Relation;
  resolve: RefResolver;
  filters: QueueFilters;
}) {
  const assertions = useQuery(assertionsQuery(project, relation.id));
  const answers = assertions.data ? answersSinceHold(relation, assertions.data) : [];
  const hold = relation.provenance;
  return (
    <li
      data-testid="held-item"
      data-relation-id={relation.id}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-start gap-3">
        <TypeLabel type={relation.type} />
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
          <Endpoint label={resolve(relation.from)} />
          <ArrowRightIcon className="size-4 text-muted-foreground" aria-hidden />
          <Endpoint label={resolve(relation.to)} />
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link
            to="/projects/$project/review/$relation"
            params={{ project, relation: relation.id }}
            search={{ ...filters, view: 'held' }}
          >
            <SearchCheckIcon data-icon="inline-start" />
            Prüfen
          </Link>
        </Button>
      </div>

      {hold ? (
        <div className="flex flex-col gap-1.5 rounded-lg bg-warning-soft px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <BookmarkIcon className="size-3.5 text-warning" aria-hidden />
            <span>Vorgemerkt von</span>
            <Principal sourceKind={hold.sourceKind} handle={hold.handle} />
            <time dateTime={hold.at}>{formatDateTime(hold.at)}</time>
            {hold.label ? (
              <Badge variant="outline" className="bg-card">
                <PlainText as="span" text={hold.label} />
              </Badge>
            ) : null}
          </div>
          {hold.rationale ? <PlainText text={hold.rationale} /> : null}
          {hold.question ? (
            <p>
              <span className="font-medium">Frage: </span>
              <PlainText as="span" text={hold.question} />
            </p>
          ) : null}
        </div>
      ) : null}

      {assertions.isPending ? (
        <Skeleton className="h-5 w-48" />
      ) : answers.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {answers.length === 1 ? 'Antwort' : `Antworten (${answers.length})`}
          </h4>
          <ol aria-label="Antworten" className="flex flex-col gap-2">
            {answers.map((a) => (
              <li key={a.id} data-testid="held-answer" className="border-l-2 border-border pl-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Principal sourceKind={a.sourceKind} handle={a.handle} />
                  <time dateTime={a.at}>{formatDateTime(a.at)}</time>
                </div>
                {a.rationale ? <PlainText className="text-sm" text={a.rationale} /> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <AnswerForm project={project} relationId={relation.id} />
    </li>
  );
}

/**
 * Held relations ("vorgemerkt", CONCEPT §3): their own list, with the hold
 * note, the question and label, the answers so far and a field for the next
 * answer. An answer is a note; it reaches the next agent run.
 */
export function HeldList({
  project,
  relations,
  resolve,
  filters = {},
}: {
  project: string;
  relations: readonly Relation[];
  resolve: RefResolver;
  filters?: QueueFilters;
}) {
  if (relations.length === 0) {
    return (
      <Empty className="border bg-card py-10">
        <EmptyHeader>
          <EmptyMedia>
            <BookmarkIcon className="size-6 text-muted-foreground" aria-hidden />
          </EmptyMedia>
          <EmptyTitle className="text-base font-semibold">Nichts vorgemerkt</EmptyTitle>
          <EmptyDescription>
            Merke eine Relation mit „Vormerken“ (H) vor, wenn eine Frage offen ist. Sie erscheint
            dann hier mit einem Feld für die Antwort.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ul aria-label="Vorgemerkte Relationen" className="flex flex-col gap-3">
      {relations.map((r) => (
        <HeldItem key={r.id} project={project} relation={r} resolve={resolve} filters={filters} />
      ))}
    </ul>
  );
}
