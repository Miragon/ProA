/**
 * The eval corpus (`eval/corpus/<landscape>/models/**.bpmn`) as upload files,
 * plus the libraries' own view of a landscape (facts → rules), which the
 * server must reproduce after an import.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFacts } from '@proa/bpmn-facts';
import { MAX_IMPORT_FILES, type ImportResult, type ProjectFacts } from '@proa/contracts';
import { runRules, type RuleResult } from '@proa/relations';

export const CORPUS_DIR = fileURLToPath(new URL('../../../../eval/corpus', import.meta.url));
export const CANDIDATES_REPORT = fileURLToPath(
  new URL('../../../../eval/reports/candidates.json', import.meta.url),
);

export interface CorpusFile {
  /** Path below `models/`, with `/` separators, e.g. `finanzen/mahnwesen.bpmn`. */
  path: string;
  /** Model key: the path without `.bpmn`. */
  key: string;
  bytes: Uint8Array;
}

/** Every model of a landscape, sorted by path. */
export async function corpusFiles(landscape: string): Promise<CorpusFile[]> {
  const dir = path.join(CORPUS_DIR, landscape, 'models');
  const entries = (await readdir(dir, { recursive: true }))
    .map((e) => e.split(path.sep).join('/'))
    .filter((e) => e.endsWith('.bpmn'))
    .sort();
  return Promise.all(
    entries.map(async (p) => ({
      path: p,
      key: p.slice(0, -'.bpmn'.length),
      bytes: new Uint8Array(await readFile(path.join(dir, p))),
    })),
  );
}

/** multipart/form-data body of an import. */
export function importForm(files: readonly { path: string; bytes: Uint8Array }[]): FormData {
  const fd = new FormData();
  for (const f of files) fd.append('files', new Blob([f.bytes]), f.path);
  return fd;
}

/** Imports `files` in batches of at most {@link MAX_IMPORT_FILES}; returns every file's outcome. */
export async function importAll(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  project: string,
  files: readonly CorpusFile[],
): Promise<ImportResult['files']> {
  const outcomes: ImportResult['files'] = [];
  for (let i = 0; i < files.length; i += MAX_IMPORT_FILES) {
    const res = await request(`/api/v1/projects/${project}/imports`, {
      method: 'POST',
      body: importForm(files.slice(i, i + MAX_IMPORT_FILES)),
    });
    if (res.status !== 200) throw new Error(`import: ${res.status} ${await res.text()}`);
    outcomes.push(...((await res.json()) as ImportResult).files);
  }
  return outcomes;
}

/** The libraries' result for a set of files: extracted facts and the rule tier. */
export async function libraryView(
  files: readonly CorpusFile[],
): Promise<{ projectFacts: ProjectFacts; rules: RuleResult; factCount: number }> {
  const models: ProjectFacts['models'] = [];
  for (const f of files) {
    const r = await extractFacts(f.bytes, { modelKey: f.key });
    models.push({
      modelKey: f.key,
      factsVersion: r.factsVersion,
      processes: r.processes,
      facts: r.facts,
      messageFlows: r.messageFlows,
    });
  }
  const projectFacts = { models };
  return {
    projectFacts,
    rules: runRules(projectFacts),
    factCount: models.reduce((n, m) => n + m.facts.length, 0),
  };
}

/** The parts of `eval/reports/candidates.json` the server is compared with. */
export interface CandidatesReport {
  landscapes: {
    name: string;
    counts: {
      models: number;
      processes: number;
      facts: number;
      rules: { accepted: number; proposed: number };
    };
    findings: { kind: string; computed: string[] }[];
  }[];
}

export async function candidatesReport(): Promise<CandidatesReport> {
  return JSON.parse(await readFile(CANDIDATES_REPORT, 'utf8')) as CandidatesReport;
}
