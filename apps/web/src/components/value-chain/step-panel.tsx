import type { Placement, ValueChainDetail, ValueChainOrgUnit, ValueChainStep } from '@proa/client';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  LocateIcon,
  PlusIcon,
  SearchCheckIcon,
  UsersIcon,
} from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { ToneBadge } from '@/components/badges';
import { PlainText } from '@/components/review/plain-text';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Kbd } from '@/components/ui/kbd';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { LINK_KINDS, REACHED_BY_CALL_LABEL, STEP_KINDS } from '@/lib/labels';
import { MAX_VALUE_CHAIN_NAME_CHARS } from '@/lib/limits';
import { valueChainStepQuery } from '@/lib/queries';
import { splitRef } from '@/lib/refs';
import { isTypingTarget } from '@/lib/use-shortcuts';
import {
  colorOfKind,
  drillDownTarget,
  isWebUrl,
  kindChoiceOf,
  type DrillDownTarget,
  type KindChoice,
  type ProcessOption,
  type StepOption,
} from '@/lib/value-chain';

import type { CanvasElementInfo } from './chain-canvas-types';
import { CommitField } from './commit-field';
import { LinkEditor } from './link-editor';
import { ManualPlacementForm } from './manual-placement-form';
import { PlacementCard } from './placement-card';
import type { PlacementOutcome } from './placement-decision-panel';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** How a step's link reads in view mode (M4 §2 "The link field"). */
function LinkView({ project, step }: { project: string; step: ValueChainStep }) {
  if (step.link === null) return <p className="text-sm text-muted-foreground">Kein Link</p>;
  if (step.linkKind === 'process' && step.linkResolved && step.linkProcess) {
    const { modelKey, elementId } = splitRef(step.linkProcess);
    return (
      <Link
        to="/projects/$project/models/$"
        params={{ project, _splat: modelKey }}
        search={{ element: elementId }}
        className="inline-flex max-w-full items-center gap-1.5 text-sm text-link hover:underline"
        data-testid="step-link"
      >
        <LocateIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate font-mono text-xs">{step.linkProcess}</span>
      </Link>
    );
  }
  if (step.linkKind === 'url' && isWebUrl(step.link)) {
    return (
      <a
        href={step.link}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex max-w-full items-center gap-1.5 text-sm text-link hover:underline"
        data-testid="step-link"
      >
        <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden />
        <PlainText as="span" className="truncate" text={step.link} />
      </a>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-testid="step-link">
      <PlainText as="span" className="font-mono text-xs break-all" text={step.link} />
      <span className="text-xs text-warning">
        {LINK_KINDS[step.linkKind].label}: nicht auflösbar
      </span>
    </div>
  );
}

/**
 * Escape anywhere in the panel goes back to the overview, except where it
 * already means something: a text field, a form (cancel), a dialog.
 */
function backOnEscape(event: KeyboardEvent<HTMLElement>, onBack: () => void) {
  if (event.key !== 'Escape' || event.defaultPrevented || isTypingTarget(event.target)) return;
  if (
    event.target instanceof Element &&
    event.target.closest('form, [role="dialog"], [role="alertdialog"]')
  )
    return;
  event.preventDefault();
  onBack();
}

/** "Zur Übersicht" (also Escape): the keyboard way back to the step tree and the open reviews. */
function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <div>
      <Button variant="ghost" size="xs" onClick={onBack} data-testid="panel-back">
        <ArrowLeftIcon data-icon="inline-start" />
        Zur Übersicht
        <Kbd className="ml-1">Esc</Kbd>
      </Button>
    </div>
  );
}

/** The ancestors of a head step, top first (the path segments as buttons). */
function ancestorsOf(
  step: ValueChainStep,
  steps: readonly ValueChainStep[],
): { elementId: string; name: string }[] {
  const byId = new Map(steps.map((s) => [s.elementId, s]));
  const out: { elementId: string; name: string }[] = [];
  const seen = new Set<string>([step.elementId]);
  let parent = step.parentId === null ? undefined : byId.get(step.parentId);
  while (parent && !seen.has(parent.elementId)) {
    seen.add(parent.elementId);
    out.unshift({ elementId: parent.elementId, name: parent.name });
    parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
  }
  return out;
}

const KIND_CHOICES: { value: KindChoice; label: string }[] = [
  { value: 'none', label: 'Ohne Farbe (Kern oder Sonstige)' },
  { value: 'management', label: 'Management (lila)' },
  { value: 'support', label: 'Unterstützung (grün)' },
];

export interface StepPanelProps {
  project: string;
  elementId: string;
  /** The step in the head revision; `undefined` for a new step not saved yet. */
  step: ValueChainStep | undefined;
  orgUnit: ValueChainOrgUnit | undefined;
  detail: ValueChainDetail | undefined;
  placements: readonly Placement[];
  mode: 'view' | 'edit';
  canReview: boolean;
  /** Edit mode: the element on the canvas (name, colour, link, parent). */
  canvasInfo: CanvasElementInfo | null;
  processes: readonly ProcessOption[];
  stepOptions: readonly StepOption[];
  modelKeys: ReadonlySet<string>;
  activePlacementId: string | null;
  shortcuts: boolean;
  onSelectStep: (elementId: string) => void;
  /** Back to the overview (no selection): "Zur Übersicht" or Escape. */
  onBack: () => void;
  onSelectPlacement: (placementId: string) => void;
  onDecided: (placementId: string, outcome: PlacementOutcome) => void;
  onReload: () => void;
  onOpen: (target: DrillDownTarget) => void;
  onSetName: (name: string) => void;
  onSetColor: (color: string | undefined) => void;
  onSetLink: (link: string | null) => void;
}

/**
 * The side panel with a step selected (M4 §4): name and path, kind, owners,
 * link, its placements as cards (the review happens here), the roll-up of its
 * sub-steps and the processes reached by call, "Prozess hinzufügen" and the
 * drill-down. In edit mode name, kind (top level) and link are edited on the
 * canvas, each change one undoable command. An org unit shows the steps it
 * owns. "Zur Übersicht" (or Escape) goes back to the overview; the path
 * segments select the parent steps.
 */
export function StepPanel(props: StepPanelProps) {
  const {
    project,
    elementId,
    step,
    orgUnit,
    detail,
    placements,
    mode,
    canReview,
    canvasInfo,
    processes,
    stepOptions,
    modelKeys,
    activePlacementId,
    shortcuts,
    onSelectStep,
    onBack,
    onSelectPlacement,
    onDecided,
    onReload,
    onOpen,
  } = props;
  const [adding, setAdding] = useState(false);
  /** Focus goes back to "Prozess hinzufügen" when the form closes. */
  const refocusAdd = useRef(false);
  const closeForm = () => {
    refocusAdd.current = true;
    setAdding(false);
  };
  const isOrgUnit = canvasInfo ? canvasInfo.type === 'orgUnit' : orgUnit !== undefined;
  const drill = useQuery({
    ...valueChainStepQuery(project, elementId),
    enabled: step !== undefined && !isOrgUnit,
  });
  const name =
    mode === 'edit' && canvasInfo ? canvasInfo.name : (step?.name ?? orgUnit?.name ?? '');
  const own = placements.filter((p) => p.elementId === elementId && p.stepLive);

  if (isOrgUnit) {
    const owned = (orgUnit?.stepIds ?? [])
      .map((id) => detail?.steps.find((s) => s.elementId === id))
      .filter((s): s is ValueChainStep => s !== undefined);
    return (
      <div
        className="flex flex-col gap-4"
        data-testid="org-unit-panel"
        onKeyDown={(e) => backOnEscape(e, onBack)}
      >
        <BackButton onBack={onBack} />
        <div className="flex items-center gap-2">
          <UsersIcon className="size-4 text-muted-foreground" aria-hidden />
          <span className="text-xs text-muted-foreground">Organisationseinheit</span>
        </div>
        {mode === 'edit' && canvasInfo ? (
          <NameField value={canvasInfo.name} onCommit={props.onSetName} />
        ) : (
          <h2 className="text-lg font-semibold">
            <PlainText as="span" text={name || 'Ohne Namen'} />
          </h2>
        )}
        <Section title="Verantwortet">
          {owned.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Keinen Schritt (im gespeicherten Stand).
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {owned.map((s) => (
                <li key={s.elementId}>
                  <button
                    type="button"
                    className="text-sm text-link hover:underline"
                    onClick={() => onSelectStep(s.elementId)}
                  >
                    <PlainText as="span" text={s.name} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    );
  }

  const topLevel = canvasInfo ? canvasInfo.parentId === null : step?.parentId === null;
  const kindChoice = kindChoiceOf(canvasInfo?.color);
  const target = step ? drillDownTarget(step) : null;
  const notInHead = drill.error instanceof ApiError && drill.error.status === 404;
  const ancestors = step ? ancestorsOf(step, detail?.steps ?? []) : [];

  return (
    <div
      className="flex flex-col gap-5"
      data-testid="step-panel"
      data-element-id={elementId}
      onKeyDown={(e) => backOnEscape(e, onBack)}
    >
      <div className="flex flex-col gap-2">
        <BackButton onBack={onBack} />
        {ancestors.length > 0 ? (
          <nav
            aria-label="Pfad"
            className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          >
            {ancestors.map((a) => (
              <span key={a.elementId} className="inline-flex items-center gap-1">
                <button
                  type="button"
                  className="rounded-sm hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  onClick={() => onSelectStep(a.elementId)}
                  data-testid="path-segment"
                >
                  <PlainText as="span" text={a.name || a.elementId} />
                </button>
                <ChevronRightIcon className="size-3" aria-hidden />
              </span>
            ))}
          </nav>
        ) : null}
        {mode === 'edit' && canvasInfo ? (
          <NameField value={canvasInfo.name} onCommit={props.onSetName} />
        ) : (
          <h2 className="text-lg leading-tight font-semibold" data-testid="step-name">
            <PlainText as="span" text={name || 'Ohne Namen'} />
          </h2>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {step ? (
            <ToneBadge tone={STEP_KINDS[step.kind].tone} title={STEP_KINDS[step.kind].hint}>
              {STEP_KINDS[step.kind].label}
            </ToneBadge>
          ) : (
            <ToneBadge tone="info">Neuer Schritt</ToneBadge>
          )}
          <span className="font-mono text-xs text-muted-foreground">{elementId}</span>
        </div>
      </div>

      {mode === 'edit' && canvasInfo && topLevel ? (
        <Field>
          <FieldLabel htmlFor="vc-step-kind">Art</FieldLabel>
          <NativeSelect
            id="vc-step-kind"
            value={kindChoice}
            onChange={(e) => {
              const value = e.target.value as KindChoice;
              if (value !== 'custom') props.onSetColor(colorOfKind(value));
            }}
          >
            {KIND_CHOICES.map((k) => (
              <NativeSelectOption key={k.value} value={k.value}>
                {k.label}
              </NativeSelectOption>
            ))}
            {kindChoice === 'custom' ? (
              <NativeSelectOption value="custom" disabled>
                Andere Farbe (Sonstige)
              </NativeSelectOption>
            ) : null}
          </NativeSelect>
          <FieldDescription>
            Kern ergibt sich aus der Vorgänger-Kette der obersten Ebene; Management und
            Unterstützung aus der Farbe.
          </FieldDescription>
        </Field>
      ) : null}

      {step && step.owners.length > 0 ? (
        <Section title="Verantwortlich">
          <p className="flex flex-wrap gap-1.5 text-sm">
            {step.owners.map((o) => (
              <button
                key={o.elementId}
                type="button"
                className="rounded-sm bg-muted px-1.5 hover:bg-accent"
                onClick={() => onSelectStep(o.elementId)}
              >
                <PlainText as="span" text={o.name} />
              </button>
            ))}
          </p>
        </Section>
      ) : null}

      <Section title="Link">
        {mode === 'edit' && canvasInfo ? (
          <LinkEditor link={canvasInfo.link} processes={processes} onChange={props.onSetLink} />
        ) : step ? (
          <LinkView project={project} step={step} />
        ) : null}
      </Section>

      <Section title="Prozesse">
        {!step ? (
          <p className="text-sm text-muted-foreground" data-testid="new-step-hint">
            Neuer Schritt – Platzierungen nach dem Speichern.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground" data-testid="step-counts">
              {step.counts.accepted} angenommen · {step.counts.proposed} vorgeschlagen ·{' '}
              {step.counts.held} vorgemerkt
            </p>
            {own.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Auf diesem Schritt liegt noch kein Prozess.
              </p>
            ) : (
              <ul className="flex flex-col gap-2" aria-label="Platzierungen">
                {own.map((p) => (
                  <PlacementCard
                    key={p.id}
                    project={project}
                    placement={p}
                    modelKeys={modelKeys}
                    stepOptions={stepOptions}
                    linkedByStep={step.linkProcess === p.process}
                    active={p.id === activePlacementId}
                    canReview={canReview}
                    shortcuts={shortcuts}
                    onActivate={() => onSelectPlacement(p.id)}
                    onSelectStep={onSelectStep}
                    onDecided={(outcome) => onDecided(p.id, outcome)}
                    onReload={onReload}
                  />
                ))}
              </ul>
            )}
            {canReview ? (
              adding ? (
                <ManualPlacementForm
                  project={project}
                  target={{ kind: 'process', step: step.elementId, stepName: step.name, processes }}
                  onDone={closeForm}
                  onCancel={closeForm}
                />
              ) : (
                <div>
                  <Button
                    ref={(button) => {
                      if (button && refocusAdd.current) {
                        refocusAdd.current = false;
                        button.focus();
                      }
                    }}
                    variant="outline"
                    size="sm"
                    onClick={() => setAdding(true)}
                    data-testid="add-process"
                  >
                    <PlusIcon data-icon="inline-start" />
                    Prozess hinzufügen
                  </Button>
                </div>
              )
            ) : null}
          </>
        )}
      </Section>

      {step && !notInHead ? (
        drill.isPending ? (
          <Skeleton className="h-12 w-full" />
        ) : drill.data ? (
          <>
            {drill.data.placements.subtree.length > 0 ? (
              <Section title="In den Unterschritten">
                <ul className="flex flex-col gap-1 text-sm" aria-label="Prozesse der Unterschritte">
                  {drill.data.placements.subtree.map((p) => (
                    <li key={p.id} className="flex min-w-0 items-baseline gap-1.5">
                      <PlainText as="span" className="truncate" text={p.processName ?? p.process} />
                      <span className="truncate text-xs text-muted-foreground">
                        auf <PlainText as="span" text={p.stepName ?? p.elementId} />
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}
            {drill.data.placements.reachedByCall.length > 0 ? (
              <Section title={REACHED_BY_CALL_LABEL}>
                <ul
                  className="flex flex-col gap-1 text-sm"
                  aria-label={REACHED_BY_CALL_LABEL}
                  data-testid="reached-by-call"
                >
                  {drill.data.placements.reachedByCall.map((r) => (
                    <li key={r.process} className="flex min-w-0 items-baseline gap-1.5">
                      <PlainText as="span" className="truncate" text={r.name ?? r.process} />
                      {r.via[0] ? (
                        <Link
                          to="/projects/$project/review/$relation"
                          params={{ project, relation: r.via[0].relationId }}
                          className="text-xs text-link hover:underline"
                        >
                          über Aufruf
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">Nur angezeigt, keine Platzierung.</p>
              </Section>
            ) : null}
          </>
        ) : null
      ) : null}

      {step && target ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpen(target)}
            data-testid="open-step"
          >
            {target.kind === 'model' ? (
              <SearchCheckIcon data-icon="inline-start" />
            ) : (
              <FolderOpenIcon data-icon="inline-start" />
            )}
            {target.kind === 'model' ? 'Prozess öffnen' : 'Schritt öffnen'}
          </Button>
          {target.kind === 'model' ? (
            <Button variant="ghost" size="sm" onClick={() => onOpen({ kind: 'step', elementId })}>
              <FolderOpenIcon data-icon="inline-start" />
              Schrittansicht
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The name on the canvas in edit mode: applied on Enter or when leaving the field. */
function NameField({ value, onCommit }: { value: string; onCommit: (name: string) => void }) {
  return (
    <CommitField
      id="vc-element-name"
      label="Name"
      value={value}
      maxLength={MAX_VALUE_CHAIN_NAME_CHARS}
      onCommit={onCommit}
    />
  );
}
