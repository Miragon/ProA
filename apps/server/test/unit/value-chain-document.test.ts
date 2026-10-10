/**
 * `prepareRevision` (M4 S2): the version check before `migrate`, the
 * schema-model schema and cross-field rules with per-element reasons,
 * `loadDocument` as the authority, the canonical bytes, every ProA rule (the
 * limits first, then the rest; the graph rules against a reference copy of
 * their first, quadratic version) and the reload of the canonical form.
 * Synthetic documents, plus the dev landscape's golden chain.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { loadDocument, serializeDocument } from '@miragon/value-chain-schema-model';
import {
  MAX_VALUE_CHAIN_COORDINATE,
  MAX_VALUE_CHAIN_DEPTH,
  MAX_VALUE_CHAIN_ELEMENT_SIZE,
  MAX_VALUE_CHAIN_VIOLATIONS,
  VALUE_CHAIN_VIOLATIONS,
  type ValueChainViolation,
} from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import { DomainError } from '../../src/domain/errors.ts';
import { loadCanonical, notJson, prepareRevision } from '../../src/domain/value-chain/document.ts';
import { clearStructureCache, structureOf } from '../../src/domain/value-chain/structure.ts';
import { NORDWIND_CHAIN, chain } from '../support/value-chain.ts';

type Doc = ReturnType<typeof chain>;

function refused(input: unknown): DomainError {
  try {
    prepareRevision(input);
  } catch (err) {
    if (err instanceof DomainError) return err;
    throw err;
  }
  throw new Error('the document was accepted');
}

function violations(input: unknown): ValueChainViolation[] {
  const err = refused(input);
  expect(err.code).toBe('value-chain-invalid');
  return err.extras['violations'] as ValueChainViolation[];
}

const reasons = (input: unknown) => violations(input).map((v) => v.reason);

const base = (): Doc =>
  chain({
    name: 'Kette',
    steps: [
      { id: 'step-a', name: 'Auftrag' },
      { id: 'step-b', name: 'Versand' },
      { id: 'step-a1', name: 'Erfassung', parent: 'step-a' },
    ],
    sequence: [['step-a', 'step-b']],
    orgUnits: [{ id: 'org-v', name: 'Vertrieb', owns: ['step-a'] }],
  });

/** A document with one element or connection changed. */
function edit(mutate: (d: Doc & Record<string, unknown>) => void): Doc {
  const d = structuredClone(base()) as Doc & Record<string, unknown>;
  mutate(d);
  return d;
}

const step = (id: string, name = id, extra: Record<string, unknown> = {}) => ({
  id,
  elementType: 'step',
  name,
  bounds: { x: 0, y: 0, width: 160, height: 60 },
  ...extra,
});
const conn = (id: string, connectionType: string, source: string, target: string) => ({
  id,
  connectionType,
  source,
  target,
  waypoints: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
});

describe('prepareRevision: canonical bytes', () => {
  it('stores serializeDocument(loadDocument(input)) and its sha256', () => {
    const input = base();
    const { prepared, structure } = prepareRevision(input);
    const canonical = serializeDocument(loadDocument(input));
    expect(new TextDecoder().decode(prepared.content)).toBe(canonical);
    expect(prepared.contentHash).toBe(createHash('sha256').update(canonical).digest('hex'));
    expect(prepared).toMatchObject({ schemaVersion: 1, name: 'Kette' });
    expect(prepared.structureHash).toBe(structure.structureHash);
    expect([...prepared.stepFingerprints.keys()]).toEqual(['step-a', 'step-a1', 'step-b']);
  });

  it('is independent of key order, element order and float noise', () => {
    const a = prepareRevision(base()).prepared;
    const shuffled = base();
    shuffled.elements.reverse();
    shuffled.connections.reverse();
    const noisy = edit((d) => {
      const first = d.elements[0];
      if (first) first.bounds = { ...first.bounds, x: first.bounds.x + 0.0001 };
    });
    expect(prepareRevision(shuffled).prepared.contentHash).toBe(a.contentHash);
    expect(prepareRevision(noisy).prepared.contentHash).toBe(a.contentHash);
  });

  it('keeps the golden dev chain byte for byte', () => {
    const text = readFileSync(NORDWIND_CHAIN, 'utf8');
    const { prepared } = prepareRevision(JSON.parse(text));
    expect(new TextDecoder().decode(prepared.content)).toBe(text);
  });

  it('turns a JSON syntax error into not-json (HTTP layer)', () => {
    const err = notJson('the body is not JSON (SyntaxError)');
    expect(err.code).toBe('value-chain-invalid');
    expect(err.extras).toEqual({
      violations: [
        {
          reason: 'not-json',
          elementId: null,
          connectionId: null,
          path: null,
          detail: 'the body is not JSON (SyntaxError)',
        },
      ],
      truncated: false,
    });
  });
});

describe('prepareRevision: version, schema and cross-field rules', () => {
  it('refuses anything but a JSON object', () => {
    for (const input of [null, [], 'kette', 5, true]) {
      expect(reasons(input), JSON.stringify(input)).toEqual(['not-an-object']);
    }
  });

  it('refuses a newer schemaVersion before migrate and zod, whatever else is wrong', () => {
    const err = refused({ schemaVersion: 2, elements: 'nonsense' });
    expect(err.code).toBe('value-chain-unsupported-version');
    expect(err.extras).toEqual({ schemaVersion: 2, supported: 1 });
    // Not an integer: migrate treats it as 1, the schema refuses it.
    expect(reasons(edit((d) => (d.schemaVersion = 1.5)))).toEqual(['schema']);
  });

  it('names the path and the element or connection of every schema issue', () => {
    const v = violations(
      edit((d) => {
        delete (d.elements[1] as Record<string, unknown>)['name'];
        const c = d.connections[0];
        if (c) c.waypoints = [{ x: 0, y: 0 }];
      }),
    );
    expect(v).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'schema', path: 'elements.1.name', elementId: 'step-b' }),
        expect.objectContaining({
          reason: 'schema',
          path: 'connections.0.waypoints',
          connectionId: 'hier-step-a-step-a1',
        }),
      ]),
    );
    expect(reasons({ schemaVersion: 1, meta: {} })).toEqual(['schema', 'schema', 'schema']);
  });

  const crossField: [string, () => Doc][] = [
    ['duplicate-id', () => edit((d) => d.elements.push(step('step-b', 'Doppelt')))],
    [
      'unknown-endpoint',
      () => edit((d) => d.connections.push(conn('seq-x', 'sequence', 'step-b', 'step-x'))),
    ],
    [
      'self-connection',
      () => edit((d) => d.connections.push(conn('seq-x', 'sequence', 'step-b', 'step-b'))),
    ],
    [
      'connection-not-allowed',
      () => edit((d) => d.connections.push(conn('seq-x', 'sequence', 'org-v', 'step-b'))),
    ],
  ];

  it.each(crossField)('%s names the element or connection', (reason, build) => {
    const [v, ...rest] = violations(build());
    expect(rest).toEqual([]);
    expect(v?.reason).toBe(reason);
    expect(v?.elementId ?? v?.connectionId).toBe(reason === 'duplicate-id' ? 'step-b' : 'seq-x');
  });

  it.each(crossField)(
    'agrees with schema-model: %s makes loadDocument throw too',
    (_reason, build) => {
      expect(() => loadDocument(build())).toThrow();
    },
  );

  it('refuses an assignment between two steps', () => {
    expect(
      reasons(
        edit((d) =>
          d.connections.push(
            conn('as-x', 'assignment', 'step-a', 'step-b') as Doc['connections'][number],
          ),
        ),
      ),
    ).toEqual(['connection-not-allowed']);
  });
});

describe('prepareRevision: the ProA rules', () => {
  const addElement = (e: Record<string, unknown>) =>
    edit((d) => d.elements.push(e as Doc['elements'][number]));
  const addConnection = (c: Record<string, unknown>) =>
    edit((d) => d.connections.push(c as Doc['connections'][number]));

  it.each<[string, () => Doc, string, Partial<ValueChainViolation>]>([
    [
      'meta.name blank',
      () => edit((d) => (d.meta.name = '  ')),
      'name-required',
      { path: 'meta.name' },
    ],
    [
      'a long step name',
      () => addElement(step('step-x', 'x'.repeat(201))),
      'name-too-long',
      { elementId: 'step-x' },
    ],
    [
      'a long chain name',
      () => edit((d) => (d.meta.name = 'x'.repeat(201))),
      'name-too-long',
      { path: 'meta.name' },
    ],
    [
      'a right-to-left override',
      () => addElement(step('step-x', 'Ab‮cd')),
      'name-characters',
      { elementId: 'step-x' },
    ],
    [
      'a bell in an org unit',
      () =>
        edit((d) => {
          const org = d.elements.find((e) => e.id === 'org-v');
          if (org) org.name = 'Vertrieb\u0007';
        }),
      'name-characters',
      { elementId: 'org-v' },
    ],
    [
      'a long id',
      () => addElement(step('s'.repeat(129), 'Lang')),
      'id-too-long',
      { elementId: 's'.repeat(129) },
    ],
    [
      'whitespace in an id',
      () => addElement(step('step x', 'Leer')),
      'id-characters',
      { elementId: 'step x' },
    ],
    ['a bidi mark in an id', () => addElement(step('step‎x', 'Bidi')), 'id-characters', {}],
    [
      'vc-root',
      () => addElement(step('vc-root', 'Wurzel')),
      'reserved-id',
      { elementId: 'vc-root' },
    ],
    [
      '@outside as element',
      () => addElement(step('@outside', 'Außen')),
      'reserved-id',
      { elementId: '@outside' },
    ],
    [
      '@ in a connection id',
      () => addConnection(conn('@seq', 'sequence', 'step-b', 'step-a1')),
      'reserved-id',
      { connectionId: '@seq' },
    ],
    [
      'a long link',
      () => addElement(step('step-x', 'Link', { link: `https://x/${'a'.repeat(2000)}` })),
      'link-too-long',
      { elementId: 'step-x' },
    ],
    [
      'a line break in a link',
      () => addElement(step('step-x', 'Link', { link: 'a\nb' })),
      'link-characters',
      { elementId: 'step-x' },
    ],
  ])('%s: %s', (_what, build, reason, where) => {
    expect(violations(build())).toEqual([expect.objectContaining({ reason, ...where })]);
  });

  it('allows empty step names and line breaks in names, refuses an empty chain name', () => {
    expect(() => prepareRevision(addElement(step('step-x', '')))).not.toThrow();
    expect(() => prepareRevision(addElement(step('step-x', 'Zeile 1\nZeile 2')))).not.toThrow();
    expect(reasons(edit((d) => (d.meta.name = '')))).toEqual(['name-required']);
  });

  it('checks the hierarchy: one parent, no cycle, at most two levels below the top', () => {
    const twoParents = addConnection(conn('hier-b-a1', 'hierarchy', 'step-b', 'step-a1'));
    expect(violations(twoParents)).toEqual([
      expect.objectContaining({ reason: 'multiple-parents', elementId: 'step-a1' }),
    ]);
    const cycle = chain({
      steps: [
        { id: 'a', name: 'A', parent: 'c' },
        { id: 'b', name: 'B', parent: 'a' },
        { id: 'c', name: 'C', parent: 'b' },
      ],
    });
    // Reported once, whichever step the walk starts from.
    expect(violations(cycle)).toEqual([
      expect.objectContaining({
        reason: 'hierarchy-cycle',
        detail: expect.stringContaining('→') as unknown,
      }),
    ]);
    // Both directions between one pair are a duplicate connection as well.
    const back = addConnection(conn('hier-a1-a', 'hierarchy', 'step-a1', 'step-a'));
    expect(reasons(back)).toEqual(['hierarchy-cycle', 'duplicate-connection']);
    const deep = chain({
      steps: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B', parent: 'a' },
        { id: 'c', name: 'C', parent: 'b' },
        { id: 'd', name: 'D', parent: 'c' },
      ],
    });
    expect(violations(deep)).toEqual([
      expect.objectContaining({ reason: 'hierarchy-too-deep', elementId: 'd' }),
    ]);
    expect(() =>
      prepareRevision({
        ...deep,
        elements: deep.elements.slice(0, 3),
        connections: deep.connections.slice(0, 2),
      }),
    ).not.toThrow();
  });

  it('refuses two connections of a type between one pair, in either direction', () => {
    expect(violations(addConnection(conn('seq-z', 'sequence', 'step-a', 'step-b')))).toEqual([
      expect.objectContaining({ reason: 'duplicate-connection', connectionId: 'seq-z' }),
    ]);
    expect(reasons(addConnection(conn('as-z', 'assignment', 'step-a', 'org-v')))).toEqual([
      'duplicate-connection',
    ]);
  });

  it('refuses a cycle over sequence edges', () => {
    const d = chain({
      steps: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
        { id: 'c', name: 'C' },
      ],
      sequence: [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ],
    });
    expect(violations(d)).toEqual([
      expect.objectContaining({
        reason: 'sequence-cycle',
        detail: expect.stringContaining('a → b → c → a') as unknown,
      }),
    ]);
  });

  it('refuses more than 500 elements and more than 1,000 connections', () => {
    const orgs = Array.from({ length: 501 }, (_, i) => ({
      id: `org-${i}`,
      elementType: 'orgUnit',
      name: `O${i}`,
      bounds: { x: 0, y: 0, width: 130, height: 60 },
    }));
    expect(reasons({ ...base(), elements: [...base().elements, ...orgs] })).toEqual([
      'too-many-elements',
    ]);
    const steps = Array.from({ length: 32 }, (_, i) => step(`s-${i}`));
    const owners = Array.from({ length: 32 }, (_, i) => ({ ...orgs[i], id: `o-${i}` }));
    const assignments = owners.flatMap((o) =>
      steps.map((s) => conn(`as-${o.id}-${s.id}`, 'assignment', o.id, s.id)),
    );
    expect(assignments.length).toBe(1024);
    expect(
      reasons({ ...base(), elements: [...steps, ...owners], connections: assignments }),
    ).toEqual(['too-many-connections']);
  });

  it('refuses a canonical document above 1 MiB (the pretty-printed bytes count)', () => {
    const d = base();
    const first = d.connections[0];
    if (first) first.waypoints = Array.from({ length: 30_000 }, (_, i) => ({ x: i, y: 0 }));
    const raw = JSON.stringify(d).length;
    expect(raw).toBeLessThan(1024 * 1024);
    expect(violations(d)).toEqual([
      expect.objectContaining({
        reason: 'document-too-large',
        detail: expect.stringMatching(/bytes/) as unknown,
      }),
    ]);
  });

  it('lists every violation in check order, at most 100, and says when it cut', () => {
    const many = edit((d) => {
      d.meta.name = '';
      for (let i = 0; i < 150; i++) d.elements.push(step(`x-${i}`, `X‮${i}`));
      d.elements.push(step('@oops', 'Reserviert'));
    });
    const err = refused(many);
    const v = err.extras['violations'] as ValueChainViolation[];
    expect(v).toHaveLength(MAX_VALUE_CHAIN_VIOLATIONS);
    expect(err.extras['truncated']).toBe(true);
    const order = v.map((x) => VALUE_CHAIN_VIOLATIONS.indexOf(x.reason));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(v[0]?.reason).toBe('name-required');
    expect(err.message).toMatch(/152 rules, first: name-required/);
  });
});

describe('prepareRevision: geometry and the reload of the canonical form', () => {
  const at = (v: ValueChainViolation) => [v.reason, v.elementId, v.connectionId, v.path];

  it('refuses coordinates and sizes beyond the limits, accepts them at the limits', () => {
    const far = edit((d) => {
      const [a, b, c] = d.elements;
      if (a) a.bounds.x = 1e306;
      if (b) b.bounds.y = -(MAX_VALUE_CHAIN_COORDINATE + 1);
      if (c) c.bounds.width = MAX_VALUE_CHAIN_ELEMENT_SIZE + 1;
      const first = d.connections[0];
      if (first)
        first.waypoints = [
          { x: 0, y: 0 },
          { x: 1, y: -1e9 },
          { x: 2e7, y: 0 },
        ];
    });
    expect(violations(far).map(at)).toEqual([
      ['geometry-out-of-range', 'step-a', null, 'elements.0.bounds.x'],
      ['geometry-out-of-range', 'step-b', null, 'elements.1.bounds.y'],
      ['geometry-out-of-range', 'step-a1', null, 'elements.2.bounds.width'],
      ['geometry-out-of-range', null, base().connections[0]?.id, 'connections.0.waypoints.1.y'],
    ]);
    const edge = edit((d) => {
      const [a, b] = d.elements;
      if (a)
        a.bounds = {
          x: MAX_VALUE_CHAIN_COORDINATE,
          y: -MAX_VALUE_CHAIN_COORDINATE,
          width: MAX_VALUE_CHAIN_ELEMENT_SIZE,
          height: MAX_VALUE_CHAIN_ELEMENT_SIZE,
        };
      if (b) b.bounds.x = -MAX_VALUE_CHAIN_COORDINATE + 0.0004;
    });
    expect(() => prepareRevision(edge)).not.toThrow();
  });

  it('stores only what a read loads again: the structure after a cache miss is the same', async () => {
    // 1e306 is finite, so schema-model accepts it, but rounding to 3 decimals makes it Infinity,
    // which JSON writes as null: the geometry rule refuses it before anything is stored.
    const huge = edit((d) => {
      const first = d.elements[0];
      if (first) first.bounds.x = 1e306;
    });
    expect(reasons(huge)).toEqual(['geometry-out-of-range']);

    const edge = edit((d) => {
      d.elements.forEach((e, i) => {
        e.bounds.x = MAX_VALUE_CHAIN_COORDINATE - i * 0.0004;
        e.bounds.y = -MAX_VALUE_CHAIN_COORDINATE + i * 1.23456;
      });
    });
    const { prepared, structure } = prepareRevision(edge);
    clearStructureCache();
    const reread = await structureOf(prepared.contentHash, () => Promise.resolve(prepared.content));
    expect(reread).toEqual(structure);
    // Saving the stored bytes again is the same revision (the rounding is idempotent).
    const again = prepareRevision(JSON.parse(new TextDecoder().decode(prepared.content)));
    expect(again.prepared.contentHash).toBe(prepared.contentHash);
  });

  it('refuses canonical text that does not load again, naming the path and element', () => {
    const canonical = JSON.stringify({
      connections: [],
      elements: [
        {
          bounds: { height: 60, width: 160, x: null, y: 0 },
          elementType: 'step',
          id: 'step-a',
          name: 'A',
        },
      ],
      meta: { name: 'K' },
      schemaVersion: 1,
    });
    let error: unknown;
    try {
      loadCanonical(canonical);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(DomainError);
    const err = error as DomainError;
    expect(err.code).toBe('value-chain-invalid');
    expect(err.extras['violations']).toEqual([
      expect.objectContaining({
        reason: 'schema',
        elementId: 'step-a',
        path: 'elements.0.bounds.x',
        detail: expect.stringMatching(/^the canonical form does not load again: /) as unknown,
      }),
    ]);
    const valid = serializeDocument(loadDocument(base()));
    expect(loadCanonical(valid)).toEqual(JSON.parse(valid));
  });
});

describe('prepareRevision: the limits first, and graph rules in bounded time', () => {
  /** `n` steps, each the parent of the next (one hierarchy chain), plus a sequence star. */
  function longChain(n: number, star = 0) {
    const steps = Array.from({ length: n }, (_, i) => step(`s${i}`, `S${i}`));
    return {
      schemaVersion: 1,
      meta: { name: 'Lang' },
      elements: steps,
      connections: [
        ...steps.slice(1).map((s, i) => conn(`h${i}`, 'hierarchy', `s${i}`, s.id)),
        ...Array.from({ length: star }, (_, i) =>
          conn(`q${i}`, 'sequence', 's0', `s${(i % (n - 1)) + 1}`),
        ),
      ],
    };
  }

  it('reports only the limits when a document breaks them, whatever else is wrong', () => {
    const doc = longChain(8_000);
    doc.meta.name = '';
    doc.elements.push(step('@oops', 'X‮'));
    expect(JSON.stringify(doc).length).toBeLessThan(2 * 1024 * 1024);
    const started = performance.now();
    expect(reasons(doc)).toEqual([
      'document-too-large',
      'too-many-elements',
      'too-many-connections',
    ]);
    // The first version walked every step's ancestors with a list lookup: 43 s for this body.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('checks a chain at the limits quickly: 500 steps in one hierarchy, 500 sequence edges', () => {
    const doc = longChain(500, 500);
    const started = performance.now();
    const err = refused(doc);
    expect(performance.now() - started).toBeLessThan(5_000);
    // s3…s499 are too deep; the 500th sequence edge repeats the first.
    expect(err.message).toMatch(/breaks 498 rules, first: hierarchy-too-deep/);
    const listed = err.extras['violations'] as ValueChainViolation[];
    expect(listed.every((v) => v.reason === 'hierarchy-too-deep')).toBe(true);
    expect(listed[0]).toMatchObject({
      elementId: 's10',
      detail: `the step is at level 10, at most ${MAX_VALUE_CHAIN_DEPTH} levels below the top`,
    });
  });

  // The first, quadratic versions of the two graph rules, kept here as the reference.
  type C = { connectionType: string; source: string; target: string };
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

  function referenceHierarchy(connections: readonly C[]): [string, string, string][] {
    const out: [string, string, string][] = [];
    const parents = new Map<string, string[]>();
    for (const c of connections) {
      if (c.connectionType !== 'hierarchy') continue;
      parents.set(c.target, [...(parents.get(c.target) ?? []), c.source]);
    }
    const ids = [...parents.keys()].sort(cmp);
    for (const id of ids) {
      const list = parents.get(id) ?? [];
      if (list.length > 1) {
        out.push([
          'multiple-parents',
          id,
          `the step has ${list.length} parents: ${[...list].sort(cmp).join(', ')}`,
        ]);
      }
    }
    const parentOf = (id: string) => [...(parents.get(id) ?? [])].sort(cmp)[0];
    const inCycle = new Set<string>();
    for (const id of ids) {
      const seen: string[] = [id];
      let p = parentOf(id);
      while (p !== undefined && !seen.includes(p)) {
        seen.push(p);
        p = parentOf(p);
      }
      if (p !== undefined) {
        const cycle = seen.slice(seen.indexOf(p));
        if (!cycle.some((x) => inCycle.has(x))) {
          out.push(['hierarchy-cycle', p, `the hierarchy runs in a circle: ${cycle.join(' → ')}`]);
        }
        for (const x of cycle) inCycle.add(x);
        continue;
      }
      const depth = seen.length - 1;
      if (depth > MAX_VALUE_CHAIN_DEPTH) {
        out.push([
          'hierarchy-too-deep',
          id,
          `the step is at level ${depth}, at most ${MAX_VALUE_CHAIN_DEPTH} levels below the top`,
        ]);
      }
    }
    return out;
  }

  function referenceSequence(connections: readonly C[]): [string, string, string][] {
    const next = new Map<string, string[]>();
    for (const c of connections) {
      if (c.connectionType !== 'sequence') continue;
      next.set(c.source, [...(next.get(c.source) ?? []), c.target].sort(cmp));
    }
    const state = new Map<string, 'open' | 'done'>();
    const out: [string, string, string][] = [];
    const visit = (start: string) => {
      const stack: [string, number][] = [[start, 0]];
      state.set(start, 'open');
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (!top) break;
        const [node, index] = top;
        const succ = next.get(node) ?? [];
        if (index >= succ.length) {
          state.set(node, 'done');
          stack.pop();
          continue;
        }
        top[1] = index + 1;
        const target = succ[index];
        if (target === undefined) continue;
        const s = state.get(target);
        if (s === 'open') {
          const path = stack.map(([n]) => n);
          const cycle = [...path.slice(path.indexOf(target)), target];
          out.push([
            'sequence-cycle',
            target,
            `the sequence runs in a circle: ${cycle.join(' → ')}`,
          ]);
        } else if (s === undefined) {
          state.set(target, 'open');
          stack.push([target, 0]);
        }
      }
    };
    for (const id of [...next.keys()].sort(cmp)) if (!state.has(id)) visit(id);
    return out;
  }

  /** mulberry32: a small seeded generator, so a failure names a reproducible case. */
  function random(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('reports exactly what the first versions of the hierarchy and sequence rules reported', () => {
    const graph = new Set([
      'multiple-parents',
      'hierarchy-cycle',
      'hierarchy-too-deep',
      'sequence-cycle',
    ]);
    const seen = new Map<string, number>();
    for (let seed = 1; seed <= 400; seed++) {
      const next = random(seed);
      const n = 2 + Math.floor(next() * 11);
      const ids = Array.from({ length: n }, (_, i) => `s${Math.floor(next() * 1000)}-${i}`);
      const connections = Array.from({ length: Math.floor(next() * n * 2) }, (_, i) => {
        const source = ids[Math.floor(next() * n)] ?? 's';
        let target = ids[Math.floor(next() * n)] ?? 's';
        if (target === source) target = ids[(ids.indexOf(source) + 1) % n] ?? 's';
        return conn(`c${i}`, next() < 0.6 ? 'hierarchy' : 'sequence', source, target);
      });
      const doc = {
        schemaVersion: 1,
        meta: { name: 'Zufall' },
        elements: ids.map((id) => step(id)),
        connections,
      };
      const expected = [...referenceHierarchy(connections), ...referenceSequence(connections)];
      let actual: [string, string | null, string][] = [];
      try {
        prepareRevision(doc);
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        actual = (err.extras['violations'] as ValueChainViolation[])
          .filter((v) => graph.has(v.reason))
          .map((v) => [v.reason, v.elementId, v.detail]);
      }
      // valueChainInvalid lists by reason in check order, stable within a reason.
      const order = (r: string) =>
        VALUE_CHAIN_VIOLATIONS.indexOf(r as ValueChainViolation['reason']);
      const sorted = expected
        .map((v, i) => ({ v, i }))
        .sort((a, b) => order(a.v[0]) - order(b.v[0]) || a.i - b.i)
        .map(({ v }) => v);
      expect(actual, `seed ${seed}`).toEqual(sorted);
      for (const [reason] of sorted) seen.set(reason, (seen.get(reason) ?? 0) + 1);
    }
    // Every graph rule fires in many of the cases.
    for (const reason of graph) expect(seen.get(reason) ?? 0, reason).toBeGreaterThan(20);
  });
});
