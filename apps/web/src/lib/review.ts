import type { Model, ModelStage, Relation, RelationAssertion, Tier } from '@proa/client';

import { ApiError } from './api';
import { STAGE_ORDER, TIER_ORDER } from './labels';
import { splitRef } from './refs';
import { touchesModel } from './relation-filters';

/**
 * The review inbox (CONCEPT §3 "Review workflow"): open proposals sorted by
 * confidence and by how many models a decision finishes, held items in their
 * own list, model counts per pipeline stage. Pure functions, shared by the
 * inbox and the review screen, so "next" on the review screen follows the
 * same order as the inbox.
 */

/** Narrows the queue; kept in the URL so the review screen walks the same list. */
export interface QueueFilters {
  /** Only relations touching a model in this pipeline stage. */
  stage?: ModelStage;
  tier?: Tier;
  /** Only relations with an endpoint in this model. */
  model?: string;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Validates untrusted search params (TanStack Router `validateSearch`). */
export function parseQueueFilters(search: Record<string, unknown>): QueueFilters {
  const out: QueueFilters = {};
  const stage = oneOf(STAGE_ORDER, search['stage']);
  const tier = oneOf(TIER_ORDER, search['tier']);
  const model = search['model'];
  if (stage) out.stage = stage;
  if (tier) out.tier = tier;
  if (typeof model === 'string' && model !== '') out.model = model;
  return out;
}

type ModelInfo = Pick<Model, 'key' | 'stage' | 'openItems'>;

/** Model keys at both ends of a relation (one key when both ends lie in one file). */
export function modelKeysOf(relation: Pick<Relation, 'from' | 'to'>): string[] {
  const from = splitRef(relation.from).modelKey;
  const to = splitRef(relation.to).modelKey;
  return from === to ? [from] : [from, to];
}

/**
 * How many models a decision on this proposal finishes: models whose only
 * open item it is (CONCEPT §3: the inbox is sorted "by how many open items a
 * decision closes").
 */
export function finishesModels(
  relation: Pick<Relation, 'from' | 'to'>,
  openItems: ReadonlyMap<string, number>,
): number {
  return modelKeysOf(relation).filter((key) => openItems.get(key) === 1).length;
}

function matchesQueue(
  relation: Relation,
  filters: QueueFilters,
  stageOf: ReadonlyMap<string, ModelStage>,
): boolean {
  if (filters.tier !== undefined && relation.tier !== filters.tier) return false;
  if (filters.model !== undefined && !touchesModel(relation, filters.model)) return false;
  if (filters.stage !== undefined) {
    return modelKeysOf(relation).some((key) => stageOf.get(key) === filters.stage);
  }
  return true;
}

export interface QueueItem {
  relation: Relation;
  /** Models this decision finishes (0–2). */
  finishes: number;
}

/**
 * Whether a relation waits for a review decision (CONCEPT §2, §3, the
 * `review_items` of the stage): a proposal, or an accepted relation whose
 * endpoint changed or is missing since the decision. Held relations have
 * their own list.
 */
export function isReviewItem(relation: Pick<Relation, 'status' | 'endpointState'>): boolean {
  return (
    relation.status === 'proposed' ||
    (relation.status === 'accepted' && relation.endpointState !== 'ok')
  );
}

/**
 * The review queue in review order: open proposals and accepted relations
 * whose endpoint changed ({@link isReviewItem}), highest confidence first,
 * then those that finish the most models, then by refs (stable).
 */
export function reviewQueue(
  relations: readonly Relation[],
  models: readonly ModelInfo[],
  filters: QueueFilters = {},
): QueueItem[] {
  const stageOf = new Map(models.map((m) => [m.key, m.stage]));
  const openItems = new Map(models.map((m) => [m.key, m.openItems]));
  return relations
    .filter((r) => isReviewItem(r) && matchesQueue(r, filters, stageOf))
    .map((relation) => ({ relation, finishes: finishesModels(relation, openItems) }))
    .sort(
      (a, b) =>
        (b.relation.confidence ?? 0) - (a.relation.confidence ?? 0) ||
        b.finishes - a.finishes ||
        a.relation.from.localeCompare(b.relation.from) ||
        a.relation.to.localeCompare(b.relation.to) ||
        a.relation.type.localeCompare(b.relation.type),
    );
}

/** Held relations ("vorgemerkt"), the oldest hold first. */
export function heldList(
  relations: readonly Relation[],
  models: readonly ModelInfo[],
  filters: QueueFilters = {},
): Relation[] {
  const stageOf = new Map(models.map((m) => [m.key, m.stage]));
  return relations
    .filter((r) => r.status === 'held' && matchesQueue(r, filters, stageOf))
    .sort(
      (a, b) =>
        (a.provenance?.at ?? a.updatedAt).localeCompare(b.provenance?.at ?? b.updatedAt) ||
        a.id.localeCompare(b.id),
    );
}

/**
 * Agents' no-links for the inbox tab „Kein Zusammenhang“, with the model and
 * stage filters of the proposals (a no-link has no tier), in the server's
 * order (oldest first).
 */
export function noLinkList<T extends Pick<Relation, 'from' | 'to'>>(
  noLinks: readonly T[],
  models: readonly ModelInfo[],
  filters: QueueFilters = {},
): T[] {
  const stageOf = new Map(models.map((m) => [m.key, m.stage]));
  return noLinks.filter((n) => {
    const keys = modelKeysOf(n);
    if (filters.model !== undefined && !keys.includes(filters.model)) return false;
    return filters.stage === undefined || keys.some((k) => stageOf.get(k) === filters.stage);
  });
}

/** Number of models per pipeline stage (every stage present, zero included). */
export function stageCounts(models: readonly Pick<Model, 'stage'>[]): Record<ModelStage, number> {
  const counts = Object.fromEntries(STAGE_ORDER.map((s) => [s, 0])) as Record<ModelStage, number>;
  for (const m of models) counts[m.stage] += 1;
  return counts;
}

/** Inbox order of the stages: the pipeline from left to right. */
export const PIPELINE_ORDER: readonly ModelStage[] = [
  'waiting_for_agent',
  'agent_working',
  'agent_failed',
  'waiting_for_review',
  'waiting_for_clarification',
  'incorporated',
];

/**
 * Proposals per tier, for the bulk actions (only tiers that occur, in tier
 * order). Accepted relations whose endpoint changed are re-confirmed one by
 * one.
 */
export function proposalsByTier(queue: readonly QueueItem[]): { tier: Tier; items: Relation[] }[] {
  return TIER_ORDER.map((tier) => ({
    tier,
    items: queue
      .filter((q) => q.relation.tier === tier && q.relation.status === 'proposed')
      .map((q) => q.relation),
  })).filter((g) => g.items.length > 0);
}

/** Position of `id` in the queue and its neighbours; outside the queue, "next" is the first item. */
export function neighbours(
  queue: readonly QueueItem[],
  id: string,
): { index: number; previous: Relation | null; next: Relation | null } {
  const index = queue.findIndex((q) => q.relation.id === id);
  if (index < 0) return { index, previous: null, next: queue[0]?.relation ?? null };
  return {
    index,
    previous: queue[index - 1]?.relation ?? null,
    next: queue[index + 1]?.relation ?? null,
  };
}

/** An entry of an evidence list: a ref into a known model (clickable) or plain text. */
export type EvidenceItem =
  | { kind: 'ref'; text: string; modelKey: string; elementId: string }
  | { kind: 'text'; text: string };

const REF_PATTERN = /^[^\s#]+#[^\s#]+$/;

/** Splits evidence into refs of known models and plain text (agents may cite anything). */
export function evidenceItems(
  evidence: readonly string[],
  modelKeys: ReadonlySet<string>,
): EvidenceItem[] {
  return evidence.map((text) => {
    const trimmed = text.trim();
    if (REF_PATTERN.test(trimmed)) {
      const { modelKey, elementId } = splitRef(trimmed);
      if (modelKeys.has(modelKey)) return { kind: 'ref', text: trimmed, modelKey, elementId };
    }
    return { kind: 'text', text };
  });
}

/**
 * The proposal a relation's status rests on (its provenance), else the
 * latest proposal: its evidence and question are shown on the review screen.
 */
export function currentProposal(
  relation: Pick<Relation, 'provenance'>,
  assertions: readonly RelationAssertion[],
): RelationAssertion | null {
  const basis = assertions.find((a) => a.id === relation.provenance?.assertionId);
  if (basis?.kind === 'proposal') return basis;
  return assertions.findLast((a) => a.kind === 'proposal') ?? null;
}

/** Notes (answers) given after the relation's current hold, oldest first. */
export function answersSinceHold(
  relation: Pick<Relation, 'provenance'>,
  assertions: readonly RelationAssertion[],
): RelationAssertion[] {
  const holdAt = assertions.findIndex((a) => a.id === relation.provenance?.assertionId);
  return assertions.slice(holdAt < 0 ? 0 : holdAt + 1).filter((a) => a.kind === 'note');
}

/** A version conflict (optimistic concurrency) in words the reviewer can act on. */
export interface Conflict {
  title: string;
  description: string;
}

/** What a conflict is about: relations (M2) or placements (M4). */
export type ConflictNoun = 'relation' | 'placement';

const NOUNS: Record<ConflictNoun, { one: string; many: string; the: string }> = {
  relation: { one: 'Eine Relation hat', many: 'Relationen haben', the: 'Die Relation' },
  placement: { one: 'Eine Platzierung hat', many: 'Platzierungen haben', the: 'Die Platzierung' },
};

/**
 * Turns a 409 `conflict` or 412 `precondition-failed` into a message: the
 * relation (or placement) changed after it was loaded (another decision, a
 * new proposal, a re-upload or a chain save), it became obsolete, or a bulk
 * list no longer matches.
 */
export function conflictOf(
  error: unknown,
  seenVersion?: number,
  noun: ConflictNoun = 'relation',
): Conflict | null {
  if (!(error instanceof ApiError)) return null;
  const { code } = error.problem;
  if (code !== 'conflict' && code !== 'precondition-failed') return null;
  const words = NOUNS[noun];
  const extras = error.problem as Record<string, unknown>;
  const mismatches = Array.isArray(extras['mismatches']) ? extras['mismatches'] : null;
  if (mismatches) {
    const n = mismatches.length;
    return {
      title: 'Die Liste hat sich geändert',
      description: `${n === 1 ? words.one : `${n} ${words.many}`} sich seit dem Laden geändert. Es wurde nichts entschieden. Die Liste ist neu geladen; prüfe sie und bestätige noch einmal.`,
    };
  }
  if (typeof extras['expectedCount'] === 'number') {
    return {
      title: 'Die Liste hat sich geändert',
      description: `Die Anzahl der ${noun === 'relation' ? 'Relationen' : 'Platzierungen'} stimmt nicht mehr. Es wurde nichts entschieden. Die Liste ist neu geladen; prüfe sie und bestätige noch einmal.`,
    };
  }
  const now = typeof extras['version'] === 'number' ? extras['version'] : null;
  if (now !== null) {
    const seen = seenVersion === undefined ? '' : ` (du hast Version ${seenVersion} gesehen)`;
    return {
      title: `${words.the} wurde inzwischen geändert`,
      description: `Sie steht jetzt auf Version ${now}${seen}: Ein Agent oder eine andere Prüfung hat etwas ergänzt. Deine Entscheidung wurde nicht gespeichert. Der neue Stand ist geladen; prüfe ihn und entscheide noch einmal.`,
    };
  }
  return {
    title: `${words.the} kann so nicht entschieden werden`,
    description: `${error.problem.detail ?? error.problem.title}. Der neue Stand ist geladen; prüfe ihn noch einmal.`,
  };
}

/** Short German summary of a relation for toasts and dialogs: "a → b". */
export function pairText(
  relation: Pick<Relation, 'from' | 'to'>,
  labelOf: (ref: string) => string,
): string {
  return `${labelOf(relation.from)} → ${labelOf(relation.to)}`;
}
