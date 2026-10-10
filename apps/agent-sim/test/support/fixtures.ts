/** Hand-built claim inputs (`proa-claim/1`) for the policy, recorder and agent tests. */
import {
  CLAIM_INPUT_FORMAT,
  ClaimInput,
  LEASE_TOKEN_PREFIX,
  newId,
  type ClaimCandidate,
  type ClaimRelation,
  type ClaimedRelationsAnalysis,
} from '@proa/contracts';

export const MODEL = 'vertrieb/orders';
export const ORDERS = {
  process: `${MODEL}#Process_Orders`,
  shipped: `${MODEL}#Event_OrderShipped`,
  done: `${MODEL}#End_OrderDone`,
  callBilling: `${MODEL}#Call_Billing`,
  paid: `${MODEL}#Start_PaymentReceived`,
  cancelled: `${MODEL}#Start_OrderCancelled`,
  returned: `${MODEL}#Start_OrderReturned`,
} as const;
export const BILLING = {
  process: 'finanzen/billing#Process_Billing',
  shipped: 'finanzen/billing#Start_OrderShipped',
  shipment: 'finanzen/billing#Start_ShipmentSent',
  done: 'finanzen/billing#Start_OrderDone',
} as const;
export const STOCK_LOW = 'lager/stock#Start_StockLow';
export const STOCK_COUNT = 'lager/stock#Start_StockCounted';
export const PAYMENT = 'finanzen/payments#Event_PaymentReceived';
export const CANCEL = 'service/desk#Event_CancelOrder';
export const RETURN = 'service/desk#Event_ReturnOrder';

const AT = '2026-10-01T10:00:00.000Z';

function relation(
  type: ClaimRelation['type'],
  from: string,
  to: string,
  extra: Partial<ClaimRelation>,
): ClaimRelation {
  return {
    id: newId('relation'),
    type,
    from: from as ClaimRelation['from'],
    to: to as ClaimRelation['to'],
    status: 'proposed',
    tier: 'key',
    confidence: 1,
    source: 'rule',
    endpointState: 'ok',
    ...extra,
  };
}

/** Candidates covering every verdict, sorted by score like the server sends them. */
export const CANDIDATES: ClaimCandidate[] = [
  ['call', ORDERS.callBilling, BILLING.process, 'rule', 1], // accepted by the rule tier: skip
  ['message', ORDERS.shipped, BILLING.shipped, 'key', 1], // identical names, a rule proposal: propose
  ['trigger', ORDERS.done, BILLING.done, 'lexical', 1], // identical labels: propose
  ['message', PAYMENT, ORDERS.paid, 'lexical', 0.9], // rejected by a human: skip
  ['message', CANCEL, ORDERS.cancelled, 'lexical', 0.8], // rejected, endpoint changed since: propose again
  ['message', RETURN, ORDERS.returned, 'lexical', 0.7], // held: skip
  ['message', ORDERS.shipped, BILLING.shipment, 'lexical', 0.58], // borderline: ask
  ['message', ORDERS.shipped, BILLING.shipment, 'lexical', 0.58], // repeated entry: ignored
  ['message', ORDERS.shipped, STOCK_LOW, 'lexical', 0.31], // below askAt: no-link
  ['message', ORDERS.shipped, STOCK_COUNT, 'compatible', 0.12], // compatible below askAt: not judged
];

/** A claim input for {@link MODEL} with every kind of candidate and existing relation. */
export function claimInput(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return ClaimInput.parse({
    format: CLAIM_INPUT_FORMAT,
    model: {
      key: MODEL,
      name: 'Orders',
      revisionId: newId('revision'),
      rev: 1,
      engine: 'c8',
      processes: [{ processId: 'Process_Orders', name: 'Order handling', participantName: null }],
    },
    facts: [
      { ref: ORDERS.process, kind: 'process', label: 'Order handling', key: 'Process_Orders' },
      {
        ref: ORDERS.shipped,
        kind: 'msg_throw',
        eventDef: 'message',
        label: 'Order shipped',
        key: 'OrderShipped',
        process: 'Process_Orders',
      },
      {
        ref: ORDERS.done,
        kind: 'evt_end',
        eventDef: 'none',
        label: 'Order done',
        process: 'Process_Orders',
      },
      {
        ref: ORDERS.callBilling,
        kind: 'call',
        label: 'Bill the order',
        key: 'Process_Billing',
        process: 'Process_Orders',
      },
      {
        ref: ORDERS.paid,
        kind: 'msg_catch',
        eventDef: 'message',
        label: 'Payment received',
        process: 'Process_Orders',
      },
      {
        ref: ORDERS.cancelled,
        kind: 'msg_catch',
        eventDef: 'message',
        label: 'Order cancelled',
        process: 'Process_Orders',
      },
      {
        ref: ORDERS.returned,
        kind: 'msg_catch',
        eventDef: 'message',
        label: 'Order returned',
        process: 'Process_Orders',
      },
    ],
    candidates: CANDIDATES,
    partners: {
      [BILLING.process]: {
        kind: 'process',
        label: 'Billing',
        key: 'Process_Billing',
        process: BILLING.process,
        processName: 'Billing',
      },
      [BILLING.shipped]: {
        kind: 'msg_catch',
        eventDef: 'message',
        label: 'Order shipped',
        key: 'OrderShipped',
        process: BILLING.process,
        processName: 'Billing',
      },
      [BILLING.shipment]: {
        kind: 'msg_catch',
        eventDef: 'message',
        label: 'Shipment sent',
        process: BILLING.process,
        processName: 'Billing',
      },
      [BILLING.done]: {
        kind: 'evt_start',
        eventDef: 'none',
        label: 'Order done',
        process: BILLING.process,
        processName: 'Billing',
      },
      [STOCK_LOW]: {
        kind: 'msg_catch',
        eventDef: 'message',
        label: 'Stock low',
        process: 'lager/stock#Process_Stock',
      },
      [STOCK_COUNT]: {
        kind: 'msg_catch',
        eventDef: 'message',
        label: 'Stock counted',
        process: 'lager/stock#Process_Stock',
      },
      [PAYMENT]: {
        kind: 'msg_throw',
        eventDef: 'message',
        label: 'Payment received',
        process: 'finanzen/payments#Process_Payments',
        processName: 'Payments',
      },
      [CANCEL]: {
        kind: 'msg_throw',
        eventDef: 'message',
        label: 'Cancel order',
        process: 'service/desk#Process_Desk',
      },
      [RETURN]: {
        kind: 'msg_throw',
        eventDef: 'message',
        label: 'Return order',
        process: 'service/desk#Process_Desk',
      },
    },
    relations: [
      relation('call', ORDERS.callBilling, BILLING.process, { status: 'accepted', tier: 'rule' }),
      relation('message', ORDERS.shipped, BILLING.shipped, {}),
      relation('message', PAYMENT, ORDERS.paid, {
        status: 'rejected',
        tier: 'lexical',
        source: 'human',
        decision: { verdict: 'reject', note: 'payments are matched elsewhere', at: AT },
      }),
      relation('message', CANCEL, ORDERS.cancelled, {
        status: 'rejected',
        tier: 'lexical',
        source: 'human',
        endpointState: 'changed',
        decision: { verdict: 'reject', note: 'not the same event', at: AT },
      }),
      relation('message', RETURN, ORDERS.returned, {
        status: 'held',
        tier: 'lexical',
        source: 'human',
        decision: {
          verdict: 'hold',
          note: 'ask the service team',
          question: 'Same return?',
          at: AT,
        },
        notes: [{ text: 'still open', at: AT }],
      }),
    ],
    ...overrides,
  });
}

/** A claimed task around {@link claimInput}. */
export function claimed(
  projectKey = 'demo',
  input: ClaimInput = claimInput(),
): ClaimedRelationsAnalysis {
  return {
    kind: 'relations',
    taskId: newId('analysisTask'),
    projectId: newId('project'),
    projectKey,
    modelId: newId('model'),
    modelKey: input.model.key,
    revisionId: input.model.revisionId,
    attempt: 1,
    leaseToken: `${LEASE_TOKEN_PREFIX}${'A'.repeat(43)}`,
    leaseUntil: '2026-10-01T10:15:00.000Z',
    procedure: { id: 'proa-relations', version: '0.0.1' },
    input,
  };
}
