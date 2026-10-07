import { Candidate } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import { generateCandidates } from '../src/index.ts';
import { call, end, model, msgCatch, msgThrow, project, shuffled, start } from './support/facts.ts';

const pairs = (cs: Candidate[]) => cs.map((c) => `${c.basis} ${c.type} ${c.from} -> ${c.to}`);
const find = (cs: Candidate[], from: string, to: string) =>
  cs.find((c) => c.from === from && c.to === to);

const billing = model('finanzen/rechnung', {
  processes: [{ id: 'Process_Rechnung', name: 'Rechnungsstellung' }],
  facts: [
    msgThrow('Event_RechnungVersendet', 'RechnungVersendet', { label: 'Rechnung versendet' }),
    msgCatch('Start_LieferungVersendet', 'LieferungVersendet', { label: 'Lieferung versendet' }),
    end('End_RechnungGestellt', 'Rechnung gestellt'),
    end('End_Ware', 'Ware versandbereit'),
    call('Call_Ausgabe', '${kanal}', { label: 'Rechnung ausgeben' }),
    call('Call_Mahnung', 'Process_Mahnwesen', { label: 'Mahnen' }),
  ],
});
const shop = model('vertrieb/shop', {
  processes: [{ id: 'Process_Shop', name: 'Order handling' }],
  facts: [
    msgCatch('Start_InvoiceSent', 'InvoiceSent', {
      label: 'Invoice sent',
      scope: 'event_subprocess',
    }),
    msgThrow('Event_Shipped', 'LieferungVersendet', { label: 'Shipment dispatched' }),
    msgCatch('Start_Nested', 'RechnungVersendet', {
      label: 'Rechnung versendet',
      scope: 'subprocess',
    }),
    start('Start_Ware', 'Ware versandbereit'),
    start('Start_Timer', 'Rechnung gestellt', { eventDef: 'timer' }),
  ],
});
const dunning = model('finanzen/mahnwesen', {
  processes: [{ id: 'Process_Mahnwesen', name: 'Mahnwesen' }],
  facts: [msgCatch('Start_Mahnung', 'MahnungAngefordert', { label: 'Mahnung angefordert' })],
});
const letters = model('finanzen/briefversand', {
  processes: [{ id: 'Process_Brief', name: 'Briefversand' }],
});
const landscape = project(billing, shop, dunning, letters);

describe('generateCandidates', () => {
  const all = generateCandidates(landscape);

  it('returns valid candidates sorted by score, then (type, from, to)', () => {
    for (const c of all) expect(() => Candidate.parse(c)).not.toThrow();
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1]!;
      const b = all[i]!;
      expect(a.score >= b.score).toBe(true);
    }
  });

  it('carries the rule tier: accepted calls as rule, identical names as key (score 1)', () => {
    expect(
      find(all, 'finanzen/rechnung#Call_Mahnung', 'finanzen/mahnwesen#Process_Mahnwesen'),
    ).toMatchObject({
      basis: 'rule',
      score: 1,
    });
    expect(
      find(all, 'vertrieb/shop#Event_Shipped', 'finanzen/rechnung#Start_LieferungVersendet'),
    ).toMatchObject({
      basis: 'key',
      score: 1,
      signals: { keyEqual: true, eventDefCompatible: true },
    });
  });

  it('finds German/English pairs lexically', () => {
    const c = find(
      all,
      'finanzen/rechnung#Event_RechnungVersendet',
      'vertrieb/shop#Start_InvoiceSent',
    );
    expect(c?.basis).toBe('lexical');
    expect(c?.signals.jaccard).toBe(1);
  });

  it('offers labelled none end → none start pairs as triggers, never timer starts', () => {
    expect(find(all, 'finanzen/rechnung#End_Ware', 'vertrieb/shop#Start_Ware')).toMatchObject({
      type: 'trigger',
      basis: 'lexical',
      score: 1,
    });
    expect(all.some((c) => c.to === 'vertrieb/shop#Start_Timer')).toBe(false);
  });

  it('never pairs incompatible event definitions or subprocess-scoped starts', () => {
    // A none end with the label of a message start is the event-def-mismatch trap.
    expect(all.some((c) => c.from === 'finanzen/rechnung#End_Ware' && c.type !== 'trigger')).toBe(
      false,
    );
    expect(all.some((c) => c.to === 'vertrieb/shop#Start_Nested')).toBe(false);
    expect(all.every((c) => c.from.split('#')[0] !== c.to.split('#')[0])).toBe(true);
  });

  it('ranks processes for open (dynamic) calls only; settled calls keep their rule target', () => {
    const fromDynamic = all
      .filter((c) => c.from === 'finanzen/rechnung#Call_Ausgabe')
      .map((c) => c.to);
    expect(fromDynamic.sort()).toEqual([
      'finanzen/briefversand#Process_Brief',
      'finanzen/mahnwesen#Process_Mahnwesen',
      'vertrieb/shop#Process_Shop',
    ]);
    expect(all.filter((c) => c.from === 'finanzen/rechnung#Call_Mahnung')).toHaveLength(1);
  });

  it('limits lexical and compatible partners per endpoint', () => {
    const tight = generateCandidates(landscape, undefined, {
      lexicalPerEndpoint: 0,
      compatiblePerEndpoint: 0,
    });
    expect(tight.every((c) => c.basis === 'rule' || c.basis === 'key')).toBe(true);
    const one = generateCandidates(landscape, 'vertrieb/shop', {
      lexicalPerEndpoint: 1,
      compatiblePerEndpoint: 0,
    });
    const lexicalFromShipped = one.filter(
      (c) => c.from === 'vertrieb/shop#Event_Shipped' && c.basis === 'lexical',
    );
    expect(lexicalFromShipped.length).toBeLessThanOrEqual(1);
  });

  it('with a focus model, returns pairs touching it in both directions, a subset of the full run', () => {
    const focused = generateCandidates(landscape, 'vertrieb/shop');
    expect(focused.length).toBeGreaterThan(0);
    expect(
      focused.every(
        (c) => c.from.startsWith('vertrieb/shop#') || c.to.startsWith('vertrieb/shop#'),
      ),
    ).toBe(true);
    expect(focused.some((c) => c.from.startsWith('vertrieb/shop#'))).toBe(true);
    expect(focused.some((c) => c.to.startsWith('vertrieb/shop#'))).toBe(true);
    const full = new Set(pairs(all));
    for (const p of pairs(focused)) expect(full.has(p)).toBe(true);
    expect(generateCandidates(landscape, 'does/not-exist')).toEqual([]);
  });

  it('is deterministic and independent of the input order', () => {
    expect(generateCandidates(shuffled(landscape))).toEqual(all);
    expect(generateCandidates(landscape)).toEqual(all);
  });

  it('handles an empty project', () => {
    expect(generateCandidates(project())).toEqual([]);
  });
});
