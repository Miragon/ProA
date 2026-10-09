import type {
  Placement,
  PlacementSummary,
  StepKind,
  ValueChainDetail,
  ValueChainImpact,
  ValueChainStep,
  ValueChainViolation,
} from '@proa/client';

import { OUTSIDE_LABEL, STEP_KIND_ORDER, VALUE_CHAIN_VIOLATION_TEXTS } from './labels';
import {
  BIDI_CHARACTERS,
  MAX_VALUE_CHAIN_BYTES,
  MAX_VALUE_CHAIN_CONNECTIONS,
  MAX_VALUE_CHAIN_ELEMENTS,
  MAX_VALUE_CHAIN_LINK_CHARS,
  OUTSIDE_STEP,
  PROA_PROCESS_LINK_PREFIX,
  STEP_KIND_COLORS,
} from './limits';
import { splitRef } from './refs';

/**
 * The value chain page (M4 §4), pure: what the canvas badges say, which
 * placements are open and in which order J/K walks them, the step tree,
 * drill-down targets, evidence, the save's impact and its confirmation rule,
 * violation texts, link editing and the client's pre-check. No React, no
 * renderer: the chain chunk stays thin and everything here is unit-tested.
 */

type Status = Pick<PlacementSummary, 'status' | 'endpointState'>;

/**
 * An open placement item (the "Wertschöpfungskette" tab count, the J/K queue):
 * a proposal, or an accepted placement whose step or process changed or is
 * missing (re-confirm, reject or correct). Held placements wait for an answer.
 */
export function isOpenPlacement(p: Status): boolean {
  return p.status === 'proposed' || (p.status === 'accepted' && p.endpointState !== 'ok');
}

/**
 * Placements that home a process on a step: accepted or held (the step tree
 * and the step view count the same). A proposal is not homed yet; it counts
 * as open.
 */
function countsAsProcess(p: Pick<PlacementSummary, 'status'>): boolean {
  return p.status === 'accepted' || p.status === 'held';
}

export interface StepBadge {
  /** "3 Prozesse · 2 offen", "1 Prozess", "1 offen". */
  text: string;
  /** Accepted or held placements. */
  total: number;
  /** Open items (`isOpenPlacement`). */
  open: number;
  tone: 'warning' | 'neutral';
}

/** `1 Prozess`, `3 Prozesse`. */
export function processCount(n: number): string {
  return n === 1 ? '1 Prozess' : `${n} Prozesse`;
}

/**
 * The overlay badge of one step (M4 §4 "Overlays"): the processes homed on its
 * live generation (accepted or held) and its open items (proposals, accepted
 * placements to re-confirm); `null` for a step without either.
 */
export function stepBadge(
  elementId: string,
  placements: readonly Pick<
    PlacementSummary,
    'elementId' | 'stepLive' | 'status' | 'endpointState'
  >[],
): StepBadge | null {
  let total = 0;
  let open = 0;
  for (const p of placements) {
    if (p.elementId !== elementId || !p.stepLive) continue;
    if (countsAsProcess(p)) total += 1;
    if (isOpenPlacement(p)) open += 1;
  }
  if (total === 0 && open === 0) return null;
  const parts = [total > 0 ? processCount(total) : '', open > 0 ? `${open} offen` : ''];
  return {
    text: parts.filter(Boolean).join(' · '),
    total,
    open,
    tone: open > 0 ? 'warning' : 'neutral',
  };
}

/** Open items per live step (the step tree; the same rule as the badges). */
export function openCountsByStep(
  placements: readonly Pick<
    PlacementSummary,
    'elementId' | 'stepLive' | 'status' | 'endpointState'
  >[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of placements) {
    if (!p.stepLive || !isOpenPlacement(p)) continue;
    out.set(p.elementId, (out.get(p.elementId) ?? 0) + 1);
  }
  return out;
}

/** Open placement items of the chain (the tab count). */
export function openPlacementCount(detail: Pick<ValueChainDetail, 'placements'>): number {
  return detail.placements.filter(isOpenPlacement).length;
}

// ------------------------------------------------------------------ steps

/** Top-level order: the core chain, then the management, support and other bands, each by rank. */
function kindIndex(kind: StepKind): number {
  return STEP_KIND_ORDER.indexOf(kind);
}

export interface StepNode {
  step: ValueChainStep;
  children: StepNode[];
}

/**
 * The step tree for the panel: top-level steps by kind band and rank,
 * sub-steps by rank (`childIds`).
 */
export function stepTree(steps: readonly ValueChainStep[]): StepNode[] {
  const byId = new Map(steps.map((s) => [s.elementId, s]));
  const build = (step: ValueChainStep): StepNode => ({
    step,
    children: step.childIds.flatMap((id) => {
      const child = byId.get(id);
      return child ? [build(child)] : [];
    }),
  });
  return steps
    .filter((s) => s.parentId === null)
    .sort(
      (a, b) =>
        kindIndex(a.kind) - kindIndex(b.kind) ||
        a.rank - b.rank ||
        a.elementId.localeCompare(b.elementId),
    )
    .map(build);
}

/** Steps in tree order (depth first), e.g. for pickers. */
export function stepsInOrder(steps: readonly ValueChainStep[]): ValueChainStep[] {
  const out: ValueChainStep[] = [];
  const walk = (nodes: readonly StepNode[]) => {
    for (const n of nodes) {
      out.push(n.step);
      walk(n.children);
    }
  };
  walk(stepTree(steps));
  return out;
}

/** "Vertrieb › Auftragsabwicklung". */
export function pathText(step: Pick<ValueChainStep, 'path'>): string {
  return step.path.join(' › ');
}

/**
 * The sort key of a step in tree order: kind band, then the ranks from the
 * top level down (so a parent sorts before its children).
 */
function stepOrderKey(
  step: ValueChainStep | undefined,
  byId: ReadonlyMap<string, ValueChainStep>,
): number[] {
  if (!step) return [];
  const ranks: number[] = [];
  let current: ValueChainStep | undefined = step;
  let top: ValueChainStep = step;
  while (current) {
    ranks.unshift(current.rank);
    top = current;
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return [kindIndex(top.kind), ...ranks];
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

type QueueEntry = Pick<
  PlacementSummary,
  'id' | 'elementId' | 'stepLive' | 'process' | 'status' | 'endpointState' | 'confidence'
>;

/**
 * The open placements in review order (J/K, "next" after a decision): live
 * steps in tree order (top-level band and rank, then the path down), then
 * `@outside`, then removed steps; within a step the highest confidence first.
 */
export function placementQueue<T extends QueueEntry>(
  placements: readonly T[],
  steps: readonly ValueChainStep[],
): T[] {
  const byId = new Map(steps.map((s) => [s.elementId, s]));
  const group = (p: QueueEntry) =>
    p.elementId === OUTSIDE_STEP ? 1 : p.stepLive && byId.has(p.elementId) ? 0 : 2;
  return placements
    .filter(isOpenPlacement)
    .sort(
      (a, b) =>
        group(a) - group(b) ||
        compareKeys(
          group(a) === 0 ? stepOrderKey(byId.get(a.elementId), byId) : [],
          group(b) === 0 ? stepOrderKey(byId.get(b.elementId), byId) : [],
        ) ||
        a.elementId.localeCompare(b.elementId) ||
        (b.confidence ?? 0) - (a.confidence ?? 0) ||
        a.process.localeCompare(b.process) ||
        a.id.localeCompare(b.id),
    );
}

/** Position of `id` in the queue and its neighbours (outside the queue, "next" is the first). */
export function queueNeighbours<T extends { id: string }>(
  queue: readonly T[],
  id: string | null,
): { index: number; previous: T | null; next: T | null } {
  const index = id === null ? -1 : queue.findIndex((p) => p.id === id);
  if (index < 0) return { index, previous: null, next: queue[0] ?? null };
  return { index, previous: queue[index - 1] ?? null, next: queue[index + 1] ?? null };
}

/** How a placement's step reads: its name, „Außerhalb der Kette“, or a removed step's id. */
export function placementStepLabel(
  p: Pick<Placement, 'elementId' | 'generation' | 'stepName' | 'stepLive'>,
): string {
  if (p.elementId === OUTSIDE_STEP) return OUTSIDE_LABEL;
  if (p.stepName !== null && p.stepLive) return p.stepName;
  return `${p.elementId} (Generation ${p.generation}, entfernt)`;
}

// ------------------------------------------------------------- drill-down

export type DrillDownTarget =
  { kind: 'model'; modelKey: string; elementId: string } | { kind: 'step'; elementId: string };

/**
 * Where a double-click (view mode) or „Schritt öffnen“ leads (M4 §2 "The link
 * field", §4): a resolved `proa:process/` link opens that process's model view,
 * every other step the ProA step view.
 */
export function drillDownTarget(
  step: Pick<ValueChainStep, 'elementId' | 'linkKind' | 'linkProcess' | 'linkResolved'>,
): DrillDownTarget {
  if (step.linkKind === 'process' && step.linkResolved && step.linkProcess) {
    const { modelKey, elementId } = splitRef(step.linkProcess);
    if (modelKey !== '' && elementId !== '') return { kind: 'model', modelKey, elementId };
  }
  return { kind: 'step', elementId: step.elementId };
}

// --------------------------------------------------------------- evidence

/** An evidence entry of a placement proposal (M4 §3.1). */
export type PlacementEvidenceItem =
  | { kind: 'ref'; text: string; modelKey: string; elementId: string }
  | { kind: 'relation'; text: string; relationId: string }
  | { kind: 'step'; text: string; elementId: string }
  | { kind: 'text'; text: string };

const REF_PATTERN = /^[^\s#]+#[^\s#]+$/;
const RELATION_PATTERN = /^rel_[0-9A-Za-z]+$/;
const STEP_PREFIX = 'step:';

/**
 * Splits evidence into fact refs of known models (model view), relation ids
 * (review screen), `step:<id>` (select the step) and plain text.
 */
export function placementEvidenceItems(
  evidence: readonly string[],
  modelKeys: ReadonlySet<string>,
): PlacementEvidenceItem[] {
  return evidence.map((text) => {
    const trimmed = text.trim();
    if (RELATION_PATTERN.test(trimmed))
      return { kind: 'relation', text: trimmed, relationId: trimmed };
    if (
      trimmed.startsWith(STEP_PREFIX) &&
      trimmed.length > STEP_PREFIX.length &&
      !/\s/.test(trimmed)
    )
      return { kind: 'step', text: trimmed, elementId: trimmed.slice(STEP_PREFIX.length) };
    if (REF_PATTERN.test(trimmed)) {
      const { modelKey, elementId } = splitRef(trimmed);
      if (modelKeys.has(modelKey)) return { kind: 'ref', text: trimmed, modelKey, elementId };
    }
    return { kind: 'text', text };
  });
}

// ----------------------------------------------------------------- review

export interface PlacementActions {
  accept: boolean;
  reject: boolean;
  hold: boolean;
  correct: boolean;
  /** Accepting re-confirms an accepted placement whose step or process changed. */
  reconfirm: boolean;
  /** Why only reject and correct remain, if so. */
  limited: 'removed-step' | 'missing-process' | null;
}

/**
 * What a reviewer may do with a placement (M4 §4; S1/S2 rules): nothing when
 * obsolete; only reject or correct when its step was removed or its process
 * left the head (the server refuses accept and hold, `unknown-step`);
 * otherwise as for relations.
 */
export function placementActions(
  p: Pick<Placement, 'status' | 'endpointState' | 'stepLive' | 'endpoints'>,
): PlacementActions {
  if (p.status === 'obsolete') {
    return {
      accept: false,
      reject: false,
      hold: false,
      correct: false,
      reconfirm: false,
      limited: null,
    };
  }
  const limited = !p.stepLive
    ? ('removed-step' as const)
    : p.endpoints.process === 'missing'
      ? ('missing-process' as const)
      : null;
  if (limited) {
    return {
      accept: false,
      reject: p.status !== 'rejected',
      hold: false,
      correct: true,
      reconfirm: false,
      limited,
    };
  }
  const reconfirm = p.status === 'accepted' && p.endpointState === 'changed';
  return {
    accept: p.status !== 'accepted' || reconfirm,
    reject: p.status !== 'rejected',
    hold: true,
    correct: true,
    reconfirm,
    limited: null,
  };
}

/**
 * The bulk re-confirm of the S3 checklist: accepted placements whose step or
 * process changed, on a live step with the process still there (`selectable`);
 * accepted placements on removed steps or with a missing process are listed
 * apart (`apart`): only a rejection or a correction closes them.
 */
export function reconfirmCandidates<
  T extends Pick<Placement, 'status' | 'endpointState' | 'stepLive' | 'endpoints'>,
>(placements: readonly T[]): { selectable: T[]; apart: T[] } {
  const selectable: T[] = [];
  const apart: T[] = [];
  for (const p of placements) {
    if (p.status !== 'accepted' || p.endpointState === 'ok') continue;
    if (!p.stepLive || p.endpoints.process === 'missing') apart.push(p);
    else if (p.endpointState === 'changed') selectable.push(p);
  }
  return { selectable, apart };
}

// ----------------------------------------------------------------- saving

/**
 * Whether a save needs the reviewer's confirmation (M4 §4 "Save": steps that
 * have placements): it strands accepted or held placements, sends accepted
 * ones to re-confirm, or withdraws proposals.
 */
export function needsConfirmation(impact: ValueChainImpact): boolean {
  const p = impact.placements;
  return p.stranded > 0 || p.toReconfirm > 0 || p.proposalsWithdrawn > 0;
}

/** A removed step in the impact dialog. */
export interface RemovedLine {
  elementId: string;
  name: string;
  accepted: number;
  held: number;
  proposed: number;
}

/** A renamed or re-parented step whose accepted placements go to re-confirm. */
export interface ChangedLine {
  elementId: string;
  before: string;
  after: string;
  accepted: number;
  /** Name or parent changed (the fingerprint), not only the kind. */
  fingerprintChanged: boolean;
  kindOnly: boolean;
}

export interface ImpactSummary {
  removed: RemovedLine[];
  /** Name or parent changed. */
  changed: ChangedLine[];
  /** Only the kind changed (information). */
  kindOnly: ChangedLine[];
  added: { elementId: string; name: string }[];
  stranded: number;
  toReconfirm: number;
  proposalsWithdrawn: number;
}

export function impactSummary(impact: ValueChainImpact): ImpactSummary {
  const changed: ChangedLine[] = impact.steps.changed.map((c) => ({
    elementId: c.elementId,
    before: c.before.name,
    after: c.after.name,
    accepted: c.placements.accepted,
    fingerprintChanged: c.fingerprintChanged,
    kindOnly: !c.fingerprintChanged,
  }));
  return {
    removed: impact.steps.removed.map((r) => ({
      elementId: r.elementId,
      name: r.name,
      accepted: r.placements.accepted,
      held: r.placements.held,
      proposed: r.placements.proposed,
    })),
    changed: changed.filter((c) => c.fingerprintChanged),
    kindOnly: changed.filter((c) => c.kindOnly),
    added: impact.steps.added,
    stranded: impact.placements.stranded,
    toReconfirm: impact.placements.toReconfirm,
    proposalsWithdrawn: impact.placements.proposalsWithdrawn,
  };
}

/** Whether two impacts say the same about placements (the save's own vs the dry run's). */
export function sameImpact(a: ValueChainImpact, b: ValueChainImpact): boolean {
  const key = (i: ValueChainImpact) =>
    JSON.stringify([
      i.placements,
      i.steps.removed.map((r) => [r.elementId, r.placements]),
      i.steps.changed.map((c) => [c.elementId, c.fingerprintChanged, c.placements]),
    ]);
  return key(a) === key(b);
}

/** One sentence for the save toast: what the save did to placements. */
export function impactSentence(impact: ValueChainImpact): string {
  const parts: string[] = [];
  const p = impact.placements;
  if (p.stranded > 0)
    parts.push(
      p.stranded === 1
        ? '1 Platzierung bleibt als offener Punkt'
        : `${p.stranded} Platzierungen bleiben als offene Punkte`,
    );
  if (p.toReconfirm > 0)
    parts.push(
      p.toReconfirm === 1
        ? '1 Platzierung musst du erneut bestätigen'
        : `${p.toReconfirm} Platzierungen musst du erneut bestätigen`,
    );
  if (p.proposalsWithdrawn > 0)
    parts.push(
      p.proposalsWithdrawn === 1
        ? '1 Vorschlag zurückgezogen'
        : `${p.proposalsWithdrawn} Vorschläge zurückgezogen`,
    );
  const s = impact.steps;
  const steps: string[] = [];
  if (s.added.length > 0) steps.push(`${s.added.length} neu`);
  if (s.removed.length > 0) steps.push(`${s.removed.length} entfernt`);
  if (s.changed.length > 0) steps.push(`${s.changed.length} geändert`);
  const head = steps.length > 0 ? `Schritte: ${steps.join(', ')}.` : 'Nur Layout geändert.';
  return parts.length > 0 ? `${head} ${parts.join('; ')}.` : head;
}

/** `"r12"` (the content ETag) → 12; `null` for anything else. */
export function revisionOfEtag(etag: string | null): number | null {
  const match = etag === null ? null : /^(?:W\/)?"r([1-9][0-9]{0,8})"$/.exec(etag.trim());
  return match ? Number(match[1]) : null;
}

export interface Precheck {
  bytes: number;
  elements: number;
  connections: number;
  /** German messages; empty when the server may judge the rest. */
  problems: string[];
}

/**
 * The client's pre-check before a dry run (M4 §4): the canonical bytes and
 * the element and connection counts. Everything else is the server's call.
 */
export function precheck(text: string): Precheck {
  const bytes = new TextEncoder().encode(text).length;
  let elements = 0;
  let connections = 0;
  try {
    const doc = JSON.parse(text) as { elements?: unknown; connections?: unknown };
    elements = Array.isArray(doc.elements) ? doc.elements.length : 0;
    connections = Array.isArray(doc.connections) ? doc.connections.length : 0;
  } catch {
    // the canonical text is JSON; a failure here leaves the counts at 0
  }
  const problems: string[] = [];
  if (bytes > MAX_VALUE_CHAIN_BYTES)
    problems.push(
      `Die Kette ist mit ${formatKb(bytes)} zu groß (höchstens ${formatKb(MAX_VALUE_CHAIN_BYTES)}).`,
    );
  if (elements > MAX_VALUE_CHAIN_ELEMENTS)
    problems.push(
      `Die Kette hat ${elements} Elemente, höchstens ${MAX_VALUE_CHAIN_ELEMENTS} sind erlaubt.`,
    );
  if (connections > MAX_VALUE_CHAIN_CONNECTIONS)
    problems.push(
      `Die Kette hat ${connections} Verbindungen, höchstens ${MAX_VALUE_CHAIN_CONNECTIONS.toLocaleString('de-DE')} sind erlaubt.`,
    );
  return { bytes, elements, connections, problems };
}

function formatKb(bytes: number): string {
  return `${Math.ceil(bytes / 1024).toLocaleString('de-DE')} KB`;
}

export interface ViolationLine {
  text: string;
  /** The element or connection to select, if any. */
  elementId: string | null;
  connectionId: string | null;
  /** Its name (from the local document), else the id. */
  where: string | null;
}

/** German text and the named element of one violation (422 `value-chain-invalid`). */
export function violationLine(
  v: ValueChainViolation,
  nameOf: (id: string) => string | null,
): ViolationLine {
  const target = v.elementId ?? v.connectionId;
  const name = target === null ? null : nameOf(target);
  return {
    text: VALUE_CHAIN_VIOLATION_TEXTS[v.reason] ?? v.detail,
    elementId: v.elementId,
    connectionId: v.connectionId,
    where: target === null ? null : name && name.trim() !== '' ? `„${name}“ (${target})` : target,
  };
}

// ------------------------------------------------------------------- links

export type LinkMode = 'none' | 'process' | 'other';

/** `proa:process/<model_key>#<process_id>`. */
export function processLink(processRef: string): string {
  return `${PROA_PROCESS_LINK_PREFIX}${processRef}`;
}

/** How the link editor shows a link: none, a ProA process (its ref) or other text. */
export function parseLink(link: string | null | undefined): { mode: LinkMode; value: string } {
  if (link === null || link === undefined || link === '') return { mode: 'none', value: '' };
  if (link.startsWith(PROA_PROCESS_LINK_PREFIX)) {
    const ref = link.slice(PROA_PROCESS_LINK_PREFIX.length);
    if (REF_PATTERN.test(ref)) return { mode: 'process', value: ref };
  }
  return { mode: 'other', value: link };
}

const LINK_CONTROL = /\p{Cc}/u;

/** Why a free link is refused (mirrors the ProA rules), or `null`. */
export function linkProblem(text: string): string | null {
  if (text.trim() === '') return 'Gib einen Link ein oder wähle „Kein Link“.';
  if (text.length > MAX_VALUE_CHAIN_LINK_CHARS)
    return `Höchstens ${MAX_VALUE_CHAIN_LINK_CHARS.toLocaleString('de-DE')} Zeichen.`;
  if (LINK_CONTROL.test(text) || BIDI_CHARACTERS.test(text))
    return 'Keine Steuer- oder Richtungszeichen (auch keine Zeilenumbrüche).';
  return null;
}

/** An http(s) URL, shown as an external link. */
export function isWebUrl(link: string): boolean {
  return /^https?:\/\/\S+$/i.test(link);
}

// ------------------------------------------------------------------- kinds

export type KindChoice = 'none' | 'management' | 'support' | 'custom';

/** Normalized as the server compares colours: lowercase, no whitespace. */
function normColor(color: string | undefined | null): string {
  return (color ?? '').toLowerCase().replace(/\s+/g, '');
}

/** Which kind a top-level step's colour gives (the "Art" select). */
export function kindChoiceOf(color: string | undefined | null): KindChoice {
  const c = normColor(color);
  if (c === '') return 'none';
  if (c === normColor(STEP_KIND_COLORS.management)) return 'management';
  if (c === normColor(STEP_KIND_COLORS.support)) return 'support';
  return 'custom';
}

/** The colour that gives a kind; `undefined` removes the colour. */
export function colorOfKind(choice: Exclude<KindChoice, 'custom'>): string | undefined {
  return choice === 'none' ? undefined : STEP_KIND_COLORS[choice];
}

// ----------------------------------------------------------------- edit mode

/**
 * Head steps that have placements but are missing from the document being
 * edited (the unsaved-changes summary): saving would strand or withdraw them.
 */
export function stepsMissingFromCanvas(
  detail: Pick<ValueChainDetail, 'steps'>,
  elementIds: ReadonlySet<string>,
): ValueChainStep[] {
  return detail.steps.filter(
    (s) =>
      !elementIds.has(s.elementId) && s.counts.accepted + s.counts.held + s.counts.proposed > 0,
  );
}

/** `<key>-r<rev>[-entwurf].vc.json`. */
export function documentFileName(project: string, rev: number | null, draft: boolean): string {
  return `${project}${rev === null ? '' : `-r${rev}`}${draft ? '-entwurf' : ''}.vc.json`;
}

// ---------------------------------------------------------------- pickers

/** A step to pick (correct, place, add): head steps in tree order, optionally `@outside`. */
export interface StepOption {
  elementId: string;
  name: string;
  /** "Vertrieb › Auftragsabwicklung"; empty for `@outside`. */
  path: string;
}

export function stepOptions(
  steps: readonly ValueChainStep[],
  { outside = false, exclude }: { outside?: boolean; exclude?: string } = {},
): StepOption[] {
  const out: StepOption[] = stepsInOrder(steps)
    .filter((s) => s.elementId !== exclude)
    .map((s) => ({ elementId: s.elementId, name: s.name, path: pathText(s) }));
  if (outside && exclude !== OUTSIDE_STEP)
    out.push({ elementId: OUTSIDE_STEP, name: OUTSIDE_LABEL, path: '' });
  return out;
}

/** A head process to pick (link editor, "Prozess hinzufügen"). */
export interface ProcessOption {
  /** `<model_key>#<process_id>`. */
  ref: string;
  /** Process name, else the pool name, else the process id. */
  name: string;
  modelKey: string;
}

/** The head processes of every model, by model key and name. */
export function processOptions(
  facts: Iterable<{
    modelKey: string;
    processes: readonly {
      ref: string;
      processId: string;
      name: string | null;
      participantName: string | null;
    }[];
  }>,
): ProcessOption[] {
  const out: ProcessOption[] = [];
  for (const f of facts) {
    for (const p of f.processes) {
      out.push({
        ref: p.ref,
        name: p.name ?? p.participantName ?? p.processId,
        modelKey: f.modelKey,
      });
    }
  }
  return out.sort((a, b) => a.modelKey.localeCompare(b.modelKey) || a.name.localeCompare(b.name));
}

/** The CLI command that uploads a chain drawn elsewhere (`proa value-chain push`, M4 S2). */
export function pushCommand(project: string): string {
  return `proa value-chain push kette.vc.json -p ${project}`;
}
