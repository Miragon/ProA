// The _sample landscape is the toolchain's regression test: its committed
// models must equal a fresh generation and the whole landscape must validate.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { CORPUS_DIR } from '../lib/landscape.mjs';
import { formatReport, validateLandscape } from '../lib/validate-landscape.mjs';

test('_sample regenerates byte-identically and validates green', async () => {
  const result = await validateLandscape(path.join(CORPUS_DIR, '_sample'));
  assert.ok(result.ok, formatReport(result));
  assert.equal(result.ls.specs.length, 3);
  const engines = new Set(result.ls.specs.map((s) => s.spec.engine));
  assert.deepEqual([...engines].sort(), ['c7', 'c8']);
  assert.ok(result.ls.specs.some((s) => s.spec.collaboration), 'sample needs a collaboration');
});
