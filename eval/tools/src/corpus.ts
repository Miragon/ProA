import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `eval/corpus`. */
export const CORPUS_DIR = fileURLToPath(new URL('../../corpus', import.meta.url));

/** Landscapes that are scored: every corpus directory not starting with `_`. */
export async function listScoredLandscapes(corpusDir: string = CORPUS_DIR): Promise<string[]> {
  const entries = await readdir(corpusDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort();
}

export interface CorpusModel {
  /** Path below `models/` without `.bpmn`, e.g. `finanzen/rechnungsstellung`. */
  key: string;
  xml: string;
}

/** All `models/**\/*.bpmn` of a landscape, sorted by key. */
export async function loadModels(landscapeDir: string): Promise<CorpusModel[]> {
  const modelsDir = path.join(landscapeDir, 'models');
  const files = (await readdir(modelsDir, { recursive: true }))
    .filter((f) => f.endsWith('.bpmn'))
    .sort();
  return Promise.all(
    files.map(async (f) => ({
      key: f.slice(0, -'.bpmn'.length).split(path.sep).join('/'),
      xml: await readFile(path.join(modelsDir, f), 'utf8'),
    })),
  );
}
