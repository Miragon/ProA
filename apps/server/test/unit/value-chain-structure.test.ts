/**
 * The structure of a value chain revision (M4 S2): kinds by colour, ranks,
 * step fingerprints, `structure_hash`, owners, link kinds and the structure
 * cache; the golden dev chain against its expected steps. Synthetic chains
 * and the dev landscape only.
 */
import { readFileSync } from 'node:fs';

import { STEP_KIND_COLORS } from '@proa/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { prepareRevision } from '../../src/domain/value-chain/document.ts';
import {
  STRUCTURE_CACHE_SIZE,
  cachedStructureKeys,
  clearStructureCache,
  colorKey,
  descendantsOf,
  linkTarget,
  siblingsOf,
  stepFingerprint,
  structureOf,
  type ChainStructure,
} from '../../src/domain/value-chain/structure.ts';
import {
  NORDWIND_CHAIN,
  NORDWIND_PLACEMENTS,
  chain,
  type StepSpec,
} from '../support/value-chain.ts';

const PURPLE = STEP_KIND_COLORS.management;
const GREEN = STEP_KIND_COLORS.support;

function structure(spec: Parameters<typeof chain>[0]): ChainStructure {
  return prepareRevision(chain(spec)).structure;
}

const core: StepSpec[] = [
  { id: 'a', name: 'Beschaffung', x: 0 },
  { id: 'b', name: 'Lagerhaltung', x: 300 },
  { id: 'c', name: 'Vertrieb', x: 600 },
];

describe('kinds', () => {
  const s = structure({
    steps: [
      ...core,
      { id: 'm', name: 'Steuerung', color: PURPLE, y: -200 },
      { id: 's', name: 'Personal', color: 'HSL(150,86%,34%)', y: 200 },
      { id: 'o', name: 'Sonstiges', color: '#123456', y: 400 },
      { id: 'n', name: 'Ohne Farbe', y: 600 },
      { id: 'a1', name: 'Disposition', parent: 'a', color: GREEN },
      { id: 's1', name: 'Lohn', parent: 's' },
      { id: 's11', name: 'Abrechnung', parent: 's1', color: PURPLE },
    ],
    sequence: [
      ['a', 'b'],
      ['b', 'c'],
    ],
  });
  const kind = (id: string) => s.byId.get(id)?.kind;

  it('makes the top-level sequence chain core, also when one step carries a colour', () => {
    expect(['a', 'b', 'c'].map(kind)).toEqual(['core', 'core', 'core']);
    const coloured = structure({
      steps: [{ ...core[0], color: GREEN } as StepSpec, core[1] as StepSpec],
      sequence: [['a', 'b']],
    });
    expect(coloured.byId.get('a')?.kind).toBe('core');
  });

  it('takes the kind of other top-level steps from the colour, lowercased and without spaces', () => {
    expect(kind('m')).toBe('management');
    expect(kind('s')).toBe('support');
    expect(kind('o')).toBe('other');
    expect(kind('n')).toBe('other');
    expect(colorKey(' HSL(150, 86%, 34%) ')).toBe('hsl(150,86%,34%)');
  });

  it('lets sub-steps inherit the kind of their top-level step, whatever their own colour', () => {
    expect(kind('a1')).toBe('core');
    expect(kind('s1')).toBe('support');
    expect(kind('s11')).toBe('support');
    expect(s.byId.get('s11')).toMatchObject({
      depth: 2,
      path: ['Personal', 'Lohn', 'Abrechnung'],
      pathIds: ['s', 's1', 's11'],
    });
  });
});

describe('ranks', () => {
  it('follows the sequence among top-level steps of a kind, whatever their x', () => {
    const s = structure({
      steps: [
        { id: 'a', name: 'A', x: 900 },
        { id: 'b', name: 'B', x: 0 },
        { id: 'c', name: 'C', x: 500 },
        { id: 'm1', name: 'M1', color: PURPLE, x: 400 },
        { id: 'm2', name: 'M2', color: PURPLE, x: 100 },
      ],
      sequence: [
        ['a', 'b'],
        ['b', 'c'],
      ],
    });
    expect(['a', 'b', 'c', 'm1', 'm2'].map((id) => s.byId.get(id)?.rank)).toEqual([0, 1, 2, 1, 0]);
  });

  it('orders unsequenced siblings by x, then y (a column shares x), then id', () => {
    const s = structure({
      steps: [
        { id: 'p', name: 'P' },
        { id: 'z', name: 'Z', parent: 'p', x: 100, y: 300 },
        { id: 'y', name: 'Y', parent: 'p', x: 100, y: 100 },
        { id: 'x', name: 'X', parent: 'p', x: 100, y: 200 },
        { id: 'w', name: 'W', parent: 'p', x: 100, y: 200 },
      ],
    });
    expect(s.byId.get('p')?.childIds).toEqual(['y', 'w', 'x', 'z']);
    expect(['y', 'w', 'x', 'z'].map((id) => s.byId.get(id)?.rank)).toEqual([0, 1, 2, 3]);
  });

  it('ranks a sequenced sibling group by its edges and ignores edges across groups', () => {
    const s = structure({
      steps: [
        { id: 'p', name: 'P' },
        { id: 'q', name: 'Q', x: 500 },
        { id: 'p1', name: 'P1', parent: 'p', y: 300 },
        { id: 'p2', name: 'P2', parent: 'p', y: 100 },
        { id: 'q1', name: 'Q1', parent: 'q', y: 0 },
      ],
      sequence: [
        ['p', 'q'],
        ['p1', 'p2'],
        ['q1', 'p1'],
      ],
    });
    expect(s.byId.get('p1')?.rank).toBe(0);
    expect(s.byId.get('p2')?.rank).toBe(1);
    expect(s.byId.get('q1')?.rank).toBe(0);
  });
});

describe('step fingerprints', () => {
  const fp = (name: string, parent?: string) =>
    structure({
      steps: [
        { id: 'p', name: 'Eltern' },
        { id: 'q', name: 'Andere' },
        { id: 's', name, ...(parent ? { parent } : {}) },
      ],
    }).byId.get('s')?.fingerprint;

  it('is sha256(step|name_norm|parent_id), 12 hex characters', () => {
    expect(fp('Qualitätsprüfung', 'p')).toBe(stepFingerprint('qualitaetspruefung', 'p'));
    expect(fp('Qualitätsprüfung')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('keeps the meaning across case and umlaut spelling, changes with a rename or a new parent', () => {
    expect(fp('Qualitätsprüfung', 'p')).toBe(fp('QUALITAETSPRUEFUNG', 'p'));
    expect(fp('Qualitätsprüfung ', 'p')).toBe(fp(' qualitätsprüfung', 'p'));
    expect(fp('Qualitätsprüfung', 'p')).not.toBe(fp('Wareneingang', 'p'));
    expect(fp('Qualitätsprüfung', 'p')).not.toBe(fp('Qualitätsprüfung', 'q'));
    expect(fp('Qualitätsprüfung', 'p')).not.toBe(fp('Qualitätsprüfung'));
  });
});

describe('structure_hash', () => {
  interface Spec {
    name: string;
    steps: StepSpec[];
    sequence: [string, string][];
    orgUnits: { id: string; name: string; owns: string[] }[];
  }
  const spec = (): Spec => ({
    name: 'Kette',
    steps: [
      { id: 'a', name: 'Auftrag' },
      { id: 'b', name: 'Versand' },
      { id: 'h', name: 'Hilfe', color: GREEN, y: 300 },
      { id: 'a1', name: 'Erfassung', parent: 'a' },
    ],
    sequence: [['a', 'b']],
    orgUnits: [{ id: 'org', name: 'Vertrieb', owns: ['a'] }],
  });
  const hash = (input: unknown) => prepareRevision(input).structure.structureHash;
  const reference = hash(chain(spec()));

  it('ignores bounds, waypoints, the raw colour, connection ids and the chain name', () => {
    const moved = chain(spec());
    for (const e of moved.elements) e.bounds = { ...e.bounds, x: e.bounds.x + 37, width: 220 };
    for (const c of moved.connections) {
      c.waypoints = [
        { x: 5, y: 5 },
        { x: 6, y: 9 },
        { x: 7, y: 7 },
      ];
      c.id = `${c.id}-renamed`;
    }
    moved.meta.name = 'Anderer Name';
    const h = moved.elements.find((e) => e.id === 'h') as { color?: string };
    h.color = 'hsl(150,86%,34%)';
    expect(hash(moved)).toBe(reference);
    expect(hash({ ...chain(spec()), meta: { name: 'X' } })).toBe(reference);
  });

  it('changes with ids, names, links, connections and a recolour that changes a kind', () => {
    const variants: [string, (s: ReturnType<typeof spec>) => void][] = [
      [
        'id',
        (s) => {
          s.steps[1] = { id: 'b2', name: 'Versand' };
          s.sequence = [['a', 'b2']];
        },
      ],
      ['name', (s) => (s.steps[1] = { id: 'b', name: 'Fakturierung' })],
      ['link', (s) => (s.steps[1] = { id: 'b', name: 'Versand', link: 'https://example.org' })],
      ['sequence', (s) => (s.sequence = [])],
      ['owner', (s) => (s.orgUnits = [{ id: 'org', name: 'Vertrieb', owns: ['b'] }])],
      ['recolour', (s) => (s.steps[2] = { id: 'h', name: 'Hilfe', color: PURPLE, y: 300 })],
    ];
    for (const [what, change] of variants) {
      const s = spec();
      change(s);
      expect(hash(chain(s)), what).not.toBe(reference);
    }
    // A recolour that keeps the kind (both "other") changes nothing.
    const other = spec();
    other.steps[2] = { id: 'h', name: 'Hilfe', color: '#000000', y: 300 };
    const other2 = spec();
    other2.steps[2] = { id: 'h', name: 'Hilfe', color: '#ffffff', y: 300 };
    expect(hash(chain(other))).toBe(hash(chain(other2)));
  });

  it('is versioned', () => {
    expect(reference).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('owners, org units, descendants and siblings', () => {
  const s = structure({
    steps: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'a1', name: 'A1', parent: 'a' },
      { id: 'a11', name: 'A11', parent: 'a1' },
      { id: 'a2', name: 'A2', parent: 'a' },
    ],
    orgUnits: [
      { id: 'org-z', name: 'Zentral', owns: ['a', 'b'] },
      { id: 'org-y', name: 'Y', owns: ['a'] },
      { id: 'org-x', name: 'Leer', owns: [] },
    ],
  });

  it('lists the org units assigned to a step and the steps of each org unit', () => {
    expect(s.byId.get('a')?.ownerIds).toEqual(['org-y', 'org-z']);
    expect(s.byId.get('a1')?.ownerIds).toEqual([]);
    expect(s.orgUnits).toEqual([
      { elementId: 'org-x', name: 'Leer', stepIds: [] },
      { elementId: 'org-y', name: 'Y', stepIds: ['a'] },
      { elementId: 'org-z', name: 'Zentral', stepIds: ['a', 'b'] },
    ]);
  });

  it('finds descendants on every level and the siblings of a step', () => {
    expect(descendantsOf(s, 'a')).toEqual(['a1', 'a11', 'a2']);
    expect(siblingsOf(s, 'a1').map((x) => x.elementId)).toEqual(['a2']);
    expect(siblingsOf(s, 'a').map((x) => x.elementId)).toEqual(['b']);
  });
});

describe('link kinds', () => {
  const head = new Set(['vertrieb/auftrag#P_Auftrag']);
  it.each([
    [null, { kind: 'none', process: null, resolved: false }],
    [
      'proa:process/vertrieb/auftrag#P_Auftrag',
      { kind: 'process', process: 'vertrieb/auftrag#P_Auftrag', resolved: true },
    ],
    [
      'proa:process/vertrieb/weg#P_Weg',
      { kind: 'process', process: 'vertrieb/weg#P_Weg', resolved: false },
    ],
    ['proa:process/kein ref', { kind: 'process', process: null, resolved: false }],
    ['https://wiki.example.org/x', { kind: 'url', process: null, resolved: false }],
    ['HTTP://example.org', { kind: 'url', process: null, resolved: false }],
    ['operations-detail', { kind: 'opaque', process: null, resolved: false }],
  ])('%s', (link, expected) => {
    expect(linkTarget(link, head)).toEqual(expected);
  });
});

describe('the structure cache', () => {
  beforeEach(() => clearStructureCache());

  it('parses stored bytes once per content hash, least recently used out first', async () => {
    const docs = Array.from(
      { length: STRUCTURE_CACHE_SIZE + 1 },
      (_, i) => prepareRevision(chain({ steps: [{ id: `s${i}`, name: `S${i}` }] })).prepared,
    );
    let loads = 0;
    const load = (i: number) => () => {
      loads++;
      return Promise.resolve(docs[i]?.content ?? null);
    };
    const first = await structureOf(docs[0]?.contentHash ?? '', load(0));
    expect(await structureOf(docs[0]?.contentHash ?? '', load(0))).toBe(first);
    expect(loads).toBe(1);
    for (let i = 1; i <= STRUCTURE_CACHE_SIZE; i++)
      await structureOf(docs[i]?.contentHash ?? '', load(i));
    expect(cachedStructureKeys()).toHaveLength(STRUCTURE_CACHE_SIZE);
    expect(cachedStructureKeys()).not.toContain(docs[0]?.contentHash);
    expect(first.steps.map((s) => s.elementId)).toEqual(['s0']);
    await expect(structureOf('missing', () => Promise.resolve(null))).rejects.toThrow(/not found/);
  });
});

describe('the golden dev chain', () => {
  it('derives the kinds, levels and parents of expected-placements.yaml', () => {
    const s = prepareRevision(JSON.parse(readFileSync(NORDWIND_CHAIN, 'utf8'))).structure;
    const expected = (
      parse(readFileSync(NORDWIND_PLACEMENTS, 'utf8')) as {
        steps: { id: string; kind: string; level: number; parent?: string }[];
      }
    ).steps;
    expect(s.steps.map((x) => x.elementId).sort()).toEqual(expected.map((x) => x.id).sort());
    for (const step of expected) {
      expect(s.byId.get(step.id), step.id).toMatchObject({
        kind: step.kind,
        depth: step.level,
        parentId: step.parent ?? null,
      });
    }
    const coreChain = s.steps
      .filter((x) => x.kind === 'core' && x.depth === 0)
      .sort((a, b) => a.rank - b.rank)
      .map((x) => x.elementId);
    expect(coreChain).toEqual([
      'step-beschaffung',
      'step-lagerhaltung',
      'step-vertrieb',
      'step-versand',
      'step-fakturierung',
      'step-kundenservice',
    ]);
    expect(s.steps.filter((x) => x.depth === 0).every((x) => x.ownerIds.length === 1)).toBe(true);
  });
});
