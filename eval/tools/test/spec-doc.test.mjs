// Keeps SPEC.md honest: its complete example must generate, parse, lint and
// pass the DI check, and its c7 variant (as described in SPEC.md) too.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { toBpmnXml } from '../lib/bpmn.mjs';
import { checkDi, lintModel, parseModel } from '../lib/checks.mjs';
import { layoutModel } from '../lib/layout.mjs';
import { buildModel } from '../lib/model.mjs';
import { ModelSpec } from '../lib/schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

async function example() {
  const md = await readFile(path.join(here, '..', 'SPEC.md'), 'utf8');
  const m = /<!-- spec-example:start -->\s*```yaml\n([\s\S]*?)```\s*<!-- spec-example:end -->/.exec(md);
  assert.ok(m, 'SPEC.md must contain the marked complete example');
  return YAML.parse(m[1]);
}

async function check(raw, engineVersion) {
  const spec = ModelSpec.parse(raw);
  const model = buildModel(spec, { engineVersion });
  const xml = await toBpmnXml(model, layoutModel(model), { specRel: 'SPEC.md' });
  const parsed = await parseModel(xml, spec.engine);
  assert.deepEqual(parsed.errors, []);
  const lint = await lintModel(parsed.definitions, { engine: spec.engine, version: engineVersion });
  assert.deepEqual(lint.errors, []);
  assert.deepEqual(checkDi(parsed.definitions), []);
}

test('SPEC.md complete example (c8) is valid', async () => {
  await check(await example(), '8.9.0');
});

test('SPEC.md example as c7 is valid', async () => {
  const text = JSON.stringify(await example())
    .replace('"engine":"c8"', '"engine":"c7"')
    .replace('"=berechtigt"', '"${berechtigt}"');
  const raw = JSON.parse(text, (k, v) => (v && typeof v === 'object' && 'correlationKey' in v ? v.name : v));
  await check(raw, '7.24.0');
});
