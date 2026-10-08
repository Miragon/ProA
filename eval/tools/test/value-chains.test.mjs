// Runs eval/value-chains/validate-value-chains.mjs (M4 S0): the golden value chains pass with
// @miragon/value-chain-schema-model from npm at the version eval/tools pins, and the built-in
// re-implementation agrees with it on every document.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALUE_CHAINS = path.resolve(TOOLS, '../value-chains');
const VALIDATOR = path.join(VALUE_CHAINS, 'validate-value-chains.mjs');
const SCHEMA_MODEL = '@miragon/value-chain-schema-model';

const pinned = JSON.parse(readFileSync(path.join(TOOLS, 'package.json'), 'utf8')).dependencies[SCHEMA_MODEL];
const landscapes = readdirSync(VALUE_CHAINS).filter((d) => existsSync(path.join(VALUE_CHAINS, d, 'value-chain.vc.json')));

// On failure only the summary lines are shown: the findings of the holdout landscape would quote
// its golden placements (run the validator itself for the details).
function validate(...args) {
  const run = spawnSync(process.execPath, [VALIDATOR, ...args], { encoding: 'utf8' });
  const summary = run.stdout.split('\n').filter((line) => /^(schema:|cross-check:|[\w-]+: (ok|FAIL))/.test(line));
  assert.equal(run.status, 0, `validator exited ${run.status}\n${summary.join('\n')}\n${run.stderr}`);
  return run.stdout;
}

test('the golden value chains exist for both scored landscapes', () => {
  assert.deepEqual(landscapes.sort(), ['nordwind-handel', 'stadtwerke-auental']);
});

test('eval/tools pins the schema-model exactly', () => {
  assert.match(pinned, /^\d+\.\d+\.\d+$/);
});

test('the validator passes with the npm schema-model and the built-in copy agrees', () => {
  const out = validate();
  assert.ok(out.startsWith(`schema: npm package ${SCHEMA_MODEL} ${pinned} (ESM build`), out.split('\n')[0]);
  for (const landscape of landscapes) assert.ok(out.includes(`\n${landscape}: ok\n`), `${landscape} is not ok`);
  assert.ok(
    out.includes(
      `cross-check: the built-in re-implementation agrees with ${SCHEMA_MODEL} ${pinned} on ${landscapes.length} of ${landscapes.length} documents`,
    ),
  );
});

test('the validator passes with the built-in re-implementation alone', () => {
  const out = validate('--builtin');
  assert.ok(out.startsWith('schema: built-in re-implementation'));
  assert.ok(!out.includes('cross-check: the built-in'));
});
