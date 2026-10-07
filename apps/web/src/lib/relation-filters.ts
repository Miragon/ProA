import type { Relation, RelationStatus, RelationType, Tier } from '@proa/client';

import { STATUS_ORDER, TIER_ORDER, TYPE_ORDER } from './labels';
import { splitRef } from './refs';

/** Filters of the relation table; kept in the URL search params. */
export interface RelationFilters {
  status?: RelationStatus;
  tier?: Tier;
  type?: RelationType;
  /** Model key: relations with an endpoint in this model. */
  model?: string;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Validates untrusted search params (TanStack Router `validateSearch`). */
export function parseRelationFilters(search: Record<string, unknown>): RelationFilters {
  const filters: RelationFilters = {};
  const status = oneOf(STATUS_ORDER, search['status']);
  const tier = oneOf(TIER_ORDER, search['tier']);
  const type = oneOf(TYPE_ORDER, search['type']);
  const model =
    typeof search['model'] === 'string' && search['model'] !== '' ? search['model'] : undefined;
  if (status) filters.status = status;
  if (tier) filters.tier = tier;
  if (type) filters.type = type;
  if (model) filters.model = model;
  return filters;
}

export function touchesModel(relation: Pick<Relation, 'from' | 'to'>, modelKey: string): boolean {
  return (
    splitRef(relation.from).modelKey === modelKey || splitRef(relation.to).modelKey === modelKey
  );
}

export function matchesFilters(relation: Relation, filters: RelationFilters): boolean {
  return (
    (filters.status === undefined || relation.status === filters.status) &&
    (filters.tier === undefined || relation.tier === filters.tier) &&
    (filters.type === undefined || relation.type === filters.type) &&
    (filters.model === undefined || touchesModel(relation, filters.model))
  );
}

const rank = <T>(order: readonly T[], value: T) => order.indexOf(value);

/**
 * Display order: accepted before proposed (status order), then by tier
 * (rule before key before …), type, and the refs.
 */
export function compareRelations(a: Relation, b: Relation): number {
  return (
    rank(STATUS_ORDER, a.status) - rank(STATUS_ORDER, b.status) ||
    rank(TIER_ORDER, a.tier) - rank(TIER_ORDER, b.tier) ||
    rank(TYPE_ORDER, a.type) - rank(TYPE_ORDER, b.type) ||
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to)
  );
}

export function filterRelations(
  relations: readonly Relation[],
  filters: RelationFilters,
): Relation[] {
  return relations.filter((r) => matchesFilters(r, filters)).sort(compareRelations);
}

/** Presets shown as quick filters above the table. */
export interface RelationPreset {
  id: string;
  label: string;
  filters: RelationFilters;
}

export const RELATION_PRESETS: readonly RelationPreset[] = [
  { id: 'all', label: 'Alle', filters: {} },
  { id: 'rule', label: 'Durch Regel angenommen', filters: { status: 'accepted', tier: 'rule' } },
  { id: 'key', label: 'Schlüssel-Vorschläge', filters: { status: 'proposed', tier: 'key' } },
  { id: 'proposed', label: 'Alle Vorschläge', filters: { status: 'proposed' } },
];

export function sameFilters(a: RelationFilters, b: RelationFilters): boolean {
  return a.status === b.status && a.tier === b.tier && a.type === b.type && a.model === b.model;
}
