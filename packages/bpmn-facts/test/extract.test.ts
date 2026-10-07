// extractFacts per BPMN construct, for Camunda 7 and Camunda 8 (CONCEPT §2).
import { describe, expect, it } from 'vitest';

import {
  FACTS_VERSION,
  MAX_WARNINGS,
  factFingerprint,
  factsHash,
  normalizeKey,
} from '../src/index.ts';

import {
  MODEL_KEY,
  definitions,
  extract,
  factOf,
  factsOf,
  kinds,
  model,
  process,
} from './support/bpmn.ts';

const msg = (id: string, name: string, extension = ''): string =>
  `<bpmn:message id="${id}" name="${name}">${extension}</bpmn:message>`;
const zeebeSubscription = (key: string): string =>
  `<bpmn:extensionElements><zeebe:subscription correlationKey="${key}" /></bpmn:extensionElements>`;

describe('result envelope', () => {
  it('carries model key, facts version and engine', async () => {
    const r = await extract(model('c7', '<bpmn:task id="Task_A" name="A" />'));
    expect(r).toMatchObject({
      modelKey: MODEL_KEY,
      factsVersion: FACTS_VERSION,
      engine: 'c7',
      warnings: [],
    });
    expect(FACTS_VERSION).toBe('1');
  });

  it('builds refs from the model key', async () => {
    const r = await extract(model('c8', '<bpmn:task id="Task_A" name="A" />'), {
      modelKey: 'billing/dunning-v2',
    });
    expect(factOf(r, 'task', 'Task_A')).toMatchObject({
      modelKey: 'billing/dunning-v2',
      ref: 'billing/dunning-v2#Task_A',
      processId: 'Process_1',
    });
  });
});

describe('process', () => {
  it('is a fact keyed by its id, labelled by its name (C7)', async () => {
    const xml = definitions(
      'c7',
      `<bpmn:process id="Process_Rechnung" name="Rechnungsstellung" isExecutable="true">
         <bpmn:documentation>Erstellt Rechnungen.</bpmn:documentation>
       </bpmn:process>`,
    );
    const r = await extract(xml);
    expect(factOf(r, 'process', 'Process_Rechnung')).toEqual({
      modelKey: MODEL_KEY,
      ref: `${MODEL_KEY}#Process_Rechnung`,
      kind: 'process',
      elementId: 'Process_Rechnung',
      processId: 'Process_Rechnung',
      scope: 'process',
      eventDef: null,
      label: 'Rechnungsstellung',
      keyRaw: 'Process_Rechnung',
      keyNorm: 'process rechnung',
      fingerprint: factFingerprint({
        kind: 'process',
        eventDef: null,
        keyRaw: 'Process_Rechnung',
        label: 'Rechnungsstellung',
        scope: 'process',
        refName: null,
      }),
      attrs: {
        elementType: 'bpmn:Process',
        isExecutable: true,
        documentation: 'Erstellt Rechnungen.',
      },
    });
    expect(r.processes).toEqual([
      {
        ref: `${MODEL_KEY}#Process_Rechnung`,
        processId: 'Process_Rechnung',
        name: 'Rechnungsstellung',
        participantName: null,
        isExecutable: true,
      },
    ]);
  });

  it('takes the participant name, and the label from it when the process has no name (C8 collaboration)', async () => {
    const xml = definitions(
      'c8',
      `<bpmn:collaboration id="Collaboration_1">
         <bpmn:participant id="Participant_Kunde" name="Kunde" />
         <bpmn:participant id="Participant_Shop" name="Online-Shop" processRef="Process_Shop" />
         <bpmn:participant id="Participant_Lager" name="Lager" processRef="Process_Lager" />
       </bpmn:collaboration>
       ${process('<bpmn:task id="Task_Pack" name="Packen" />', { id: 'Process_Lager', name: 'Lagerprozess', executable: false })}
       ${process('<bpmn:task id="Task_Sell" name="Verkaufen" />', { id: 'Process_Shop', name: '' })}`,
    );
    const r = await extract(xml);
    expect(
      r.processes.map((p) => [p.processId, p.name, p.participantName, p.isExecutable]),
    ).toEqual([
      ['Process_Lager', 'Lagerprozess', 'Lager', false],
      ['Process_Shop', null, 'Online-Shop', true],
    ]);
    expect(factOf(r, 'process', 'Process_Shop')).toMatchObject({
      label: 'Online-Shop',
      attrs: {
        participantId: 'Participant_Shop',
        participantName: 'Online-Shop',
        isExecutable: true,
      },
    });
    expect(factOf(r, 'process', 'Process_Lager').label).toBe('Lagerprozess');
    expect(factOf(r, 'task', 'Task_Pack').processId).toBe('Process_Lager');
    // black-box participants are no facts
    expect(factsOf(r, 'Participant_Kunde')).toEqual([]);
  });

  it('treats a missing isExecutable as false', async () => {
    const r = await extract(definitions('c7', '<bpmn:process id="Process_A" />'));
    expect(r.processes[0]).toMatchObject({
      processId: 'Process_A',
      name: null,
      isExecutable: false,
    });
    expect(factOf(r, 'process', 'Process_A')).toMatchObject({
      label: '',
      attrs: { isExecutable: false },
    });
  });
});

describe('call', () => {
  it('C7: static calledElement, binding, version and tenant kept as attrs', async () => {
    const r = await extract(
      model(
        'c7',
        `<bpmn:callActivity id="Call_A" name="A aufrufen" calledElement="Process_A"
            camunda:calledElementBinding="version" camunda:calledElementVersion="3" camunda:calledElementTenantId="tenant-1" />
         <bpmn:callActivity id="Call_B" name="B aufrufen" calledElement="Process_B"
            camunda:calledElementBinding="versionTag" camunda:calledElementVersionTag="v2" />
         <bpmn:callActivity id="Call_C" name="C aufrufen" calledElement="Process_C" />`,
      ),
    );
    expect(factOf(r, 'call', 'Call_A')).toMatchObject({
      eventDef: null,
      label: 'A aufrufen',
      keyRaw: 'Process_A',
      keyNorm: 'process a',
      attrs: {
        elementType: 'bpmn:CallActivity',
        dynamic: false,
        binding: 'version',
        version: '3',
        tenantId: 'tenant-1',
      },
    });
    expect(factOf(r, 'call', 'Call_B').attrs).toEqual({
      elementType: 'bpmn:CallActivity',
      dynamic: false,
      binding: 'versionTag',
      versionTag: 'v2',
    });
    // the engine default (latest) is not written into the facts
    expect(factOf(r, 'call', 'Call_C').attrs).toEqual({
      elementType: 'bpmn:CallActivity',
      dynamic: false,
    });
  });

  it.each([
    ['${target}', true],
    ['#{target}', true],
    ['Process_${region}', true],
    ['=target', false], // FEEL syntax means nothing to Camunda 7: a constant id
  ])('C7: calledElement %j is dynamic: %s', async (calledElement, dynamic) => {
    const r = await extract(
      model('c7', `<bpmn:callActivity id="Call_X" name="X" calledElement="${calledElement}" />`),
    );
    expect(factOf(r, 'call', 'Call_X')).toMatchObject({
      keyRaw: calledElement,
      attrs: { dynamic },
    });
  });

  it('C8: zeebe:calledElement processId, bindingType and versionTag kept as attrs', async () => {
    const r = await extract(
      model(
        'c8',
        `<bpmn:callActivity id="Call_A" name="A aufrufen">
           <bpmn:extensionElements>
             <zeebe:calledElement processId="Process_A" propagateAllChildVariables="false" bindingType="versionTag" versionTag="v1" />
           </bpmn:extensionElements>
         </bpmn:callActivity>
         <bpmn:callActivity id="Call_B" name="B aufrufen">
           <bpmn:extensionElements><zeebe:calledElement processId="Process_B" /></bpmn:extensionElements>
         </bpmn:callActivity>`,
      ),
    );
    expect(factOf(r, 'call', 'Call_A')).toMatchObject({
      keyRaw: 'Process_A',
      attrs: { dynamic: false, binding: 'versionTag', versionTag: 'v1' },
    });
    expect(factOf(r, 'call', 'Call_B').attrs).toEqual({
      elementType: 'bpmn:CallActivity',
      dynamic: false,
    });
  });

  it.each([
    ['=target', true],
    [' = "Process_" + region', true],
    ['${target}', false], // JUEL syntax means nothing to Zeebe
  ])('C8: processId %j is dynamic: %s', async (processId, dynamic) => {
    const r = await extract(
      model(
        'c8',
        `<bpmn:callActivity id="Call_X" name="X">
           <bpmn:extensionElements><zeebe:calledElement processId='${processId}' /></bpmn:extensionElements>
         </bpmn:callActivity>`,
      ),
    );
    expect(factOf(r, 'call', 'Call_X')).toMatchObject({
      keyRaw: processId.trim(),
      attrs: { dynamic },
    });
  });

  it('warns about a call without target and keeps an empty key', async () => {
    const r = await extract(
      model(
        'c7',
        `<bpmn:callActivity id="Call_None" name="Nichts" />
         <bpmn:callActivity id="Call_Case" name="Fall" camunda:caseRef="case-1" />`,
      ),
    );
    expect(factOf(r, 'call', 'Call_None')).toMatchObject({
      keyRaw: '',
      keyNorm: '',
      attrs: { dynamic: false },
    });
    expect(r.warnings).toEqual([
      {
        code: 'call-without-target',
        message: 'call activity without calledElement',
        elementId: 'Call_None',
      },
      {
        code: 'call-without-target',
        message: 'call activity calls a CMMN case (camunda:caseRef "case-1"), not a process',
        elementId: 'Call_Case',
      },
    ]);
  });

  it('reads the calledElement attribute of a file without engine', async () => {
    const r = await extract(
      model('none', '<bpmn:callActivity id="Call_A" name="A" calledElement="Process_A" />'),
    );
    expect(r.engine).toBeNull();
    expect(factOf(r, 'call', 'Call_A')).toMatchObject({
      keyRaw: 'Process_A',
      attrs: { dynamic: false },
    });
  });
});

describe('message throw and catch', () => {
  const c7Body = `
    <bpmn:startEvent id="Start_Auftrag" name="Auftrag eingegangen">
      <bpmn:messageEventDefinition id="Start_Auftrag_ed" messageRef="Message_Auftrag" />
    </bpmn:startEvent>
    <bpmn:userTask id="Task_Pruefen" name="Prüfen" />
    <bpmn:boundaryEvent id="Boundary_Storno" name="Storno" cancelActivity="false" attachedToRef="Task_Pruefen">
      <bpmn:messageEventDefinition messageRef="Message_Storno" />
    </bpmn:boundaryEvent>
    <bpmn:boundaryEvent id="Boundary_Abbruch" name="Abbruch" attachedToRef="Task_Pruefen">
      <bpmn:messageEventDefinition messageRef="Message_Abbruch" />
    </bpmn:boundaryEvent>
    <bpmn:intermediateCatchEvent id="Event_Zahlung" name="Zahlung erhalten">
      <bpmn:messageEventDefinition messageRef="Message_Zahlung" />
    </bpmn:intermediateCatchEvent>
    <bpmn:intermediateThrowEvent id="Event_Versand" name="Ware versandbereit">
      <bpmn:messageEventDefinition messageRef="Message_Versand" camunda:type="external" camunda:topic="versand" />
    </bpmn:intermediateThrowEvent>
    <bpmn:sendTask id="Task_Senden" name="Absage senden" messageRef="Message_Absage" camunda:type="external" camunda:topic="absage" />
    <bpmn:receiveTask id="Task_Empfangen" name="Antwort empfangen" messageRef="Message_Antwort" />
    <bpmn:endEvent id="End_Fertig" name="Auftrag erledigt">
      <bpmn:messageEventDefinition messageRef="Message_Erledigt" camunda:type="external" camunda:topic="erledigt" />
    </bpmn:endEvent>
    <bpmn:subProcess id="EventSub_Aenderung" name="Änderung" triggeredByEvent="true">
      <bpmn:startEvent id="Start_Aenderung" name="Änderung eingegangen" isInterrupting="false">
        <bpmn:messageEventDefinition messageRef="Message_Aenderung" />
      </bpmn:startEvent>
      <bpmn:endEvent id="End_Aenderung" name="Änderung gebucht" />
    </bpmn:subProcess>`;
  const c7Messages = [
    msg('Message_Auftrag', 'AuftragEingegangen'),
    msg('Message_Storno', 'Storno'),
    msg('Message_Abbruch', 'Abbruch'),
    msg('Message_Zahlung', 'ZahlungErhalten'),
    msg('Message_Versand', 'WareVersandbereit'),
    msg('Message_Absage', 'Absage'),
    msg('Message_Antwort', 'Antwort'),
    msg('Message_Erledigt', 'AuftragErledigt'),
    msg('Message_Aenderung', 'ÄnderungEingegangen'),
  ].join('\n');

  it('C7: every message construct becomes msg_throw or msg_catch keyed by the message name', async () => {
    const r = await extract(model('c7', c7Body, c7Messages));
    const summary = r.facts
      .filter((f) => f.kind === 'msg_throw' || f.kind === 'msg_catch')
      .map((f) => [f.kind, f.elementId, f.eventDef, f.scope, f.keyRaw, f.attrs.elementType]);
    expect(summary).toEqual([
      ['msg_throw', 'End_Fertig', 'message', 'process', 'AuftragErledigt', 'bpmn:EndEvent'],
      [
        'msg_throw',
        'Event_Versand',
        'message',
        'process',
        'WareVersandbereit',
        'bpmn:IntermediateThrowEvent',
      ],
      ['msg_throw', 'Task_Senden', null, 'process', 'Absage', 'bpmn:SendTask'],
      ['msg_catch', 'Boundary_Abbruch', 'message', 'process', 'Abbruch', 'bpmn:BoundaryEvent'],
      ['msg_catch', 'Boundary_Storno', 'message', 'process', 'Storno', 'bpmn:BoundaryEvent'],
      [
        'msg_catch',
        'Event_Zahlung',
        'message',
        'process',
        'ZahlungErhalten',
        'bpmn:IntermediateCatchEvent',
      ],
      [
        'msg_catch',
        'Start_Aenderung',
        'message',
        'event_subprocess',
        'ÄnderungEingegangen',
        'bpmn:StartEvent',
      ],
      ['msg_catch', 'Start_Auftrag', 'message', 'process', 'AuftragEingegangen', 'bpmn:StartEvent'],
      ['msg_catch', 'Task_Empfangen', null, 'process', 'Antwort', 'bpmn:ReceiveTask'],
    ]);
    expect(factOf(r, 'msg_catch', 'Boundary_Storno').attrs).toEqual({
      elementType: 'bpmn:BoundaryEvent',
      attachedTo: 'Task_Pruefen',
      interrupting: false,
      messageName: 'Storno',
      dynamic: false,
    });
    expect(factOf(r, 'msg_catch', 'Boundary_Abbruch').attrs).toMatchObject({ interrupting: true });
    expect(factOf(r, 'msg_catch', 'Start_Aenderung')).toMatchObject({
      label: 'Änderung eingegangen',
      keyNorm: 'aenderungeingegangen',
      attrs: {
        interrupting: false,
        messageName: 'ÄnderungEingegangen',
        subprocessId: 'EventSub_Aenderung',
      },
    });
    // a message start of the process carries no interrupting flag
    expect(factOf(r, 'msg_catch', 'Start_Auftrag').attrs).not.toHaveProperty('interrupting');
    // the end event of the event subprocess is a fact, but in event_subprocess scope
    expect(factOf(r, 'evt_end', 'End_Aenderung').scope).toBe('event_subprocess');
    // the receive/send tasks are message facts, not task facts
    expect(factsOf(r, 'Task_Senden').map((f) => f.kind)).toEqual(['msg_throw']);
    expect(factsOf(r, 'Task_Empfangen').map((f) => f.kind)).toEqual(['msg_catch']);
    expect(r.warnings).toEqual([]);
  });

  it('C8: correlation keys of the referenced message are kept', async () => {
    const r = await extract(
      model(
        'c8',
        `<bpmn:startEvent id="Start_Auftrag" name="Auftrag eingegangen">
           <bpmn:messageEventDefinition messageRef="Message_Auftrag" />
         </bpmn:startEvent>
         <bpmn:intermediateThrowEvent id="Event_Versand" name="Ware versandbereit">
           <bpmn:extensionElements><zeebe:taskDefinition type="versand" /></bpmn:extensionElements>
           <bpmn:messageEventDefinition messageRef="Message_Versand" />
         </bpmn:intermediateThrowEvent>
         <bpmn:receiveTask id="Task_Antwort" name="Antwort abwarten" messageRef="Message_Antwort" />
         <bpmn:sendTask id="Task_Senden" name="Senden" messageRef="Message_Versand">
           <bpmn:extensionElements><zeebe:taskDefinition type="senden" /></bpmn:extensionElements>
         </bpmn:sendTask>`,
        [
          msg('Message_Auftrag', 'AuftragEingegangen'),
          msg('Message_Versand', 'WareVersandbereit', zeebeSubscription('=auftragsnummer')),
          msg('Message_Antwort', 'Antwort', zeebeSubscription('=anfrageId')),
        ].join('\n'),
      ),
    );
    expect(r.engine).toBe('c8');
    expect(factOf(r, 'msg_catch', 'Start_Auftrag').attrs).toEqual({
      elementType: 'bpmn:StartEvent',
      messageName: 'AuftragEingegangen',
      dynamic: false,
    });
    expect(factOf(r, 'msg_throw', 'Event_Versand').attrs).toMatchObject({
      messageName: 'WareVersandbereit',
      correlationKey: '=auftragsnummer',
    });
    expect(factOf(r, 'msg_throw', 'Task_Senden').attrs).toMatchObject({
      correlationKey: '=auftragsnummer',
    });
    expect(factOf(r, 'msg_catch', 'Task_Antwort')).toMatchObject({
      eventDef: null,
      keyRaw: 'Antwort',
      attrs: { correlationKey: '=anfrageId' },
    });
  });

  it('falls back to the label without a named message ref, and says so by omitting messageName', async () => {
    const r = await extract(
      model(
        'c7',
        `<bpmn:sendTask id="Task_Erinnern" name="Erinnerung senden" />
         <bpmn:intermediateCatchEvent id="Event_Antwort" name="Antwort erhalten">
           <bpmn:messageEventDefinition messageRef="Message_Unnamed" />
         </bpmn:intermediateCatchEvent>
         <bpmn:intermediateCatchEvent id="Event_Ohne" name="Ohne Nachricht">
           <bpmn:messageEventDefinition />
         </bpmn:intermediateCatchEvent>`,
        '<bpmn:message id="Message_Unnamed" />',
      ),
    );
    for (const [kind, id, key] of [
      ['msg_throw', 'Task_Erinnern', 'Erinnerung senden'],
      ['msg_catch', 'Event_Antwort', 'Antwort erhalten'],
      ['msg_catch', 'Event_Ohne', 'Ohne Nachricht'],
    ] as const) {
      const f = factOf(r, kind, id);
      expect(f.keyRaw).toBe(key);
      expect(f.attrs).not.toHaveProperty('messageName');
      expect(f.attrs.dynamic).toBe(false);
      expect(f.fingerprint).toBe(
        factFingerprint({
          kind,
          eventDef: f.eventDef,
          keyRaw: key,
          label: key,
          scope: 'process',
          refName: null,
        }),
      );
    }
  });

  it('reports an unresolved message ref and falls back to the label', async () => {
    const r = await extract(
      model(
        'c7',
        `<bpmn:intermediateThrowEvent id="Event_X" name="Etwas passiert">
           <bpmn:messageEventDefinition messageRef="Message_Missing" />
         </bpmn:intermediateThrowEvent>`,
      ),
    );
    expect(factOf(r, 'msg_throw', 'Event_X').keyRaw).toBe('Etwas passiert');
    expect(r.warnings).toEqual([
      expect.objectContaining({
        code: 'parse-warning',
        message: expect.stringContaining('Message_Missing') as unknown,
      }),
    ]);
  });

  it.each([
    ['c7', '${kanal}Eingang', true],
    ['c7', '=kanal', false],
    ['c8', '=kanal', true],
    ['c8', '${kanal}', false],
    ['none', '=kanal', true],
    ['none', '#{kanal}', true],
  ] as const)('%s: message name %j is dynamic: %s', async (engine, name, dynamic) => {
    const r = await extract(
      model(
        engine,
        `<bpmn:intermediateCatchEvent id="Event_X" name="X"><bpmn:messageEventDefinition messageRef="Message_X" /></bpmn:intermediateCatchEvent>`,
        msg('Message_X', name),
      ),
    );
    expect(factOf(r, 'msg_catch', 'Event_X')).toMatchObject({
      keyRaw: name,
      attrs: { messageName: name, dynamic },
    });
  });
});

describe('signal throw and catch', () => {
  const body = `
    <bpmn:startEvent id="Start_Signal" name="Rückruf gestartet">
      <bpmn:signalEventDefinition signalRef="Signal_Rueckruf" />
    </bpmn:startEvent>
    <bpmn:intermediateThrowEvent id="Event_Broadcast" name="Rückruf melden">
      <bpmn:signalEventDefinition signalRef="Signal_Rueckruf" />
    </bpmn:intermediateThrowEvent>
    <bpmn:intermediateCatchEvent id="Event_Warten" name="Freigabe abwarten">
      <bpmn:signalEventDefinition signalRef="Signal_Freigabe" />
    </bpmn:intermediateCatchEvent>
    <bpmn:task id="Task_A" name="A" />
    <bpmn:boundaryEvent id="Boundary_Stopp" name="Stopp" attachedToRef="Task_A">
      <bpmn:signalEventDefinition signalRef="Signal_Stopp" />
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="End_Signal" name="Fertig gemeldet">
      <bpmn:signalEventDefinition signalRef="Signal_Fertig" />
    </bpmn:endEvent>
    <bpmn:endEvent id="End_Unbenannt" name="Ohne Signalnamen">
      <bpmn:signalEventDefinition />
    </bpmn:endEvent>
    <bpmn:subProcess id="EventSub_Stopp" triggeredByEvent="true">
      <bpmn:startEvent id="Start_StoppSub" name="Stopp empfangen" isInterrupting="false">
        <bpmn:signalEventDefinition signalRef="Signal_Stopp" />
      </bpmn:startEvent>
    </bpmn:subProcess>`;
  const signals = [
    '<bpmn:signal id="Signal_Rueckruf" name="Rückruf" />',
    '<bpmn:signal id="Signal_Freigabe" name="Freigabe" />',
    '<bpmn:signal id="Signal_Stopp" name="Stopp" />',
    '<bpmn:signal id="Signal_Fertig" name="Fertig" />',
  ].join('\n');

  it.each(['c7', 'c8'] as const)(
    '%s: signal events become sig_throw / sig_catch keyed by the signal name',
    async (engine) => {
      const r = await extract(model(engine, body, signals));
      expect(
        r.facts
          .filter((f) => f.kind.startsWith('sig_'))
          .map((f) => [
            f.kind,
            f.elementId,
            f.eventDef,
            f.scope,
            f.keyRaw,
            f.keyNorm,
            f.attrs.signalName ?? null,
          ]),
      ).toEqual([
        ['sig_throw', 'End_Signal', 'signal', 'process', 'Fertig', 'fertig', 'Fertig'],
        [
          'sig_throw',
          'End_Unbenannt',
          'signal',
          'process',
          'Ohne Signalnamen',
          'ohne signalnamen',
          null,
        ],
        ['sig_throw', 'Event_Broadcast', 'signal', 'process', 'Rückruf', 'rueckruf', 'Rückruf'],
        ['sig_catch', 'Boundary_Stopp', 'signal', 'process', 'Stopp', 'stopp', 'Stopp'],
        ['sig_catch', 'Event_Warten', 'signal', 'process', 'Freigabe', 'freigabe', 'Freigabe'],
        ['sig_catch', 'Start_Signal', 'signal', 'process', 'Rückruf', 'rueckruf', 'Rückruf'],
        ['sig_catch', 'Start_StoppSub', 'signal', 'event_subprocess', 'Stopp', 'stopp', 'Stopp'],
      ]);
      expect(factOf(r, 'sig_catch', 'Boundary_Stopp').attrs).toMatchObject({
        attachedTo: 'Task_A',
        interrupting: true,
      });
      expect(factOf(r, 'sig_catch', 'Start_StoppSub').attrs).toMatchObject({ interrupting: false });
      // no message facts, no evt facts for typed events
      expect(r.facts.filter((f) => f.kind.startsWith('msg_') || f.kind.startsWith('evt_'))).toEqual(
        [],
      );
    },
  );
});

describe('plain starts and ends, and events outside v1', () => {
  it.each(['c7', 'c8'] as const)(
    '%s: none/timer/conditional starts and none/terminate ends only',
    async (engine) => {
      const condition = engine === 'c7' ? '${bereit}' : '=bereit';
      const r = await extract(
        model(
          engine,
          `<bpmn:startEvent id="Start_None" name="Antrag gestellt" />
         <bpmn:startEvent id="Start_Timer" name="Monatsanfang">
           <bpmn:timerEventDefinition><bpmn:timeCycle>R/P1M</bpmn:timeCycle></bpmn:timerEventDefinition>
         </bpmn:startEvent>
         <bpmn:startEvent id="Start_Cond" name="Bestand niedrig">
           <bpmn:conditionalEventDefinition><bpmn:condition xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${condition}</bpmn:condition></bpmn:conditionalEventDefinition>
         </bpmn:startEvent>
         <bpmn:endEvent id="End_None" name="Antrag erledigt" />
         <bpmn:endEvent id="End_Terminate" name="Abgebrochen"><bpmn:terminateEventDefinition /></bpmn:endEvent>
         <bpmn:endEvent id="End_Error" name="Fehler"><bpmn:errorEventDefinition errorRef="Error_1" /></bpmn:endEvent>
         <bpmn:endEvent id="End_Escalation" name="Eskaliert"><bpmn:escalationEventDefinition escalationRef="Escalation_1" /></bpmn:endEvent>
         <bpmn:endEvent id="End_Compensate" name="Kompensiert"><bpmn:compensateEventDefinition /></bpmn:endEvent>
         <bpmn:intermediateCatchEvent id="Event_Timer" name="3 Tage vergangen">
           <bpmn:timerEventDefinition><bpmn:timeDuration>P3D</bpmn:timeDuration></bpmn:timerEventDefinition>
         </bpmn:intermediateCatchEvent>
         <bpmn:intermediateCatchEvent id="Event_Cond" name="Freigegeben">
           <bpmn:conditionalEventDefinition><bpmn:condition>${condition}</bpmn:condition></bpmn:conditionalEventDefinition>
         </bpmn:intermediateCatchEvent>
         <bpmn:intermediateThrowEvent id="Event_None" name="Meilenstein erreicht" />
         <bpmn:intermediateThrowEvent id="Event_Esc" name="Eskalieren"><bpmn:escalationEventDefinition escalationRef="Escalation_1" /></bpmn:intermediateThrowEvent>
         <bpmn:intermediateThrowEvent id="Event_LinkThrow" name="Weiter"><bpmn:linkEventDefinition name="weiter" /></bpmn:intermediateThrowEvent>
         <bpmn:intermediateCatchEvent id="Event_LinkCatch" name="Weiter"><bpmn:linkEventDefinition name="weiter" /></bpmn:intermediateCatchEvent>
         <bpmn:task id="Task_A" name="A" />
         <bpmn:boundaryEvent id="Boundary_Timer" name="Frist" attachedToRef="Task_A">
           <bpmn:timerEventDefinition><bpmn:timeDuration>P1D</bpmn:timeDuration></bpmn:timerEventDefinition>
         </bpmn:boundaryEvent>
         <bpmn:boundaryEvent id="Boundary_Error" name="Fehler" attachedToRef="Task_A"><bpmn:errorEventDefinition /></bpmn:boundaryEvent>
         <bpmn:subProcess id="EventSub_Error" triggeredByEvent="true">
           <bpmn:startEvent id="Start_Error" name="Fehler aufgetreten"><bpmn:errorEventDefinition /></bpmn:startEvent>
           <bpmn:endEvent id="End_ErrorHandled" name="Fehler behandelt" />
         </bpmn:subProcess>
         <bpmn:subProcess id="EventSub_Timer" triggeredByEvent="true">
           <bpmn:startEvent id="Start_SubTimer" name="Frist abgelaufen" isInterrupting="false">
             <bpmn:timerEventDefinition><bpmn:timeDuration>P2D</bpmn:timeDuration></bpmn:timerEventDefinition>
           </bpmn:startEvent>
         </bpmn:subProcess>`,
          '<bpmn:error id="Error_1" errorCode="E1" name="E1" /><bpmn:escalation id="Escalation_1" escalationCode="ESC" name="ESC" />',
        ),
      );
      const events = r.facts.filter((f) => f.attrs.elementType?.endsWith('Event'));
      expect(events.map((f) => [f.kind, f.elementId, f.eventDef, f.scope])).toEqual([
        ['evt_start', 'Start_Cond', 'conditional', 'process'],
        ['evt_start', 'Start_None', 'none', 'process'],
        ['evt_start', 'Start_SubTimer', 'timer', 'event_subprocess'],
        ['evt_start', 'Start_Timer', 'timer', 'process'],
        ['evt_end', 'End_ErrorHandled', 'none', 'event_subprocess'],
        ['evt_end', 'End_None', 'none', 'process'],
        ['evt_end', 'End_Terminate', 'terminate', 'process'],
      ]);
      expect(factOf(r, 'evt_start', 'Start_None')).toMatchObject({
        keyRaw: 'Antrag gestellt',
        keyNorm: 'antrag gestellt',
      });
      expect(factOf(r, 'evt_start', 'Start_SubTimer').attrs).toMatchObject({
        interrupting: false,
        subprocessId: 'EventSub_Timer',
      });
      expect(r.warnings).toEqual([]);
    },
  );

  it('multiple event definitions: message and signal parts become facts, with a warning', async () => {
    const r = await extract(
      model(
        'c7',
        `<bpmn:startEvent id="Start_Multi" name="Auftrag oder Signal">
           <bpmn:messageEventDefinition messageRef="Message_A" />
           <bpmn:signalEventDefinition signalRef="Signal_A" />
         </bpmn:startEvent>`,
        `${msg('Message_A', 'AuftragEingegangen')}<bpmn:signal id="Signal_A" name="Los" />`,
      ),
    );
    expect(factsOf(r, 'Start_Multi').map((f) => [f.kind, f.eventDef, f.keyRaw])).toEqual([
      ['msg_catch', 'multiple', 'AuftragEingegangen'],
      ['sig_catch', 'multiple', 'Los'],
    ]);
    expect(r.warnings).toMatchObject([
      { code: 'multiple-event-definitions', elementId: 'Start_Multi' },
    ]);
  });
});

describe('scope', () => {
  const body = `
    <bpmn:startEvent id="Start_Top" name="Start" />
    <bpmn:subProcess id="Sub_Pack" name="Verpacken">
      <bpmn:startEvent id="Start_Inner" name="Ware versandbereit" />
      <bpmn:intermediateCatchEvent id="Event_InnerCatch" name="Etikett da">
        <bpmn:messageEventDefinition messageRef="Message_Etikett" />
      </bpmn:intermediateCatchEvent>
      <bpmn:subProcess id="EventSub_InSub" triggeredByEvent="true">
        <bpmn:startEvent id="Start_InSubEvent" name="Abbruch"><bpmn:messageEventDefinition messageRef="Message_Abbruch" /></bpmn:startEvent>
      </bpmn:subProcess>
      <bpmn:endEvent id="End_Inner" name="Ware versandbereit" />
    </bpmn:subProcess>
    <bpmn:subProcess id="EventSub_Outer" triggeredByEvent="true">
      <bpmn:startEvent id="Start_Outer" name="Storno"><bpmn:messageEventDefinition messageRef="Message_Storno" /></bpmn:startEvent>
      <bpmn:subProcess id="Sub_InEventSub" name="Storno buchen">
        <bpmn:startEvent id="Start_Deep" name="Buchung" />
        <bpmn:task id="Task_Deep" name="Buchen" />
      </bpmn:subProcess>
    </bpmn:subProcess>
    <bpmn:transaction id="Tx_Pay" name="Zahlung">
      <bpmn:task id="Task_InTx" name="Abbuchen" />
    </bpmn:transaction>
    <bpmn:adHocSubProcess id="AdHoc_Check" name="Prüfungen">
      <bpmn:task id="Task_InAdHoc" name="Prüfen" />
    </bpmn:adHocSubProcess>`;

  it.each(['c7', 'c8'] as const)(
    '%s: the innermost container decides the scope',
    async (engine) => {
      const r = await extract(
        model(
          engine,
          body,
          [
            msg('Message_Etikett', 'Etikett'),
            msg('Message_Abbruch', 'Abbruch'),
            msg('Message_Storno', 'Storno'),
          ].join(''),
        ),
      );
      const scopes = Object.fromEntries(
        r.facts
          .filter((f) => f.kind !== 'process')
          .map((f) => [f.elementId, `${f.scope} ${String(f.attrs.subprocessId ?? '-')}`]),
      );
      expect(scopes).toEqual({
        Start_Top: 'process -',
        Start_Inner: 'subprocess Sub_Pack',
        Event_InnerCatch: 'subprocess Sub_Pack',
        Start_InSubEvent: 'event_subprocess EventSub_InSub',
        End_Inner: 'subprocess Sub_Pack',
        Start_Outer: 'event_subprocess EventSub_Outer',
        Start_Deep: 'subprocess Sub_InEventSub',
        Task_Deep: 'subprocess Sub_InEventSub',
        Task_InTx: 'subprocess Tx_Pay',
        Task_InAdHoc: 'subprocess AdHoc_Check',
      });
      // subprocesses themselves are no facts; every fact keeps the owning process
      expect(factsOf(r, 'Sub_Pack')).toEqual([]);
      expect(new Set(r.facts.map((f) => f.processId))).toEqual(new Set(['Process_1']));
      // same label, different scope -> different fingerprint
      expect(factOf(r, 'evt_end', 'End_Inner').fingerprint).not.toBe(
        factFingerprint({ ...factOf(r, 'evt_end', 'End_Inner'), scope: 'process', refName: null }),
      );
    },
  );

  it('survives deeply nested subprocesses without recursion limits', async () => {
    const depth = 3000;
    const open = Array.from({ length: depth }, (_, i) => `<bpmn:subProcess id="Sub_${i}">`).join(
      '',
    );
    const xml = model(
      'c7',
      `${open}<bpmn:endEvent id="End_Deep" name="Tief" />${'</bpmn:subProcess>'.repeat(depth)}`,
    );
    const r = await extract(xml);
    expect(factOf(r, 'evt_end', 'End_Deep')).toMatchObject({
      scope: 'subprocess',
      attrs: { subprocessId: `Sub_${depth - 1}` },
    });
  });
});

describe('data_store', () => {
  it.each(['c7', 'c8'] as const)(
    '%s: who reads and writes comes from the data associations',
    async (engine) => {
      const r = await extract(
        model(
          engine,
          `<bpmn:userTask id="Task_Lesen" name="Kunde prüfen">
           <bpmn:property id="Property_Lesen" name="__targetRef_placeholder" />
           <bpmn:dataInputAssociation id="DIA_1"><bpmn:sourceRef>DataStore_Kunden</bpmn:sourceRef><bpmn:targetRef>Property_Lesen</bpmn:targetRef></bpmn:dataInputAssociation>
         </bpmn:userTask>
         <bpmn:subProcess id="Sub_Pflege" name="Pflege">
           <bpmn:serviceTask id="Task_Schreiben" name="Kunde speichern">
             <bpmn:dataOutputAssociation id="DOA_1"><bpmn:targetRef>DataStore_Kunden</bpmn:targetRef></bpmn:dataOutputAssociation>
             <bpmn:dataOutputAssociation id="DOA_2"><bpmn:targetRef>DataStore_Archiv</bpmn:targetRef></bpmn:dataOutputAssociation>
           </bpmn:serviceTask>
           <bpmn:dataStoreReference id="DataStore_Lokal" name="Zwischenablage" />
         </bpmn:subProcess>
         <bpmn:intermediateThrowEvent id="Event_Log" name="Protokolliert">
           <bpmn:dataInputAssociation id="DIA_2"><bpmn:sourceRef>DataStore_Kunden</bpmn:sourceRef></bpmn:dataInputAssociation>
         </bpmn:intermediateThrowEvent>
         <bpmn:dataStoreReference id="DataStore_Kunden" name="Kunden-Stammdaten" />
         <bpmn:dataStoreReference id="DataStore_Archiv" dataStoreRef="Store_Archiv" />`,
          '<bpmn:dataStore id="Store_Archiv" name="Archiv" />',
        ),
      );
      expect(factOf(r, 'data_store', 'DataStore_Kunden')).toMatchObject({
        label: 'Kunden-Stammdaten',
        keyRaw: 'Kunden-Stammdaten',
        keyNorm: 'kunden stammdaten',
        scope: 'process',
        eventDef: null,
        attrs: { readBy: ['Event_Log', 'Task_Lesen'], writtenBy: ['Task_Schreiben'] },
      });
      expect(factOf(r, 'data_store', 'DataStore_Archiv')).toMatchObject({
        label: 'Archiv',
        attrs: { readBy: [], writtenBy: ['Task_Schreiben'] },
      });
      expect(factOf(r, 'data_store', 'DataStore_Lokal')).toMatchObject({
        scope: 'subprocess',
        attrs: { readBy: [], writtenBy: [], subprocessId: 'Sub_Pflege' },
      });
    },
  );
});

describe('message_flow', () => {
  const xml = (engine: 'c7' | 'c8'): string =>
    definitions(
      engine,
      `<bpmn:collaboration id="Collaboration_1">
         <bpmn:participant id="Participant_Kunde" name="Kunde" />
         <bpmn:participant id="Participant_Shop" name="Shop" processRef="Process_Shop" />
         <bpmn:participant id="Participant_Lager" name="Lager" processRef="Process_Lager" />
         <bpmn:messageFlow id="Flow_Bestellung" name="Bestellung" sourceRef="Participant_Kunde" targetRef="Start_Bestellung" />
         <bpmn:messageFlow id="Flow_Auftrag" sourceRef="Task_Weitergeben" targetRef="Start_Lager" messageRef="Message_Auftrag" />
         <bpmn:messageFlow id="Flow_Kaputt" sourceRef="Task_Weitergeben" targetRef="Nirgendwo" />
       </bpmn:collaboration>
       ${process(
         `<bpmn:startEvent id="Start_Bestellung" name="Bestellung eingegangen"><bpmn:messageEventDefinition messageRef="Message_Bestellung" /></bpmn:startEvent>
          <bpmn:sendTask id="Task_Weitergeben" name="An Lager geben" messageRef="Message_Auftrag" />`,
         { id: 'Process_Shop', name: 'Shop' },
       )}
       ${process(
         '<bpmn:startEvent id="Start_Lager" name="Auftrag erhalten"><bpmn:messageEventDefinition messageRef="Message_Auftrag" /></bpmn:startEvent>',
         { id: 'Process_Lager', name: 'Lager' },
       )}
       ${msg('Message_Bestellung', 'Bestellung')}${msg('Message_Auftrag', 'Lagerauftrag')}`,
    );

  it.each(['c7', 'c8'] as const)(
    '%s: flows inside one file are facts and MessageFlowInfo, never relations',
    async (engine) => {
      const r = await extract(xml(engine));
      expect(r.messageFlows).toEqual([
        {
          ref: `${MODEL_KEY}#Flow_Auftrag`,
          elementId: 'Flow_Auftrag',
          name: null,
          from: `${MODEL_KEY}#Task_Weitergeben`,
          to: `${MODEL_KEY}#Start_Lager`,
          messageName: 'Lagerauftrag',
        },
        {
          ref: `${MODEL_KEY}#Flow_Bestellung`,
          elementId: 'Flow_Bestellung',
          name: 'Bestellung',
          from: `${MODEL_KEY}#Participant_Kunde`,
          to: `${MODEL_KEY}#Start_Bestellung`,
          messageName: null,
        },
      ]);
      expect(factOf(r, 'message_flow', 'Flow_Auftrag')).toMatchObject({
        processId: null,
        scope: 'process',
        eventDef: null,
        label: '',
        keyRaw: 'Lagerauftrag',
        attrs: {
          elementType: 'bpmn:MessageFlow',
          sourceRef: `${MODEL_KEY}#Task_Weitergeben`,
          targetRef: `${MODEL_KEY}#Start_Lager`,
          messageName: 'Lagerauftrag',
        },
      });
      expect(factOf(r, 'message_flow', 'Flow_Bestellung')).toMatchObject({
        label: 'Bestellung',
        keyRaw: 'Bestellung',
      });
      expect(r.warnings.map((w) => w.code)).toEqual(['parse-warning', 'message-flow-unresolved']);
      expect(factsOf(r, 'Flow_Kaputt')).toEqual([]);
    },
  );
});

describe('lane', () => {
  it.each(['c7', 'c8'] as const)(
    '%s: lanes and child lanes with their flow nodes',
    async (engine) => {
      const r = await extract(
        model(
          engine,
          `<bpmn:laneSet id="LaneSet_1">
           <bpmn:lane id="Lane_Vertrieb" name="Vertrieb">
             <bpmn:flowNodeRef>Task_B</bpmn:flowNodeRef>
             <bpmn:flowNodeRef>Task_A</bpmn:flowNodeRef>
             <bpmn:childLaneSet id="LaneSet_Child">
               <bpmn:lane id="Lane_Innendienst" name="Innendienst"><bpmn:flowNodeRef>Task_A</bpmn:flowNodeRef></bpmn:lane>
             </bpmn:childLaneSet>
           </bpmn:lane>
           <bpmn:lane id="Lane_Leer" name="Leer" />
         </bpmn:laneSet>
         <bpmn:task id="Task_A" name="A" />
         <bpmn:task id="Task_B" name="B" />`,
        ),
      );
      expect(
        r.facts
          .filter((f) => f.kind === 'lane')
          .map((f) => [f.elementId, f.label, f.keyNorm, f.attrs.flowNodeRefs]),
      ).toEqual([
        ['Lane_Innendienst', 'Innendienst', 'innendienst', ['Task_A']],
        ['Lane_Leer', 'Leer', 'leer', []],
        ['Lane_Vertrieb', 'Vertrieb', 'vertrieb', ['Task_A', 'Task_B']],
      ]);
    },
  );
});

describe('task', () => {
  it.each(['c7', 'c8'] as const)(
    '%s: every plain task type is a task fact; gateways and subprocesses are none',
    async (engine) => {
      const r = await extract(
        model(
          engine,
          `<bpmn:task id="Task_Plain" name="Ablegen" />
         <bpmn:userTask id="Task_User" name="Antrag prüfen" />
         <bpmn:serviceTask id="Task_Service" name="Bonität abfragen" />
         <bpmn:scriptTask id="Task_Script" name="Summe bilden" />
         <bpmn:manualTask id="Task_Manual" name="Ware verpacken" />
         <bpmn:businessRuleTask id="Task_Rule" name="Rabatt ermitteln" />
         <bpmn:exclusiveGateway id="Gateway_Ok" name="Ok?" />
         <bpmn:parallelGateway id="Gateway_Split" />
         <bpmn:subProcess id="Sub_Empty" name="Leer" />`,
        ),
      );
      expect(
        r.facts
          .filter((f) => f.kind !== 'process')
          .map((f) => [f.kind, f.elementId, f.attrs.elementType, f.keyNorm]),
      ).toEqual([
        ['task', 'Task_Manual', 'bpmn:ManualTask', 'ware verpacken'],
        ['task', 'Task_Plain', 'bpmn:Task', 'ablegen'],
        ['task', 'Task_Rule', 'bpmn:BusinessRuleTask', 'rabatt ermitteln'],
        ['task', 'Task_Script', 'bpmn:ScriptTask', 'summe bilden'],
        ['task', 'Task_Service', 'bpmn:ServiceTask', 'bonitaet abfragen'],
        ['task', 'Task_User', 'bpmn:UserTask', 'antrag pruefen'],
      ]);
    },
  );
});

describe('labels and documentation', () => {
  it('strips control and bidi characters and collapses whitespace', async () => {
    const r = await extract(
      model(
        'c7',
        `<bpmn:task id="Task_A" name="  Rechnung&#10;versenden&#9; &#x202E;jetzt&#x202C;&#x7;  " />
         <bpmn:task id="Task_B">
           <bpmn:documentation>Zeile 1&#13;&#10;Zeile 2&#x2066;&#x2069;


Absatz&#x1B;[31m</bpmn:documentation>
         </bpmn:task>`,
      ),
    );
    expect(factOf(r, 'task', 'Task_A')).toMatchObject({
      label: 'Rechnung versenden jetzt',
      keyNorm: 'rechnung versenden jetzt',
    });
    expect(factOf(r, 'task', 'Task_B')).toMatchObject({
      label: '',
      attrs: { documentation: 'Zeile 1\nZeile 2\n\nAbsatz[31m' },
    });
  });

  it('cuts labels at 200 and documentation at 2,000 characters, with warnings', async () => {
    const long = `${'a'.repeat(199)}😀tail`;
    const r = await extract(
      model(
        'c7',
        `<bpmn:task id="Task_A" name="${long}"><bpmn:documentation>${'d'.repeat(2500)}</bpmn:documentation></bpmn:task>`,
      ),
    );
    const f = factOf(r, 'task', 'Task_A');
    expect(f.label).toBe('a'.repeat(199)); // the surrogate pair is not split
    expect(f.attrs.documentation).toHaveLength(2000);
    expect(r.warnings.map((w) => [w.code, w.elementId])).toEqual([
      ['label-truncated', 'Task_A'],
      ['documentation-truncated', 'Task_A'],
    ]);
  });
});

describe('fingerprint', () => {
  const variant = (name: string, id = 'Event_A', message = 'WareVersandbereit'): string =>
    model(
      'c8',
      `<bpmn:intermediateThrowEvent id="${id}" name="${name}">
         <bpmn:documentation>Doku ${name}</bpmn:documentation>
         <bpmn:messageEventDefinition messageRef="Message_A" />
       </bpmn:intermediateThrowEvent>`,
      msg('Message_A', message),
    );
  const fp = async (xml: string): Promise<string> => {
    const r = await extract(xml);
    const f = r.facts.find((x) => x.kind === 'msg_throw');
    if (!f) throw new Error('no msg_throw');
    return f.fingerprint;
  };

  it('is sha256(kind|event_def|ref_name_norm|label_norm|scope)[:12]', async () => {
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256')
      .update('msg_throw|message|wareversandbereit|ware versandbereit|process')
      .digest('hex')
      .slice(0, 12);
    expect(await fp(variant('Ware versandbereit'))).toBe(expected);
  });

  it('ignores the element id, documentation and spelling variants; changes with label or message name', async () => {
    const base = await fp(variant('Ware versandbereit'));
    expect(await fp(variant('Ware versandbereit', 'Event_Renamed'))).toBe(base);
    expect(await fp(variant('Ware  Versandbereit!'))).toBe(base);
    expect(await fp(variant('Ware versandfertig'))).not.toBe(base);
    expect(await fp(variant('Ware versandbereit', 'Event_A', 'WareBereit'))).not.toBe(base);
  });

  it('factFingerprint defaults the ref name to keyRaw for calls only', () => {
    const call = {
      kind: 'call',
      eventDef: null,
      keyRaw: 'Process_A',
      label: 'A',
      scope: 'process',
    } as const;
    expect(factFingerprint(call)).toBe(factFingerprint({ ...call, refName: 'Process_A' }));
    expect(factFingerprint(call)).not.toBe(factFingerprint({ ...call, refName: null }));
    const task = { ...call, kind: 'task', keyRaw: 'A' } as const;
    expect(factFingerprint(task)).toBe(factFingerprint({ ...task, refName: null }));
    expect(factFingerprint(task)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('factsHash', () => {
  const diagram = (x: number): string =>
    `<bpmndi:BPMNDiagram id="BPMNDiagram_1"><bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
       <bpmndi:BPMNShape id="Task_A_di" bpmnElement="Task_A"><dc:Bounds x="${x}" y="100" width="100" height="80" /></bpmndi:BPMNShape>
       <bpmndi:BPMNShape id="Start_A_di" bpmnElement="Start_A"><dc:Bounds x="${x + 200}" y="122" width="36" height="36" /></bpmndi:BPMNShape>
     </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>`;
  const doc = (order: 'ab' | 'ba', x: number, label = 'Prüfen', docText = 'Doku'): string => {
    const a = `<bpmn:task id="Task_A" name="${label}"><bpmn:documentation>${docText}</bpmn:documentation></bpmn:task>`;
    const b = '<bpmn:startEvent id="Start_A" name="Los" />';
    return model(
      'c7',
      order === 'ab' ? `${a}\n${b}` : `  ${b}\n\n  <!-- moved -->\n${a}`,
      diagram(x),
    );
  };
  const hashOf = async (xml: string): Promise<string> => factsHash((await extract(xml)).facts);

  it('ignores layout, element order, formatting and the order of the facts array', async () => {
    const base = await hashOf(doc('ab', 100));
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashOf(doc('ba', 480))).toBe(base);
    const facts = (await extract(doc('ab', 100))).facts;
    expect(factsHash([...facts].reverse())).toBe(base);
  });

  it('changes with any fact content, documentation included', async () => {
    const base = await hashOf(doc('ab', 100));
    expect(await hashOf(doc('ab', 100, 'Prüfen und freigeben'))).not.toBe(base);
    expect(await hashOf(doc('ab', 100, 'Prüfen', 'Andere Doku'))).not.toBe(base);
    expect(factsHash([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('engine detection', () => {
  it.each([
    ['Camunda Platform', '', 'c7'],
    ['Camunda Cloud', '', 'c8'],
    [null, 'xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"', 'c8'],
    [null, 'xmlns:camunda="http://camunda.org/schema/1.0/bpmn"', 'c7'],
    [
      null,
      'xmlns:camunda="http://camunda.org/schema/1.0/bpmn" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"',
      null,
    ],
    [null, '', null],
    ['Something Else', 'xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"', 'c8'],
  ])('platform %j, namespaces %j -> %s', async (platform, namespaces, engine) => {
    const platformAttr = platform === null ? '' : `m:executionPlatform="${platform}"`;
    const xml = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:m="http://camunda.org/schema/modeler/1.0" ${namespaces} ${platformAttr} id="D"><process id="P" /></definitions>`;
    const r = await extract(xml);
    expect(r.engine).toBe(engine);
    expect(r.processes.map((p) => p.processId)).toEqual(['P']);
  });

  it('reads a C8 call in a file that declares both namespaces but no platform', async () => {
    const xml = `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="D">
      <bpmn:process id="P"><bpmn:callActivity id="Call_A" name="A"><bpmn:extensionElements><zeebe:calledElement processId="Process_A" /></bpmn:extensionElements></bpmn:callActivity></bpmn:process>
    </bpmn:definitions>`;
    const r = await extract(xml);
    expect(factOf(r, 'call', 'Call_A').keyRaw).toBe('Process_A');
  });
});

describe('determinism and robustness', () => {
  const body = `
    <bpmn:endEvent id="End_B" name="B" />
    <bpmn:task id="Task_Z" name="Z" />
    <bpmn:startEvent id="Start_A" name="A" />
    <bpmn:callActivity id="Call_C" name="C" calledElement="Process_C" />
    <bpmn:task id="Task_A" name="A" />`;

  it('orders facts by kind (enum order), then element id', async () => {
    const r = await extract(model('c7', body));
    expect(kinds(r)).toEqual([
      ['process', 'Process_1'],
      ['call', 'Call_C'],
      ['evt_start', 'Start_A'],
      ['evt_end', 'End_B'],
      ['task', 'Task_A'],
      ['task', 'Task_Z'],
    ]);
  });

  it('gives the same result for strings, UTF-8 bytes, with or without BOM, and on repeat', async () => {
    const xml = model('c7', body.replace('name="Z"', 'name="Zähler prüfen"'));
    const a = await extract(xml);
    const b = await extract(new TextEncoder().encode(xml));
    const c = await extract(Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(xml)]));
    const d = await extract(`\uFEFF${xml}`);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(d).toEqual(a);
    expect(await extract(xml)).toEqual(a);
    expect(factOf(a, 'task', 'Task_Z').keyNorm).toBe(normalizeKey('Zähler prüfen'));
  });

  it('skips elements without a valid id, with warnings', async () => {
    const r = await extract(
      model(
        'c7',
        `<bpmn:task name="Ohne Id" />
         <bpmn:task id="1-not-an-ncname" name="Kaputt" />
         <bpmn:task id="Task_${'x'.repeat(256)}" name="Zu lang" />
         <bpmn:task id="Task_Ok" name="Ok" />`,
      ),
    );
    expect(kinds(r)).toEqual([
      ['process', 'Process_1'],
      ['task', 'Task_Ok'],
    ]);
    // bpmn-moddle drops ids that are no NCName; ids over 255 characters are ours to skip
    expect(r.warnings.map((w) => w.code)).toEqual(['parse-warning', 'missing-id', 'invalid-id']);
    expect(r.warnings[0]?.message).toContain('illegal ID <1-not-an-ncname>');
  });

  it('drops duplicate ids (bpmn-moddle reports them) and keeps facts unique', async () => {
    const r = await extract(
      model('c7', '<bpmn:task id="Task_A" name="Erste" /><bpmn:task id="Task_A" name="Zweite" />'),
    );
    expect(r.facts.filter((f) => f.elementId === 'Task_A')).toHaveLength(1);
    expect(r.warnings.map((w) => w.code)).toContain('parse-warning');
  });

  it(`reports at most ${MAX_WARNINGS} warnings`, async () => {
    const tasks = Array.from({ length: MAX_WARNINGS + 20 }, () => '<bpmn:task name="x" />').join(
      '',
    );
    const r = await extract(model('c7', tasks));
    expect(r.warnings).toHaveLength(MAX_WARNINGS + 1);
    expect(r.warnings.at(-1)).toEqual({
      code: 'too-many-warnings',
      message: '20 more warnings omitted',
    });
  });

  it('keeps going on unknown content and reports it', async () => {
    const r = await extract(
      model(
        'c7',
        '<bpmn:task id="Task_A" name="A"><bpmn:bogus /></bpmn:task><bpmn:task id="Task_B" name="B" />',
      ),
    );
    expect(factOf(r, 'task', 'Task_B').label).toBe('B');
    expect(r.warnings[0]).toMatchObject({ code: 'parse-warning' });
  });
});
