// Minimal fact extraction from parsed BPMN (bpmn-moddle definitions), in the
// spirit of CONCEPT §2. Used by the validator to resolve expected.yaml refs,
// check endpoint kinds and recompute deterministic findings.

const EVENT_DEF = {
  'bpmn:MessageEventDefinition': 'message',
  'bpmn:SignalEventDefinition': 'signal',
  'bpmn:TimerEventDefinition': 'timer',
  'bpmn:ConditionalEventDefinition': 'conditional',
  'bpmn:ErrorEventDefinition': 'error',
  'bpmn:EscalationEventDefinition': 'escalation',
  'bpmn:TerminateEventDefinition': 'terminate',
  'bpmn:LinkEventDefinition': 'link',
  'bpmn:CompensateEventDefinition': 'compensate'
};

const TASKS = new Set([
  'bpmn:Task',
  'bpmn:UserTask',
  'bpmn:ServiceTask',
  'bpmn:ManualTask',
  'bpmn:ScriptTask',
  'bpmn:BusinessRuleTask'
]);

/** Kinds an agent may use as `from` / `to` in a must_not_link entry (loose). */
export const OUTGOING_KINDS = new Set(['call', 'msg_throw', 'sig_throw', 'evt_end', 'end_other', 'throw_other']);
export const INCOMING_KINDS = new Set(['process', 'msg_catch', 'sig_catch', 'evt_start', 'start_other', 'catch_other']);

export function isDynamicCall(key) {
  return /^\s*[$#]\{/.test(key) || key.trim().startsWith('=');
}

function calledElementOf(el) {
  if (el.calledElement) return el.calledElement;
  const ext = el.extensionElements?.values ?? [];
  const ce = ext.find((v) => v.$type === 'zeebe:CalledElement');
  return ce?.processId ?? ce?.processIdExpression ?? '';
}

function classify(el, ctx) {
  const t = el.$type;
  const def = EVENT_DEF[el.eventDefinitions?.[0]?.$type] ?? 'none';
  const label = (el.name ?? '').trim();
  const fact = {
    id: el.id,
    type: t,
    kind: 'other',
    eventDef: null,
    label,
    key: label,
    keyFromRef: false,
    scope: ctx.scope,
    processId: ctx.processId,
    endpoint: false,
    dynamic: false
  };
  const msgName = () => el.messageRef?.name ?? el.eventDefinitions?.[0]?.messageRef?.name;
  const sigName = () => el.eventDefinitions?.[0]?.signalRef?.name;

  if (t.endsWith('Event')) fact.eventDef = def;
  switch (t) {
    case 'bpmn:StartEvent':
      fact.kind =
        def === 'message' ? 'msg_catch' : def === 'signal' ? 'sig_catch' : ['none', 'timer', 'conditional'].includes(def) ? 'evt_start' : 'start_other';
      break;
    case 'bpmn:EndEvent':
      fact.kind =
        def === 'message' ? 'msg_throw' : def === 'signal' ? 'sig_throw' : ['none', 'terminate'].includes(def) ? 'evt_end' : 'end_other';
      break;
    case 'bpmn:IntermediateThrowEvent':
      fact.kind = def === 'message' ? 'msg_throw' : def === 'signal' ? 'sig_throw' : 'throw_other';
      break;
    case 'bpmn:IntermediateCatchEvent':
    case 'bpmn:BoundaryEvent':
      fact.kind = def === 'message' ? 'msg_catch' : def === 'signal' ? 'sig_catch' : 'catch_other';
      break;
    case 'bpmn:SendTask':
      fact.kind = 'msg_throw';
      break;
    case 'bpmn:ReceiveTask':
      fact.kind = 'msg_catch';
      break;
    case 'bpmn:CallActivity':
      fact.kind = 'call';
      break;
    case 'bpmn:DataStoreReference':
      fact.kind = 'data_store';
      break;
    case 'bpmn:SubProcess':
      fact.kind = el.triggeredByEvent ? 'event_subprocess' : 'subprocess';
      break;
    default:
      if (TASKS.has(t)) fact.kind = 'task';
      else if (t.endsWith('Gateway')) fact.kind = 'gateway';
  }

  if (fact.kind === 'msg_throw' || fact.kind === 'msg_catch') {
    const name = msgName();
    if (name) {
      fact.key = name;
      fact.keyFromRef = true;
    }
  }
  if (fact.kind === 'sig_throw' || fact.kind === 'sig_catch') {
    const name = sigName();
    if (name) {
      fact.key = name;
      fact.keyFromRef = true;
    }
  }
  if (fact.kind === 'call') {
    fact.key = calledElementOf(el);
    fact.keyFromRef = Boolean(fact.key);
    fact.dynamic = isDynamicCall(fact.key);
  }

  // endpoint eligibility for must_link/may_link (CONCEPT §2: start/end events
  // inside subprocesses are never endpoints; event-subprocess starts are)
  const isStart = t === 'bpmn:StartEvent';
  const isEnd = t === 'bpmn:EndEvent';
  if (['msg_throw', 'msg_catch', 'sig_throw', 'sig_catch'].includes(fact.kind)) {
    if (isStart) fact.endpoint = ctx.scope === 'process' || ctx.scope === 'event_subprocess';
    else if (isEnd) fact.endpoint = ctx.scope === 'process';
    else fact.endpoint = true;
  } else if (fact.kind === 'evt_start' || fact.kind === 'evt_end') {
    fact.endpoint = ctx.scope === 'process';
  } else if (fact.kind === 'call') {
    fact.endpoint = true;
  }
  return fact;
}

/**
 * @param {string} modelKey
 * @param {object} definitions bpmn-moddle root
 */
export function extractFacts(modelKey, definitions) {
  const facts = {
    key: modelKey,
    processes: new Map(),
    elements: new Map(),
    messageFlows: []
  };
  const roots = definitions.rootElements ?? [];
  const collab = roots.find((r) => r.$type === 'bpmn:Collaboration');
  const participantName = new Map();
  for (const p of collab?.participants ?? []) if (p.processRef) participantName.set(p.processRef.id, p.name);
  for (const mf of collab?.messageFlows ?? []) {
    facts.messageFlows.push({ id: mf.id, from: mf.sourceRef?.id, to: mf.targetRef?.id });
  }

  const walk = (container, ctx) => {
    for (const el of container.flowElements ?? []) {
      if (el.$type === 'bpmn:SequenceFlow') continue;
      facts.elements.set(el.id, classify(el, ctx));
      if (el.$type === 'bpmn:SubProcess') {
        walk(el, { ...ctx, scope: el.triggeredByEvent ? 'event_subprocess' : 'subprocess' });
      }
    }
  };
  for (const p of roots.filter((r) => r.$type === 'bpmn:Process')) {
    facts.processes.set(p.id, {
      id: p.id,
      kind: 'process',
      label: (p.name ?? participantName.get(p.id) ?? '').trim(),
      key: p.id,
      processId: p.id,
      scope: 'process',
      endpoint: true,
      isExecutable: p.isExecutable === true
    });
    walk(p, { processId: p.id, scope: 'process' });
  }
  return facts;
}

/** Resolves `<key>#<id>` against a Map<modelKey, facts>. */
export function resolveRef(index, ref) {
  const hash = ref.indexOf('#');
  const key = ref.slice(0, hash);
  const id = ref.slice(hash + 1);
  const facts = index.get(key);
  if (!facts) return { error: `model "${key}" does not exist` };
  const fact = facts.processes.get(id) ?? facts.elements.get(id);
  if (!fact) return { error: `"${id}" does not exist in ${key}` };
  return { fact, modelKey: key, ref };
}
