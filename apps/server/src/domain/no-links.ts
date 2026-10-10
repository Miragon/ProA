/**
 * No-links (judge each pair once, CONCEPT §3): the per-item checks of a
 * submission's `noLinks`, their withdrawal, and the version moves of the
 * relations on their pairs. A stored no-link is an agent judgement that a
 * typed pair is unrelated, with the basis the claim showed.
 */
import {
  hasControlCharacters,
  isRef,
  parseRef,
  type DeclaredProcedure,
  type NoLinkId,
  type NoLinkInvalidReason,
  type PrincipalId,
  type ProjectId,
  type Ref,
} from '@proa/contracts';

import { pairKey, type LinkType } from './judgements.ts';
import type { PairAssessment, PairQuery, RelationRecord, Tx } from './ports.ts';
import { naturalKey } from './relation-state.ts';

const LINK_TYPES: readonly LinkType[] = ['call', 'message', 'signal', 'trigger'];

/** A no-link that passed the item checks, with its resolved type. */
export interface ValidNoLink {
  type: LinkType;
  from: Ref;
  to: Ref;
  reason: string;
}

export type NoLinkValidation =
  { ok: true; value: ValidNoLink } | { ok: false; reason: NoLinkInvalidReason };

/**
 * The per-item checks of a no-link, in this order: a given type is a link
 * type, well-formed refs, no control characters other than tab and line
 * breaks in the reason, one end in the task's model, both ends in the head
 * facts (`unknown-ref`), then the type: a given one must fit the endpoints
 * (`type-mismatch`, `same-process`, `message-flow`); without one, the one
 * type that fits is taken (`type-required` when several fit; when none
 * does, a type whose endpoint roles fit gives its reason, else
 * `type-mismatch`). `also-proposed` and `duplicate` need the submission and
 * are checked by the caller.
 */
export function validateNoLink(
  item: { type?: string | undefined; from: string; to: string; reason: string },
  assess: (pair: PairQuery) => PairAssessment,
  taskModelKey: string,
): NoLinkValidation {
  if (item.type !== undefined && !LINK_TYPES.includes(item.type as LinkType)) {
    return { ok: false, reason: 'type-not-allowed' };
  }
  const { from, to, reason } = item;
  if (!isRef(from) || !isRef(to)) return { ok: false, reason: 'malformed-ref' };
  if (hasControlCharacters(reason)) return { ok: false, reason: 'control-characters' };
  if (parseRef(from).modelKey !== taskModelKey && parseRef(to).modelKey !== taskModelKey) {
    return { ok: false, reason: 'outside-task-model' };
  }
  const valid = (type: LinkType): NoLinkValidation => ({
    ok: true,
    value: { type, from, to, reason },
  });
  if (item.type !== undefined) {
    const type = item.type as LinkType;
    const a = assess({ type, from, to });
    return a.ok ? valid(type) : { ok: false, reason: a.reason };
  }
  const outcomes = LINK_TYPES.map((type) => ({ type, a: assess({ type, from, to }) }));
  if (outcomes.some((o) => !o.a.ok && o.a.reason === 'unknown-ref')) {
    return { ok: false, reason: 'unknown-ref' };
  }
  const fitting = outcomes.filter((o) => o.a.ok);
  if (fitting.length > 1) return { ok: false, reason: 'type-required' };
  const [one] = fitting;
  if (one) return valid(one.type);
  const roles = outcomes.find((o) => !o.a.ok && o.a.reason !== 'type-mismatch');
  return { ok: false, reason: roles && !roles.a.ok ? roles.a.reason : 'type-mismatch' };
}

/**
 * Ends live no-links (one withdrawal row each, stamped with `seq`) and moves
 * the version of the relations on their typed pairs, so a bulk decision
 * prepared before fails (409).
 *
 * @param relations every relation of the project by natural key
 */
export async function withdrawNoLinks(
  tx: Tx,
  projectId: ProjectId,
  noLinks: readonly { id: NoLinkId; type: LinkType; fromRef: string; toRef: string }[],
  by: { seq: number; principalId: PrincipalId; reason: string },
  relations: Map<string, RelationRecord>,
): Promise<void> {
  if (noLinks.length === 0) return;
  await tx.noLinks.withdraw(
    projectId,
    noLinks.map((n) => n.id),
    by,
  );
  await touchRelations(
    tx,
    projectId,
    noLinks.map((n) => pairKey({ type: n.type, from: n.fromRef, to: n.toRef })),
    relations,
  );
}

/**
 * Moves the version of the relations with these natural keys once each
 * (their no-links were stored or withdrawn, or their currency may have
 * flipped): `Relation.noLinks` is part of what a reviewer decides on.
 */
export async function touchRelations(
  tx: Tx,
  projectId: ProjectId,
  keys: readonly string[],
  relations: Map<string, RelationRecord>,
): Promise<void> {
  for (const key of new Set(keys)) {
    const relation = relations.get(key);
    if (relation) relations.set(key, await tx.relations.update(projectId, relation.id, {}));
  }
}

/**
 * Moves the version of the relations on the pairs of the live no-links
 * touching `modelKeys`, once each: a new head `facts_hash` of such a model
 * (or its deletion) can flip their currency either way, a revert included,
 * and `Relation.noLinks` lists only current ones, so a bulk decision prepared
 * before fails (409). A procedure release only ends currency (it shows no new
 * objection) and moves nothing.
 *
 * @param procedure the procedure claims name (the listing computes currency; unused here)
 */
export async function touchNoLinkRelations(
  tx: Tx,
  projectId: ProjectId,
  modelKeys: Iterable<string>,
  procedure: DeclaredProcedure,
): Promise<void> {
  const keys: string[] = [];
  for (const modelKey of new Set(modelKeys)) {
    for (const n of await tx.noLinks.listLive(
      projectId,
      { touchingModelKey: modelKey },
      procedure,
    )) {
      keys.push(pairKey({ type: n.type, from: n.fromRef, to: n.toRef }));
    }
  }
  if (keys.length === 0) return;
  const relations = new Map(
    (await tx.relations.all(projectId)).map((r) => [naturalKey(r.type, r.fromRef, r.toRef), r]),
  );
  await touchRelations(tx, projectId, keys, relations);
}
