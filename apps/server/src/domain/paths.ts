import { isModelKey } from '@proa/contracts';

/** File extensions stripped from import paths (longest first). */
const BPMN_EXTENSIONS = ['.bpmn20.xml', '.bpmn2', '.bpmn', '.xml'];

const TRANSLITERATION: Readonly<Record<string, string>> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

function slugSegment(segment: string): string {
  return segment
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => TRANSLITERATION[c] ?? c)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Model key of an imported file (CONCEPT §4: "the model key is the slugified
 * path"): the path below the import root without its BPMN extension, each
 * segment lowercased, transliterated (ä → ae, …) and reduced to `[a-z0-9-]`.
 * `Finanzen/Rechnungsstellung.bpmn` → `finanzen/rechnungsstellung`.
 *
 * @returns the key, or `null` if nothing valid remains
 */
export function modelKeyFromPath(path: string): string | null {
  let p = path.replaceAll('\\', '/');
  const lower = p.toLowerCase();
  const ext = BPMN_EXTENSIONS.find((e) => lower.endsWith(e));
  if (ext) p = p.slice(0, -ext.length);
  const segments = p
    .split('/')
    .filter((s) => s !== '' && s !== '.' && s !== '..')
    .map(slugSegment)
    .filter((s) => s !== '');
  const key = segments.join('/');
  return key !== '' && isModelKey(key) ? key : null;
}
