// Builds the BPMN 2.0 XML (semantic model + DI) for one normalized model.
import { ENGINES, GENERATOR } from './constants.mjs';
import { defaultTopic, SpecError } from './model.mjs';
import { createModdle } from './moddle.mjs';

const BPMN_TYPE = {
  startEvent: 'bpmn:StartEvent',
  endEvent: 'bpmn:EndEvent',
  intermediateThrowEvent: 'bpmn:IntermediateThrowEvent',
  intermediateCatchEvent: 'bpmn:IntermediateCatchEvent',
  boundaryEvent: 'bpmn:BoundaryEvent',
  task: 'bpmn:Task',
  manualTask: 'bpmn:ManualTask',
  userTask: 'bpmn:UserTask',
  serviceTask: 'bpmn:ServiceTask',
  businessRuleTask: 'bpmn:BusinessRuleTask',
  sendTask: 'bpmn:SendTask',
  receiveTask: 'bpmn:ReceiveTask',
  scriptTask: 'bpmn:ScriptTask',
  callActivity: 'bpmn:CallActivity',
  subProcess: 'bpmn:SubProcess',
  eventSubProcess: 'bpmn:SubProcess',
  exclusiveGateway: 'bpmn:ExclusiveGateway',
  parallelGateway: 'bpmn:ParallelGateway',
  eventBasedGateway: 'bpmn:EventBasedGateway'
};

const DIAGRAM_ID = 'BPMNDiagram_1';
const PLANE_ID = 'BPMNPlane_1';

/**
 * @param {object} model normalized model (lib/model.mjs)
 * @param {{ shapes: Map, edges: Map }} layout absolute DI (lib/layout.mjs)
 * @param {{ specRel: string }} options spec path relative to the landscape, for the header comment
 * @returns {Promise<string>} BPMN XML, byte-stable for the same input
 */
export async function toBpmnXml(model, layout, { specRel }) {
  const moddle = createModdle(model.engine);
  const c7 = model.engine === 'c7';
  const elements = new Map();

  const create = (type, props = {}) => {
    const el = moddle.create(type);
    for (const [k, v] of Object.entries(props)) if (v !== undefined) el.set(k, v);
    return el;
  };
  const docs = (text) => (text ? [create('bpmn:Documentation', { text })] : undefined);
  const expr = (body) => create('bpmn:FormalExpression', { body });
  const ext = (values) => (values.length ? create('bpmn:ExtensionElements', { values }) : undefined);

  for (const id of [DIAGRAM_ID, PLANE_ID]) {
    if (model.ids.has(id)) throw new SpecError([`id "${id}" is reserved for the generated diagram`]);
  }

  // root elements
  const rootMessages = new Map();
  for (const m of model.messages) {
    const values = !c7 && m.correlationKey ? [create('zeebe:Subscription', { correlationKey: m.correlationKey })] : [];
    rootMessages.set(m, create('bpmn:Message', { id: m.id, name: m.name, extensionElements: ext(values) }));
  }
  const rootSignals = new Map(model.signals.map((s) => [s, create('bpmn:Signal', { id: s.id, name: s.name })]));
  const rootErrors = new Map(
    model.errors.map((e) => [e, create('bpmn:Error', { id: e.id, name: e.name, errorCode: e.code })])
  );
  const rootEscalations = new Map(
    model.escalations.map((e) => [e, create('bpmn:Escalation', { id: e.id, name: e.name, escalationCode: e.code })])
  );

  function eventDefinition(node) {
    const ev = node.event;
    const id = `${node.id}_ed`;
    switch (ev.kind) {
      case 'message': {
        const def = create('bpmn:MessageEventDefinition', { id, messageRef: rootMessages.get(node.message) });
        const isThrow = node.type === 'endEvent' || node.type === 'intermediateThrowEvent';
        if (isThrow && c7) {
          def.set('camunda:type', 'external');
          def.set('camunda:topic', node.spec.topic ?? defaultTopic(node.id));
        }
        return def;
      }
      case 'signal':
        return create('bpmn:SignalEventDefinition', { id, signalRef: rootSignals.get(node.signal) });
      case 'timer': {
        const prop = { duration: 'timeDuration', cycle: 'timeCycle', date: 'timeDate' }[ev.timerType];
        return create('bpmn:TimerEventDefinition', { id, [prop]: expr(ev.value) });
      }
      case 'error':
        return create('bpmn:ErrorEventDefinition', { id, errorRef: node.error ? rootErrors.get(node.error) : undefined });
      case 'escalation':
        return create('bpmn:EscalationEventDefinition', {
          id,
          escalationRef: node.escalation ? rootEscalations.get(node.escalation) : undefined
        });
      case 'conditional': {
        const def = create('bpmn:ConditionalEventDefinition', { id, condition: expr(ev.condition) });
        if (c7 && ev.variableName) def.set('camunda:variableName', ev.variableName);
        return def;
      }
      case 'terminate':
        return create('bpmn:TerminateEventDefinition', { id });
      default:
        return undefined;
    }
  }

  function buildNode(node, dataStores) {
    const s = node.spec;
    const el = create(BPMN_TYPE[node.type], { id: node.id, name: node.name, documentation: docs(node.documentation) });
    elements.set(node.id, el);
    const values = [];
    const external = (topic) => {
      if (c7) {
        el.set('camunda:type', 'external');
        el.set('camunda:topic', topic);
      } else {
        values.push(create('zeebe:TaskDefinition', { type: topic }));
      }
    };

    switch (node.type) {
      case 'startEvent':
        if (node.interrupting === false) el.isInterrupting = false;
        break;
      case 'boundaryEvent':
        el.attachedToRef = elements.get(node.attachedTo.id);
        if (!node.interrupting) el.cancelActivity = false;
        break;
      case 'userTask':
        if (c7) {
          if (s.assignee) el.set('camunda:assignee', s.assignee);
          if (s.candidateGroups) el.set('camunda:candidateGroups', s.candidateGroups);
          if (s.form) el.set('camunda:formKey', s.form);
        } else {
          // custom form reference: deployable without a linked Camunda Form
          values.push(create('zeebe:FormDefinition', { externalReference: s.form ?? `custom:${defaultTopic(node.id)}` }));
          values.push(create('zeebe:UserTask'));
          if (s.assignee || s.candidateGroups) {
            values.push(
              create('zeebe:AssignmentDefinition', { assignee: s.assignee, candidateGroups: s.candidateGroups })
            );
          }
        }
        break;
      case 'serviceTask':
      case 'businessRuleTask':
      case 'sendTask':
        external(s.topic ?? defaultTopic(node.id));
        break;
      case 'scriptTask':
        if (c7) {
          el.scriptFormat = s.scriptFormat ?? 'groovy';
          el.script = s.script ?? '// no-op';
          if (s.resultVariable) el.set('camunda:resultVariable', s.resultVariable);
        } else {
          values.push(
            create('zeebe:Script', { expression: s.script ?? '=true', resultVariable: s.resultVariable ?? 'scriptResult' })
          );
        }
        break;
      case 'callActivity':
        if (c7) {
          el.calledElement = s.calledElement;
          if (s.binding) el.set('camunda:calledElementBinding', s.binding);
          if (s.version) el.set('camunda:calledElementVersion', s.version);
          if (s.versionTag) el.set('camunda:calledElementVersionTag', s.versionTag);
        } else {
          values.push(
            create('zeebe:CalledElement', {
              processId: s.calledElement,
              propagateAllChildVariables: false,
              bindingType: s.binding,
              versionTag: s.versionTag
            })
          );
        }
        break;
      case 'eventSubProcess':
        el.triggeredByEvent = true;
        break;
      default:
        break;
    }

    if (node.message && (node.type === 'sendTask' || node.type === 'receiveTask')) {
      el.messageRef = rootMessages.get(node.message);
    }
    if (node.event && node.event.kind !== 'none') {
      el.eventDefinitions = [eventDefinition(node)];
      const isMsgThrow =
        node.event.kind === 'message' && (node.type === 'endEvent' || node.type === 'intermediateThrowEvent');
      if (isMsgThrow && !c7) values.push(create('zeebe:TaskDefinition', { type: s.topic ?? defaultTopic(node.id) }));
    }

    if (node.reads.length) {
      const placeholder = create('bpmn:Property', { id: `Property_${node.id}`, name: '__targetRef_placeholder' });
      el.properties = [placeholder];
      el.dataInputAssociations = node.reads.map((dsId) => {
        const id = `DataInputAssociation_${node.id}_${dsId}`;
        const a = create('bpmn:DataInputAssociation', { id, sourceRef: [dataStores.get(dsId)], targetRef: placeholder });
        elements.set(id, a);
        return a;
      });
    }
    if (node.writes.length) {
      el.dataOutputAssociations = node.writes.map((dsId) => {
        const id = `DataOutputAssociation_${node.id}_${dsId}`;
        const a = create('bpmn:DataOutputAssociation', { id, targetRef: dataStores.get(dsId) });
        elements.set(id, a);
        return a;
      });
    }

    if (values.length) el.extensionElements = ext(values);
    if (node.child) buildContainer(node.child, el, dataStores);
    return el;
  }

  function buildContainer(container, parentEl, dataStores) {
    const flowElements = [];
    for (const n of container.nodes) {
      flowElements.push(buildNode(n, dataStores));
      for (const b of n.boundaries) flowElements.push(buildNode(b, dataStores));
    }
    if (container.kind === 'process') flowElements.push(...dataStores.values());
    for (const f of container.flows) {
      const el = create('bpmn:SequenceFlow', {
        id: f.id,
        name: f.name,
        sourceRef: elements.get(f.source.id),
        targetRef: elements.get(f.target.id),
        conditionExpression: f.condition !== undefined ? expr(f.condition) : undefined
      });
      elements.set(f.id, el);
      flowElements.push(el);
      if (f.isDefault) elements.get(f.source.id).default = el;
    }
    // incoming/outgoing in flow declaration order
    const all = [...container.nodes, ...container.nodes.flatMap((n) => n.boundaries)];
    for (const n of all) {
      const el = elements.get(n.id);
      if (n.incoming.length) el.incoming = n.incoming.map((f) => elements.get(f.id));
      if (n.outgoing.length) el.outgoing = n.outgoing.map((f) => elements.get(f.id));
    }
    parentEl.flowElements = flowElements;
  }

  // processes
  const processEls = [];
  for (const p of model.processes) {
    const el = create('bpmn:Process', {
      id: p.id,
      name: p.name,
      isExecutable: p.isExecutable,
      documentation: docs(p.documentation)
    });
    if (c7) el.set('camunda:historyTimeToLive', p.historyTimeToLive);
    elements.set(p.id, el);
    const dataStores = new Map(
      p.dataStores.map((d) => {
        const ds = create('bpmn:DataStoreReference', { id: d.id, name: d.name, documentation: docs(d.documentation) });
        elements.set(d.id, ds);
        return [d.id, ds];
      })
    );
    buildContainer(p.root, el, dataStores);
    if (p.lanes.length) {
      el.laneSets = [
        create('bpmn:LaneSet', {
          id: `LaneSet_${p.id}`,
          lanes: p.lanes.map((l) => {
            const lane = create('bpmn:Lane', {
              id: l.id,
              name: l.name,
              documentation: docs(l.documentation),
              flowNodeRef: l.nodes.map((n) => elements.get(n.id))
            });
            elements.set(l.id, lane);
            return lane;
          })
        })
      ];
    }
    processEls.push(el);
  }

  // collaboration
  let collabEl;
  if (model.collaboration) {
    const c = model.collaboration;
    collabEl = create('bpmn:Collaboration', { id: c.id, name: c.name, documentation: docs(c.documentation) });
    elements.set(c.id, collabEl);
    collabEl.participants = c.participants.map((pt) => {
      const el = create('bpmn:Participant', {
        id: pt.id,
        name: pt.name,
        documentation: docs(pt.documentation),
        processRef: pt.process ? elements.get(pt.process.id) : undefined
      });
      elements.set(pt.id, el);
      return el;
    });
    if (c.messageFlows.length) {
      collabEl.messageFlows = c.messageFlows.map((mf) => {
        const el = create('bpmn:MessageFlow', {
          id: mf.id,
          name: mf.name,
          sourceRef: elements.get(mf.source.node ? mf.source.node.id : mf.source.participant.id),
          targetRef: elements.get(mf.target.node ? mf.target.node.id : mf.target.participant.id),
          messageRef: mf.message ? rootMessages.get(mf.message) : undefined
        });
        elements.set(mf.id, el);
        return el;
      });
    }
  }

  // DI
  const planeElements = [];
  const bounds = (b) => create('dc:Bounds', { x: b.x, y: b.y, width: b.width, height: b.height });
  const diId = (id) => {
    const di = `${id}_di`;
    if (model.ids.has(di)) throw new SpecError([`id "${di}" collides with a generated DI id`]);
    return di;
  };
  const addShape = (id) => {
    const s = layout.shapes.get(id);
    if (!s) throw new Error(`layout has no shape for ${id}`);
    if (!elements.has(id)) throw new Error(`no semantic element for shape ${id}`);
    const di = create('bpmndi:BPMNShape', { id: diId(id), bpmnElement: elements.get(id), bounds: bounds(s) });
    if (s.isHorizontal) di.isHorizontal = true;
    if (s.isExpanded) di.isExpanded = true;
    if (s.label) di.label = create('bpmndi:BPMNLabel', { bounds: bounds(s.label) });
    planeElements.push(di);
  };
  const addEdge = (id) => {
    const e = layout.edges.get(id);
    if (!e) throw new Error(`layout has no edge for ${id}`);
    if (!elements.has(id)) throw new Error(`no semantic element for edge ${id}`);
    const di = create('bpmndi:BPMNEdge', {
      id: diId(id),
      bpmnElement: elements.get(id),
      waypoint: e.waypoints.map((p) => create('dc:Point', { x: p.x, y: p.y }))
    });
    if (e.label) di.label = create('bpmndi:BPMNLabel', { bounds: bounds(e.label) });
    planeElements.push(di);
  };
  const shapeContainer = (container) => {
    for (const n of container.nodes) {
      addShape(n.id);
      for (const b of n.boundaries) addShape(b.id);
      if (n.child) shapeContainer(n.child);
    }
  };
  const edgeContainer = (container) => {
    for (const f of container.flows) addEdge(f.id);
    for (const n of container.nodes) if (n.child) edgeContainer(n.child);
  };
  const shapeProcess = (p) => {
    for (const l of p.lanes) addShape(l.id);
    shapeContainer(p.root);
    for (const d of p.dataStores) addShape(d.id);
  };
  if (model.collaboration) {
    for (const pt of model.collaboration.participants) {
      addShape(pt.id);
      if (pt.process) shapeProcess(pt.process);
    }
  } else {
    shapeProcess(model.processes[0]);
  }
  for (const p of model.processes) {
    edgeContainer(p.root);
    for (const d of p.dataStores) {
      for (const n of d.readers) addEdge(`DataInputAssociation_${n.id}_${d.id}`);
      for (const n of d.writers) addEdge(`DataOutputAssociation_${n.id}_${d.id}`);
    }
  }
  if (model.collaboration) for (const mf of model.collaboration.messageFlows) addEdge(mf.id);

  const plane = create('bpmndi:BPMNPlane', {
    id: PLANE_ID,
    bpmnElement: collabEl ?? processEls[0],
    planeElement: planeElements
  });

  const definitions = create('bpmn:Definitions', {
    id: model.definitionsId,
    name: model.name,
    targetNamespace: 'http://bpmn.io/schema/bpmn',
    exporter: GENERATOR.exporter,
    exporterVersion: GENERATOR.exporterVersion,
    rootElements: [
      ...(collabEl ? [collabEl] : []),
      ...processEls,
      ...rootMessages.values(),
      ...rootSignals.values(),
      ...rootErrors.values(),
      ...rootEscalations.values()
    ],
    diagrams: [create('bpmndi:BPMNDiagram', { id: DIAGRAM_ID, plane })]
  });
  definitions.set('modeler:executionPlatform', ENGINES[model.engine].executionPlatform);
  definitions.set('modeler:executionPlatformVersion', model.engineVersion);

  const { xml } = await moddle.toXML(definitions, { format: true });
  const header = `<!-- Generated by eval/tools/generate.mjs from ${specRel}. Do not edit; change the spec and regenerate. -->`;
  const out = xml.replace(/^(<\?xml[^>]*\?>)\n/, `$1\n${header}\n`);
  return out.endsWith('\n') ? out : `${out}\n`;
}
