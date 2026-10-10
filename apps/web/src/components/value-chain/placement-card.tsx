import type { Placement, PlacementAssertion } from '@proa/client';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import {
  ChevronDownIcon,
  CircleHelpIcon,
  CrosshairIcon,
  ExternalLinkIcon,
  LocateIcon,
  MessageSquareReplyIcon,
  SearchCheckIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { AutoAcceptMark } from '@/components/auto-accept-mark';
import { EndpointStateBadge, StatusBadge, TierBadge } from '@/components/badges';
import { PlainText } from '@/components/review/plain-text';
import { ProvenanceList } from '@/components/review/provenance';
import { AutoAcceptProvenance } from '@/components/rules/auto-accept-provenance';
import { AssertionTimeline } from '@/components/review/timeline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api';
import type { AutoAcceptIndex } from '@/lib/auto-accept';
import { useIsOwner } from '@/lib/auto-accept-actions';
import { formatConfidence } from '@/lib/labels';
import { MAX_NOTE_CHARS } from '@/lib/limits';
import { placementAssertionsQuery } from '@/lib/queries';
import { splitRef } from '@/lib/refs';
import { toast } from '@/lib/toast';
import { placementEvidenceItems, placementStepLabel, type StepOption } from '@/lib/value-chain';
import { useAddPlacementNote } from '@/lib/value-chain-actions';

import { PlacementDecisionPanel, type PlacementOutcome } from './placement-decision-panel';

export interface PlacementCardProps {
  project: string;
  placement: Placement;
  /** Model keys of the project: evidence refs into them link to the model view. */
  modelKeys: ReadonlySet<string>;
  /** Steps to correct to (`@outside` included). */
  stepOptions: readonly StepOption[];
  /** `proa:process/` link of the placement's step points at this process (rule basis). */
  linkedByStep?: boolean;
  /** Name the step on the card (overview lists). */
  showStep?: boolean;
  active: boolean;
  canReview: boolean;
  /** A, R, H, C act on the active card when shortcuts are on. */
  shortcuts: boolean;
  onActivate: () => void;
  onSelectStep: (elementId: string) => void;
  onDecided: (outcome: PlacementOutcome) => void;
  onReload: () => void;
  /**
   * The auto-accept ledger (owner decision 19, every reviewer): marks a
   * placement an auto-accept rule accepted, with a single-item revoke for
   * owners.
   */
  autoIndex?: AutoAcceptIndex;
}

/** The current proposal of a placement: the one its status rests on, else the latest. */
function currentProposal(
  placement: Placement,
  assertions: readonly PlacementAssertion[],
): PlacementAssertion | null {
  const basis = assertions.find((a) => a.id === placement.provenance?.assertionId);
  if (basis?.kind === 'proposal') return basis;
  return assertions.findLast((a) => a.kind === 'proposal') ?? null;
}

/** Notes after the current hold (answers). */
function answersSinceHold(placement: Placement, assertions: readonly PlacementAssertion[]) {
  const at = assertions.findIndex((a) => a.id === placement.provenance?.assertionId);
  return assertions.slice(at < 0 ? 0 : at + 1).filter((a) => a.kind === 'note');
}

function PlacementLink({
  project,
  assertion: a,
}: {
  project: string;
  assertion: PlacementAssertion;
}) {
  if (!a.linkedPlacementId) return null;
  return (
    <Link
      to="/projects/$project/value-chain"
      params={{ project }}
      search={{ placement: a.linkedPlacementId }}
      className="text-sm text-link hover:underline"
    >
      {a.kind === 'decision' && a.verdict === 'reject'
        ? 'Korrigiert durch die manuelle Platzierung'
        : 'Korrektur dieses Vorschlags'}{' '}
      <span className="font-mono text-xs">{a.linkedPlacementId}</span>
    </Link>
  );
}

function AnswerForm({ project, placementId }: { project: string; placementId: string }) {
  const id = useId();
  const [text, setText] = useState('');
  const add = useAddPlacementNote(project);
  function submit(event: FormEvent) {
    event.preventDefault();
    const answer = text.trim();
    if (answer === '' || add.isPending) return;
    add.mutate(
      { placementId, text: answer },
      {
        onSuccess: () => {
          setText('');
          toast({ tone: 'success', title: 'Antwort gespeichert' });
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

function Toggle({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Button variant="ghost" size="xs" aria-expanded={open} onClick={onToggle}>
      <ChevronDownIcon
        data-icon="inline-start"
        className={cn('transition-transform', open ? 'rotate-180' : '')}
      />
      {children}
    </Button>
  );
}

/**
 * One placement as the reviewer reads it (M4 §4, like the M2 review screen):
 * process and status, tier, endpoint state and confidence; who it rests on;
 * the rationale, question and hold note as plain text; evidence and history
 * on demand; the answer field of a held placement; and the decision at the
 * foot. The active card (from `?placement=`, else the first open one) takes
 * the A/R/H/C shortcuts and scrolls into view when it becomes active (J/K, a
 * `reviewUrl` to a card far down the overview); its key hints show only while
 * the keys work. A click on the card focuses it, so in edit mode the panel
 * (and with it the keys) takes over from the canvas.
 */
export function PlacementCard({
  project,
  placement: p,
  modelKeys,
  stepOptions,
  linkedByStep = false,
  showStep = false,
  active,
  canReview,
  shortcuts,
  onActivate,
  onSelectStep,
  onDecided,
  onReload,
  autoIndex,
}: PlacementCardProps) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Revoking an auto-acceptance is the owners' (the marks are every reviewer's).
  const owner = useIsOwner(project);
  const self = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (active) self.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const held = p.status === 'held';
  const assertions = useQuery({
    ...placementAssertionsQuery(project, p.id),
    enabled: evidenceOpen || historyOpen || held,
  });
  const { modelKey, elementId: processId } = splitRef(p.process);
  const name = p.processName ?? processId;
  const prov = p.provenance;
  const auto = autoIndex?.inForce.get(p.id);
  const autoEntries = autoIndex?.bySubject.get(p.id) ?? [];
  const proposal = assertions.data ? currentProposal(p, assertions.data) : null;
  const evidence = proposal ? placementEvidenceItems(proposal.evidence, modelKeys) : [];
  const answers = held && assertions.data ? answersSinceHold(p, assertions.data) : [];
  const textLabel =
    prov?.kind === 'decision'
      ? prov.verdict === 'reject'
        ? 'Grund der Ablehnung'
        : prov.verdict === 'hold'
          ? 'Notiz'
          : 'Notiz zur Entscheidung'
      : 'Begründung';

  return (
    <li
      ref={self}
      tabIndex={-1}
      data-testid="placement-card"
      data-placement-id={p.id}
      data-status={p.status}
      data-active={active ? 'true' : 'false'}
      data-auto={auto ? 'true' : undefined}
      aria-current={active ? 'true' : undefined}
      onClick={() => {
        if (!active) onActivate();
      }}
      className={cn(
        'flex scroll-my-2 flex-col gap-2.5 rounded-xl border bg-card p-3 text-sm transition-colors outline-none',
        active ? 'border-primary ring-2 ring-primary/20' : 'hover:border-contour',
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <PlainText as="span" className="font-semibold" text={name} />
          <span className="truncate font-mono text-xs text-muted-foreground" title={p.process}>
            {p.process}
          </span>
          {showStep ? (
            <span className="text-xs text-muted-foreground">
              auf <PlainText as="span" text={placementStepLabel(p)} />
            </span>
          ) : null}
        </div>
        <span className="text-xs tabular-nums text-muted-foreground" title="Konfidenz">
          {formatConfidence(p.confidence)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={p.status} />
        <TierBadge tier={p.tier} />
        <EndpointStateBadge state={p.endpointState} />
        {p.endpoints.process === 'missing' ? (
          <Badge variant="outline">Prozess fehlt</Badge>
        ) : !p.stepLive ? (
          <Badge variant="outline">Schritt entfernt</Badge>
        ) : null}
        {auto ? <AutoAcceptMark entry={auto} /> : null}
      </div>

      {prov?.sourceKind === 'rule' ? (
        <p className="text-xs text-muted-foreground" data-testid="rule-basis">
          Regel: {linkedByStep ? 'Link des Schritts' : 'gleicher Name'}
        </p>
      ) : null}
      {prov?.rationale ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">{textLabel}</p>
          <PlainText text={prov.rationale} />
        </div>
      ) : null}
      {prov?.question ? (
        <div
          className="flex gap-2 rounded-lg border border-warning/40 bg-warning-soft px-2.5 py-1.5"
          data-testid="placement-question"
        >
          <CircleHelpIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">{held ? 'Offene Frage' : 'Frage'}</p>
            <PlainText text={prov.question} />
          </div>
        </div>
      ) : null}
      {prov?.label ? (
        <span>
          <Badge variant="outline">
            <PlainText as="span" text={prov.label} />
          </Badge>
        </span>
      ) : null}

      {prov ? (
        <details className="group text-xs">
          <summary className="cursor-pointer text-muted-foreground select-none">Herkunft</summary>
          <div className="flex flex-col gap-2 pt-2">
            {autoEntries.length > 0 ? (
              <AutoAcceptProvenance project={project} entries={autoEntries} canRevoke={owner} />
            ) : null}
            <ProvenanceList provenance={prov} />
          </div>
        </details>
      ) : null}

      <div className="flex flex-wrap items-center gap-1">
        <Toggle open={evidenceOpen} onToggle={() => setEvidenceOpen((o) => !o)}>
          Belege
        </Toggle>
        <Toggle open={historyOpen} onToggle={() => setHistoryOpen((o) => !o)}>
          Verlauf
        </Toggle>
        {modelKeys.has(modelKey) ? (
          <Button variant="ghost" size="xs" asChild className="ml-auto">
            <Link
              to="/projects/$project/models/$"
              params={{ project, _splat: modelKey }}
              search={{ element: processId }}
            >
              <LocateIcon data-icon="inline-start" />
              Im Modell
            </Link>
          </Button>
        ) : null}
      </div>
      {evidenceOpen ? (
        assertions.isPending ? (
          <Skeleton className="h-8 w-full" />
        ) : evidence.length === 0 ? (
          <p className="text-xs text-muted-foreground">Keine Belege angegeben.</p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Belege">
            {evidence.map((item, i) => (
              <li key={i} className="min-w-0">
                {item.kind === 'ref' ? (
                  <Link
                    to="/projects/$project/models/$"
                    params={{ project, _splat: item.modelKey }}
                    search={{ element: item.elementId }}
                    className="inline-flex max-w-full items-center gap-1.5 text-link hover:underline"
                    data-testid="evidence-link"
                  >
                    <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate font-mono text-xs">{item.text}</span>
                  </Link>
                ) : item.kind === 'relation' ? (
                  <Link
                    to="/projects/$project/review/$relation"
                    params={{ project, relation: item.relationId }}
                    className="inline-flex max-w-full items-center gap-1.5 text-link hover:underline"
                    data-testid="evidence-relation"
                  >
                    <SearchCheckIcon className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate font-mono text-xs">{item.relationId}</span>
                  </Link>
                ) : item.kind === 'step' ? (
                  <button
                    type="button"
                    onClick={() => onSelectStep(item.elementId)}
                    className="inline-flex max-w-full items-center gap-1.5 text-left text-link hover:underline"
                    data-testid="evidence-step"
                  >
                    <CrosshairIcon className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate font-mono text-xs">{item.text}</span>
                  </button>
                ) : (
                  <PlainText as="span" className="text-xs text-muted-foreground" text={item.text} />
                )}
              </li>
            ))}
          </ul>
        )
      ) : null}
      {historyOpen ? (
        assertions.data ? (
          <AssertionTimeline
            assertions={assertions.data}
            basisId={prov?.assertionId ?? null}
            renderLink={(a) => <PlacementLink project={project} assertion={a} />}
            marks={autoIndex?.byAssertion}
          />
        ) : (
          <Skeleton className="h-16 w-full" />
        )
      ) : null}

      {held && answers.length > 0 ? (
        <ol aria-label="Antworten" className="flex flex-col gap-1.5">
          {answers.map((a) => (
            <li key={a.id} data-testid="placement-answer" className="border-l-2 pl-2.5">
              {a.rationale ? <PlainText text={a.rationale} /> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {held && canReview ? <AnswerForm project={project} placementId={p.id} /> : null}

      {canReview ? (
        <PlacementDecisionPanel
          project={project}
          placement={p}
          processName={name}
          stepOptions={stepOptions}
          shortcuts={active && shortcuts}
          showKeys={active && shortcuts}
          onDecided={(outcome) => onDecided(outcome)}
          onReload={onReload}
        />
      ) : null}
    </li>
  );
}
