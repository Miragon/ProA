import type { Placement, UnplacedProcess, ValueChainDetail, ValueChainStep } from '@proa/client';
import { CheckCheckIcon, RotateCcwIcon, TriangleAlertIcon, WandSparklesIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { STAGE_ICONS, ToneBadge } from '@/components/badges';
import { PlainText } from '@/components/review/plain-text';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api';
import type { AutoAcceptIndex } from '@/lib/auto-accept';
import { CHAIN_STAGES, STEP_KINDS, VALUE_CHAIN_FINDING_KINDS } from '@/lib/labels';
import { MAX_VALUE_CHAIN_NAME_CHARS, OUTSIDE_STEP } from '@/lib/limits';
import { useRequeueChain } from '@/lib/review-actions';
import { toast } from '@/lib/toast';
import {
  isOpenPlacement,
  openCountsByStep,
  placementQueue,
  placementStepLabel,
  processCount,
  reconfirmCandidates,
  stepTree,
  type StepNode,
  type StepOption,
} from '@/lib/value-chain';

import { BulkReconfirmDialog } from './bulk-reconfirm-dialog';
import { CommitField } from './commit-field';
import { PlacementCard } from './placement-card';
import type { PlacementOutcome } from './placement-decision-panel';
import { UnplacedList } from './unplaced-list';
import { UnsureList } from './unsure-list';

function Section({
  title,
  count,
  children,
  action,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
          {count === undefined ? null : <span className="ml-1 tabular-nums">({count})</span>}
        </h3>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** The tree's ids in display order (depth first). */
function treeOrder(nodes: readonly StepNode[]): string[] {
  return nodes.flatMap((n) => [n.step.elementId, ...treeOrder(n.children)]);
}

function TreeItems({
  nodes,
  level,
  tabStop,
  open,
  onSelect,
  onFocusItem,
  onKey,
}: {
  nodes: readonly StepNode[];
  level: number;
  /** The one item in the tab order (roving tabindex). */
  tabStop: string | null;
  /** Open items per step (`isOpenPlacement`, like the canvas badges). */
  open: ReadonlyMap<string, number>;
  onSelect: (id: string) => void;
  onFocusItem: (id: string) => void;
  onKey: (event: KeyboardEvent<HTMLElement>, node: StepNode) => void;
}) {
  return nodes.map((node) => {
    const { step, children } = node;
    const pending = open.get(step.elementId) ?? 0;
    const placed = step.counts.accepted + step.counts.held;
    return (
      <li key={step.elementId} role="none" className="flex flex-col">
        <div
          role="treeitem"
          aria-level={level}
          tabIndex={step.elementId === tabStop ? 0 : -1}
          data-testid="step-tree-item"
          data-element-id={step.elementId}
          onClick={() => onSelect(step.elementId)}
          onFocus={() => onFocusItem(step.elementId)}
          onKeyDown={(e) => onKey(e, node)}
          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          style={{ paddingLeft: `${8 + (level - 1) * 16}px` }}
        >
          <PlainText
            as="span"
            className="min-w-0 flex-1 truncate"
            text={step.name || step.elementId}
          />
          {level === 1 && step.kind !== 'core' ? (
            <span className="text-xs text-muted-foreground">{STEP_KINDS[step.kind].label}</span>
          ) : null}
          {placed > 0 ? (
            <span
              className="text-xs tabular-nums text-muted-foreground"
              title="angenommen oder vorgemerkt"
            >
              {processCount(placed)}
            </span>
          ) : null}
          {pending > 0 ? (
            <span
              className="text-xs tabular-nums text-warning"
              title="Vorschläge und erneut zu bestätigende Platzierungen"
            >
              {pending} offen
            </span>
          ) : null}
        </div>
        {children.length > 0 ? (
          <ul role="group" className="flex flex-col">
            <TreeItems
              nodes={children}
              level={level + 1}
              tabStop={tabStop}
              open={open}
              onSelect={onSelect}
              onFocusItem={onFocusItem}
              onKey={onKey}
            />
          </ul>
        ) : null}
      </li>
    );
  });
}

/**
 * The step tree (WAI-ARIA tree, every node open): one tab stop (roving
 * tabindex); ArrowDown/ArrowUp move, Home/End jump to the first and last
 * step, ArrowRight goes to the first sub-step, ArrowLeft to the parent;
 * Enter or Space selects. `focusStepId` takes the focus when the tree mounts
 * (back from a step's panel).
 */
function StepTree({
  steps,
  open,
  focusStepId,
  onSelect,
}: {
  steps: readonly ValueChainStep[];
  open: ReadonlyMap<string, number>;
  focusStepId: string | null;
  onSelect: (id: string) => void;
}) {
  const tree = stepTree(steps);
  const order = treeOrder(tree);
  const [current, setCurrent] = useState<string | null>(focusStepId);
  const tabStop = current !== null && order.includes(current) ? current : (order[0] ?? null);
  const root = useRef<HTMLUListElement>(null);

  const focusItem = (id: string | undefined) => {
    if (id === undefined) return;
    const items = root.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [];
    for (const item of items) {
      if (item.dataset['elementId'] === id) {
        item.focus();
        return;
      }
    }
  };

  useEffect(() => {
    if (focusStepId !== null) focusItem(focusStepId);
    // Once, when the tree mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKey(event: KeyboardEvent<HTMLElement>, { step, children }: StepNode) {
    const at = order.indexOf(step.elementId);
    let target: string | undefined;
    switch (event.key) {
      case 'Enter':
      case ' ':
        event.preventDefault();
        onSelect(step.elementId);
        return;
      case 'ArrowDown':
        target = order[Math.min(at + 1, order.length - 1)];
        break;
      case 'ArrowUp':
        target = order[Math.max(at - 1, 0)];
        break;
      case 'Home':
        target = order[0];
        break;
      case 'End':
        target = order.at(-1);
        break;
      case 'ArrowRight':
        target = children[0]?.step.elementId;
        break;
      case 'ArrowLeft':
        target = step.parentId ?? undefined;
        break;
      default:
        return;
    }
    event.preventDefault();
    focusItem(target);
  }

  return (
    <ul ref={root} role="tree" aria-label="Schritte der Kette" className="flex flex-col">
      <TreeItems
        nodes={tree}
        level={1}
        tabStop={tabStop}
        open={open}
        onSelect={onSelect}
        onFocusItem={setCurrent}
        onKey={onKey}
      />
    </ul>
  );
}

export interface ChainOverviewProps {
  project: string;
  detail: ValueChainDetail | undefined;
  placements: readonly Placement[];
  unplaced: readonly UnplacedProcess[] | undefined;
  modelKeys: ReadonlySet<string>;
  stepOptions: readonly StepOption[];
  canReview: boolean;
  mode: 'view' | 'edit';
  activePlacementId: string | null;
  shortcuts: boolean;
  onSelectStep: (elementId: string) => void;
  onSelectPlacement: (placementId: string) => void;
  onDecided: (placementId: string, outcome: PlacementOutcome) => void;
  onReload: () => void;
  /** Edit mode: the chain's name on the canvas and how to change it. */
  chainName?: string;
  onChainName?: (name: string) => void;
  /** Edit mode: head steps with placements missing from the drawing. */
  missingSteps?: readonly ValueChainStep[];
  /** The tree item to focus when the overview opens (back from that step's panel). */
  focusStepId?: string | null;
  /**
   * The auto-accept ledger (owner decision 19, owners only): marks on the
   * cards and the filter „Nur automatisch angenommene“.
   */
  autoIndex?: AutoAcceptIndex;
}

/**
 * The stage of the chain's placement pipeline (M4 §3.5): where the agent
 * stands, and how many processes the next placement task judges (`due`).
 * When the task failed, or processes are due without a queued or claimed
 * task (reviewers' decisions and notes make processes due but queue
 * nothing; chains from before the pipeline), reviewers can queue it here.
 */
function PipelineStage({
  project,
  pipeline,
  canReview,
}: {
  project: string;
  pipeline: ValueChainDetail['pipeline'];
  canReview: boolean;
}) {
  const stage = CHAIN_STAGES[pipeline.stage];
  const requeue = useRequeueChain(project);
  const failed = pipeline.stage === 'agent_failed';
  const open = pipeline.task?.state === 'queued' || pipeline.task?.state === 'claimed';
  const idle = !failed && !open && pipeline.due > 0;

  function queue() {
    requeue.mutate(undefined, {
      onSuccess: (result) => {
        const outcome = result.valueChain?.outcome;
        if (outcome === 'queued' || outcome === 'open') {
          toast({
            tone: 'success',
            title: outcome === 'queued' ? 'Eingeplant' : 'Schon eingeplant',
            description: 'Die Platzierungsaufgabe wartet auf einen Agenten.',
          });
        } else if (outcome === 'nothing-due') {
          toast({
            tone: 'info',
            title: 'Nichts fällig',
            description:
              'Jeder offene Prozess hat ein Urteil des Agenten auf seinem jetzigen Stand.',
          });
        } else {
          toast({
            tone: 'danger',
            title: 'Nicht eingeplant',
            description: 'Das Projekt hat keine Wertschöpfungskette.',
          });
        }
      },
      onError: (error) =>
        toast({ tone: 'danger', title: 'Nicht eingeplant', description: errorMessage(error) }),
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p
        className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground"
        data-testid="chain-stage"
        data-stage={pipeline.stage}
      >
        <span>Platzierungen durch den Agenten:</span>
        <ToneBadge tone={stage.tone} icon={STAGE_ICONS[pipeline.stage]} title={stage.hint}>
          {stage.label}
        </ToneBadge>
        {pipeline.due > 0 ? (
          <span className="tabular-nums" data-testid="chain-due">
            {pipeline.due === 1 ? '1 Prozess fällig' : `${pipeline.due} Prozesse fällig`}
          </span>
        ) : null}
      </p>
      {failed || idle ? (
        <div
          className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
          data-testid="chain-requeue"
        >
          <span>
            {failed
              ? 'Plane die Aufgabe erneut ein, damit ein Agent sie übernimmt.'
              : 'Für diese Prozesse ist keine Aufgabe eingeplant (Entscheidungen und Notizen planen keine ein).'}
          </span>
          {canReview ? (
            <Button
              size="xs"
              variant="outline"
              disabled={requeue.isPending}
              onClick={queue}
              data-testid="requeue-chain"
            >
              <RotateCcwIcon data-icon="inline-start" />
              {failed ? 'Erneut einplanen' : 'Aufgabe einplanen'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The side panel without a selection (M4 §4): the chain in brief with the
 * stage of its placement pipeline, the step tree (one tab stop; arrows,
 * Home/End, Enter), the open reviews with the bulk re-confirm, findings,
 * processes the agent was unsure about, processes without a step, placements
 * outside the chain and on removed steps (that section first while it holds
 * the active card); in edit mode also the chain's name and what the unsaved
 * drawing removes.
 */
export function ChainOverview(props: ChainOverviewProps) {
  const {
    project,
    detail,
    placements,
    unplaced,
    modelKeys,
    stepOptions,
    canReview,
    mode,
    activePlacementId,
    shortcuts,
    onSelectStep,
    onSelectPlacement,
    onDecided,
    onReload,
    autoIndex,
  } = props;
  const [bulkOpen, setBulkOpen] = useState(false);
  const [onlyAuto, setOnlyAuto] = useState(false);
  const autoAccepted = autoIndex ? placements.filter((p) => autoIndex.inForce.has(p.id)) : [];
  const steps = detail?.steps ?? [];
  const queue = placementQueue(placements, steps);
  const reconfirm = reconfirmCandidates(placements);
  const outside = placements.filter((p) => p.elementId === OUTSIDE_STEP);
  const removed = placements.filter((p) => p.elementId !== OUTSIDE_STEP && !p.stepLive);
  const findings = detail?.findings ?? [];
  const withoutStep = findings.filter((f) => f.kind === 'process-without-step');
  const stepFindings = findings.filter((f) => f.kind !== 'process-without-step');
  const stepName = (id: string | null) => steps.find((s) => s.elementId === id)?.name ?? id ?? '';

  // The active card's section leads when it holds the active card (a `reviewUrl` or J/K into
  // `@outside` or a removed step): the card is in view at once, and the sections above it that
  // load later ("Prozesse ohne Schritt") cannot push it away.
  const activeGroup = outside.some((p) => p.id === activePlacementId)
    ? 'outside'
    : removed.some((p) => p.id === activePlacementId)
      ? 'removed'
      : null;

  const card = (p: Placement) => (
    <PlacementCard
      key={p.id}
      project={project}
      placement={p}
      modelKeys={modelKeys}
      stepOptions={stepOptions}
      showStep
      active={p.id === activePlacementId}
      canReview={canReview}
      shortcuts={shortcuts}
      onActivate={() => onSelectPlacement(p.id)}
      onSelectStep={onSelectStep}
      onDecided={(outcome) => onDecided(p.id, outcome)}
      onReload={onReload}
      autoIndex={autoIndex}
    />
  );

  // Owner decision 19: the panel filter shows only what auto-accept rules accepted (in force).
  const autoFilter =
    autoIndex && (autoAccepted.length > 0 || onlyAuto) ? (
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant={onlyAuto ? 'default' : 'outline'}
          aria-pressed={onlyAuto}
          onClick={() => setOnlyAuto((on) => !on)}
          data-testid="filter-auto"
        >
          <WandSparklesIcon data-icon="inline-start" />
          Nur automatisch angenommene
          <span className="tabular-nums opacity-80">{autoAccepted.length}</span>
        </Button>
      </div>
    ) : null;
  if (onlyAuto && autoIndex) {
    return (
      <div className="flex flex-col gap-5" data-testid="chain-overview">
        {autoFilter}
        <Section title="Automatisch angenommen" count={autoAccepted.length}>
          {autoAccepted.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Keine Platzierung ist automatisch angenommen.
            </p>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="auto-accepted-list">
              {autoAccepted.map(card)}
            </ul>
          )}
        </Section>
      </div>
    );
  }

  const outsideSection =
    outside.length > 0 ? (
      <Section title="Außerhalb der Kette" count={outside.length}>
        <ul className="flex flex-col gap-2">{outside.map(card)}</ul>
      </Section>
    ) : null;
  const removedSection =
    removed.length > 0 ? (
      <Section title="Auf entfernten Schritten" count={removed.length}>
        <p className="text-xs text-muted-foreground">
          Diese Schritte gibt es nicht mehr; ProA kennt nur noch ihre ID. Lehne die Platzierungen ab
          oder korrigiere sie auf einen anderen Schritt.
        </p>
        <ul className="flex flex-col gap-2">{removed.map(card)}</ul>
      </Section>
    ) : null;

  return (
    <div className="flex flex-col gap-5" data-testid="chain-overview">
      {autoFilter}
      {mode === 'edit' && props.onChainName ? (
        <CommitField
          id="vc-chain-name"
          label="Name der Kette"
          value={props.chainName ?? ''}
          maxLength={MAX_VALUE_CHAIN_NAME_CHARS}
          required
          onCommit={props.onChainName}
        />
      ) : null}
      {mode === 'edit' && props.missingSteps && props.missingSteps.length > 0 ? (
        <div
          className="flex gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm"
          data-testid="unsaved-removed"
        >
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">Entfernte Schritte mit Platzierungen</p>
            <p className="text-muted-foreground">
              Speicherst du so, bleiben ihre Platzierungen als offene Punkte:
            </p>
            <ul className="mt-1 list-disc pl-4">
              {props.missingSteps.map((s) => (
                <li key={s.elementId}>
                  <PlainText as="span" text={s.name || s.elementId} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {activeGroup === 'outside' ? outsideSection : null}
      {activeGroup === 'removed' ? removedSection : null}

      {detail ? (
        <p className="text-sm text-muted-foreground" data-testid="chain-summary">
          {steps.length} Schritte · {placements.filter((p) => p.status === 'accepted').length}{' '}
          angenommen · {placements.filter(isOpenPlacement).length} offen ·{' '}
          {placements.filter((p) => p.status === 'held').length} vorgemerkt · {findings.length}{' '}
          Befunde
        </p>
      ) : mode === 'edit' ? (
        <p className="text-sm text-muted-foreground">
          Neue Kette: Ziehe Schritte aus der Palette links oder importiere eine .vc.json.
          Gespeichert wird erst mit „Speichern“.
        </p>
      ) : (
        <Skeleton className="h-5 w-full" />
      )}
      {detail ? (
        <PipelineStage project={project} pipeline={detail.pipeline} canReview={canReview} />
      ) : null}

      {steps.length > 0 ? (
        <Section title="Schritte" count={steps.length}>
          <StepTree
            steps={steps}
            open={openCountsByStep(placements)}
            focusStepId={props.focusStepId ?? null}
            onSelect={onSelectStep}
          />
        </Section>
      ) : null}

      {detail ? (
        <Section
          title="Offene Prüfungen"
          count={queue.length}
          action={
            canReview && reconfirm.selectable.length > 0 ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => setBulkOpen(true)}
                data-testid="open-bulk-reconfirm"
              >
                <CheckCheckIcon data-icon="inline-start" />
                Alle erneut bestätigen ({reconfirm.selectable.length})
              </Button>
            ) : null
          }
        >
          {queue.length === 0 ? (
            <p className="text-sm text-muted-foreground">Keine Platzierung wartet auf dich.</p>
          ) : (
            <ul className="flex flex-col gap-1" aria-label="Offene Platzierungen">
              {queue.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    data-testid="open-placement"
                    data-placement-id={p.id}
                    onClick={() => onSelectPlacement(p.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <PlainText
                        as="span"
                        className="truncate font-medium"
                        text={p.processName ?? p.process}
                      />
                      <span className="truncate text-xs text-muted-foreground">
                        <PlainText as="span" text={placementStepLabel(p)} />
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {p.status === 'proposed' ? 'Vorschlag' : 'erneut prüfen'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {detail ? (
        <Section title="Befunde" count={findings.length}>
          {findings.length === 0 ? (
            <p className="text-sm text-muted-foreground">Keine Befunde.</p>
          ) : (
            <ul className="flex flex-col gap-1.5" aria-label="Befunde der Kette">
              {withoutStep.length > 0 ? (
                <li
                  className="text-sm"
                  data-testid="chain-finding"
                  data-kind="process-without-step"
                >
                  <ToneBadge tone="warning">
                    {VALUE_CHAIN_FINDING_KINDS['process-without-step'].label}
                  </ToneBadge>{' '}
                  {withoutStep.length === 1 ? '1 Prozess' : `${withoutStep.length} Prozesse`} ohne
                  angenommenen Schritt
                  {withoutStep.some((f) => f.state === 'proposed')
                    ? `, ${withoutStep.filter((f) => f.state === 'proposed').length} mit offenem Vorschlag`
                    : ''}
                  {withoutStep.some((f) => f.state === 'held')
                    ? `, ${withoutStep.filter((f) => f.state === 'held').length} vorgemerkt`
                    : ''}
                  .
                </li>
              ) : null}
              {stepFindings.map((f) => (
                <li
                  key={`${f.kind}:${f.elementId}`}
                  className="flex flex-wrap items-center gap-1.5 text-sm"
                  data-testid="chain-finding"
                  data-kind={f.kind}
                >
                  <ToneBadge tone="warning">{VALUE_CHAIN_FINDING_KINDS[f.kind].label}</ToneBadge>
                  <button
                    type="button"
                    className="text-link hover:underline"
                    onClick={() => f.elementId && onSelectStep(f.elementId)}
                  >
                    <PlainText as="span" text={stepName(f.elementId)} />
                  </button>
                  {f.link ? (
                    <PlainText
                      as="span"
                      className="truncate font-mono text-xs text-muted-foreground"
                      text={f.link}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {detail && detail.unsure.length > 0 ? (
        <Section title="Agent unsicher" count={detail.unsure.length}>
          <UnsureList
            project={project}
            items={detail.unsure}
            steps={stepOptions}
            canReview={canReview}
          />
        </Section>
      ) : null}

      {detail ? (
        <Section title="Prozesse ohne Schritt" count={unplaced?.length}>
          {unplaced ? (
            <UnplacedList
              project={project}
              processes={unplaced}
              steps={stepOptions}
              canReview={canReview}
              onSelectStep={onSelectStep}
            />
          ) : (
            <Skeleton className="h-16 w-full" />
          )}
        </Section>
      ) : null}

      {activeGroup === 'outside' ? null : outsideSection}
      {activeGroup === 'removed' ? null : removedSection}

      {canReview ? (
        <BulkReconfirmDialog
          project={project}
          placements={placements}
          open={bulkOpen}
          onOpenChange={setBulkOpen}
          onShowPlacement={onSelectPlacement}
        />
      ) : null}
    </div>
  );
}
