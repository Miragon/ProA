// eval:candidates (CONCEPT §7, M1 item 5): the LLM-free gate over eval/corpus.
//
//   pnpm eval:candidates            (from the repository root)
//   node src/candidates.ts [--out <dir>] [--no-write] [landscape ...]
//
// For every scored landscape: extract the facts (@proa/bpmn-facts), run the
// rule tier, the candidate generation and baseline-proa1 (@proa/relations),
// score them against expected.yaml and write eval/reports/candidates.{md,json}.
// Gates per landscape: rule-tier precision 1.0, no must_not_link accepted,
// ≥ 98 % of must_link pairs among rules ∪ candidates, deterministic findings
// equal expected_findings (dangling-throw/unmatched-catch: all expected found,
// extras explained by a semantic link). Exit codes: 0 pass, 1 a gate failed.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { CORPUS_DIR, listScoredLandscapes } from './corpus.ts';
import { runLandscape } from './landscape.ts';
import { renderMarkdown, type EvalReport } from './report.ts';
import { formatRatio, scoreLandscape } from './score.ts';

/** `eval/reports`. */
export const REPORTS_DIR = fileURLToPath(new URL('../../reports', import.meta.url));

/** Scores the given landscapes (default: every scored landscape of the corpus). */
export async function evaluate(names?: readonly string[], corpusDir: string = CORPUS_DIR): Promise<EvalReport> {
  const landscapes = names && names.length > 0 ? [...names] : await listScoredLandscapes(corpusDir);
  const scores = [];
  for (const name of landscapes) {
    scores.push(scoreLandscape(await runLandscape(path.join(corpusDir, name))));
  }
  return { pass: scores.every((s) => s.pass), landscapes: scores };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      out: { type: 'string', default: REPORTS_DIR },
      'no-write': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const report = await evaluate(positionals);
  for (const s of report.landscapes) {
    console.log(`${s.name} (${s.split}): ${s.pass ? 'pass' : 'FAIL'}`);
    for (const g of s.gates) {
      console.log(`  ${g.pass ? 'ok  ' : 'FAIL'} ${g.title}: ${g.value} (target ${g.target})`);
    }
    console.log(
      `       baseline-proa1: must_link recall ${formatRatio(s.systems.baseline.recall)}, ` +
        `precision ${formatRatio(s.systems.baseline.precision)}, ` +
        `${s.systems.baseline.mustNotLink} must_not_link hits`,
    );
  }
  if (!values['no-write']) {
    await mkdir(values.out, { recursive: true });
    await writeFile(path.join(values.out, 'candidates.md'), renderMarkdown(report));
    await writeFile(path.join(values.out, 'candidates.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report: ${path.relative(process.cwd(), path.join(values.out, 'candidates.md'))}`);
  }
  console.log(`eval:candidates: ${report.pass ? 'pass' : 'FAIL'}`);
  return report.pass ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
