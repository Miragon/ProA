const TRANSLITERATION: Readonly<Record<string, string>> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/**
 * Computes `key_norm` (CONCEPT §2): NFKC, lowercase, ä/ö/ü/ß → ae/oe/ue/ss,
 * remaining diacritics folded (é → e), every run of characters that are
 * neither letters nor digits (punctuation, `_`, whitespace) → one space,
 * trimmed. Part of the fact format: changing it requires a new
 * `FACTS_VERSION`.
 *
 * @example normalizeKey('Antrag prüfen')   // 'antrag pruefen'
 * @example normalizeKey('Gemäß §3 (neu)') // 'gemaess 3 neu'
 */
export function normalizeKey(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => TRANSLITERATION[c] ?? c)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
