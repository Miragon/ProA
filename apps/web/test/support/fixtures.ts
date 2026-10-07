import type { AgentToken, Relation } from '@proa/client';

import { buildRefIndex, resolverOf } from '../../src/lib/refs';

const NOW = '2026-10-07T09:00:00.000Z';

export function relation(
  overrides: Partial<Relation> & Pick<Relation, 'id' | 'from' | 'to'>,
): Relation {
  return {
    type: 'message',
    status: 'proposed',
    endpointState: 'ok',
    tier: 'key',
    confidence: 1,
    version: 1,
    attrs: {},
    updatedAt: NOW,
    ...overrides,
  };
}

/** The relations of eval/corpus/_sample, as the rule tier produces them. */
export const sampleRelations: Relation[] = [
  relation({
    id: 'rel_01SIGNAL0000000000000000001',
    type: 'signal',
    from: 'finanzen/rechnungsstellung#End_RechnungsstellungAbgeschlossen',
    to: 'vertrieb/auftragsabwicklung#Start_RechnungsstellungAbgeschlossen',
    attrs: { signalName: 'RechnungsstellungAbgeschlossen' },
  }),
  relation({
    id: 'rel_01MESSAGE000000000000000001',
    type: 'message',
    from: 'vertrieb/auftragsabwicklung#Event_WareVersandbereit',
    to: 'finanzen/rechnungsstellung#Start_WareVersandbereit',
    attrs: { messageName: 'WareVersandbereit' },
  }),
  relation({
    id: 'rel_01CALL000000000000000000001',
    type: 'call',
    from: 'vertrieb/auftragsabwicklung#Call_ZahlungAbwickeln',
    to: 'finance/payment-collection#Process_PaymentCollection',
    status: 'accepted',
    tier: 'rule',
    confidence: 1,
    attrs: { binding: 'latest' },
  }),
  relation({
    id: 'rel_01STEM000000000000000000001',
    type: 'call',
    from: 'finanzen/rechnungsstellung#Call_Mahnwesen',
    to: 'finance/payment-collection#Process_PaymentCollection',
    tier: 'key',
    confidence: 0.8,
    endpointState: 'changed',
    attrs: { calledElement: 'Process_Mahnwesen', match: 'file-stem' },
  }),
];

export const sampleResolver = resolverOf(
  buildRefIndex(
    [
      {
        modelKey: 'vertrieb/auftragsabwicklung',
        ref: 'vertrieb/auftragsabwicklung#Call_ZahlungAbwickeln',
        kind: 'call',
        label: 'Zahlung abwickeln',
        processId: 'Process_Auftragsabwicklung',
      },
      {
        modelKey: 'vertrieb/auftragsabwicklung',
        ref: 'vertrieb/auftragsabwicklung#Event_WareVersandbereit',
        kind: 'msg_throw',
        label: 'Ware versandbereit',
        processId: 'Process_Auftragsabwicklung',
      },
      {
        modelKey: 'finanzen/rechnungsstellung',
        ref: 'finanzen/rechnungsstellung#Start_WareVersandbereit',
        kind: 'msg_catch',
        label: 'Ware versandbereit',
        processId: 'Process_Rechnungsstellung',
      },
    ],
    [
      {
        ref: 'vertrieb/auftragsabwicklung#Process_Auftragsabwicklung',
        processId: 'Process_Auftragsabwicklung',
        name: 'Auftragsabwicklung',
        participantName: 'Vertrieb',
        isExecutable: true,
      },
      {
        ref: 'finanzen/rechnungsstellung#Process_Rechnungsstellung',
        processId: 'Process_Rechnungsstellung',
        name: 'Rechnungsstellung',
        participantName: null,
        isExecutable: true,
      },
      {
        ref: 'finance/payment-collection#Process_PaymentCollection',
        processId: 'Process_PaymentCollection',
        name: 'Payment collection',
        participantName: null,
        isExecutable: true,
      },
    ],
  ),
);

export function agentToken(
  overrides: Partial<AgentToken> & Pick<AgentToken, 'id' | 'name'>,
): AgentToken {
  return {
    prefix: 'Ab3dE5gH',
    scopes: ['proa:read', 'proa:propose'],
    expiresAt: '2027-01-05T09:00:00.000Z',
    revokedAt: null,
    lastUsedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}
