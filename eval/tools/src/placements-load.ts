// Loads what eval:placements scores for one landscape (M4-VALUE-CHAIN.md §6):
// the golden chain (eval/value-chains/<landscape>/value-chain.vc.json, read
// with @miragon/value-chain-schema-model), the golden placements
// (expected-placements.yaml), the process facts and must_link neighbours of
// the corpus landscape, and the outcome of validate-value-chains.mjs.
//
// Holdout hygiene: nothing here prints, and no error message quotes the
// files' content (a YAML or schema error names the file and the error class
// or the issue count; the validator's findings are reduced to its summary
// lines), because one landscape is the holdout.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDocument } from '@miragon/value-chain-schema-model';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { CORPUS_DIR } from './corpus.ts';
import { loadLandscape } from './landscape.ts';
import type { ChainStep, Golden, PlacementProcess, PlacementRun, ValidatorResult } from './placements-score.ts';

/** `eval/value-chains`. */
export const VALUE_CHAINS_DIR = fileURLToPath(new URL('../../value-chains', import.meta.url));
export const CHAIN_FILE = 'value-chain.vc.json';
export const GOLDEN_FILE = 'expected-placements.yaml';
export const VALIDATOR_FILE = 'validate-value-chains.mjs';

/** The validator lines kept (as eval/tools/test/value-chains.test.mjs keeps them): no findings. */
const SUMMARY_LINE = /^(schema:|cross-check:|[\w-]+: (ok|FAIL))/;

/** A landscape's golden data cannot be read: exit 1. The message never quotes the files. */
export class PlacementDataError extends Error {
  override readonly name = 'PlacementDataError';
}

/**
 * Runs `node eval/value-chains/validate-value-chains.mjs <name>` and keeps its
 * exit code and summary lines. The validator could not start → exit 2.
 */
export function runValidator(name: string, valueChainsDir: string = VALUE_CHAINS_DIR): ValidatorResult {
  const run = spawnSync(process.execPath, [path.join(valueChainsDir, VALIDATOR_FILE), name], {
    encoding: 'utf8',
  });
  if (run.error || run.status === null) return { exitCode: 2, summary: [] };
  return {
    exitCode: run.status,
    summary: run.stdout.split('\n').filter((line) => SUMMARY_LINE.test(line)),
  };
}

/** The parts of expected-placements.yaml the scorer uses (the validator checks the full format). */
const GoldenFile = z.looseObject({
  landscape: z.string(),
  steps: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      level: z.number().int(),
      parent: z.string().optional(),
    }),
  ),
  placements: z.array(
    z.looseObject({
      process: z.string(),
      name: z.string(),
      must: z.string(),
      may: z.array(z.string()).optional(),
      must_not: z.array(z.string()).optional(),
      tags: z.array(z.string()).default([]),
      superseded_by: z.string().optional(),
    }),
  ),
});

const errorClass = (err: unknown): string => (err instanceof Error ? err.constructor.name : typeof err);

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Steps of the chain document: elements of type `step`; a `hierarchy` connection runs parent → child. */
export function chainStepsOf(text: string, name: string): ChainStep[] {
  let doc: ReturnType<typeof loadDocument>;
  try {
    doc = loadDocument(JSON.parse(text));
  } catch (err) {
    throw new PlacementDataError(
      `${name}: ${CHAIN_FILE} does not load (${errorClass(err)}; message withheld, run ` +
        `node eval/value-chains/${VALIDATOR_FILE} ${name})`,
    );
  }
  const parentOf = new Map<string, string>();
  for (const c of doc.connections) if (c.connectionType === 'hierarchy') parentOf.set(c.target, c.source);
  return doc.elements
    .filter((e) => e.elementType === 'step')
    .map((e) => ({
      id: e.id,
      name: e.name,
      parentId: parentOf.get(e.id) ?? null,
      link: e.elementType === 'step' ? (e.link ?? null) : null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function goldenOf(text: string, name: string, contentHash: string): Golden {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new PlacementDataError(`${name}: ${GOLDEN_FILE} is not YAML (${errorClass(err)}; message withheld)`);
  }
  const parsed = GoldenFile.safeParse(raw);
  if (!parsed.success) {
    throw new PlacementDataError(
      `${name}: ${GOLDEN_FILE} does not match the format (${parsed.error.issues.length} issues; ` +
        `run node eval/value-chains/${VALIDATOR_FILE} ${name})`,
    );
  }
  return {
    landscape: parsed.data.landscape,
    contentHash,
    steps: parsed.data.steps.map((s) => ({ id: s.id, name: s.name, kind: s.kind, level: s.level, parent: s.parent ?? null })),
    placements: parsed.data.placements.map((p) => ({
      process: p.process,
      name: p.name,
      must: p.must,
      may: p.may ?? [],
      mustNot: p.must_not ?? [],
      tags: p.tags,
      supersededBy: p.superseded_by ?? null,
    })),
  };
}

export interface PlacementDirs {
  corpusDir?: string;
  valueChainsDir?: string;
}

/**
 * Loads one landscape for eval:placements. The corpus landscape must exist
 * (the caller checks the name); a scored landscape without
 * `eval/value-chains/<name>/` is a data error.
 *
 * @throws {PlacementDataError} for a missing or unreadable golden file
 */
export async function loadPlacementRun(name: string, dirs: PlacementDirs = {}): Promise<PlacementRun> {
  const corpusDir = dirs.corpusDir ?? CORPUS_DIR;
  const valueChainsDir = dirs.valueChainsDir ?? VALUE_CHAINS_DIR;
  const chainDir = path.join(valueChainsDir, name);
  if (!(await isDirectory(chainDir))) {
    throw new PlacementDataError(`${name}: no golden value chain (${CHAIN_FILE}, ${GOLDEN_FILE}) in ${chainDir}`);
  }
  const read = async (file: string): Promise<Buffer> => {
    try {
      return await readFile(path.join(chainDir, file));
    } catch (err) {
      throw new PlacementDataError(`${name}: cannot read ${file} (${errorClass(err)})`);
    }
  };
  const chainBytes = await read(CHAIN_FILE);
  const contentHash = createHash('sha256').update(chainBytes).digest('hex');
  const chainSteps = chainStepsOf(chainBytes.toString('utf8'), name);
  const golden = goldenOf((await read(GOLDEN_FILE)).toString('utf8'), name, contentHash);

  const { meta, expected, facts } = await loadLandscape(path.join(corpusDir, name));
  const all = facts.models.flatMap((m) => m.facts);
  const processes: PlacementProcess[] = all
    .filter((f) => f.kind === 'process')
    .map((f) => ({ ref: f.ref, label: f.label, name: f.label === '' ? null : f.label, modelKey: f.modelKey }))
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const processRefs = new Set(processes.map((p) => p.ref));
  const processOf = new Map<string, string>();
  for (const f of all) if (f.processId !== null) processOf.set(f.ref, `${f.modelKey}#${f.processId}`);
  const owner = (ref: string): string | null => processOf.get(ref) ?? (processRefs.has(ref) ? ref : null);
  const sets = new Map<string, Set<string>>();
  const join = (a: string, b: string) => sets.set(a, (sets.get(a) ?? new Set()).add(b));
  for (const r of expected.relations) {
    if (r.expect !== 'must_link') continue;
    const a = owner(r.from);
    const b = owner(r.to);
    if (a === null || b === null || a === b) continue;
    join(a, b);
    join(b, a);
  }
  const neighbours = new Map(
    [...sets].map(([k, v]) => [k, [...v].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))] as const),
  );
  return {
    name,
    split: meta.split,
    golden,
    chainSteps,
    processes,
    neighbours,
    validator: runValidator(name, valueChainsDir),
  };
}
