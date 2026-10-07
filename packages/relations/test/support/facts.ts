// Builders for hand-written facts, shaped like @proa/bpmn-facts output.
import { FACTS_VERSION, normalizeKey } from '@proa/bpmn-facts';
import type {
  EventDef,
  Fact,
  FactAttrs,
  FactKind,
  FactScope,
  MessageFlowInfo,
  ModelFacts,
  ProcessInfo,
  ProjectFacts,
  Ref,
} from '@proa/contracts';

export interface FactInit {
  /** Default: the model's first process. */
  processId?: string | null;
  scope?: FactScope;
  eventDef?: EventDef | null;
  label?: string;
  /** Default: message/signal name, calledElement, process id, else the label. */
  keyRaw?: string;
  attrs?: FactAttrs;
}

export interface ModelInit {
  processes: Array<{ id: string; name?: string; participantName?: string; participantId?: string }>;
  facts?: Array<(modelKey: string, defaultProcess: string) => Fact>;
  messageFlows?: Array<{ id: string; from: string; to: string; name?: string }>;
}

function build(
  kind: FactKind,
  elementId: string,
  init: FactInit,
  defaults: Partial<Fact> & { attrs?: FactAttrs },
) {
  return (modelKey: string, defaultProcess: string): Fact => {
    const label = init.label ?? defaults.label ?? '';
    const keyRaw = init.keyRaw ?? defaults.keyRaw ?? label;
    return {
      modelKey,
      ref: `${modelKey}#${elementId}`,
      kind,
      elementId,
      processId: init.processId === undefined ? defaultProcess : init.processId,
      scope: init.scope ?? 'process',
      eventDef: init.eventDef === undefined ? (defaults.eventDef ?? null) : init.eventDef,
      label,
      keyRaw,
      keyNorm: normalizeKey(keyRaw),
      fingerprint: '000000000000',
      attrs: { ...defaults.attrs, ...init.attrs },
    };
  };
}

/** A call activity; `target` is the calledElement (`${…}` or `=…` makes it dynamic). */
export function call(elementId: string, target: string, init: FactInit = {}) {
  const dynamic = /^\s*[$#]\{/.test(target) || target.trim().startsWith('=');
  return build('call', elementId, init, {
    keyRaw: target,
    label: elementId,
    attrs: { elementType: 'bpmn:CallActivity', dynamic },
  });
}

type EventElement =
  | 'bpmn:StartEvent'
  | 'bpmn:EndEvent'
  | 'bpmn:IntermediateThrowEvent'
  | 'bpmn:IntermediateCatchEvent'
  | 'bpmn:BoundaryEvent'
  | 'bpmn:SendTask'
  | 'bpmn:ReceiveTask';

/** A message throw (`msg_throw`); `message` null means no messageRef (key = label). */
export function msgThrow(
  elementId: string,
  message: string | null,
  init: FactInit & { element?: EventElement } = {},
) {
  const element = init.element ?? 'bpmn:IntermediateThrowEvent';
  return build('msg_throw', elementId, init, {
    eventDef: element.endsWith('Task') ? null : 'message',
    label: elementId,
    ...(message === null ? {} : { keyRaw: message }),
    attrs: {
      elementType: element,
      dynamic: false,
      ...(message === null ? {} : { messageName: message }),
    },
  });
}

/** A message catch (`msg_catch`); `message` null means no messageRef (key = label). */
export function msgCatch(
  elementId: string,
  message: string | null,
  init: FactInit & { element?: EventElement } = {},
) {
  const element = init.element ?? 'bpmn:StartEvent';
  return build('msg_catch', elementId, init, {
    eventDef: element.endsWith('Task') ? null : 'message',
    label: elementId,
    ...(message === null ? {} : { keyRaw: message }),
    attrs: {
      elementType: element,
      dynamic: false,
      ...(message === null ? {} : { messageName: message }),
    },
  });
}

export function sigThrow(
  elementId: string,
  signal: string,
  init: FactInit & { element?: EventElement } = {},
) {
  return build('sig_throw', elementId, init, {
    eventDef: 'signal',
    label: elementId,
    keyRaw: signal,
    attrs: {
      elementType: init.element ?? 'bpmn:IntermediateThrowEvent',
      dynamic: false,
      signalName: signal,
    },
  });
}

export function sigCatch(
  elementId: string,
  signal: string,
  init: FactInit & { element?: EventElement } = {},
) {
  return build('sig_catch', elementId, init, {
    eventDef: 'signal',
    label: elementId,
    keyRaw: signal,
    attrs: { elementType: init.element ?? 'bpmn:StartEvent', dynamic: false, signalName: signal },
  });
}

/** A none (or timer/conditional) start event. */
export function start(elementId: string, label: string, init: FactInit = {}) {
  return build(
    'evt_start',
    elementId,
    { label, ...init },
    {
      eventDef: 'none',
      attrs: { elementType: 'bpmn:StartEvent' },
    },
  );
}

/** A none (or terminate) end event. */
export function end(elementId: string, label: string, init: FactInit = {}) {
  return build(
    'evt_end',
    elementId,
    { label, ...init },
    {
      eventDef: 'none',
      attrs: { elementType: 'bpmn:EndEvent' },
    },
  );
}

export function task(elementId: string, label: string, init: FactInit = {}) {
  return build('task', elementId, { label, ...init }, { attrs: { elementType: 'bpmn:Task' } });
}

/** A model with its process facts, the given facts and message flows (ids, not refs). */
export function model(modelKey: string, init: ModelInit): ModelFacts {
  const [first] = init.processes;
  const defaultProcess = first?.id ?? 'Process_1';
  const processes: ProcessInfo[] = init.processes.map((p) => ({
    ref: `${modelKey}#${p.id}`,
    processId: p.id,
    name: p.name ?? null,
    participantName: p.participantName ?? null,
    isExecutable: true,
  }));
  const processFacts: Fact[] = init.processes.map((p) => ({
    modelKey,
    ref: `${modelKey}#${p.id}`,
    kind: 'process',
    elementId: p.id,
    processId: p.id,
    scope: 'process',
    eventDef: null,
    label: p.name ?? p.participantName ?? '',
    keyRaw: p.id,
    keyNorm: normalizeKey(p.id),
    fingerprint: '000000000000',
    attrs: {
      elementType: 'bpmn:Process',
      isExecutable: true,
      ...(p.participantId === undefined ? {} : { participantId: p.participantId }),
      ...(p.participantName === undefined ? {} : { participantName: p.participantName }),
    },
  }));
  const messageFlows: MessageFlowInfo[] = (init.messageFlows ?? []).map((f) => ({
    ref: `${modelKey}#${f.id}`,
    elementId: f.id,
    name: f.name ?? null,
    from: `${modelKey}#${f.from}`,
    to: `${modelKey}#${f.to}`,
    messageName: null,
  }));
  return {
    modelKey,
    factsVersion: FACTS_VERSION,
    processes,
    facts: [...processFacts, ...(init.facts ?? []).map((f) => f(modelKey, defaultProcess))],
    messageFlows,
  };
}

export function project(...models: ModelFacts[]): ProjectFacts {
  return { models };
}

export const ref = (modelKey: string, id: string): Ref => `${modelKey}#${id}`;

/** Reverses models, facts and flows: results must not depend on input order. */
export function shuffled(pf: ProjectFacts): ProjectFacts {
  return {
    models: [...pf.models].reverse().map((m) => ({
      ...m,
      processes: [...m.processes].reverse(),
      facts: [...m.facts].reverse(),
      messageFlows: [...m.messageFlows].reverse(),
    })),
  };
}
