// Tests for the TypeScript part of eval/tools (src/), run by node --test with type stripping.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { CORPUS_DIR, listScoredLandscapes, loadModels } from '../src/corpus.ts';

test('scored landscapes exclude _sample', async () => {
  assert.deepEqual(await listScoredLandscapes(), ['nordwind-handel', 'stadtwerke-auental']);
});

test('loadModels derives model keys from paths below models/', async () => {
  const models = await loadModels(path.join(CORPUS_DIR, '_sample'));
  assert.deepEqual(
    models.map((m) => m.key),
    ['finance/payment-collection', 'finanzen/rechnungsstellung', 'vertrieb/auftragsabwicklung'],
  );
  assert.ok(models.every((m) => m.xml.includes('bpmn:definitions')));
});
