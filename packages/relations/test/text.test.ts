import { describe, expect, it } from 'vitest';

import {
  STOPWORDS,
  SYNONYMS,
  bestSimilarity,
  conceptJaccard,
  conceptOf,
  contentWords,
  hasLexicalEvidence,
  levenshtein,
  normalizeLabel,
  relativeLevenshtein,
  similarity,
  splitCamelCase,
  textForm,
} from '../src/index.ts';

const sim = (a: string, b: string) => similarity(textForm(a), textForm(b));

describe('normalization', () => {
  it('normalizes labels like fact keys (transliteration, punctuation)', () => {
    expect(normalizeLabel('Antrag prüfen')).toBe(normalizeLabel('Antrag pruefen'));
    expect(normalizeLabel('Order received.')).toBe('order received');
  });

  it('splits camelCase names', () => {
    expect(splitCamelCase('KreditprüfungAngefordert')).toBe('Kreditprüfung Angefordert');
    expect(splitCamelCase('ERPSystemReady')).toBe('ERP System Ready');
    expect(splitCamelCase('invoice2Sent')).toBe('invoice2 Sent');
  });

  it('drops German and English stopwords and joins multi-word terms', () => {
    expect(contentWords('Rechnung an den Kunden versendet')).toEqual([
      'rechnung',
      'kunden',
      'versendet',
    ]);
    expect(contentWords('Request a credit note')).toEqual(['request', 'creditnote']);
    expect(contentWords('Process_PaymentCollection')).toEqual(['payment', 'collection']);
    expect(STOPWORDS.has('fuer')).toBe(true);
  });

  it('keeps every synonym stem in normalized form', () => {
    for (const stems of Object.values(SYNONYMS)) {
      for (const stem of stems) expect(normalizeLabel(stem)).toBe(stem);
    }
  });
});

describe('concepts', () => {
  it('maps German and English words of one meaning to one concept', () => {
    expect(conceptOf('rechnung')).toBe('invoice');
    expect(conceptOf('invoice')).toBe('invoice');
    expect(conceptOf('versendet')).toBe('send');
    expect(conceptOf('sent')).toBe('send');
    expect(conceptOf('gutschrift')).toBe('creditnote');
    expect(conceptOf('creditnote')).toBe('creditnote');
  });

  it('covers inflections, German participles and compound heads', () => {
    expect(conceptOf('rechnungen')).toBe('invoice');
    expect(conceptOf('geprueft')).toBe('check');
    expect(conceptOf('pruefung')).toBe('check');
    expect(conceptOf('gesperrt')).toBe('lock');
    expect(conceptOf('eilzahlung')).toBe('pay');
    expect(conceptOf('wareneingang')).toBe('receive');
  });

  it('leaves unknown words alone and keeps short stems exact', () => {
    expect(conceptOf('kommissionierung')).toBe('kommissionierung');
    expect(conceptOf('neutral')).toBe('neutral');
    expect(conceptOf('neu')).toBe('new');
  });
});

describe('distances', () => {
  it('computes the Levenshtein distance', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('orderreceived', 'orderrejected')).toBe(3);
    expect(levenshtein('flaw', 'lawn')).toBe(2);
  });

  it('relates the distance to the longer string', () => {
    expect(relativeLevenshtein('abcd', 'abcd')).toBe(1);
    expect(relativeLevenshtein('abcd', 'abce')).toBe(0.75);
    expect(relativeLevenshtein('', 'abc')).toBe(0);
  });

  it('computes concept Jaccard with inflection variants', () => {
    expect(conceptJaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(conceptJaccard(['a', 'b'], ['a', 'c'])).toBeCloseTo(1 / 3);
    expect(conceptJaccard(['kommissioniert'], ['kommissionierung'])).toBe(1);
    expect(conceptJaccard([], ['a'])).toBe(0);
  });
});

describe('similarity', () => {
  it('scores transliteration variants as identical', () => {
    expect(sim('Antrag prüfen', 'Antrag pruefen').score).toBe(1);
  });

  it('finds German/English pairs through the synonym list', () => {
    const s = sim('Rechnung versendet', 'Invoice sent');
    expect(s.jaccard).toBe(1);
    expect(hasLexicalEvidence(s)).toBe(true);
    expect(sim('Gutschrift angefordert', 'Request credit note').jaccard).toBe(1);
  });

  it('ranks a near miss below an identical label but keeps lexical evidence', () => {
    const near = sim('Order received', 'Order rejected');
    expect(near.score).toBeLessThan(sim('Order received', 'Order received').score);
    expect(near.jaccard).toBeCloseTo(0.3333);
    expect(hasLexicalEvidence(near)).toBe(true);
  });

  it('finds no evidence between unrelated labels', () => {
    const s = sim('Kommissionierung abgeschlossen', 'Lieferant angelegt');
    expect(s.jaccard).toBe(0);
    expect(hasLexicalEvidence(s)).toBe(false);
  });

  it('takes the best pair of texts', () => {
    const best = bestSimilarity(
      [textForm('Payment allocated'), textForm('ZahlungZugeordnet')],
      [textForm('Zahlung zugeordnet')],
    );
    expect(best.score).toBe(1);
    expect(bestSimilarity([], [textForm('x')]).score).toBe(0);
  });
});
