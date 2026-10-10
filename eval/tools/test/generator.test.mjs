import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { toBpmnXml } from '../lib/bpmn.mjs';
import { CORPUS_DIR, loadLandscape } from '../lib/landscape.mjs';
import { layoutModel } from '../lib/layout.mjs';
import { buildModel, SpecError } from '../lib/model.mjs';
import { ModelSpec } from '../lib/schema.mjs';
import { formatReport, validateLandscape } from '../lib/validate-landscape.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STRESS = path.join(here, 'fixtures', 'stress');

test('generation is deterministic', async () => {
  for (const dir of [path.join(CORPUS_DIR, '_sample'), STRESS]) {
    const a = await loadLandscape(dir);
    const b = await loadLandscape(dir);
    for (let i = 0; i < a.specs.length; i++) {
      assert.ok(a.specs[i].xml, `${a.specs[i].rel}: ${a.specs[i].errors.join('; ')}`);
      assert.equal(a.specs[i].xml, b.specs[i].xml, `${a.specs[i].rel} differs between runs`);
    }
  }
});

test('stress fixtures parse, lint and have complete DI', async () => {
  const result = await validateLandscape(STRESS, { inMemory: true });
  assert.ok(result.ok, formatReport(result));
});

async function generate(spec, engineVersion) {
  const parsed = ModelSpec.parse(spec);
  const model = buildModel(parsed, { engineVersion: engineVersion ?? (parsed.engine === 'c7' ? '7.24.0' : '8.9.0') });
  return toBpmnXml(model, layoutModel(model), { specRel: 'test' });
}

function specErrors(spec) {
  try {
    const parsed = ModelSpec.parse(spec);
    buildModel(parsed, { engineVersion: parsed.engine === 'c7' ? '7.24.0' : '8.9.0' });
    return [];
  } catch (e) {
    if (e instanceof SpecError) return e.errors;
    throw e;
  }
}

const minimal = (engine, elements, extra = {}) => ({
  key: 'test/model',
  engine,
  processes: [{ id: 'Process_Test', name: 'Test', elements }],
  ...extra
});

test('engine specifics end up in the XML', async () => {
  const elements = [
    { type: 'startEvent', id: 'Start_A', name: 'A' },
    { type: 'serviceTask', id: 'Task_B', name: 'B' },
    { type: 'callActivity', id: 'Call_C', name: 'C', calledElement: 'Process_X' },
    { type: 'intermediateThrowEvent', id: 'Event_D', name: 'D', message: { name: 'D', correlationKey: '=id' } },
    { type: 'userTask', id: 'Task_E', name: 'E' },
    { type: 'endEvent', id: 'End_F', name: 'F' }
  ];
  const c8 = await generate(minimal('c8', elements));
  assert.match(c8, /modeler:executionPlatform="Camunda Cloud" modeler:executionPlatformVersion="8\.9\.0"/);
  assert.match(c8, /<zeebe:taskDefinition type="b" \/>/);
  assert.match(c8, /<zeebe:calledElement processId="Process_X" propagateAllChildVariables="false" \/>/);
  assert.match(c8, /<zeebe:subscription correlationKey="=id" \/>/);
  assert.match(c8, /<zeebe:userTask \/>/);
  const c7Elements = elements.map((e) => (e.message ? { ...e, message: 'D' } : e));
  const c7 = await generate(minimal('c7', c7Elements));
  assert.match(c7, /modeler:executionPlatform="Camunda Platform" modeler:executionPlatformVersion="7\.24\.0"/);
  assert.match(c7, /camunda:historyTimeToLive="180"/);
  assert.match(c7, /camunda:type="external" camunda:topic="b"/);
  assert.match(c7, /calledElement="Process_X"/);
  assert.match(c7, /messageRef="Message_D" camunda:type="external" camunda:topic="d"/);
});

// start -> merge -> <mid> -> fork (back to merge or end)
const loop = (mid) => [
  { type: 'startEvent', id: 'S', name: 's' },
  { type: 'exclusiveGateway', id: 'G_Merge' },
  mid,
  { type: 'exclusiveGateway', id: 'G_Fork', name: 'again?', next: [{ to: 'G_Merge', name: 'yes', condition: '=again' }, { to: 'E', name: 'no', default: true }] },
  { type: 'endEvent', id: 'E', name: 'e' }
];

test('spec semantics are checked', () => {
  const cases = [
    [minimal('c7', [{ type: 'startEvent', id: 'S', name: 's' }, { type: 'endEvent', id: 'E', name: 'e', timer: { duration: 'PT1H' } }]), /timer end events do not exist/],
    [minimal('c8', [{ type: 'startEvent', id: 'S', name: 's' }, { type: 'intermediateCatchEvent', id: 'C', name: 'c', message: 'M' }, { type: 'endEvent', id: 'E', name: 'e' }]), /needs a correlationKey/],
    [minimal('c7', [{ type: 'startEvent', id: 'S', name: 's' }, { type: 'intermediateCatchEvent', id: 'C', name: 'c', message: { name: 'M', correlationKey: '=x' } }, { type: 'endEvent', id: 'E', name: 'e' }]), /correlationKey is c8-only/],
    [minimal('c7', [{ type: 'startEvent', id: 'S', name: 's', next: 'Nope' }, { type: 'endEvent', id: 'E', name: 'e' }]), /next "Nope" does not exist/],
    [minimal('c7', [{ type: 'startEvent', id: 'S', name: 's' }, { type: 'userTask', id: 'T', name: 't' }]), /no outgoing sequence flow/],
    [minimal('c7', [{ type: 'startEvent', id: 'S', name: 's' }, { type: 'exclusiveGateway', id: 'G', name: 'g', next: ['A', 'B'] }, { type: 'endEvent', id: 'A', name: 'a' }, { type: 'endEvent', id: 'B', name: 'b' }]), /needs 'condition' or 'default: true'/],
    [minimal('c8', [{ type: 'startEvent', id: 'S', name: 's' }, { type: 'callActivity', id: 'C', name: 'c', calledElement: '${x}' }, { type: 'endEvent', id: 'E', name: 'e' }]), /c8 calledElement expressions are FEEL/],
    [minimal('c7', [{ type: 'startEvent', id: 'S', name: 's', lane: 'L' }, { type: 'endEvent', id: 'E', name: 'e' }]), /has no lanes/],
    [minimal('c7', [{ type: 'startEvent', id: 'S', name: 's' }, { type: 'endEvent', id: 'S', name: 'e' }]), /duplicate id "S"/],
    [{ ...minimal('c7', [{ type: 'startEvent', id: 'S', name: 's' }, { type: 'endEvent', id: 'E', name: 'e' }]), processes: [{ id: 'P1', elements: [{ type: 'startEvent', id: 'S1', name: 's' }, { type: 'endEvent', id: 'E1', name: 'e' }] }, { id: 'P2', elements: [{ type: 'startEvent', id: 'S2', name: 's' }, { type: 'endEvent', id: 'E2', name: 'e' }] }] }, /collaboration is required/],
    // both found by deploying to camunda/camunda 8.9.22 (deploy-check.mjs)
    [minimal('c8', [{ type: 'startEvent', id: 'S', name: 's' }, { type: 'callActivity', id: 'C', name: 'c', calledElement: 'Process_Elsewhere', binding: 'deployment' }, { type: 'endEvent', id: 'E', name: 'e' }]), /binding: deployment needs the called process "Process_Elsewhere" in this file/],
    [minimal('c8', loop({ type: 'manualTask', id: 'T', name: 't' })), /G_Fork, G_Merge, T: c8 rejects loops without a wait state/],
    // duplicate subscriptions in one scope, rejected by both engines
    [minimal('c7', [{ type: 'startEvent', id: 'S1', name: 's1', message: 'M' }, { type: 'exclusiveGateway', id: 'G' }, { type: 'serviceTask', id: 'T', name: 't' }, { type: 'endEvent', id: 'E', name: 'e' }, { type: 'startEvent', id: 'S2', name: 's2', message: 'M', next: 'G' }]), /S1, S2: message "M" in the start events of Process_Test more than once/],
    [minimal('c8', [{ type: 'startEvent', id: 'S', name: 's' }, { type: 'userTask', id: 'T', name: 't', boundary: [{ id: 'B1', name: 'b1', signal: 'X', next: 'E1' }, { id: 'B2', name: 'b2', signal: 'X', interrupting: false, next: 'E2' }] }, { type: 'endEvent', id: 'E', name: 'e' }, { type: 'endEvent', id: 'E1', name: 'e1' }, { type: 'endEvent', id: 'E2', name: 'e2' }]), /B1, B2: signal "X" in the boundary events of T more than once/],
    [minimal('c7', [{ type: 'startEvent', id: 'S', name: 's' }, { type: 'eventBasedGateway', id: 'G', next: ['C1', 'C2'] }, { type: 'intermediateCatchEvent', id: 'C1', name: 'c1', message: 'M', next: 'E1' }, { type: 'intermediateCatchEvent', id: 'C2', name: 'c2', message: 'M', next: 'E2' }, { type: 'endEvent', id: 'E1', name: 'e1' }, { type: 'endEvent', id: 'E2', name: 'e2' }]), /C1, C2: message "M" in gateway G more than once/],
    [{ ...minimal('c7', []), collaboration: { participants: [{ id: 'Participant_A', name: 'A', process: 'P_A' }, { id: 'Participant_B', name: 'B', process: 'P_B' }] }, processes: [{ id: 'P_A', elements: [{ type: 'startEvent', id: 'SA', name: 's', message: 'M' }, { type: 'endEvent', id: 'EA', name: 'e' }] }, { id: 'P_B', elements: [{ type: 'startEvent', id: 'SB', name: 's', message: 'M' }, { type: 'endEvent', id: 'EB', name: 'e' }] }] }, /message "M" starts P_A and P_B/]
  ];
  for (const [spec, pattern] of cases) {
    const errors = specErrors(spec);
    assert.ok(errors.some((e) => pattern.test(e)), `expected ${pattern} in:\n${errors.join('\n') || '(no errors)'}`);
  }
});

test('deploy-time rules leave valid models alone', () => {
  const toC7 = (els) => els.map((e) => (e.next ? { ...e, next: e.next.map((f) => ({ ...f, condition: f.condition && '${again}' })) } : e));
  // a wait state in the loop, a gateway-only loop, and the same loop on c7 are fine
  assert.deepEqual(specErrors(minimal('c8', loop({ type: 'serviceTask', id: 'T', name: 't' }))), []);
  assert.deepEqual(specErrors(minimal('c8', loop({ type: 'exclusiveGateway', id: 'T' }))), []);
  assert.deepEqual(specErrors(minimal('c7', toC7(loop({ type: 'manualTask', id: 'T', name: 't' })))), []);
  // deployment binding: dynamic targets and targets in the same file are fine
  const call = (calledElement) => [{ type: 'startEvent', id: 'S', name: 's' }, { type: 'callActivity', id: 'C', name: 'c', calledElement, binding: 'deployment' }, { type: 'endEvent', id: 'E', name: 'e' }];
  assert.deepEqual(specErrors(minimal('c8', call('=target'))), []);
  assert.deepEqual(specErrors(minimal('c7', call('Process_Elsewhere'))), []);
  // the same message in different scopes: process start and event subprocess start
  const evsub = { type: 'eventSubProcess', id: 'ES', name: 'es', elements: [{ type: 'startEvent', id: 'ESS', name: 'x', message: { name: 'M', correlationKey: '=k' } }, { type: 'endEvent', id: 'ESE', name: 'y' }] };
  assert.deepEqual(specErrors(minimal('c8', [{ type: 'startEvent', id: 'S', name: 's', message: 'M' }, { type: 'userTask', id: 'T', name: 't' }, { type: 'endEvent', id: 'E', name: 'e' }, evsub])), []);
});

test('zod rejects unknown keys and bad refs', () => {
  const r = ModelSpec.safeParse(minimal('c7', [{ type: 'startEvent', id: 'S', nmae: 'typo' }]));
  assert.equal(r.success, false);
  assert.ok(r.error.issues.some((i) => /nmae/.test(i.message)));
  assert.equal(ModelSpec.safeParse({ ...minimal('c7', []), key: 'Finanzen/Rechnung' }).success, false);
});
