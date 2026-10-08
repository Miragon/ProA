import { describe, expect, it } from 'vitest';

import { createPairAssessor } from '../src/index.ts';
import {
  call,
  end,
  model,
  msgCatch,
  msgThrow,
  project,
  ref,
  start,
  task,
} from './support/facts.ts';

const billing = model('finanzen/rechnung', {
  processes: [{ id: 'Process_Rechnung', name: 'Rechnungsstellung' }],
  facts: [
    msgThrow('Event_RechnungVersendet', 'RechnungVersendet', { label: 'Rechnung versendet' }),
    msgThrow('Event_Storno', 'StornoGebucht', { label: 'Storno gebucht' }),
    end('End_Fertig', 'Rechnung gestellt'),
    end('End_Sub', 'Teil fertig', { scope: 'subprocess' }),
    call('Call_Mahnung', 'Process_Mahnwesen', { label: 'Mahnen' }),
    task('Task_Pruefen', 'Rechnung prüfen'),
  ],
});
const shop = model('vertrieb/shop', {
  processes: [
    { id: 'Process_Shop', name: 'Order handling' },
    { id: 'Process_Helper', name: 'Helper' },
  ],
  facts: [
    msgCatch('Start_RechnungVersendet', 'Rechnung_Versendet', { label: 'Rechnung angekommen' }),
    msgCatch('Start_InvoiceSent', 'InvoiceSent', { label: 'Invoice sent' }),
    msgCatch('Start_Gutschrift', 'CreditIssued', { label: 'Kundenkonto entlastet' }),
    start('Start_Gestellt', 'Rechnung gestellt'),
    msgThrow('Event_Local', 'Lokal', { label: 'Lokal' }),
    msgCatch('Catch_Local', 'Lokal', { label: 'Lokal', processId: 'Process_Shop' }),
    msgCatch('Catch_Helper', 'HelperMsg', { label: 'Helper', processId: 'Process_Helper' }),
  ],
  messageFlows: [{ id: 'Flow_1', from: 'Event_Local', to: 'Catch_Helper' }],
});
const dunning = model('finanzen/mahnwesen', {
  processes: [{ id: 'Process_Mahnwesen', name: 'Mahnwesen' }],
});
const assess = createPairAssessor(project(billing, shop, dunning));
const B = (id: string) => ref('finanzen/rechnung', id);
const S = (id: string) => ref('vertrieb/shop', id);

describe('createPairAssessor', () => {
  it('rejects refs that are not head facts (hallucinated elements)', () => {
    expect(assess({ type: 'message', from: B('Event_Nope'), to: S('Start_InvoiceSent') })).toEqual({
      ok: false,
      reason: 'unknown-ref',
    });
    expect(assess({ type: 'message', from: B('Event_Storno'), to: ref('x/y', 'Start') })).toEqual({
      ok: false,
      reason: 'unknown-ref',
    });
  });

  it('rejects ends that cannot take that side of the type', () => {
    // A catch as source, a task, the wrong direction, a subprocess end, a call to a non-process.
    for (const [type, from, to] of [
      ['message', S('Start_InvoiceSent'), B('Event_RechnungVersendet')],
      ['message', B('Task_Pruefen'), S('Start_InvoiceSent')],
      ['signal', B('Event_Storno'), S('Start_InvoiceSent')],
      ['trigger', B('End_Sub'), S('Start_Gestellt')],
      ['call', B('Call_Mahnung'), S('Start_InvoiceSent')],
    ] as const) {
      expect(assess({ type, from, to }), `${type} ${from} ${to}`).toEqual({
        ok: false,
        reason: 'type-mismatch',
      });
    }
  });

  it('rejects pairs inside one process and pairs a message flow already joins', () => {
    expect(assess({ type: 'message', from: S('Event_Local'), to: S('Catch_Local') })).toEqual({
      ok: false,
      reason: 'same-process',
    });
    expect(assess({ type: 'message', from: S('Event_Local'), to: S('Catch_Helper') })).toEqual({
      ok: false,
      reason: 'message-flow',
    });
  });

  it('computes the tier: key for identical names and rule pairs, lexical, else semantic', () => {
    const key = assess({
      type: 'message',
      from: B('Event_RechnungVersendet'),
      to: S('Start_RechnungVersendet'),
    });
    expect(key).toMatchObject({ ok: true, tier: 'key', signals: { keyEqual: true } });
    expect(
      assess({
        type: 'call',
        from: B('Call_Mahnung'),
        to: ref('finanzen/mahnwesen', 'Process_Mahnwesen'),
      }),
    ).toMatchObject({ ok: true, tier: 'key' });
    // "Rechnung versendet" ~ "Invoice sent": the DE/EN synonym list gives lexical evidence.
    expect(
      assess({ type: 'message', from: B('Event_RechnungVersendet'), to: S('Start_InvoiceSent') }),
    ).toMatchObject({ ok: true, tier: 'lexical' });
    expect(
      assess({ type: 'trigger', from: B('End_Fertig'), to: S('Start_Gestellt') }),
    ).toMatchObject({ ok: true, tier: 'lexical' });
    // "Storno gebucht" → "Kundenkonto entlastet": no shared concept; only an agent can tell.
    const semantic = assess({
      type: 'message',
      from: B('Event_Storno'),
      to: S('Start_Gutschrift'),
    });
    expect(semantic).toMatchObject({ ok: true, tier: 'semantic' });
    if (semantic.ok) expect(semantic.score).toBeGreaterThanOrEqual(0);
  });
});
