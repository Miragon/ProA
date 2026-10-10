/**
 * `prepareRevision` (M4 §2 "Revision", "ProA rules"): turns the document a
 * human saves into the canonical revision S1's write path stores, or refuses
 * it with per-element reasons.
 *
 * 1. Not a JSON object: `value-chain-invalid` (`not-an-object`; the HTTP
 *    layer reports a JSON syntax error as `not-json`).
 * 2. An integer `schemaVersion` newer than schema-model's:
 *    `value-chain-unsupported-version`, checked before `migrate()`, which
 *    throws a plain Error for it.
 * 3. schema-model's zod schema (`safeParse`, issues read by duck typing,
 *    never `instanceof ZodError`): `schema` with the path and the element or
 *    connection it names.
 * 4. schema-model's cross-field rules, checked here to name the element:
 *    `duplicate-id`, `unknown-endpoint`, `self-connection`,
 *    `connection-not-allowed` (through the exported `connectionAllowed`).
 * 5. `loadDocument` as the authority: should it still throw, `schema` with
 *    the error class.
 * 6. `serializeDocument` gives the canonical bytes and their sha256.
 * 7. The ProA rules (at most 100 listed): size and counts first, and above
 *    those limits nothing else, so the graph rules only ever see a bounded
 *    document; then, collected together, names, ids, links, geometry, one
 *    parent, no hierarchy cycle, depth, no duplicate connection, no sequence
 *    cycle. Every graph rule is linear or n log n.
 * 8. The canonical form loaded again with `parseDocumentJSON`, exactly as a
 *    read loads the stored bytes on a cache miss: should it not load (it
 *    always should, the geometry rule keeps the rounding finite), `schema`.
 * 9. The structure (kinds, ranks, fingerprints, `structure_hash`), derived
 *    from that reloaded document, so the cached structure and one derived
 *    from the stored bytes are the same.
 */
import { createHash } from 'node:crypto';

import {
  CURRENT_SCHEMA_VERSION,
  connectionAllowed,
  loadDocument,
  migrate,
  parseDocumentJSON,
  serializeDocument,
  valueChainDocumentSchema,
  type ValueChainDocument,
} from '@miragon/value-chain-schema-model';
import {
  MAX_VALUE_CHAIN_BYTES,
  MAX_VALUE_CHAIN_CONNECTIONS,
  MAX_VALUE_CHAIN_COORDINATE,
  MAX_VALUE_CHAIN_DEPTH,
  MAX_VALUE_CHAIN_ELEMENTS,
  MAX_VALUE_CHAIN_ELEMENT_SIZE,
  MAX_VALUE_CHAIN_ID_CHARS,
  MAX_VALUE_CHAIN_LINK_CHARS,
  MAX_VALUE_CHAIN_NAME_CHARS,
  MAX_VALUE_CHAIN_VIOLATIONS,
  RESERVED_ELEMENT_IDS,
  VALUE_CHAIN_VIOLATIONS,
  hasBidiCharacters,
  hasControlCharacters,
  type ValueChainViolation,
  type ValueChainViolationReason,
} from '@proa/contracts';

import { DomainError } from '../errors.ts';
import type { PreparedRevision } from './revisions.ts';
import { deriveStructure, type ChainStructure } from './structure.ts';

/** A prepared revision and the structure derived from it. */
export interface PreparedChain {
  prepared: PreparedRevision;
  structure: ChainStructure;
}

type Violation = ValueChainViolation;

function violation(
  reason: ValueChainViolationReason,
  detail: string,
  where: { elementId?: string | null; connectionId?: string | null; path?: string | null } = {},
): Violation {
  return {
    reason,
    elementId: where.elementId ?? null,
    connectionId: where.connectionId ?? null,
    path: where.path ?? null,
    detail,
  };
}

const ORDER = new Map<ValueChainViolationReason, number>(
  VALUE_CHAIN_VIOLATIONS.map((r, i) => [r, i]),
);

/**
 * `value-chain-invalid` (422) with the violations in check order, at most
 * {@link MAX_VALUE_CHAIN_VIOLATIONS}, and `truncated` when more were found.
 */
export function valueChainInvalid(violations: readonly Violation[]): DomainError {
  const sorted = violations
    .map((v, i) => ({ v, i }))
    .sort((a, b) => (ORDER.get(a.v.reason) ?? 0) - (ORDER.get(b.v.reason) ?? 0) || a.i - b.i)
    .map(({ v }) => v);
  const listed = sorted.slice(0, MAX_VALUE_CHAIN_VIOLATIONS);
  const first = listed[0];
  return new DomainError(
    'value-chain-invalid',
    first
      ? `the value chain breaks ${sorted.length} rule${sorted.length === 1 ? '' : 's'}, first: ${first.reason}`
      : 'the value chain is invalid',
    { violations: listed, truncated: sorted.length > listed.length },
  );
}

/** The problem for a request body that is not JSON at all. */
export function notJson(detail: string): DomainError {
  return valueChainInvalid([violation('not-json', detail)]);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The id at `input[collection][index]`, if it is a string. */
function idAt(input: Record<string, unknown>, collection: unknown, index: unknown): string | null {
  if (typeof collection !== 'string' || typeof index !== 'number') return null;
  const list = input[collection];
  if (!Array.isArray(list)) return null;
  const item: unknown = list[index];
  return isObject(item) && typeof item['id'] === 'string' ? item['id'] : null;
}

/** zod issues as violations; read by duck typing (`issues`), never `instanceof`. */
function schemaViolations(input: Record<string, unknown>, error: unknown): Violation[] {
  const issues: unknown = isObject(error) ? error['issues'] : undefined;
  if (!Array.isArray(issues) || issues.length === 0) {
    return [violation('schema', 'the document does not match the value chain schema')];
  }
  return issues.map((issue: unknown) => {
    const path =
      isObject(issue) && Array.isArray(issue['path']) ? (issue['path'] as unknown[]) : [];
    const message =
      isObject(issue) && typeof issue['message'] === 'string' ? issue['message'] : 'invalid value';
    const id = idAt(input, path[0], path[1]);
    return violation('schema', message, {
      path: path.map(String).join('.') || null,
      elementId: path[0] === 'elements' ? id : null,
      connectionId: path[0] === 'connections' ? id : null,
    });
  });
}

/** schema-model's cross-field rules (`validateDocument`), per element. */
function crossFieldViolations(doc: ValueChainDocument): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>();
  doc.elements.forEach((e, i) => {
    if (seen.has(e.id)) {
      out.push(
        violation('duplicate-id', `the id ${e.id} is used twice`, {
          elementId: e.id,
          path: `elements.${i}.id`,
        }),
      );
    }
    seen.add(e.id);
  });
  doc.connections.forEach((c, i) => {
    if (seen.has(c.id)) {
      out.push(
        violation('duplicate-id', `the id ${c.id} is used twice`, {
          connectionId: c.id,
          path: `connections.${i}.id`,
        }),
      );
    }
    seen.add(c.id);
  });
  const typeById = new Map(doc.elements.map((e) => [e.id, e.elementType]));
  doc.connections.forEach((c, i) => {
    const where = { connectionId: c.id, path: `connections.${i}` };
    const missing = [c.source, c.target].filter((end) => !typeById.has(end));
    for (const end of missing) {
      out.push(
        violation('unknown-endpoint', `the connection names the unknown element ${end}`, where),
      );
    }
    if (missing.length > 0) return;
    if (c.source === c.target) {
      out.push(violation('self-connection', 'a connection must join two elements', where));
      return;
    }
    const sourceType = typeById.get(c.source);
    const targetType = typeById.get(c.target);
    if (sourceType && targetType && !connectionAllowed(c.connectionType, sourceType, targetType)) {
      out.push(
        violation(
          'connection-not-allowed',
          `a ${c.connectionType} connection must not join ${sourceType} to ${targetType}`,
          where,
        ),
      );
    }
  });
  return out;
}

const WHITESPACE = /\s/u;
const CONTROL = /\p{Cc}/u;

function nameViolations(
  name: string,
  where: { elementId: string | null; path: string },
): Violation[] {
  const out: Violation[] = [];
  if (name.length > MAX_VALUE_CHAIN_NAME_CHARS) {
    out.push(
      violation(
        'name-too-long',
        `a name may have at most ${MAX_VALUE_CHAIN_NAME_CHARS} characters`,
        where,
      ),
    );
  }
  if (hasControlCharacters(name) || hasBidiCharacters(name)) {
    out.push(
      violation(
        'name-characters',
        'a name must not contain control or bidirectional formatting characters',
        where,
      ),
    );
  }
  return out;
}

function idViolations(
  id: string,
  where: { elementId?: string; connectionId?: string; path: string },
): Violation[] {
  const out: Violation[] = [];
  if (id.length > MAX_VALUE_CHAIN_ID_CHARS) {
    out.push(
      violation(
        'id-too-long',
        `an id may have at most ${MAX_VALUE_CHAIN_ID_CHARS} characters`,
        where,
      ),
    );
  }
  if (CONTROL.test(id) || hasBidiCharacters(id) || WHITESPACE.test(id)) {
    out.push(
      violation(
        'id-characters',
        'an id must not contain whitespace, control or bidirectional formatting characters',
        where,
      ),
    );
  }
  if ((RESERVED_ELEMENT_IDS as readonly string[]).includes(id) || id.startsWith('@')) {
    out.push(
      violation('reserved-id', `the id ${id} is reserved (vc-root and ids starting with @)`, where),
    );
  }
  return out;
}

/** The size and count limits (M4 §2): checked first, see {@link proaRuleViolations}. */
function limitViolations(doc: ValueChainDocument, canonicalBytes: number): Violation[] {
  const out: Violation[] = [];
  if (canonicalBytes > MAX_VALUE_CHAIN_BYTES) {
    out.push(
      violation(
        'document-too-large',
        `the canonical document has ${canonicalBytes} bytes, at most ${MAX_VALUE_CHAIN_BYTES} are allowed`,
      ),
    );
  }
  if (doc.elements.length > MAX_VALUE_CHAIN_ELEMENTS) {
    out.push(
      violation(
        'too-many-elements',
        `${doc.elements.length} elements, at most ${MAX_VALUE_CHAIN_ELEMENTS}`,
        { path: 'elements' },
      ),
    );
  }
  if (doc.connections.length > MAX_VALUE_CHAIN_CONNECTIONS) {
    out.push(
      violation(
        'too-many-connections',
        `${doc.connections.length} connections, at most ${MAX_VALUE_CHAIN_CONNECTIONS}`,
        { path: 'connections' },
      ),
    );
  }
  return out;
}

const FAR = `a coordinate may be at most ${MAX_VALUE_CHAIN_COORDINATE} from the origin`;
const far = (v: number) => Math.abs(v) > MAX_VALUE_CHAIN_COORDINATE;

/**
 * Bounds and waypoints within {@link MAX_VALUE_CHAIN_COORDINATE} and
 * {@link MAX_VALUE_CHAIN_ELEMENT_SIZE}: schema-model accepts any finite
 * number, but the canonical form rounds to 3 decimals, and above about 1.8e305
 * that rounding gives `Infinity`, stored as `null`, which no read loads again.
 */
function geometryViolations(doc: ValueChainDocument): Violation[] {
  const out: Violation[] = [];
  doc.elements.forEach((e, i) => {
    const at = (field: string) => ({ elementId: e.id, path: `elements.${i}.bounds.${field}` });
    if (far(e.bounds.x)) out.push(violation('geometry-out-of-range', FAR, at('x')));
    if (far(e.bounds.y)) out.push(violation('geometry-out-of-range', FAR, at('y')));
    for (const field of ['width', 'height'] as const) {
      if (e.bounds[field] > MAX_VALUE_CHAIN_ELEMENT_SIZE) {
        out.push(
          violation(
            'geometry-out-of-range',
            `an element may be at most ${MAX_VALUE_CHAIN_ELEMENT_SIZE} wide and high`,
            at(field),
          ),
        );
      }
    }
  });
  doc.connections.forEach((c, i) => {
    const index = c.waypoints.findIndex((p) => far(p.x) || far(p.y));
    const point = c.waypoints[index];
    if (point === undefined) return;
    out.push(
      violation('geometry-out-of-range', FAR, {
        connectionId: c.id,
        path: `connections.${i}.waypoints.${index}.${far(point.x) ? 'x' : 'y'}`,
      }),
    );
  });
  return out;
}

/**
 * The ProA rules on top of schema-model (M4 §2). The size and count limits
 * come first: when one of them fails, only those violations are returned, so
 * the other rules never run on an oversized document. Otherwise every rule
 * runs and the violations are collected.
 */
export function proaRuleViolations(doc: ValueChainDocument, canonicalBytes: number): Violation[] {
  const limits = limitViolations(doc, canonicalBytes);
  if (limits.length > 0) return limits;
  const out: Violation[] = [];
  if (doc.meta.name.trim() === '') {
    out.push(
      violation('name-required', 'the value chain needs a name (meta.name)', { path: 'meta.name' }),
    );
  }
  out.push(...nameViolations(doc.meta.name, { elementId: null, path: 'meta.name' }));
  doc.elements.forEach((e, i) => {
    out.push(...nameViolations(e.name, { elementId: e.id, path: `elements.${i}.name` }));
  });
  doc.elements.forEach((e, i) =>
    out.push(...idViolations(e.id, { elementId: e.id, path: `elements.${i}.id` })),
  );
  doc.connections.forEach((c, i) =>
    out.push(...idViolations(c.id, { connectionId: c.id, path: `connections.${i}.id` })),
  );
  doc.elements.forEach((e, i) => {
    if (e.elementType !== 'step' || e.link === undefined) return;
    const where = { elementId: e.id, path: `elements.${i}.link` };
    if (e.link.length > MAX_VALUE_CHAIN_LINK_CHARS) {
      out.push(
        violation(
          'link-too-long',
          `a link may have at most ${MAX_VALUE_CHAIN_LINK_CHARS} characters`,
          where,
        ),
      );
    }
    if (CONTROL.test(e.link) || hasBidiCharacters(e.link)) {
      out.push(
        violation(
          'link-characters',
          'a link must not contain control or bidirectional formatting characters',
          where,
        ),
      );
    }
  });
  out.push(...geometryViolations(doc));
  out.push(...hierarchyViolations(doc));
  out.push(...duplicateConnections(doc));
  out.push(...sequenceCycles(doc));
  return out;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Appends `value` to the list at `key` (one push per edge, never a copy). */
function append(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * One parent per step, no cycle, depth ≤ {@link MAX_VALUE_CHAIN_DEPTH}, in
 * linear time after sorting: every step's walk up the hierarchy (along its
 * first parent in code point order) stops at a step already resolved, so each
 * step is walked once. A cycle is reported once, at the step where the walk
 * of the first step (in code point order) that reaches it closes it; a step
 * on or below a cycle gets no depth report.
 */
function hierarchyViolations(doc: ValueChainDocument): Violation[] {
  const out: Violation[] = [];
  const parents = new Map<string, string[]>();
  for (const c of doc.connections) {
    if (c.connectionType === 'hierarchy') append(parents, c.target, c.source);
  }
  const ids = [...parents.keys()].sort(byCodePoint);
  const parentOf = new Map<string, string>();
  for (const id of ids) {
    const list = (parents.get(id) ?? []).sort(byCodePoint);
    const first = list[0];
    if (first !== undefined) parentOf.set(id, first);
    if (list.length > 1) {
      out.push(
        violation('multiple-parents', `the step has ${list.length} parents: ${list.join(', ')}`, {
          elementId: id,
        }),
      );
    }
  }
  /** Levels below the top (0 = top level) of the steps resolved so far. */
  const depth = new Map<string, number>();
  /** Steps on a cycle or below one. */
  const cyclic = new Set<string>();
  for (const id of ids) {
    if (!depth.has(id) && !cyclic.has(id)) {
      const path: string[] = [];
      const onPath = new Map<string, number>();
      let p: string | undefined = id;
      while (p !== undefined && !depth.has(p) && !cyclic.has(p) && !onPath.has(p)) {
        onPath.set(p, path.length);
        path.push(p);
        p = parentOf.get(p);
      }
      const closes = p === undefined ? undefined : onPath.get(p);
      if (p !== undefined && closes !== undefined) {
        const cycle = path.slice(closes);
        out.push(
          violation('hierarchy-cycle', `the hierarchy runs in a circle: ${cycle.join(' → ')}`, {
            elementId: p,
          }),
        );
        for (const x of path) cyclic.add(x);
      } else if (p !== undefined && cyclic.has(p)) {
        for (const x of path) cyclic.add(x);
      } else {
        // `p` is resolved, or the last step on the path is at the top (no parent).
        const above = p === undefined ? -1 : (depth.get(p) ?? 0);
        path.forEach((x, i) => depth.set(x, above + path.length - i));
      }
    }
    const level = depth.get(id);
    if (level !== undefined && level > MAX_VALUE_CHAIN_DEPTH) {
      out.push(
        violation(
          'hierarchy-too-deep',
          `the step is at level ${level}, at most ${MAX_VALUE_CHAIN_DEPTH} levels below the top`,
          { elementId: id },
        ),
      );
    }
  }
  return out;
}

/** No two connections of the same type between the same pair, in either direction. */
function duplicateConnections(doc: ValueChainDocument): Violation[] {
  const out: Violation[] = [];
  const seen = new Map<string, string>();
  const sorted = doc.connections
    .map((c, i) => ({ c, i }))
    .sort((a, b) => byCodePoint(a.c.id, b.c.id));
  for (const { c, i } of sorted) {
    const [a, b] = [c.source, c.target].sort(byCodePoint);
    const key = `${c.connectionType}\u0000${a}\u0000${b}`;
    const first = seen.get(key);
    if (first !== undefined) {
      out.push(
        violation('duplicate-connection', `the ${c.connectionType} connection repeats ${first}`, {
          connectionId: c.id,
          path: `connections.${i}`,
        }),
      );
    } else seen.set(key, c.id);
  }
  return out;
}

/** No cycle over the `sequence` edges (iterative DFS, successors sorted once per step). */
function sequenceCycles(doc: ValueChainDocument): Violation[] {
  const next = new Map<string, string[]>();
  for (const c of doc.connections) {
    if (c.connectionType === 'sequence') append(next, c.source, c.target);
  }
  for (const list of next.values()) list.sort(byCodePoint);
  const state = new Map<string, 'open' | 'done'>();
  const out: Violation[] = [];
  const visit = (start: string) => {
    // The stack holds [node, index of the next successor]; `onStack` its depth per open node.
    const stack: [string, number][] = [[start, 0]];
    const onStack = new Map<string, number>([[start, 0]]);
    state.set(start, 'open');
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top) break;
      const [node, index] = top;
      const succ = next.get(node) ?? [];
      if (index >= succ.length) {
        state.set(node, 'done');
        onStack.delete(node);
        stack.pop();
        continue;
      }
      top[1] = index + 1;
      const target = succ[index];
      if (target === undefined) continue;
      const s = state.get(target);
      if (s === 'open') {
        const from = onStack.get(target) ?? 0;
        const cycle = [...stack.slice(from).map(([n]) => n), target];
        out.push(
          violation('sequence-cycle', `the sequence runs in a circle: ${cycle.join(' → ')}`, {
            elementId: target,
          }),
        );
      } else if (s === undefined) {
        state.set(target, 'open');
        onStack.set(target, stack.length);
        stack.push([target, 0]);
      }
    }
  };
  for (const id of [...next.keys()].sort(byCodePoint)) if (!state.has(id)) visit(id);
  return out;
}

/**
 * Loads canonical text with `parseDocumentJSON`, as `structureOf` loads the
 * stored bytes. The ProA rules keep this from failing (the geometry rule
 * keeps the rounding finite); should it still fail, the revision is refused
 * rather than stored in a form no read could load.
 *
 * @throws {DomainError} `value-chain-invalid` (`schema`, with the path of each issue)
 */
export function loadCanonical(canonical: string): ValueChainDocument {
  try {
    return parseDocumentJSON(canonical);
  } catch (err) {
    let reloaded: unknown;
    try {
      reloaded = JSON.parse(canonical);
    } catch {
      reloaded = undefined;
    }
    const issues = schemaViolations(isObject(reloaded) ? reloaded : {}, err).map((v) => ({
      ...v,
      detail: `the canonical form does not load again: ${v.detail}`,
    }));
    throw valueChainInvalid(issues);
  }
}

/** sha256 (hex) of the canonical bytes. */
export function canonicalHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Validates and canonicalizes a value chain document (see the module doc).
 *
 * @throws {DomainError} `value-chain-invalid` with `violations` and
 *   `truncated`; `value-chain-unsupported-version` with `schemaVersion` and
 *   `supported`
 */
export function prepareRevision(input: unknown): PreparedChain {
  if (!isObject(input)) {
    throw valueChainInvalid([violation('not-an-object', 'the document must be a JSON object')]);
  }
  const version = input['schemaVersion'];
  if (
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version > CURRENT_SCHEMA_VERSION
  ) {
    throw new DomainError(
      'value-chain-unsupported-version',
      `schemaVersion ${version} is newer than this server supports (${CURRENT_SCHEMA_VERSION})`,
      { schemaVersion: version, supported: CURRENT_SCHEMA_VERSION },
    );
  }
  let migrated: unknown;
  try {
    migrated = migrate(input);
  } catch (err) {
    throw valueChainInvalid([
      violation(
        'schema',
        `the document cannot be migrated (${err instanceof Error ? err.name : 'error'})`,
      ),
    ]);
  }
  const parsed = valueChainDocumentSchema.safeParse(migrated);
  if (!parsed.success) throw valueChainInvalid(schemaViolations(input, parsed.error));
  const cross = crossFieldViolations(parsed.data);
  if (cross.length > 0) throw valueChainInvalid(cross);

  let document: ValueChainDocument;
  try {
    document = loadDocument(input);
  } catch (err) {
    throw valueChainInvalid([
      violation(
        'schema',
        `schema-model refused the document (${err instanceof Error ? err.name : 'error'})`,
      ),
    ]);
  }
  const canonical = serializeDocument(document);
  const content = new TextEncoder().encode(canonical);
  const rules = proaRuleViolations(document, content.byteLength);
  if (rules.length > 0) throw valueChainInvalid(rules);

  const contentHash = canonicalHash(content);
  // From the canonical form loaded exactly as a read loads the stored bytes on a cache miss, so a
  // revision that would not load again is never stored and ranks never depend on digits the
  // revision does not keep.
  const structure = deriveStructure(loadCanonical(canonical), contentHash);
  return {
    prepared: {
      content,
      contentHash,
      structureHash: structure.structureHash,
      schemaVersion: document.schemaVersion,
      name: document.meta.name,
      stepFingerprints: structure.stepFingerprints,
    },
    structure,
  };
}
