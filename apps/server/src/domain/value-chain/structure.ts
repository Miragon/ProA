/**
 * The structure of a value chain revision (M4 §2 "Steps"), derived from the
 * canonical document on read and never stored per revision: each step's
 * normalized name, parent, depth, kind, rank, path, children, owners and
 * fingerprint, the org units, and the revision's `structure_hash`. Pure: the
 * cache {@link structureOf} takes the bytes from a callback, so the module
 * does no I/O.
 */
import { createHash } from 'node:crypto';

import { parseDocumentJSON, type ValueChainDocument } from '@miragon/value-chain-schema-model';
import { normalizeKey } from '@proa/bpmn-facts';
import {
  PROA_PROCESS_LINK_PREFIX,
  STEP_KIND_COLORS,
  isRef,
  type LinkKind,
  type Ref,
  type StepKind,
} from '@proa/contracts';

/** Version prefix of `structure_hash`; a change to what it covers needs a new one. */
export const STRUCTURE_HASH_VERSION = 'proa-vc-structure/1';

export interface ChainStep {
  elementId: string;
  name: string;
  /** `normalizeKey(name)`, as for facts. */
  nameNorm: string;
  link: string | null;
  color: string | null;
  parentId: string | null;
  /** 0 = top level. */
  depth: number;
  kind: StepKind;
  /** 0-based position among its siblings along the `sequence` edges. */
  rank: number;
  /** `sha256(step|name_norm|parent_id)`, first 12 hex characters. */
  fingerprint: string;
  /** Names from the top-level step down to this one. */
  path: string[];
  /** Ids from the top-level step down to this one. */
  pathIds: string[];
  /** Sub-steps by rank. */
  childIds: string[];
  /** Org units assigned to the step, in code point order. */
  ownerIds: string[];
  x: number;
  y: number;
}

export interface ChainOrgUnit {
  elementId: string;
  name: string;
  /** The steps it is assigned to, in code point order. */
  stepIds: string[];
}

export interface ChainStructure {
  contentHash: string;
  schemaVersion: number;
  /** `meta.name`. */
  name: string;
  /** Every step, in code point order of the element id. */
  steps: ChainStep[];
  byId: ReadonlyMap<string, ChainStep>;
  orgUnits: ChainOrgUnit[];
  /** The `sequence` connections between two steps as `[source, target]`, sorted. */
  sequences: [string, string][];
  structureHash: string;
  /** The fingerprint of every step, by element id. */
  stepFingerprints: ReadonlyMap<string, string>;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** `sha256(step|name_norm|parent_id)[:12]`: a change of case or umlaut spelling keeps it, a rename or a new parent changes it. */
export function stepFingerprint(nameNorm: string, parentId: string | null): string {
  return sha256(`step|${nameNorm}|${parentId ?? ''}`).slice(0, 12);
}

/** A colour as the kind convention compares it: lowercased, without whitespace. */
export function colorKey(color: string): string {
  return color.toLowerCase().replace(/\s+/g, '');
}

const KIND_OF_COLOR = new Map<string, StepKind>([
  [colorKey(STEP_KIND_COLORS.management), 'management'],
  [colorKey(STEP_KIND_COLORS.support), 'support'],
]);

/** The kind of a top-level step off the core chain, from its colour. */
export function kindOfColor(color: string | null): StepKind {
  return (color === null ? undefined : KIND_OF_COLOR.get(colorKey(color))) ?? 'other';
}

/**
 * The parent of each step (the source of its `hierarchy` edge). The ProA
 * rules allow one parent and no cycle; should a document break them anyway,
 * the first parent in code point order wins and a cycle is cut, so the
 * derivation always terminates.
 */
function parentsOf(
  stepIds: ReadonlySet<string>,
  connections: ValueChainDocument['connections'],
): Map<string, string> {
  const parents = new Map<string, string>();
  const hierarchy = connections
    .filter(
      (c) => c.connectionType === 'hierarchy' && stepIds.has(c.source) && stepIds.has(c.target),
    )
    .sort((a, b) => byCodePoint(a.source, b.source) || byCodePoint(a.id, b.id));
  for (const c of hierarchy) if (!parents.has(c.target)) parents.set(c.target, c.source);
  for (const id of [...parents.keys()].sort(byCodePoint)) {
    const seen = new Set<string>([id]);
    let p = parents.get(id);
    while (p !== undefined) {
      if (seen.has(p)) {
        parents.delete(id);
        break;
      }
      seen.add(p);
      p = parents.get(p);
    }
  }
  return parents;
}

/**
 * Kahn's algorithm over the `sequence` edges within each sibling group; the
 * ready set is ordered by x, then y, then id, and edges across groups are
 * ignored. A cycle (refused by the ProA rules) ranks its rest by position.
 */
function ranksOf(
  groups: ReadonlyMap<string, readonly ChainStepDraft[]>,
  connections: ValueChainDocument['connections'],
): Map<string, number> {
  const ranks = new Map<string, number>();
  const byPosition = (a: ChainStepDraft, b: ChainStepDraft) =>
    a.x - b.x || a.y - b.y || byCodePoint(a.elementId, b.elementId);
  for (const members of groups.values()) {
    const ids = new Set(members.map((m) => m.elementId));
    const indegree = new Map(members.map((m) => [m.elementId, 0]));
    const next = new Map<string, string[]>();
    for (const c of connections) {
      if (c.connectionType !== 'sequence' || !ids.has(c.source) || !ids.has(c.target)) continue;
      indegree.set(c.target, (indegree.get(c.target) ?? 0) + 1);
      next.set(c.source, [...(next.get(c.source) ?? []), c.target]);
    }
    const byId = new Map(members.map((m) => [m.elementId, m]));
    const ready = members.filter((m) => indegree.get(m.elementId) === 0);
    const placed = new Set<string>();
    let rank = 0;
    while (placed.size < members.length) {
      if (ready.length === 0) {
        const rest = members.filter((m) => !placed.has(m.elementId)).sort(byPosition);
        if (rest[0]) ready.push(rest[0]);
      }
      ready.sort(byPosition);
      const current = ready.shift();
      if (!current || placed.has(current.elementId)) continue;
      placed.add(current.elementId);
      ranks.set(current.elementId, rank++);
      for (const t of next.get(current.elementId) ?? []) {
        const d = (indegree.get(t) ?? 0) - 1;
        indegree.set(t, d);
        const target = byId.get(t);
        if (d === 0 && target && !placed.has(t)) ready.push(target);
      }
    }
  }
  return ranks;
}

interface ChainStepDraft {
  elementId: string;
  x: number;
  y: number;
}

/**
 * Derives the structure of a valid document (`loadDocument` passed and the
 * ProA rules hold).
 *
 * - Kind: a top-level step joined by a `sequence` edge to another top-level
 *   step is `core`; any other top-level step takes its kind from its colour
 *   ({@link kindOfColor}); sub-steps inherit the kind of their top-level step.
 * - Rank: 0-based, Kahn's algorithm over the `sequence` edges within a
 *   sibling group ({@link ranksOf}); the top-level steps form one group per
 *   kind, so the core chain ranks 0…n−1 and each band ranks on its own.
 * - `structure_hash`: sha256 over {@link STRUCTURE_HASH_VERSION} and the
 *   elements `[id, type, nameNorm, link, kind]` and connections `[type,
 *   source, target]`, both sorted; bounds, waypoints, the raw colour,
 *   connection ids and `meta.name` do not count, the derived kind does.
 */
export function deriveStructure(document: ValueChainDocument, contentHash: string): ChainStructure {
  const stepElements = document.elements
    .filter((e) => e.elementType === 'step')
    .sort((a, b) => byCodePoint(a.id, b.id));
  const orgElements = document.elements
    .filter((e) => e.elementType === 'orgUnit')
    .sort((a, b) => byCodePoint(a.id, b.id));
  const stepIds = new Set(stepElements.map((e) => e.id));
  const orgIds = new Set(orgElements.map((e) => e.id));
  const parents = parentsOf(stepIds, document.connections);
  const parentOf = (id: string) => parents.get(id) ?? null;

  const pathIdsOf = (id: string): string[] => {
    const up: string[] = [];
    let current: string | null = id;
    while (current !== null) {
      up.unshift(current);
      current = parentOf(current);
    }
    return up;
  };

  const coreTop = new Set<string>();
  for (const c of document.connections) {
    if (c.connectionType !== 'sequence') continue;
    if (!stepIds.has(c.source) || !stepIds.has(c.target)) continue;
    if (parentOf(c.source) === null && parentOf(c.target) === null) {
      coreTop.add(c.source);
      coreTop.add(c.target);
    }
  }

  const owners = new Map<string, string[]>();
  const ownedSteps = new Map<string, string[]>();
  for (const c of document.connections) {
    if (c.connectionType !== 'assignment') continue;
    const [org, step] = orgIds.has(c.source) ? [c.source, c.target] : [c.target, c.source];
    if (!orgIds.has(org) || !stepIds.has(step)) continue;
    owners.set(step, [...new Set([...(owners.get(step) ?? []), org])].sort(byCodePoint));
    ownedSteps.set(org, [...new Set([...(ownedSteps.get(org) ?? []), step])].sort(byCodePoint));
  }

  const nameOf = new Map(stepElements.map((e) => [e.id, e.name]));
  const topKind = new Map<string, StepKind>();
  for (const e of stepElements) {
    if (parentOf(e.id) !== null) continue;
    topKind.set(e.id, coreTop.has(e.id) ? 'core' : kindOfColor(e.color ?? null));
  }

  // Sibling groups: the sub-steps of one parent; at the top level, the steps of one kind (the
  // core chain, the management band, the support band), so the core chain ranks 0…n−1.
  const groups = new Map<string, ChainStepDraft[]>();
  for (const e of stepElements) {
    const key = parentOf(e.id) ?? `\u0000${topKind.get(e.id) ?? 'other'}`;
    groups.set(key, [
      ...(groups.get(key) ?? []),
      { elementId: e.id, x: e.bounds.x, y: e.bounds.y },
    ]);
  }
  const ranks = ranksOf(groups, document.connections);
  const childrenOf = new Map<string, string[]>();
  for (const e of stepElements) {
    const p = parentOf(e.id);
    if (p !== null) childrenOf.set(p, [...(childrenOf.get(p) ?? []), e.id]);
  }

  const steps: ChainStep[] = stepElements.map((e) => {
    const pathIds = pathIdsOf(e.id);
    const parentId = parentOf(e.id);
    const nameNorm = normalizeKey(e.name);
    const children = [...(childrenOf.get(e.id) ?? [])].sort(
      (a, b) => (ranks.get(a) ?? 0) - (ranks.get(b) ?? 0) || byCodePoint(a, b),
    );
    return {
      elementId: e.id,
      name: e.name,
      nameNorm,
      link: e.elementType === 'step' ? (e.link ?? null) : null,
      color: e.color ?? null,
      parentId,
      depth: pathIds.length - 1,
      kind: topKind.get(pathIds[0] ?? e.id) ?? 'other',
      rank: ranks.get(e.id) ?? 0,
      fingerprint: stepFingerprint(nameNorm, parentId),
      path: pathIds.map((id) => nameOf.get(id) ?? ''),
      pathIds,
      childIds: children,
      ownerIds: owners.get(e.id) ?? [],
      x: e.bounds.x,
      y: e.bounds.y,
    };
  });
  const byId = new Map(steps.map((s) => [s.elementId, s]));

  const elements = [
    ...steps.map((s) => [s.elementId, 'step', s.nameNorm, s.link, s.kind] as const),
    ...orgElements.map((o) => [o.id, 'orgUnit', normalizeKey(o.name), null, null] as const),
  ].sort((a, b) => byCodePoint(a[0], b[0]));
  const sequences = document.connections
    .filter(
      (c) => c.connectionType === 'sequence' && stepIds.has(c.source) && stepIds.has(c.target),
    )
    .map((c): [string, string] => [c.source, c.target])
    .sort((a, b) => byCodePoint(a[0], b[0]) || byCodePoint(a[1], b[1]));
  const connections = document.connections
    .map((c) => [c.connectionType, c.source, c.target] as const)
    .sort((a, b) => byCodePoint(a[0], b[0]) || byCodePoint(a[1], b[1]) || byCodePoint(a[2], b[2]));
  const structureHash = sha256(
    `${STRUCTURE_HASH_VERSION}\n${JSON.stringify({ elements, connections })}`,
  );

  return {
    contentHash,
    schemaVersion: document.schemaVersion,
    name: document.meta.name,
    steps,
    byId,
    orgUnits: orgElements.map((o) => ({
      elementId: o.id,
      name: o.name,
      stepIds: ownedSteps.get(o.id) ?? [],
    })),
    sequences,
    structureHash,
    stepFingerprints: new Map(steps.map((s) => [s.elementId, s.fingerprint])),
  };
}

/** The descendants of a step (all levels), in code point order. */
export function descendantsOf(structure: ChainStructure, elementId: string): string[] {
  const out: string[] = [];
  const queue = [...(structure.byId.get(elementId)?.childIds ?? [])];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || out.includes(id)) continue;
    out.push(id);
    queue.push(...(structure.byId.get(id)?.childIds ?? []));
  }
  return out.sort(byCodePoint);
}

/** The other steps with the same parent (top-level steps for a top-level step). */
export function siblingsOf(structure: ChainStructure, elementId: string): ChainStep[] {
  const step = structure.byId.get(elementId);
  if (!step) return [];
  return structure.steps.filter((s) => s.parentId === step.parentId && s.elementId !== elementId);
}

export interface LinkTarget {
  kind: LinkKind;
  /** `process` links: the ref, if well-formed. */
  process: Ref | null;
  /** A `process` link whose process is a head process. */
  resolved: boolean;
}

/**
 * What a step's `link` points to (M4 §2 "The link field"): `proa:process/<ref>`
 * is `process` (resolved if the process is in the head), `http(s)://` is
 * `url`, anything else `opaque`, no link `none`.
 */
export function linkTarget(link: string | null, headProcesses: ReadonlySet<string>): LinkTarget {
  if (link === null) return { kind: 'none', process: null, resolved: false };
  if (link.startsWith(PROA_PROCESS_LINK_PREFIX)) {
    const ref = link.slice(PROA_PROCESS_LINK_PREFIX.length);
    if (!isRef(ref)) return { kind: 'process', process: null, resolved: false };
    return { kind: 'process', process: ref, resolved: headProcesses.has(ref) };
  }
  if (/^https?:\/\//i.test(link)) return { kind: 'url', process: null, resolved: false };
  return { kind: 'opaque', process: null, resolved: false };
}

/** Entries the structure cache keeps. */
export const STRUCTURE_CACHE_SIZE = 16;

const cache = new Map<string, ChainStructure>();

/** Puts a structure into the cache (most recently used). */
export function rememberStructure(structure: ChainStructure): void {
  cache.delete(structure.contentHash);
  cache.set(structure.contentHash, structure);
  while (cache.size > STRUCTURE_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * The structure of a stored revision, from a bounded LRU cache keyed by
 * `content_hash` (content is immutable per hash, so entries are safe across
 * projects). On a miss it parses the canonical bytes with `parseDocumentJSON`.
 *
 * @param loadBytes the revision's canonical bytes (called on a miss only)
 */
export async function structureOf(
  contentHash: string,
  loadBytes: () => Promise<Uint8Array | null>,
): Promise<ChainStructure> {
  const hit = cache.get(contentHash);
  if (hit) {
    rememberStructure(hit);
    return hit;
  }
  const bytes = await loadBytes();
  if (!bytes) throw new Error(`value chain content ${contentHash} not found`);
  const structure = deriveStructure(
    parseDocumentJSON(new TextDecoder().decode(bytes)),
    contentHash,
  );
  rememberStructure(structure);
  return structure;
}

/** For tests: the cached content hashes, least recently used first. */
export function cachedStructureKeys(): string[] {
  return [...cache.keys()];
}

/** For tests: empties the cache. */
export function clearStructureCache(): void {
  cache.clear();
}
