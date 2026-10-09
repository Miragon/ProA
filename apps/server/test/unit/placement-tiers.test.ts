/**
 * The lexical tier of placement proposals (M4 S2): the server's stem rule
 * equals the derived `name-match`/`semantic` tags of the dev landscape's
 * golden placements (the holdout is never read), and the matcher combines
 * the baseline's top 3, the stem rule and equal names. Synthetic chains and
 * the dev landscape only.
 */
import { readFileSync } from 'node:fs';

import { sharesNameStem } from '@proa/relations';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { prepareRevision } from '../../src/domain/value-chain/document.ts';
import { OUTSIDE } from '../../src/domain/value-chain/steps.ts';
import { siblingsOf } from '../../src/domain/value-chain/structure.ts';
import {
  acceptedNeighbours,
  acceptedSteps,
  lexicalMatcher,
  processOfRefs,
} from '../../src/domain/value-chain/tiers.ts';
import { NORDWIND_CHAIN, NORDWIND_PLACEMENTS, chain } from '../support/value-chain.ts';

interface Expected {
  steps: { id: string; name: string; parent?: string }[];
  placements: { process: string; name: string; must: string; tags: string[] }[];
}

describe('the stem rule against the dev landscape’s derived tags', () => {
  it('singles out the must step exactly for the processes tagged name-match', () => {
    const expected = parse(readFileSync(NORDWIND_PLACEMENTS, 'utf8')) as Expected;
    const structure = prepareRevision(JSON.parse(readFileSync(NORDWIND_CHAIN, 'utf8'))).structure;
    let checked = 0;
    for (const p of expected.placements) {
      if (p.must === OUTSIDE) continue;
      const step = structure.byId.get(p.must);
      expect(step, p.must).toBeDefined();
      if (!step) continue;
      const stem = sharesNameStem(
        { name: p.name, modelKey: p.process.split('#')[0] ?? '' },
        step,
        siblingsOf(structure, p.must),
      );
      expect(stem !== null, `${p.process} → ${p.must}`).toBe(p.tags.includes('name-match'));
      expect(stem === null, `${p.process} → ${p.must}`).toBe(p.tags.includes('semantic'));
      checked++;
    }
    expect(checked).toBe(expected.placements.filter((p) => p.must !== OUTSIDE).length);
  });
});

describe('lexicalMatcher', () => {
  const structure = prepareRevision(
    chain({
      steps: [
        { id: 'step-vertrieb', name: 'Vertrieb' },
        { id: 'step-abwicklung', name: 'Auftragsabwicklung', parent: 'step-vertrieb' },
        { id: 'step-eingang', name: 'Auftragseingang', parent: 'step-vertrieb' },
        { id: 'step-fakt', name: 'Fakturierung' },
        { id: 'step-mahn', name: 'Mahnwesen', parent: 'step-fakt' },
        { id: 'step-rech', name: 'Rechnungsstellung', parent: 'step-fakt' },
        {
          id: 'step-linked',
          name: 'Sonderprozesse',
          link: 'proa:process/z/zahl#P_Zahl',
        },
      ],
    }),
  ).structure;
  const processes = new Map([
    [
      'vertrieb/order-handling#P_Order',
      { name: 'Auftragsabwicklung', modelKey: 'vertrieb/order-handling' },
    ],
    ['finanzen/mahnlauf#P_Mahn', { name: 'Mahnverfahren', modelKey: 'finanzen/mahnlauf' }],
    ['z/zahl#P_Zahl', { name: 'Zahlungsabgleich', modelKey: 'z/zahl' }],
    ['x/auftrag#P_A', { name: 'Auftrag', modelKey: 'x/auftrag' }],
  ]);
  const match = lexicalMatcher({ structure, processes, neighbours: new Map(), known: new Map() });

  it('is lexical for the baseline’s top 3 and for a shared stem', () => {
    expect(match('vertrieb/order-handling#P_Order', 'step-abwicklung')).toBe(true);
    expect(match('vertrieb/order-handling#P_Order', 'step-vertrieb')).toBe(true);
    // "mahn" is a shared stem (the baseline's 5-letter prefix rule misses it).
    expect(match('finanzen/mahnlauf#P_Mahn', 'step-mahn')).toBe(true);
    expect(match('finanzen/mahnlauf#P_Mahn', 'step-rech')).toBe(false);
  });

  it('is semantic for a step named only by a link, for @outside and for unknown steps', () => {
    expect(match('z/zahl#P_Zahl', 'step-linked')).toBe(false);
    expect(match('z/zahl#P_Zahl', OUTSIDE)).toBe(false);
    expect(match('z/zahl#P_Zahl', 'step-nope')).toBe(false);
    expect(match('m/unknown#P', 'step-mahn')).toBe(false);
  });

  it('counts an equal name as lexical even when siblings share the word', () => {
    const s = prepareRevision(
      chain({
        steps: [
          { id: 'p', name: 'Vertrieb' },
          { id: 'a', name: 'Auftrag', parent: 'p' },
          { id: 'b', name: 'Auftragsklärung', parent: 'p' },
          { id: 'c', name: 'Auftragsprüfung', parent: 'p' },
          { id: 'd', name: 'Auftragsänderung', parent: 'p' },
        ],
      }),
    ).structure;
    const m = lexicalMatcher({ structure: s, processes, neighbours: new Map(), known: new Map() });
    expect(
      sharesNameStem(
        { name: 'Auftrag', modelKey: 'x/auftrag' },
        { name: 'Auftrag' },
        siblingsOf(s, 'a'),
      ),
    ).toBeNull();
    expect(m('x/auftrag#P_A', 'a')).toBe(true);
  });

  it('gives the top 3 hints with scores', () => {
    expect(match.hints('vertrieb/order-handling#P_Order').map((h) => h.stepId)).toEqual([
      'step-abwicklung',
      'step-eingang',
      'step-vertrieb',
    ]);
  });
});

describe('neighbours and votes from accepted state only', () => {
  const facts = [
    { ref: 'a/x#P_A', modelKey: 'a/x', processId: 'P_A' },
    { ref: 'a/x#Call_B', modelKey: 'a/x', processId: 'P_A' },
    { ref: 'b/y#P_B', modelKey: 'b/y', processId: 'P_B' },
    { ref: 'c/z#Throw', modelKey: 'c/z', processId: 'P_C' },
    { ref: 'a/x#Flow', modelKey: 'a/x', processId: null },
  ] as const;
  const processOf = processOfRefs(facts);

  it('maps fact refs to their process refs', () => {
    expect(processOf.get('a/x#Call_B')).toBe('a/x#P_A');
    expect(processOf.has('a/x#Flow')).toBe(false);
  });

  it('joins processes by accepted relations only, both ways, never to themselves', () => {
    const neighbours = acceptedNeighbours(
      [
        { status: 'accepted', fromRef: 'a/x#Call_B', toRef: 'b/y#P_B' },
        { status: 'proposed', fromRef: 'c/z#Throw', toRef: 'a/x#P_A' },
        { status: 'accepted', fromRef: 'a/x#Call_B', toRef: 'a/x#P_A' },
      ],
      processOf,
    );
    expect([...neighbours]).toEqual([
      ['a/x#P_A', ['b/y#P_B']],
      ['b/y#P_B', ['a/x#P_A']],
    ]);
  });

  it('votes with accepted placements on live generations, @outside aside', () => {
    const live = new Map([
      ['s1', 1],
      ['s2', 2],
      [OUTSIDE, 1],
    ]);
    const known = acceptedSteps(
      [
        { status: 'accepted', elementId: 's1', generation: 1, processRef: 'a/x#P_A' },
        { status: 'accepted', elementId: 's2', generation: 1, processRef: 'a/x#P_A' },
        { status: 'proposed', elementId: 's2', generation: 2, processRef: 'a/x#P_A' },
        { status: 'accepted', elementId: OUTSIDE, generation: 1, processRef: 'b/y#P_B' },
      ],
      live,
    );
    expect([...known]).toEqual([['a/x#P_A', ['s1']]]);
  });
});
