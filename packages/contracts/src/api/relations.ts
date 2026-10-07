import { z } from 'zod';

import { Finding } from '../findings.ts';
import { RelationId } from '../ids.ts';
import { ModelKey, Ref } from '../refs.ts';
import { EndpointState, RelationStatus, RelationType, Tier } from '../relations.ts';
import { Cursor, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT, Timestamp, pageOf } from './common.ts';

/** A relation between two processes with its review state (CONCEPT §2). */
export const Relation = z
  .object({
    id: RelationId,
    type: RelationType,
    from: Ref,
    to: Ref,
    status: RelationStatus,
    endpointState: EndpointState,
    /** Tier of the strongest live assertion. */
    tier: Tier,
    /** Confidence of the strongest live assertion, 0–1. */
    confidence: z.number().min(0).max(1).nullable(),
    /** Optimistic-concurrency version; bulk decisions send it back. */
    version: z.number().int().min(1),
    /** E.g. call binding attributes. */
    attrs: z.record(z.string(), z.unknown()),
    updatedAt: Timestamp,
  })
  .meta({ id: 'Relation', description: 'A relation between two processes.' });
export type Relation = z.infer<typeof Relation>;

export const RelationPage = pageOf(Relation, 'RelationPage');
export type RelationPage = z.infer<typeof RelationPage>;

/** Query parameters of `GET …/relations`. Obsolete relations are only returned when asked for. */
export const RelationQuery = z.object({
  type: RelationType.optional(),
  status: RelationStatus.optional(),
  tier: Tier.optional(),
  /** Only relations with an endpoint in this model. */
  modelKey: ModelKey.optional(),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});
export type RelationQuery = z.infer<typeof RelationQuery>;

export const FindingList = z
  .object({ items: z.array(Finding) })
  .meta({ id: 'FindingList', description: 'Deterministic findings of the project head.' });
export type FindingList = z.infer<typeof FindingList>;
