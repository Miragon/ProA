import { describe, expect, it } from 'vitest';

import { normalizeKey } from '../src/index.ts';

describe('normalizeKey (CONCEPT §2 key_norm)', () => {
  it.each([
    ['Antrag prüfen', 'antrag pruefen'],
    ['Antrag pruefen', 'antrag pruefen'],
    ['Gemäß', 'gemaess'],
    ['GEMÄSS', 'gemaess'],
    ['Straße', 'strasse'],
    ['Ware_Versand-bereit!', 'ware versand bereit'],
    ['  Order   received. ', 'order received'],
    ['Line\nbreak\ttab', 'line break tab'],
    ['Café crème', 'cafe creme'],
    ['ﬁle № 3', 'file no 3'],
    ['=ausgabekanal', 'ausgabekanal'],
    ['', ''],
  ])('%j → %j', (raw, norm) => {
    expect(normalizeKey(raw)).toBe(norm);
  });

  it('handles decomposed umlauts like precomposed ones', () => {
    expect(normalizeKey('prüfen')).toBe('pruefen');
    expect(normalizeKey('PRÜFEN')).toBe('pruefen');
  });

  it('is idempotent', () => {
    for (const raw of ['Antrag prüfen', 'Gemäß §3 (neu)', 'ﬁle № 3']) {
      expect(normalizeKey(normalizeKey(raw))).toBe(normalizeKey(raw));
    }
  });
});
