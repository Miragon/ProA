// The rule tier's key placements, baseline-prefix/1 and the README's name-match
// stem rule on synthetic chains (M4-VALUE-CHAIN.md §2 "Tiers", §6). No eval
// landscape is read here.
import { describe, expect, it } from 'vitest';

import {
  BASELINE_PREFIX,
  baselinePrefix,
  derivePlacementRules,
  normalizeLabel,
  prefixTokensMatch,
  sharedStem,
  sharesNameStem,
  stemWords,
  type PrefixStep,
} from '../src/index.ts';

const steps: PrefixStep[] = [
  { id: 'step-vertrieb', name: 'Vertrieb', parentId: null },
  { id: 'step-auftragsabwicklung', name: 'Auftragsabwicklung', parentId: 'step-vertrieb' },
  { id: 'step-bonitaet', name: 'Bonitätsprüfung', parentId: 'step-vertrieb' },
  { id: 'step-fakturierung', name: 'Fakturierung & Zahlung', parentId: null },
  { id: 'step-rechnungsstellung', name: 'Rechnungsstellung', parentId: 'step-fakturierung' },
  { id: 'step-mahnwesen', name: 'Mahnwesen', parentId: 'step-fakturierung' },
  { id: 'step-versand', name: 'Versand', parentId: null },
  { id: 'step-kommissionierung', name: 'Kommissionierung', parentId: 'step-versand' },
  { id: '@outside', name: 'Auftragsabwicklung', parentId: null },
];

describe('baseline-prefix/1', () => {
  it('is versioned', () => {
    expect(BASELINE_PREFIX).toBe('baseline-prefix/1');
  });

  it('weighs the name (3), ancestors (1) and folders (2), most specific step first', () => {
    const hints = baselinePrefix({
      steps,
      processes: [
        {
          ref: 'vertrieb/auftragsabwicklung#P_A',
          name: 'Auftragsabwicklung',
          modelKey: 'vertrieb/auftragsabwicklung',
        },
      ],
    });
    // Leaf: 3 (name) + 2 (folder "vertrieb" on its parent); its sibling and the parent: 2
    // (folder), the deeper one first.
    expect(hints.get('vertrieb/auftragsabwicklung#P_A')).toEqual([
      { stepId: 'step-auftragsabwicklung', score: 5 },
      { stepId: 'step-bonitaet', score: 2 },
      { stepId: 'step-vertrieb', score: 2 },
    ]);
  });

  it('counts a process token matching an ancestor once, with weight 1', () => {
    const hints = baselinePrefix({
      steps,
      processes: [{ ref: 'x/y#P', name: 'Vertrieb Sonderfall', modelKey: 'x/sonderfall' }],
    });
    // "vertrieb" names the top step (3) and is an ancestor of both sub-steps (1 each).
    expect(hints.get('x/y#P')).toEqual([
      { stepId: 'step-vertrieb', score: 3 },
      { stepId: 'step-auftragsabwicklung', score: 1 },
      { stepId: 'step-bonitaet', score: 1 },
    ]);
  });

  it('matches by prefix (inflections), and words through their synonym concepts too', () => {
    const hints = baselinePrefix({
      steps,
      processes: [
        {
          ref: 'lager/kommissionieren#P',
          name: 'Ware kommissionieren',
          modelKey: 'lager/kommissionieren',
        },
        { ref: 'finance/invoicing#P', name: 'Invoice creation', modelKey: 'finance/invoicing' },
      ],
    });
    expect(hints.get('lager/kommissionieren#P')?.[0]).toEqual({
      stepId: 'step-kommissionierung',
      score: 3,
    });
    // "Rechnungsstellung" is one word of its own, with no concept to share with "Invoice".
    expect(hints.get('finance/invoicing#P')).toEqual([]);
    // "Invoice" and "Rechnung" share the concept `invoice`.
    const synonyms = baselinePrefix({
      steps: [{ id: 'r', name: 'Rechnung', parentId: null }],
      processes: [{ ref: 'f/freigabe#P', name: 'Invoice approval', modelKey: 'f/freigabe' }],
    });
    expect(synonyms.get('f/freigabe#P')).toEqual([{ stepId: 'r', score: 3 }]);
  });

  it('breaks ties by depth (deepest first), then by id in code point order', () => {
    const tie: PrefixStep[] = [
      { id: 'b', name: 'Versand', parentId: null },
      { id: 'a', name: 'Versand', parentId: null },
      { id: 'c', name: 'Versand', parentId: 'b' },
    ];
    const hints = baselinePrefix({
      steps: tie,
      processes: [{ ref: 'k/versand#P', name: null, modelKey: 'k/versand' }],
    });
    // c: 3 + 1 (its parent b shares the token); a and b: 3 each.
    expect(hints.get('k/versand#P')).toEqual([
      { stepId: 'c', score: 4 },
      { stepId: 'a', score: 3 },
      { stepId: 'b', score: 3 },
    ]);
  });

  it('adds neighbour votes (1 on the step, 0.5 on its ancestors) and leaves the process out', () => {
    const input = {
      steps,
      processes: [{ ref: 'a/zahlung#P', name: 'Zahlungslauf', modelKey: 'a/zahlung' }],
      neighbours: new Map([
        ['a/zahlung#P', ['b/brief#Q', 'c/druck#R', 'a/zahlung#P', 'b/brief#Q']],
      ]),
      known: new Map([
        ['b/brief#Q', ['step-mahnwesen']],
        ['c/druck#R', ['step-mahnwesen', 'step-rechnungsstellung']],
        // Its own known step is never read (leave-one-out).
        ['a/zahlung#P', ['step-kommissionierung']],
      ]),
    };
    expect(baselinePrefix(input).get('a/zahlung#P')).toEqual([
      // "Zahlungslauf" and the file stem "zahlung" both meet "Zahlung" by prefix: 3 each on
      // Fakturierung & Zahlung, 1 each on its sub-steps (an ancestor's name). Q and R vote 1
      // each on Mahnwesen, R 1 on Rechnungsstellung, and both 0.5 on their parent.
      { stepId: 'step-fakturierung', score: 7 },
      { stepId: 'step-mahnwesen', score: 4 },
      { stepId: 'step-rechnungsstellung', score: 3 },
    ]);
  });

  it('never offers @outside, keeps the top 3 and drops zero scores', () => {
    const hints = baselinePrefix({
      steps,
      processes: [
        {
          ref: 'vertrieb/auftragsabwicklung#P',
          name: 'Auftragsabwicklung',
          modelKey: 'vertrieb/auftragsabwicklung',
        },
        { ref: 'z/z#Z', name: 'Nichts', modelKey: 'z/z' },
      ],
    });
    expect(hints.get('vertrieb/auftragsabwicklung#P')?.map((h) => h.stepId)).not.toContain(
      '@outside',
    );
    expect(hints.get('z/z#Z')).toEqual([]);
    const many = baselinePrefix(
      {
        steps: Array.from({ length: 6 }, (_, i) => ({
          id: `s${i}`,
          name: 'Versand',
          parentId: null,
        })),
        processes: [{ ref: 'v/versand#P', name: null, modelKey: 'v/versand' }],
      },
      { top: 2 },
    );
    expect(many.get('v/versand#P')).toEqual([
      { stepId: 's0', score: 3 },
      { stepId: 's1', score: 3 },
    ]);
  });

  it('is deterministic whatever the input order', () => {
    const processes = [
      {
        ref: 'vertrieb/auftragsabwicklung#P',
        name: 'Auftragsabwicklung',
        modelKey: 'vertrieb/auftragsabwicklung',
      },
    ];
    const a = baselinePrefix({ steps, processes });
    const b = baselinePrefix({ steps: [...steps].reverse(), processes });
    expect([...b]).toEqual([...a]);
  });

  it('matches tokens that are equal, or share a prefix of min(5, both lengths) with 4+ characters', () => {
    expect(prefixTokensMatch('pay', 'pay')).toBe(true);
    expect(prefixTokensMatch('kommissionierung', 'kommissioniert')).toBe(true);
    expect(prefixTokensMatch('lager', 'lagerhaltung')).toBe(true);
    expect(prefixTokensMatch('mahn', 'mahnwesen')).toBe(true);
    expect(prefixTokensMatch('mahnverfahren', 'mahnwesen')).toBe(false);
    expect(prefixTokensMatch('pay', 'payment')).toBe(false);
  });
});

describe('the name-match stem rule (eval/value-chains/README.md)', () => {
  it('splits like the validator: lowercase, umlauts, letters only, 4+ letters', () => {
    expect(stemWords('Bonitätsprüfung & IT-Services')).toEqual(['bonitaetspruefung', 'services']);
    expect(stemWords('finanzen/rechnungs-ausgabe')).toEqual(['finanzen', 'rechnungs', 'ausgabe']);
  });

  it('finds the longest leading part of either word in the other', () => {
    expect(sharedStem('mahnverfahren', 'mahnwesen')).toBe('mahn');
    expect(sharedStem('wesen', 'mahnwesen')).toBe('wesen');
    expect(sharedStem('kundenservice', 'kundenkommunikation')).toBe('kunden');
    expect(sharedStem('abc', 'abcd')).toBeNull();
  });

  it('takes stems of the process name and the model key, folders included', () => {
    const siblings = [{ name: 'Rechnungsstellung' }, { name: 'Zahlungseingang' }];
    expect(
      sharesNameStem(
        { name: 'Mahnverfahren', modelKey: 'finanzen/mahnung' },
        { name: 'Mahnwesen' },
        siblings,
      ),
    ).toBe('mahn');
    expect(
      sharesNameStem(
        { name: 'Portalanfrage', modelKey: 'kundenservice/portal' },
        { name: 'Kundenkommunikation' },
        [{ name: 'Self-Service' }],
      ),
    ).toBe('kunden');
  });

  it('refuses a stem that a sibling step names too', () => {
    expect(
      sharesNameStem(
        { name: 'Portalanfrage', modelKey: 'kundenservice/portal' },
        { name: 'Kundenkommunikation' },
        [{ name: 'Kundenservice-Portal' }],
      ),
    ).toBeNull();
  });

  it('counts an equal name as a shared stem; unrelated names are semantic', () => {
    expect(
      sharesNameStem(
        { name: 'Kommissionierung', modelKey: 'lager/picking' },
        { name: 'Kommissionierung' },
        [{ name: 'Paketversand' }],
      ),
    ).toBe('kommissionierung');
    expect(
      sharesNameStem(
        { name: 'Order handling', modelKey: 'sales/order-handling' },
        { name: 'Auftragsabwicklung' },
        [],
      ),
    ).toBeNull();
  });
});

describe('derivePlacementRules (the rule tier’s key placements)', () => {
  const processes = [
    { ref: 'finanzen/mahnwesen#P_Mahn', label: 'Mahnverfahren' },
    { ref: 'finanzen/pruefung#P_Pruef', label: 'Rechnungsprüfung' },
    { ref: 'lager/versand#P_Versand', label: 'Versand' },
    { ref: 'lager/versand-alt#P_Versand', label: 'VERSAND' },
    { ref: 'ops/ohne-name#P_X', label: '' },
  ];
  const step = (id: string, name: string, link: string | null = null) => ({
    id,
    nameNorm: normalizeLabel(name),
    link,
  });

  it('matches a proa:process/ link of a known process', () => {
    expect(
      derivePlacementRules(
        [step('step-mahnwesen', 'Mahnwesen', 'proa:process/finanzen/mahnwesen#P_Mahn')],
        processes,
      ),
    ).toEqual([
      {
        stepId: 'step-mahnwesen',
        processRef: 'finanzen/mahnwesen#P_Mahn',
        byLink: true,
        byName: false,
        nameNorm: 'mahnwesen',
      },
    ]);
  });

  it('matches an equal name after normalization (transliteration, case)', () => {
    expect(derivePlacementRules([step('step-p', 'Rechnungspruefung')], processes)).toEqual([
      {
        stepId: 'step-p',
        processRef: 'finanzen/pruefung#P_Pruef',
        byLink: false,
        byName: true,
        nameNorm: 'rechnungspruefung',
      },
    ]);
  });

  it('gives both reasons at once, and one match per process sharing the name', () => {
    expect(
      derivePlacementRules(
        [step('step-versand', 'Versand', 'proa:process/lager/versand#P_Versand')],
        processes,
      ).map((m) => [m.processRef, m.byLink, m.byName]),
    ).toEqual([
      ['lager/versand#P_Versand', true, true],
      ['lager/versand-alt#P_Versand', false, true],
    ]);
  });

  it('yields one match per step for a pasted link, ordered by step id then process ref', () => {
    const link = 'proa:process/finanzen/mahnwesen#P_Mahn';
    expect(
      derivePlacementRules(
        [step('step-b', 'Zwei', link), step('step-a', 'Eins', link), step('step-c', 'Versand')],
        processes,
      ).map((m) => `${m.stepId} ${m.processRef}`),
    ).toEqual([
      'step-a finanzen/mahnwesen#P_Mahn',
      'step-b finanzen/mahnwesen#P_Mahn',
      'step-c lager/versand#P_Versand',
      'step-c lager/versand-alt#P_Versand',
    ]);
  });

  it('ignores an unknown or malformed link and an empty name', () => {
    const steps = [
      step('step-1', 'Eins', 'proa:process/x/fehlt#P'),
      step('step-2', 'Zwei', 'proa:process/'),
      step('step-3', 'Drei', 'https://example.com/proa:process/lager/versand#P_Versand'),
      step('step-4', 'Vier', 'proa:process/lager/versand#P_Versand '),
      step('step-5', '', null),
      step('step-6', ' – ', null),
    ];
    expect(derivePlacementRules(steps, processes)).toEqual([]);
  });

  it('is independent of the input order', () => {
    const steps = [
      step('step-versand', 'Versand'),
      step('step-mahnwesen', 'Mahnwesen', 'proa:process/finanzen/mahnwesen#P_Mahn'),
    ];
    expect(derivePlacementRules([...steps].reverse(), [...processes].reverse())).toEqual(
      derivePlacementRules(steps, processes),
    );
  });
});
