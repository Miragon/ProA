// eval:placements (M4-VALUE-CHAIN.md §6, S4): the LLM-free placement eval.
//
//   pnpm eval:placements            (from the repository root)
//   node src/placements.ts [--out <dir>] [--no-write] [landscape ...]
//
// For every scored landscape (default: every corpus landscape not starting
// with `_`): run eval/value-chains/validate-value-chains.mjs, load the golden
// chain and placements (eval/value-chains/<landscape>/) and the process facts
// (eval/corpus/<landscape>/), score the rule tier's key proposals and
// baseline-prefix/1 (with and without votes), and write
// eval/reports/placements.{md,json}. Gates per landscape: the validator exits
// 0, the golden placements name exactly the process facts, every rule
// proposal is a must or a may. The baselines are a floor, not a gate. The
// console and, for the holdout, the report show numbers only.
// Exit codes: 0 pass; 1 a gate failed or the data cannot be read; 2 a usage
// error, or the validator could not run (exit 2).
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { REPORTS_DIR } from './candidates.ts';
import { CORPUS_DIR, listScoredLandscapes } from './corpus.ts';
import { PlacementDataError, VALIDATOR_FILE, loadPlacementRun, type PlacementDirs } from './placements-load.ts';
import { renderPlacementsMarkdown, type PlacementsReport } from './placements-report.ts';
import { redactHoldout, scorePlacementRun, type PlacementScore } from './placements-score.ts';
import { formatRatio } from './score.ts';

export const USAGE = 'usage: pnpm eval:placements [--out <dir>] [--no-write] [landscape ...]\n';

/** A wrong call: exit code 2, with the usage text. */
export class PlacementUsageError extends Error {
  override readonly name = 'PlacementUsageError';
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Scores the given landscapes (default: every scored landscape of the
 * corpus); holdout scores come back redacted (numbers only).
 *
 * @throws {PlacementUsageError} for a landscape the corpus does not have
 * @throws {PlacementDataError} for a scored landscape without readable golden data
 */
export async function evaluatePlacements(names?: readonly string[], dirs: PlacementDirs = {}): Promise<PlacementsReport> {
  const corpusDir = dirs.corpusDir ?? CORPUS_DIR;
  const landscapes = names && names.length > 0 ? [...names] : await listScoredLandscapes(corpusDir);
  for (const name of landscapes) {
    if (name.startsWith('_') || name.startsWith('.') || !(await isDirectory(path.join(corpusDir, name)))) {
      throw new PlacementUsageError(`${name} is no scored landscape of ${corpusDir}`);
    }
  }
  const scores: PlacementScore[] = [];
  for (const name of landscapes) scores.push(redactHoldout(scorePlacementRun(await loadPlacementRun(name, dirs))));
  return { pass: scores.every((s) => s.pass), landscapes: scores };
}

/** The console lines of one landscape: gates and numbers, never items. */
export function consoleLines(s: PlacementScore): string[] {
  const lines = [`${s.name} (${s.split}): ${s.pass ? 'pass' : 'FAIL'}`];
  for (const g of s.gates) lines.push(`  ${g.pass ? 'ok  ' : 'FAIL'} ${g.title}: ${g.value} (target ${g.target})`);
  const b = s.systems.baseline;
  const nv = s.systems.baselineNoVotes;
  lines.push(
    `       baseline-prefix/1: recall@1 ${formatRatio(b.leaf.at1?.recall ?? null)}, recall@3 ` +
      `${formatRatio(b.leaf.at3?.recall ?? null)}, precision@1 ${formatRatio(b.leaf.at1?.precision ?? null)}, ` +
      `area recall@1 ${formatRatio(b.area.at1?.recall ?? null)}; without votes: recall@1 ` +
      `${formatRatio(nv.leaf.at1?.recall ?? null)}, recall@3 ${formatRatio(nv.leaf.at3?.recall ?? null)}`,
  );
  if (s.validatorExit !== 0) {
    lines.push(
      `       run node eval/value-chains/${VALIDATOR_FILE} ${s.name} for details` +
        (s.split === 'holdout' ? ' (holdout: the owner does, eval/README.md)' : ''),
    );
  }
  return lines;
}

export interface PlacementsIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Base of relative paths: pnpm's INIT_CWD (the repository root for `pnpm eval:placements`). */
  cwd: string;
}

export const processIo: PlacementsIo = {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  cwd: process.env['INIT_CWD'] ?? process.cwd(),
};

function parseOptions(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        out: { type: 'string' },
        'no-write': { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
  } catch (err) {
    throw new PlacementUsageError(err instanceof Error ? err.message : String(err));
  }
}

async function placementsCommand(argv: readonly string[], io: PlacementsIo, dirs: PlacementDirs): Promise<number> {
  const { values, positionals } = parseOptions(argv);
  const report = await evaluatePlacements(positionals, dirs);
  for (const s of report.landscapes) io.stdout(`${consoleLines(s).join('\n')}\n`);
  if (!values['no-write']) {
    const out = path.resolve(io.cwd, values.out ?? REPORTS_DIR);
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'placements.md'), renderPlacementsMarkdown(report));
    await writeFile(path.join(out, 'placements.json'), `${JSON.stringify(report, null, 2)}\n`);
    io.stdout(`report: ${path.relative(io.cwd, path.join(out, 'placements.md'))}\n`);
  }
  const environment = report.landscapes.some((s) => s.validatorExit === 2);
  io.stdout(`eval:placements: ${environment ? 'validator could not run' : report.pass ? 'pass' : 'FAIL'}\n`);
  if (environment) return 2;
  return report.pass ? 0 : 1;
}

/**
 * Runs eval:placements; returns the exit code (0 pass; 1 a failed gate or a
 * data error; 2 a usage error or a validator that could not run) and never
 * throws.
 */
export async function runPlacements(
  argv: readonly string[],
  io: PlacementsIo = processIo,
  dirs: PlacementDirs = {},
): Promise<number> {
  try {
    return await placementsCommand(argv, io, dirs);
  } catch (err) {
    if (err instanceof PlacementUsageError) {
      io.stderr(`eval:placements: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    // Own errors never quote the golden files; any other message might quote the holdout's data.
    io.stderr(
      err instanceof PlacementDataError
        ? `eval:placements: ${err.message}\n`
        : `eval:placements: ${err instanceof Error ? err.name : typeof err} (message withheld: one landscape ` +
            'is the holdout; pnpm eval:candidates <landscape> loads the same corpus and shows it)\n',
    );
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPlacements(process.argv.slice(2));
}
