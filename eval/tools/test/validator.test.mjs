// Negative cases: mutate a temp copy of _sample and expect specific failures.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import YAML from 'yaml';

import { lintModel, parseModel } from '../lib/checks.mjs';
import { CORPUS_DIR } from '../lib/landscape.mjs';
import { validateLandscape } from '../lib/validate-landscape.mjs';

let tmp;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'proa-eval-'));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

let n = 0;
async function mutated(mutate) {
  const dir = path.join(tmp, String(n++), '_sample');
  await cp(path.join(CORPUS_DIR, '_sample'), dir, { recursive: true });
  await mutate(dir);
  return validateLandscape(dir);
}

async function editYaml(file, fn) {
  const data = YAML.parse(await readFile(file, 'utf8'));
  fn(data);
  await writeFile(file, YAML.stringify(data));
}

function assertFails(result, section, pattern) {
  const s = result.sections.find((x) => x.name === section);
  assert.ok(!result.ok, 'validation should fail');
  assert.ok(
    s.errors.some((e) => pattern.test(e)),
    `expected ${pattern} in section ${section}, got:\n${result.sections.flatMap((x) => x.errors).join('\n')}`
  );
}

const exp = (dir) => path.join(dir, 'expected.yaml');

test('unresolvable ref', async () => {
  const r = await mutated((d) => editYaml(exp(d), (e) => (e.relations[0].to = 'finance/payment-collection#Process_Nope')));
  assertFails(r, 'expected', /"Process_Nope" does not exist/);
});

test('wrong endpoint kind for the relation type', async () => {
  const r = await mutated((d) => editYaml(exp(d), (e) => (e.relations[1].type = 'signal')));
  assertFails(r, 'expected', /signal needs signal throw -> signal catch/);
});

test('subprocess events are never endpoints', async () => {
  const r = await mutated((d) => editYaml(exp(d), (e) => (e.relations[2].expect = 'must_link')));
  assertFails(r, 'expected', /never an endpoint/);
});

test('closed world needs every key-tier candidate', async () => {
  const r = await mutated((d) => editYaml(exp(d), (e) => e.relations.splice(0, 2)));
  assertFails(r, 'expected', /key-tier candidate call/);
  assertFails(r, 'expected', /key-tier candidate message/);
});

test('deterministic findings are recomputed', async () => {
  const r = await mutated((d) =>
    editYaml(exp(d), (e) => {
      e.expected_findings = e.expected_findings.filter((f) => f.kind !== 'dynamic-call');
      e.expected_findings.push({ kind: 'unresolved-call', refs: ['vertrieb/auftragsabwicklung#Call_ZahlungAbwickeln'], rationale: 'wrong' });
    })
  );
  assertFails(r, 'expected', /missing finding dynamic-call/);
  assertFails(r, 'expected', /finding unresolved-call vertrieb\/auftragsabwicklung#Call_ZahlungAbwickeln does not hold/);
});

test('closed world needs dangling/unmatched findings', async () => {
  const r = await mutated((d) => editYaml(exp(d), (e) => (e.expected_findings = e.expected_findings.filter((f) => f.kind !== 'unmatched-catch'))));
  assertFails(r, 'expected', /Event_PaymentReceived .* no unmatched-catch finding/);
});

test('data store group labels must exist', async () => {
  const r = await mutated((d) => editYaml(exp(d), (e) => e.data_store_groups[0].labels.push('Kundenkartei')));
  assertFails(r, 'expected', /no data store is labelled "Kundenkartei"/);
});

test('every trap is tagged or declared not applicable', async () => {
  const r = await mutated((d) => editYaml(path.join(d, 'landscape.yaml'), (l) => delete l.traps_not_applicable.trigger));
  assertFails(r, 'expected', /trap trigger is neither tagged/);
});

test('hand-edited model is out of sync', async () => {
  const r = await mutated(async (d) => {
    const f = path.join(d, 'models/finanzen/rechnungsstellung.bpmn');
    await writeFile(f, (await readFile(f, 'utf8')).replace('name="Rechnung erstellen"', 'name="Rechnung anlegen"'));
  });
  assertFails(r, 'sync', /differs from its spec/);
});

test('missing DI is reported', async () => {
  const r = await mutated(async (d) => {
    const f = path.join(d, 'models/finanzen/rechnungsstellung.bpmn');
    const xml = await readFile(f, 'utf8');
    await writeFile(f, xml.replace(/\s*<bpmndi:BPMNShape id="Task_RechnungErstellen_di"[\s\S]*?<\/bpmndi:BPMNShape>/, ''));
  });
  assertFails(r, 'di', /Task_RechnungErstellen: no DI/);
});

test('spec errors are reported with their path', async () => {
  const r = await mutated((d) =>
    editYaml(path.join(d, 'spec/finanzen/rechnungsstellung.yaml'), (s) => (s.processes[0].elements[1].colour = 'blue'))
  );
  assertFails(r, 'specs', /spec\/finanzen\/rechnungsstellung\.yaml: processes\.0\.elements\.1: Unrecognized key: "colour"/);
});

test('lint catches what the generator would never emit', async () => {
  const xml = await readFile(path.join(CORPUS_DIR, '_sample/models/finanzen/rechnungsstellung.bpmn'), 'utf8');
  const parsed = await parseModel(xml.replace(' name="Rechnung erstellen"', ''), 'c8');
  assert.deepEqual(parsed.errors, []);
  const lint = await lintModel(parsed.definitions, { engine: 'c8', version: '8.9.0' });
  assert.ok(lint.errors.some((e) => /label-required .*Task_RechnungErstellen/.test(e)), lint.errors.join('\n'));
  const off = await lintModel(parsed.definitions, { engine: 'c8', version: '8.9.0', disable: [{ rule: 'label-required', reason: 'test' }, { rule: 'no-such-rule', reason: 'test' }] });
  assert.ok(!off.errors.some((e) => /label-required \[/.test(e)));
  assert.ok(off.errors.some((e) => /unknown rule "no-such-rule"/.test(e)));
});

test('parse rejects extension elements of the other engine', async () => {
  const xml = await readFile(path.join(CORPUS_DIR, '_sample/models/finanzen/rechnungsstellung.bpmn'), 'utf8');
  const parsed = await parseModel(xml.replace('modeler:executionPlatform="Camunda Cloud"', 'modeler:executionPlatform="Camunda Platform"'), 'c8');
  assert.ok(parsed.errors.some((e) => /does not match spec engine c8/.test(e)));
  assert.ok(parsed.errors.some((e) => /unknown element <zeebe:/.test(e)), parsed.errors.join('\n'));
});
