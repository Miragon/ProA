/** Project keys: one lowercase slug segment, at most 64 characters (`ProjectKey` in the contracts). */
export const PROJECT_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PROJECT_KEY_MAX = 64;

const TRANSLITERATION: Readonly<Record<string, string>> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** `Nordwind Handel GmbH` → `nordwind-handel-gmbh`, `Stadtwerke Auental` → `stadtwerke-auental`. */
export function slugify(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => TRANSLITERATION[c] ?? c)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PROJECT_KEY_MAX)
    .replace(/-+$/, '');
}

export function isProjectKey(value: string): boolean {
  return value.length <= PROJECT_KEY_MAX && PROJECT_KEY_PATTERN.test(value);
}
