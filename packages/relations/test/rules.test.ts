import { DerivedRelation, Finding } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import {
  FILE_STEM_CONFIDENCE,
  PROCESS_NAME_CONFIDENCE,
  RULES_VERSION,
  runRules,
} from '../src/index.ts';
import {
  call,
  end,
  model,
  msgCatch,
  msgThrow,
  project,
  ref,
  shuffled,
  sigCatch,
  sigThrow,
  start,
} from './support/facts.ts';

const brief = (r: DerivedRelation) =>
  `${r.status} ${r.tier} ${r.type} ${r.from} -> ${r.to} ${r.confidence}`;
const findingsOf = (fs: Finding[]) => fs.map((f) => `${f.kind} ${f.refs.join(' ')}`);

describe('runRules: calls', () => {
  const billing = model('billing/invoice', {
    processes: [{ id: 'Process_Invoice', name: 'Rechnung' }],
    facts: [
      call('Call_Dunning', 'Process_Dunning', {
        attrs: { binding: 'versionTag', versionTag: 'v2' },
      }),
      call('Call_Output', '${channel}'),
      call('Call_Collection', 'Process_Collection'),
      call('Call_Self', 'Process_Invoice'),
      call('Call_Empty', ''),
    ],
  });
  const dunning = model('billing/dunning', {
    processes: [{ id: 'Process_Dunning', name: 'Mahnwesen' }],
  });

  it('names its procedure', () => {
    expect(RULES_VERSION).toBe('proa-rules/1.0.0');
  });

  it('accepts a constant calledElement matching exactly one other process, keeping binding attributes', () => {
    const { relations } = runRules(project(billing, dunning));
    expect(relations).toEqual([
      {
        type: 'call',
        from: ref('billing/invoice', 'Call_Dunning'),
        to: ref('billing/dunning', 'Process_Dunning'),
        status: 'accepted',
        tier: 'rule',
        confidence: 1,
        attrs: { binding: 'versionTag', versionTag: 'v2' },
      },
    ]);
    for (const r of relations) expect(() => DerivedRelation.parse(r)).not.toThrow();
  });

  it('reports expressions, unknown targets and missing targets; a recursive call gives nothing', () => {
    const { findings } = runRules(project(billing, dunning));
    expect(findingsOf(findings)).toEqual([
      'dynamic-call billing/invoice#Call_Output',
      'unresolved-call billing/invoice#Call_Collection',
      'unresolved-call billing/invoice#Call_Empty',
    ]);
    for (const f of findings) expect(() => Finding.parse(f)).not.toThrow();
  });

  it('proposes every duplicate of an ambiguous id and reports the duplicate once', () => {
    const current = model('purchasing/approval', { processes: [{ id: 'Process_Approval' }] });
    const archived = model('purchasing/archive/approval-2019', {
      processes: [{ id: 'Process_Approval' }],
    });
    const caller = model('purchasing/requisition', {
      processes: [{ id: 'Process_Requisition' }],
      facts: [call('Call_Approval', 'Process_Approval')],
    });
    const result = runRules(project(caller, current, archived));
    expect(result.relations.map(brief)).toEqual([
      'proposed key call purchasing/requisition#Call_Approval -> purchasing/approval#Process_Approval 0.5',
      'proposed key call purchasing/requisition#Call_Approval -> purchasing/archive/approval-2019#Process_Approval 0.5',
    ]);
    expect(findingsOf(result.findings)).toEqual([
      'duplicate-process-id purchasing/approval#Process_Approval purchasing/archive/approval-2019#Process_Approval',
    ]);
  });

  it('proposes, never accepts, a match by file stem or process name', () => {
    const caller = model('ops/main', {
      processes: [{ id: 'Process_Main' }],
      facts: [call('Call_Stem', 'invoice-check'), call('Call_Name', 'Mahnwesen')],
    });
    const target = model('billing/invoice-check', { processes: [{ id: 'Process_InvoiceCheck' }] });
    const result = runRules(project(caller, target, dunning));
    expect(result.relations.map(brief)).toEqual([
      `proposed lexical call ops/main#Call_Name -> billing/dunning#Process_Dunning ${PROCESS_NAME_CONFIDENCE}`,
      `proposed key call ops/main#Call_Stem -> billing/invoice-check#Process_InvoiceCheck ${FILE_STEM_CONFIDENCE}`,
    ]);
    expect(findingsOf(result.findings)).toEqual([
      'unresolved-call ops/main#Call_Name',
      'unresolved-call ops/main#Call_Stem',
    ]);
  });
});

describe('runRules: messages and signals', () => {
  const shop = model('sales/shop', {
    processes: [{ id: 'Process_Shop', participantId: 'Participant_Shop' }],
    facts: [
      msgThrow('Event_Shipped', 'WareVersandbereit'),
      msgThrow('Task_Notify', null, { element: 'bpmn:SendTask', label: 'Kunde informieren' }),
      msgThrow('Task_Dynamic', '=messageName', {
        element: 'bpmn:SendTask',
        attrs: { dynamic: true },
      }),
      msgCatch('Start_Paid', 'ZahlungEingegangen'),
      msgCatch('Event_Reply', 'Antwort', { element: 'bpmn:IntermediateCatchEvent' }),
      msgThrow('Event_Question', 'Antwort'),
      sigThrow('Event_Recall', 'Rückruf'),
    ],
  });
  const billing = model('billing/invoice', {
    processes: [{ id: 'Process_Invoice' }],
    facts: [
      msgCatch('Start_Shipped', 'WAREVERSANDBEREIT'),
      msgCatch('Start_ByLabel', null, { label: 'Event_Shipped' }),
      msgThrow('End_Paid', 'Zahlung_Eingegangen', { element: 'bpmn:EndEvent' }),
      sigCatch('Start_Recall', 'Rueckruf', { scope: 'event_subprocess' }),
      msgCatch('Start_Nested', 'WareVersandbereit', { scope: 'subprocess' }),
      msgThrow('End_Nested', 'ZahlungEingegangen', {
        element: 'bpmn:EndEvent',
        scope: 'event_subprocess',
      }),
    ],
  });

  it('proposes identical names after normalization in the key tier, never accepted', () => {
    const { relations } = runRules(project(shop, billing));
    expect(relations.map(brief)).toEqual([
      'proposed key message billing/invoice#End_Paid -> sales/shop#Start_Paid 1',
      'proposed key message sales/shop#Event_Shipped -> billing/invoice#Start_Shipped 1',
      'proposed key signal sales/shop#Event_Recall -> billing/invoice#Start_Recall 1',
    ]);
    expect(relations.find((r) => r.type === 'signal')?.attrs).toEqual({
      signalName: 'Rückruf',
      signalNameTo: 'Rueckruf',
    });
  });

  it('never links within one process, nor pairs joined by a message flow in the file', () => {
    const collab = model('service/case', {
      processes: [{ id: 'Process_Agent' }, { id: 'Process_Case' }],
      facts: [
        msgThrow('Task_Ask', 'Auskunft', { element: 'bpmn:SendTask', processId: 'Process_Case' }),
        msgCatch('Start_Ask', 'Auskunft', { processId: 'Process_Agent' }),
        msgThrow('End_Answer', 'Antwort', { element: 'bpmn:EndEvent', processId: 'Process_Agent' }),
        msgCatch('Event_Answer', 'Antwort', {
          element: 'bpmn:IntermediateCatchEvent',
          processId: 'Process_Case',
        }),
        msgThrow('Event_Self', 'Selbst', { processId: 'Process_Case' }),
        msgCatch('Event_SelfCatch', 'Selbst', {
          element: 'bpmn:IntermediateCatchEvent',
          processId: 'Process_Case',
        }),
      ],
      messageFlows: [{ id: 'Flow_Ask', from: 'Task_Ask', to: 'Start_Ask' }],
    });
    const { relations } = runRules(project(collab));
    expect(relations.map(brief)).toEqual([
      'proposed key message service/case#End_Answer -> service/case#Event_Answer 1',
    ]);
  });

  it('reports throws and catches without a counterpart, unless a message flow serves them', () => {
    const lonely = model('ops/lonely', {
      processes: [{ id: 'Process_Lonely' }],
      facts: [
        msgThrow('Task_ToBank', 'Zahlungsdatei', { element: 'bpmn:SendTask' }),
        msgThrow('Task_ToCustomer', null, { element: 'bpmn:SendTask', label: 'Mahnung senden' }),
        msgThrow('Task_Flow', 'Bestellung', { element: 'bpmn:SendTask' }),
        msgCatch('Start_Webhook', 'Webhook'),
        msgCatch('Start_FromPool', 'Auftrag'),
        sigCatch('Start_Never', 'NieGesendet'),
        msgThrow('Task_Expr', '${name}', { element: 'bpmn:SendTask', attrs: { dynamic: true } }),
      ],
      messageFlows: [
        { id: 'Flow_1', from: 'Task_Flow', to: 'Participant_Supplier' },
        { id: 'Flow_2', from: 'Participant_Customer', to: 'Start_FromPool' },
      ],
    });
    expect(findingsOf(runRules(project(lonely)).findings)).toEqual([
      'dangling-throw ops/lonely#Task_ToBank',
      'dangling-throw ops/lonely#Task_ToCustomer',
      'unmatched-catch ops/lonely#Start_Never',
      'unmatched-catch ops/lonely#Start_Webhook',
    ]);
  });

  it('ignores subprocess-scoped starts and event-subprocess ends (never endpoints)', () => {
    const { findings } = runRules(project(shop, billing));
    const refs = findings.flatMap((f) => f.refs);
    expect(refs).not.toContain('billing/invoice#Start_Nested');
    expect(refs).not.toContain('billing/invoice#End_Nested');
    expect(findingsOf(findings)).toContain('dangling-throw sales/shop#Task_Notify');
  });

  it('is independent of the input order', () => {
    const pf = project(
      shop,
      billing,
      model('billing/dunning', { processes: [{ id: 'Process_Dunning' }] }),
    );
    expect(runRules(shuffled(pf))).toEqual(runRules(pf));
  });
});

describe('runRules: triggers', () => {
  it('never derives trigger relations (agents only), even for identical labels', () => {
    const a = model('a/one', {
      processes: [{ id: 'Process_A' }],
      facts: [end('End_Done', 'Monatsabschluss erstellt')],
    });
    const b = model('b/two', {
      processes: [{ id: 'Process_B' }],
      facts: [start('Start_Done', 'Monatsabschluss erstellt')],
    });
    expect(runRules(project(a, b))).toEqual({ relations: [], findings: [] });
  });
});
