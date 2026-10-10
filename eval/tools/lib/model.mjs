// Turns a parsed (zod-valid) model spec into a normalized internal model and
// runs all semantic checks that zod cannot express. Pure and deterministic.
import { ENGINES, lintConfigFor } from './constants.mjs';
import { EVENT_DEFINITION_KEYS } from './schema.mjs';

export const TASK_TYPES = new Set([
  'task',
  'manualTask',
  'userTask',
  'serviceTask',
  'businessRuleTask',
  'sendTask',
  'receiveTask',
  'scriptTask'
]);
export const ACTIVITY_TYPES = new Set([...TASK_TYPES, 'callActivity', 'subProcess']);
export const GATEWAY_TYPES = new Set(['exclusiveGateway', 'parallelGateway', 'eventBasedGateway']);
export const EVENT_TYPES = new Set([
  'startEvent',
  'endEvent',
  'intermediateThrowEvent',
  'intermediateCatchEvent',
  'boundaryEvent'
]);

export class SpecError extends Error {
  constructor(errors) {
    super(errors.join('\n'));
    this.errors = errors;
  }
}

/** Plain code-point comparison, independent of locale. */
export function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const TRANSLIT = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };

/** Readable ASCII id fragment from a free-text name ("Rechnung prüfen" -> "Rechnung_pruefen"). */
export function slugId(text) {
  const s = text
    .replace(/[äöüÄÖÜß]/g, (c) => TRANSLIT[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'x';
}

/** Default worker topic / job type: "Task_RechnungErstellen" -> "rechnung-erstellen". */
export function defaultTopic(id) {
  const core = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
  return core
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const C7_EXPRESSION = /^[$#]\{[\s\S]*\}$/;

/**
 * @param {object} spec zod-parsed ModelSpec
 * @param {{ engineVersion: string }} options
 */
export function buildModel(spec, { engineVersion }) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  const engine = spec.engine;
  const c7 = engine === 'c7';
  const c8 = engine === 'c8';

  if (!lintConfigFor(engine, engineVersion)) {
    err(
      `engine version ${engine} ${engineVersion} is not supported (supported: ${ENGINES[engine].lintVersions.join(', ')})`
    );
  }

  const model = {
    key: spec.key,
    engine,
    engineVersion,
    name: spec.name,
    definitionsId: `Definitions_${spec.key.replace(/[/-]/g, '_')}`,
    processes: [],
    collaboration: null,
    messages: [],
    signals: [],
    errors: [],
    escalations: [],
    ids: new Set(),
    nodesById: new Map(),
    lint: spec.lint?.disable ?? []
  };

  const claim = (id, what) => {
    if (model.ids.has(id)) err(`duplicate id "${id}" (${what}); ids must be unique per file`);
    model.ids.add(id);
  };
  claim(model.definitionsId, 'definitions');

  let order = 0;

  // ------------------------------------------------------------ processes

  for (const ps of spec.processes) {
    claim(ps.id, 'process');
    if (c8 && ps.historyTimeToLive) err(`${ps.id}: historyTimeToLive is c7-only`);
    const process = {
      id: ps.id,
      name: ps.name,
      isExecutable: ps.isExecutable ?? true,
      documentation: ps.documentation,
      historyTimeToLive: c7 ? (ps.historyTimeToLive ?? '180') : undefined,
      lanes: (ps.lanes ?? []).map((l) => ({ ...l, nodes: [] })),
      dataStores: (ps.dataStores ?? []).map((d) => ({ ...d, readers: [], writers: [] })),
      participant: null,
      root: null
    };
    for (const lane of process.lanes) claim(lane.id, 'lane');
    if (process.lanes.length) claim(`LaneSet_${process.id}`, 'generated lane set');
    for (const ds of process.dataStores) claim(ds.id, 'data store reference');
    process.root = buildContainer('process', process.id, null, process, ps.elements);
    model.processes.push(process);
  }

  function buildContainer(kind, id, owner, process, elements) {
    const container = { kind, id, owner, process, nodes: [], flows: [] };
    let currentLane = process.lanes[0]?.id;
    for (const el of elements) {
      const node = makeNode(el, container);
      container.nodes.push(node);
      // lanes only exist on the process level
      if (kind === 'process' && process.lanes.length) {
        if (el.lane) {
          if (!process.lanes.some((l) => l.id === el.lane)) err(`${el.id}: unknown lane "${el.lane}"`);
          currentLane = el.lane;
        }
        node.laneId = currentLane;
        for (const b of node.boundaries) b.laneId = currentLane;
      } else if (el.lane) {
        err(
          kind === 'process'
            ? `${el.id}: lane "${el.lane}" given but process ${process.id} has no lanes`
            : `${el.id}: lanes are only allowed on top-level elements, not inside a ${kind}`
        );
      }
    }
    return container;
  }

  function makeNode(el, container) {
    claim(el.id, el.type);
    const node = {
      id: el.id,
      type: el.type,
      spec: el,
      name: el.name,
      documentation: el.documentation,
      container,
      index: order++,
      laneId: undefined,
      event: null,
      interrupting: undefined,
      boundaries: [],
      attachedTo: null,
      child: null,
      incoming: [],
      outgoing: [],
      reads: el.reads ?? [],
      writes: el.writes ?? []
    };
    model.nodesById.set(node.id, node);

    if (EVENT_TYPES.has(el.type)) {
      node.event = normEvent(el, node);
    } else {
      const defs = EVENT_DEFINITION_KEYS.filter((k) => el[k] !== undefined);
      // only send/receive tasks carry a message
      if (defs.length && !(defs.length === 1 && defs[0] === 'message')) {
        err(`${el.id}: event definitions are not allowed on ${el.type}`);
      }
    }

    if (el.type === 'subProcess' || el.type === 'eventSubProcess') {
      node.child = buildContainer(el.type, el.id, node, container.process, el.elements);
    }

    for (const b of el.boundary ?? []) {
      claim(b.id, 'boundaryEvent');
      const bn = {
        id: b.id,
        type: 'boundaryEvent',
        spec: b,
        name: b.name,
        documentation: b.documentation,
        container,
        index: order++,
        laneId: undefined,
        event: null,
        interrupting: b.interrupting ?? true,
        boundaries: [],
        attachedTo: node,
        child: null,
        incoming: [],
        outgoing: [],
        reads: [],
        writes: []
      };
      bn.event = normEvent(b, bn);
      model.nodesById.set(bn.id, bn);
      node.boundaries.push(bn);
    }
    return node;
  }

  function normEvent(el, _node) {
    const keys = EVENT_DEFINITION_KEYS.filter((k) => el[k] !== undefined);
    if (keys.length > 1) err(`${el.id}: only one event definition allowed, got ${keys.join(', ')}`);
    const kind = keys[0] ?? 'none';
    const v = el[kind];
    switch (kind) {
      case 'message':
        return typeof v === 'string'
          ? { kind, name: v, correlationKey: undefined }
          : { kind, name: v.name, correlationKey: v.correlationKey };
      case 'signal':
        return { kind, name: typeof v === 'string' ? v : v.name };
      case 'timer': {
        const timerType = Object.keys(v)[0];
        return { kind, timerType, value: v[timerType] };
      }
      case 'error':
      case 'escalation':
        return typeof v === 'string'
          ? { kind, code: v, name: v }
          : { kind, code: v.code, name: v.name ?? v.code };
      case 'conditional':
        return typeof v === 'string'
          ? { kind, condition: v, variableName: undefined }
          : { kind, condition: v.condition, variableName: v.variableName };
      case 'terminate':
        return { kind };
      default:
        return { kind: 'none' };
    }
  }

  // ------------------------------------------------------- per-node checks

  for (const node of model.nodesById.values()) {
    checkNode(node);
  }

  function checkNode(node) {
    const { spec: el, container } = node;
    const id = node.id;

    // names (bpmnlint label-required)
    const needsName =
      EVENT_TYPES.has(node.type) || TASK_TYPES.has(node.type) || node.type === 'callActivity';
    if (needsName && !node.name) err(`${id}: name is required for ${node.type} (bpmnlint label-required)`);

    // interrupting
    if (node.type === 'startEvent') {
      if (el.interrupting !== undefined && container.kind !== 'eventSubProcess') {
        err(`${id}: 'interrupting' is only allowed on start events of event subprocesses`);
      }
      node.interrupting = container.kind === 'eventSubProcess' ? (el.interrupting ?? true) : undefined;
    }

    if (node.event) checkEvent(node);

    // topic
    if (el.topic !== undefined) {
      const isMsgThrow =
        (node.type === 'endEvent' || node.type === 'intermediateThrowEvent') && node.event?.kind === 'message';
      if (EVENT_TYPES.has(node.type) && !isMsgThrow) err(`${id}: 'topic' is only allowed on message throw events`);
    }

    // task specifics
    if (node.type === 'scriptTask') {
      if (c8 && el.scriptFormat) err(`${id}: scriptFormat is c7-only (c8 scripts are FEEL expressions)`);
      if (c8 && el.script && !el.script.startsWith('=')) err(`${id}: c8 script must be a FEEL expression starting with '='`);
    }
    if (node.type === 'callActivity') checkCall(node);
    if (node.type === 'userTask' && c8 && el.assignee && /^[$#]\{/.test(el.assignee)) {
      err(`${id}: c8 assignee expressions start with '='`);
    }

    // boundary hosts
    if (node.boundaries.length && !ACTIVITY_TYPES.has(node.type)) {
      err(`${id}: boundary events can only be attached to activities`);
    }
    if (TASK_TYPES.has(node.type) || node.type === 'callActivity') {
      if (node.boundaries.length > 2) err(`${id}: at most 2 boundary events per task (layout limit)`);
    }

    // data stores
    for (const [list, role] of [
      [node.reads, 'reads'],
      [node.writes, 'writes']
    ]) {
      for (const dsId of list) {
        const ds = container.process.dataStores.find((d) => d.id === dsId);
        if (!ds) {
          err(`${id}: ${role} unknown data store "${dsId}" (declare it under dataStores of process ${container.process.id})`);
          continue;
        }
        (role === 'reads' ? ds.readers : ds.writers).push(node);
      }
      if (new Set(list).size !== list.length) err(`${id}: duplicate data store in ${role}`);
    }
  }

  function allowedDefinitions(node) {
    switch (node.type) {
      case 'startEvent':
        if (node.container.kind === 'process') return ['none', 'message', 'signal', 'timer', 'conditional'];
        if (node.container.kind === 'subProcess') return ['none'];
        return ['message', 'signal', 'timer', 'error', 'escalation', 'conditional'];
      case 'endEvent':
        return ['none', 'message', 'signal', 'error', 'escalation', 'terminate'];
      case 'intermediateThrowEvent':
        return ['none', 'message', 'signal', 'escalation'];
      case 'intermediateCatchEvent':
        return ['message', 'signal', 'timer', 'conditional'];
      case 'boundaryEvent':
        return ['message', 'signal', 'timer', 'error', 'escalation', 'conditional'];
      default:
        return [];
    }
  }

  function checkEvent(node) {
    const ev = node.event;
    const where =
      node.type === 'startEvent' && node.container.kind !== 'process' ? ` in a ${node.container.kind}` : '';
    const allowed = allowedDefinitions(node);
    if (!allowed.includes(ev.kind)) {
      err(
        `${node.id}: ${ev.kind === 'none' ? 'a none' : `a ${ev.kind}`} ${node.type}${where} is not allowed (allowed: ${allowed.join(', ')})` +
          (node.type === 'endEvent' && ev.kind === 'timer' ? '; timer end events do not exist in BPMN' : '')
      );
      return;
    }
    const isThrow = node.type === 'endEvent' || node.type === 'intermediateThrowEvent';
    if ((ev.kind === 'error' || ev.kind === 'escalation') && isThrow && !ev.code) {
      err(`${node.id}: ${ev.kind} throw events need a code`);
    }
    if (ev.kind === 'error' && node.interrupting === false) {
      err(`${node.id}: error events are always interrupting`);
    }
    if (ev.kind === 'timer') {
      let ok;
      if (node.type === 'startEvent' && node.container.kind === 'process') ok = ['cycle', 'date'];
      else if (node.type === 'startEvent') ok = node.interrupting ? ['date', 'duration'] : ['cycle', 'date', 'duration'];
      else if (node.type === 'boundaryEvent') ok = node.interrupting ? ['duration', 'date'] : ['cycle', 'date', 'duration'];
      else ok = ['duration', 'date'];
      if (!ok.includes(ev.timerType)) {
        err(`${node.id}: timer ${ev.timerType} is not allowed here (allowed: ${ok.join(', ')})`);
      }
    }
    if (ev.kind === 'conditional') {
      if (c7 && !C7_EXPRESSION.test(ev.condition)) err(`${node.id}: c7 conditions are expressions like \${ready}`);
      if (c8 && !ev.condition.startsWith('=')) err(`${node.id}: c8 conditions are FEEL expressions starting with '='`);
      if (c8 && ev.variableName) err(`${node.id}: variableName is c7-only`);
    }
    if (ev.kind === 'message' && c7 && ev.correlationKey) {
      err(`${node.id}: correlationKey is c8-only (c7 correlates in code)`);
    }
  }

  function checkCall(node) {
    const el = node.spec;
    const ce = el.calledElement;
    if (c8 && /^[$#]\{/.test(ce)) err(`${node.id}: c8 calledElement expressions are FEEL ("=target"), not "${ce}"`);
    if (c7 && ce.startsWith('=')) err(`${node.id}: c7 calledElement expressions are "\${target}", not FEEL`);
    if (el.binding) {
      const allowed = c7 ? ['latest', 'deployment', 'version', 'versionTag'] : ['latest', 'deployment', 'versionTag'];
      if (!allowed.includes(el.binding)) err(`${node.id}: binding ${el.binding} not supported on ${engine}`);
    }
    if ((el.binding === 'version') !== Boolean(el.version)) err(`${node.id}: 'version' goes together with binding: version`);
    if ((el.binding === 'versionTag') !== Boolean(el.versionTag)) {
      err(`${node.id}: 'versionTag' goes together with binding: versionTag`);
    }
    // Zeebe resolves a static target with bindingType="deployment" at deploy
    // time and rejects the deployment when the process is not part of it; one
    // model is one deployment, so the target must be an executable process of
    // this file (c7 resolves the binding at runtime)
    if (c8 && el.binding === 'deployment' && !ce.startsWith('=')) {
      const local = spec.processes.some((p) => p.id === ce && p.isExecutable !== false);
      if (!local) {
        err(
          `${node.id}: c8 binding: deployment needs the called process "${ce}" in this file ` +
            '(Zeebe rejects the deployment otherwise); use binding latest or versionTag across files'
        );
      }
    }
  }

  // ----------------------------------------------------------- lanes

  for (const process of model.processes) {
    if (!process.lanes.length) continue;
    for (const node of process.root.nodes) {
      const lane = process.lanes.find((l) => l.id === node.laneId);
      if (!lane) continue;
      lane.nodes.push(node);
      lane.nodes.push(...node.boundaries);
    }
  }

  // ----------------------------------------------------------- flows

  for (const process of model.processes) {
    forEachContainer(process.root, buildFlows);
  }

  function buildFlows(container) {
    const local = new Map();
    for (const n of container.nodes) local.set(n.id, n);
    const list = container.nodes;

    const addFlow = (source, target, opts = {}) => {
      const id = opts.id ?? `Flow_${source.id}_${target.id}`;
      claim(id, 'sequence flow');
      const flow = {
        id,
        name: opts.name,
        condition: opts.condition,
        isDefault: opts.default === true,
        source,
        target,
        container,
        index: container.flows.length
      };
      container.flows.push(flow);
      source.outgoing.push(flow);
      target.incoming.push(flow);
      return flow;
    };

    const addExplicit = (source, next) => {
      const items = typeof next === 'string' ? [next] : next;
      for (const item of items) {
        const t = typeof item === 'string' ? { to: item } : item;
        const target = local.get(t.to);
        if (!target) {
          const elsewhere = model.nodesById.get(t.to);
          if (!elsewhere) err(`${source.id}: next "${t.to}" does not exist`);
          else if (elsewhere.type === 'boundaryEvent') err(`${source.id}: next "${t.to}" is a boundary event; boundary events have no incoming flows`);
          else err(`${source.id}: next "${t.to}" is in another (sub)process; sequence flows cannot cross (sub)process borders`);
          continue;
        }
        if (target.type === 'startEvent') {
          err(`${source.id}: next "${t.to}" is a start event; start events have no incoming flows`);
          continue;
        }
        if (target.type === 'eventSubProcess') {
          err(`${source.id}: next "${t.to}" is an event subprocess; it has no incoming flows`);
          continue;
        }
        addFlow(source, target, t);
      }
    };

    list.forEach((node, i) => {
      if (node.type === 'eventSubProcess') return;
      if (node.spec.next !== undefined) {
        addExplicit(node, node.spec.next);
      } else if (node.type !== 'endEvent') {
        const succ = list[i + 1];
        if (succ && succ.type !== 'startEvent' && succ.type !== 'eventSubProcess') {
          addFlow(node, succ);
        } else {
          err(
            `${node.id}: no outgoing sequence flow; the next list element (${succ ? succ.id : 'none'}) cannot be an implicit successor, so add 'next:' (or 'next: []')`
          );
        }
      }
      for (const b of node.boundaries) addExplicit(b, b.spec.next);
    });

    // flow / gateway checks
    for (const node of [...list, ...list.flatMap((n) => n.boundaries)]) {
      const out = node.outgoing;
      const conditional = out.filter((f) => f.condition !== undefined);
      const defaults = out.filter((f) => f.isDefault);
      if (node.type === 'exclusiveGateway' && out.length > 1) {
        if (!node.name) err(`${node.id}: forking exclusive gateways need a name (bpmnlint label-required)`);
        for (const f of out) {
          if (f.condition === undefined && !f.isDefault) err(`${node.id} -> ${f.target.id}: needs 'condition' or 'default: true'`);
          if (f.condition !== undefined && f.isDefault) err(`${node.id} -> ${f.target.id}: a default flow has no condition`);
          if (f.condition !== undefined && !f.name) err(`${node.id} -> ${f.target.id}: conditional flows need a name (bpmnlint label-required)`);
        }
        if (defaults.length > 1) err(`${node.id}: at most one default flow`);
      } else {
        if (conditional.length) err(`${node.id}: conditions are only supported on flows leaving a forking exclusive gateway`);
        if (defaults.length) err(`${node.id}: default flows are only supported on forking exclusive gateways`);
      }
      for (const f of conditional) {
        if (c7 && !C7_EXPRESSION.test(f.condition)) err(`${f.id}: c7 conditions are expressions like \${approved}`);
        if (c8 && !f.condition.startsWith('=')) err(`${f.id}: c8 conditions are FEEL expressions starting with '='`);
      }
      if (node.type === 'eventBasedGateway') {
        if (out.length < 2) err(`${node.id}: event-based gateways need at least two outgoing flows`);
        const ok = c8 ? ['message', 'timer'] : ['message', 'timer', 'signal', 'conditional'];
        for (const f of out) {
          const t = f.target;
          if (t.type !== 'intermediateCatchEvent' || !ok.includes(t.event?.kind)) {
            err(`${node.id}: event-based gateway targets must be intermediate catch events (${ok.join(', ')}) on ${engine}; ${t.id} is not`);
          }
        }
      }
    }

    // container start events
    const starts = list.filter((n) => n.type === 'startEvent');
    if (container.kind === 'process' && starts.length === 0) err(`${container.id}: process needs a start event`);
    if (container.kind !== 'process' && starts.length !== 1) {
      err(`${container.id}: a ${container.kind} needs exactly one start event, found ${starts.length}`);
    }

    if (c8) checkStraightThroughLoops(container);
  }

  // Zeebe rejects "straight-through processing loops": a cycle of sequence
  // flows with no wait state in it. Determined against camunda/camunda 8.9.22:
  // plain and manual tasks, FEEL script tasks and every intermediate throw
  // event (message throws included, although they are job-based) pass straight
  // through; a cycle of gateways alone is accepted; service, send, receive,
  // business rule and user tasks, call activities, subprocesses and catch
  // events are wait states.
  function checkStraightThroughLoops(container) {
    const passThrough = new Set(['task', 'manualTask', 'scriptTask', 'intermediateThrowEvent']);
    const inLoop = (n) => passThrough.has(n.type) || n.type === 'exclusiveGateway' || n.type === 'parallelGateway';
    const nodes = container.nodes.filter(inLoop);
    // Tarjan's strongly connected components on the pass-through subgraph
    const index = new Map();
    const low = new Map();
    const stack = [];
    const onStack = new Set();
    let next = 0;
    const visit = (v) => {
      index.set(v, next);
      low.set(v, next++);
      stack.push(v);
      onStack.add(v);
      for (const f of v.outgoing) {
        const w = f.target;
        if (!inLoop(w)) continue;
        if (!index.has(w)) {
          visit(w);
          low.set(v, Math.min(low.get(v), low.get(w)));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
      }
      if (low.get(v) !== index.get(v)) return;
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      const cyclic = scc.length > 1 || v.outgoing.some((f) => f.target === v);
      if (cyclic && scc.some((n) => passThrough.has(n.type))) {
        const ids = scc.map((n) => n.id).sort(cmp);
        err(
          `${ids.join(', ')}: c8 rejects loops without a wait state (straight-through processing loop); ` +
            'put a wait state such as a service, user or receive task or a catch event into the loop'
        );
      }
    };
    for (const n of nodes) if (!index.has(n)) visit(n);
  }

  // ----------------------------------------------------- root elements

  const messages = new Map();
  const signals = new Map();
  const errorsByCode = new Map();
  const escalations = new Map();

  const useMessage = (name, correlationKey, node, role) => {
    let m = messages.get(name);
    if (!m) {
      m = { name, correlationKey: undefined, keySources: [], usages: [] };
      messages.set(name, m);
    }
    if (correlationKey) {
      if (m.correlationKey && m.correlationKey !== correlationKey) {
        err(`message "${name}": conflicting correlationKey "${m.correlationKey}" (${m.keySources[0]}) vs "${correlationKey}" (${node?.id})`);
      }
      m.correlationKey ??= correlationKey;
      m.keySources.push(node?.id);
    }
    m.usages.push({ node, role });
    return m;
  };

  for (const node of model.nodesById.values()) {
    const ev = node.event;
    if (ev?.kind === 'message') {
      const isThrow = node.type === 'endEvent' || node.type === 'intermediateThrowEvent';
      const role = isThrow
        ? 'throw'
        : node.type === 'startEvent' && node.container.kind === 'process'
          ? 'start'
          : 'catch';
      node.message = useMessage(ev.name, ev.correlationKey, node, role);
    }
    if ((node.type === 'sendTask' || node.type === 'receiveTask') && node.spec.message) {
      const v = node.spec.message;
      const name = typeof v === 'string' ? v : v.name;
      const key = typeof v === 'string' ? undefined : v.correlationKey;
      if (c7 && key) err(`${node.id}: correlationKey is c8-only (c7 correlates in code)`);
      node.message = useMessage(name, key, node, node.type === 'sendTask' ? 'send' : 'catch');
    }
    if (ev?.kind === 'signal') {
      if (!signals.has(ev.name)) signals.set(ev.name, { name: ev.name });
      node.signal = signals.get(ev.name);
    }
    if (ev?.kind === 'error' && ev.code) {
      if (!errorsByCode.has(ev.code)) errorsByCode.set(ev.code, { code: ev.code, name: ev.name });
      node.error = errorsByCode.get(ev.code);
    }
    if (ev?.kind === 'escalation' && ev.code) {
      if (!escalations.has(ev.code)) escalations.set(ev.code, { code: ev.code, name: ev.name });
      node.escalation = escalations.get(ev.code);
    }
  }

  // c8: every message referenced by something other than a process-level
  // start event or a send task needs a zeebe:subscription correlationKey
  if (c8) {
    for (const m of messages.values()) {
      const needsKey = m.usages.some((u) => u.role === 'catch' || u.role === 'throw');
      if (needsKey && !m.correlationKey) {
        const who = m.usages.filter((u) => u.role === 'catch' || u.role === 'throw').map((u) => u.node.id);
        err(`message "${m.name}": c8 needs a correlationKey (e.g. "=orderId") on ${who.join(', ')}`);
      }
    }
  }

  // Both engines reject two catching subscriptions with the same message name,
  // signal name or condition in one scope (determined by deploying to
  // camunda-bpm-platform run-7.24.0 and camunda/camunda 8.9.22): the start
  // events of a process, the event subprocess starts of one (sub)process, the
  // boundary events of one activity, the targets of one event-based gateway.
  // Different scopes may share a name (process start and event subprocess
  // start, boundary and event subprocess, nested and outer event subprocess).
  const subscriptions = new Map();
  const subscribe = (scope, node) => {
    const ev = node.event;
    const what =
      ev.kind === 'message'
        ? `message "${ev.name}"`
        : ev.kind === 'signal'
          ? `signal "${ev.name}"`
          : ev.kind === 'conditional'
            ? `condition "${ev.condition}"`
            : null;
    if (!what) return;
    const key = `${what} in ${scope}`;
    if (!subscriptions.has(key)) subscriptions.set(key, []);
    subscriptions.get(key).push(node.id);
  };
  for (const node of model.nodesById.values()) {
    if (!node.event) continue;
    if (node.type === 'startEvent' && node.container.kind === 'process') {
      subscribe(`the start events of ${node.container.id}`, node);
    } else if (node.type === 'startEvent' && node.container.kind === 'eventSubProcess') {
      subscribe(`the event subprocesses of ${node.container.owner.container.id}`, node);
    } else if (node.type === 'boundaryEvent') {
      subscribe(`the boundary events of ${node.attachedTo.id}`, node);
    } else if (node.type === 'intermediateCatchEvent') {
      for (const f of node.incoming) if (f.source.type === 'eventBasedGateway') subscribe(`gateway ${f.source.id}`, node);
    }
  }
  for (const [key, ids] of subscriptions) {
    if (ids.length > 1) err(`${ids.join(', ')}: ${key} more than once; c7 and c8 reject the deployment`);
  }
  // a message name starts at most one process per file (c8: one bpmn:message
  // per start event; c7: one start subscription per message name and tenant,
  // also across deployments)
  for (const m of messages.values()) {
    const starts = m.usages.filter((u) => u.role === 'start');
    const processes = [...new Set(starts.map((u) => u.node.container.id))];
    if (processes.length > 1) {
      err(
        `message "${m.name}" starts ${processes.join(' and ')} (${starts.map((u) => u.node.id).join(', ')}); ` +
          'c7 and c8 allow one message start per name'
      );
    }
  }

  // ------------------------------------------------------ collaboration

  const needsCollab = model.processes.length > 1 || model.processes.some((p) => p.lanes.length);
  if (!spec.collaboration && needsCollab) {
    err('a collaboration is required when a model has more than one process or uses lanes');
  }
  if (spec.collaboration) {
    const cs = spec.collaboration;
    const collab = {
      id: cs.id ?? `Collaboration_${spec.key.replace(/[/-]/g, '_')}`,
      name: cs.name,
      documentation: cs.documentation,
      participants: [],
      messageFlows: []
    };
    claim(collab.id, 'collaboration');
    const byId = new Map();
    for (const p of cs.participants) {
      claim(p.id, 'participant');
      const participant = { id: p.id, name: p.name, documentation: p.documentation, process: null };
      if (p.process) {
        const process = model.processes.find((x) => x.id === p.process);
        if (!process) err(`${p.id}: process "${p.process}" does not exist in this model`);
        else if (process.participant) err(`${p.id}: process "${p.process}" is already used by ${process.participant.id}`);
        else {
          participant.process = process;
          process.participant = participant;
        }
      }
      collab.participants.push(participant);
      byId.set(p.id, participant);
    }
    for (const process of model.processes) {
      if (!process.participant) err(`process ${process.id} is not referenced by any participant`);
    }
    const msgFlowSource = (n) =>
      ACTIVITY_TYPES.has(n.type) ||
      ((n.type === 'intermediateThrowEvent' || n.type === 'endEvent') && n.event?.kind === 'message');
    const msgFlowTarget = (n) =>
      ACTIVITY_TYPES.has(n.type) ||
      (['startEvent', 'intermediateCatchEvent', 'boundaryEvent'].includes(n.type) && n.event?.kind === 'message');

    for (const mf of cs.messageFlows ?? []) {
      const resolve = (ref, end) => {
        if (byId.has(ref)) return { participant: byId.get(ref), node: null };
        const node = model.nodesById.get(ref);
        if (!node) {
          err(`message flow ${mf.from} -> ${mf.to}: ${end} "${ref}" is neither a participant nor an element`);
          return null;
        }
        const participant = node.container.process.participant;
        if (!participant) return null;
        return { participant, node };
      };
      const s = resolve(mf.from, 'from');
      const t = resolve(mf.to, 'to');
      if (!s || !t) continue;
      if (s.participant === t.participant) {
        err(`message flow ${mf.from} -> ${mf.to}: both ends are in participant ${s.participant.id}; message flows connect different pools`);
        continue;
      }
      if (s.node && !msgFlowSource(s.node)) err(`message flow ${mf.from} -> ${mf.to}: ${s.node.type} ${s.node.id} cannot send a message flow`);
      if (t.node && !msgFlowTarget(t.node)) err(`message flow ${mf.from} -> ${mf.to}: ${t.node.type} ${t.node.id} cannot receive a message flow`);
      const id = mf.id ?? `MessageFlow_${mf.from}_${mf.to}`;
      claim(id, 'message flow');
      const flow = {
        id,
        name: mf.name,
        source: s,
        target: t,
        message: mf.message ? useMessage(mf.message, undefined, null, 'flow') : null
      };
      collab.messageFlows.push(flow);
    }
    model.collaboration = collab;
  }

  // ----------------------------------------------- root element ids (sorted)

  const allocate = (prefix, text) => {
    const base = `${prefix}_${slugId(text)}`;
    let id = base;
    for (let i = 2; model.ids.has(id); i++) id = `${base}_${i}`;
    model.ids.add(id);
    return id;
  };
  model.messages = [...messages.values()].sort((a, b) => cmp(a.name, b.name));
  for (const m of model.messages) m.id = allocate('Message', m.name);
  model.signals = [...signals.values()].sort((a, b) => cmp(a.name, b.name));
  for (const s of model.signals) s.id = allocate('Signal', s.name);
  model.errors = [...errorsByCode.values()].sort((a, b) => cmp(a.code, b.code));
  for (const e of model.errors) e.id = allocate('Error', e.code);
  model.escalations = [...escalations.values()].sort((a, b) => cmp(a.code, b.code));
  for (const e of model.escalations) e.id = allocate('Escalation', e.code);

  // generated ids that must not collide with user ids
  for (const node of model.nodesById.values()) {
    if (node.event && node.event.kind !== 'none') claim(`${node.id}_ed`, 'generated event definition');
    if (node.reads.length) claim(`Property_${node.id}`, 'generated data input placeholder');
    for (const ds of node.reads) claim(`DataInputAssociation_${node.id}_${ds}`, 'generated data association');
    for (const ds of node.writes) claim(`DataOutputAssociation_${node.id}_${ds}`, 'generated data association');
  }

  if (errors.length) throw new SpecError(errors);
  return model;
}

export function forEachContainer(container, fn) {
  fn(container);
  for (const n of container.nodes) if (n.child) forEachContainer(n.child, fn);
}

/** All nodes of a container tree, depth-first in declaration order (boundaries after their host). */
export function allNodes(container, out = []) {
  for (const n of container.nodes) {
    out.push(n, ...n.boundaries);
    if (n.child) allNodes(n.child, out);
  }
  return out;
}
