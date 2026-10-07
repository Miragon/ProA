import { z } from 'zod';

import { ElementId, ModelKey, Ref } from './refs.ts';
import { orNull } from './zod-utils.ts';

/**
 * Fact kinds extracted by `@proa/bpmn-facts` (CONCEPT §2):
 *
 * | kind | source | `keyRaw` |
 * |---|---|---|
 * | `process` | `bpmn:process` (+ participant name) | process id |
 * | `call` | call activity | `calledElement` / `zeebe:calledElement@processId` |
 * | `msg_throw`, `msg_catch` | message events (incl. boundary, event-subprocess start), send/receive tasks | message name, else label |
 * | `sig_throw`, `sig_catch` | signal events | signal name |
 * | `evt_start`, `evt_end` | none/timer/conditional starts, none/terminate ends | label |
 * | `data_store`, `message_flow`, `lane`, `task` | inside one file | name |
 */
export const FactKind = z
  .enum([
    'process',
    'call',
    'msg_throw',
    'msg_catch',
    'sig_throw',
    'sig_catch',
    'evt_start',
    'evt_end',
    'data_store',
    'message_flow',
    'lane',
    'task',
  ])
  .meta({ id: 'FactKind', description: 'Kind of a fact extracted from a BPMN model.' });
export type FactKind = z.infer<typeof FactKind>;

/**
 * Where an element sits: directly in a process, inside an embedded
 * subprocess, or inside an event subprocess. Start and end events in
 * `subprocess` scope, and end events in `event_subprocess` scope, are never
 * relation endpoints; the typed start of an event subprocess is.
 */
export const FactScope = z
  .enum(['process', 'subprocess', 'event_subprocess'])
  .meta({ id: 'FactScope', description: 'Scope of the element within its process.' });
export type FactScope = z.infer<typeof FactScope>;

/** Event definition of an event (`none` for a plain event); `null` on non-events. */
export const EventDef = z
  .enum([
    'none',
    'message',
    'signal',
    'timer',
    'conditional',
    'error',
    'escalation',
    'terminate',
    'link',
    'compensate',
    'multiple',
  ])
  .meta({ id: 'EventDef', description: 'Event definition of an event; `none` for a plain event.' });
export type EventDef = z.infer<typeof EventDef>;

/**
 * Kind-specific extra attributes. Known keys are typed; extractors may add
 * more (the object is open). Stored as `fact.attrs jsonb`.
 */
export const FactAttrs = z
  .looseObject({
    /** BPMN type of the element, e.g. `bpmn:SendTask`, `bpmn:BoundaryEvent`. */
    elementType: z.string().optional(),
    /** `bpmn:documentation`, control and bidi characters stripped, ≤ 2,000 characters. */
    documentation: z.string().max(2000).optional(),
    /** `process`: name of the participant (pool) that references the process. */
    participantName: z.string().optional(),
    /** `process`: id of the participant (pool) that references the process; message flows refer to it. */
    participantId: z.string().optional(),
    /** `process`: `isExecutable`. */
    isExecutable: z.boolean().optional(),
    /**
     * `call`, `msg_*`, `sig_*`: the target or message/signal name is an
     * expression (C7 `${…}`/`#{…}`, C8 `=…`), so it is not a matching key.
     */
    dynamic: z.boolean().optional(),
    /**
     * `msg_*`, `message_flow`: name of the referenced `bpmn:message`. Present
     * only when the fact's key comes from a real message ref; absent when
     * `keyRaw` falls back to the label. Rules match on refs, never on labels.
     */
    messageName: z.string().optional(),
    /** `sig_*`: name of the referenced `bpmn:signal`; absent when `keyRaw` falls back to the label. */
    signalName: z.string().optional(),
    /** `msg_*` (C8): `zeebe:subscription` `correlationKey` of the referenced message. */
    correlationKey: z.string().optional(),
    /** Facts in `subprocess` or `event_subprocess` scope: id of the innermost enclosing (event) subprocess. */
    subprocessId: z.string().optional(),
    /** `data_store`: ids of the elements that read from the store (data input associations), sorted. */
    readBy: z.array(z.string()).optional(),
    /** `data_store`: ids of the elements that write to the store (data output associations), sorted. */
    writtenBy: z.array(z.string()).optional(),
    /** `lane`: ids of the flow nodes in the lane, sorted. */
    flowNodeRefs: z.array(z.string()).optional(),
    /** `call`: C7 `calledElementBinding` / C8 `bindingType`. */
    binding: z.string().optional(),
    /** `call`: C7 `calledElementVersion`. */
    version: z.string().optional(),
    /** `call`: C7 `calledElementVersionTag` / C8 `versionTag`. */
    versionTag: z.string().optional(),
    /** `call`: C7 `calledElementTenantId`. */
    tenantId: z.string().optional(),
    /** Boundary events: id of the host activity. */
    attachedTo: z.string().optional(),
    /** Boundary events and event-subprocess starts. */
    interrupting: z.boolean().optional(),
    /** `message_flow`: source and target refs. */
    sourceRef: Ref.optional(),
    targetRef: Ref.optional(),
  })
  .meta({ id: 'FactAttrs', description: 'Kind-specific attributes of a fact (open object).' });
export type FactAttrs = z.infer<typeof FactAttrs>;

/**
 * One fact of a model revision (CONCEPT §2). Identity within a revision is
 * `(kind, elementId)`.
 */
export const Fact = z
  .object({
    modelKey: ModelKey,
    /** `<modelKey>#<elementId>`. */
    ref: Ref,
    kind: FactKind,
    elementId: ElementId,
    /** Id of the owning `bpmn:process`; `null` for collaboration-level facts such as message flows. */
    processId: orNull(ElementId),
    scope: FactScope,
    eventDef: orNull(EventDef),
    /** Element name, trimmed, control and bidi characters stripped, ≤ 200 characters. */
    label: z.string().max(200),
    /** Matching key as found in the model (see {@link FactKind}). */
    keyRaw: z.string(),
    /** `keyRaw` normalized: NFKC, lowercase, ä/ö/ü/ß → ae/oe/ue/ss, punctuation → space, whitespace collapsed. */
    keyNorm: z.string(),
    /** `sha256(kind|event_def|ref_name_norm|label_norm|scope)`, first 12 hex characters. */
    fingerprint: z.string().regex(/^[0-9a-f]{12}$/),
    attrs: FactAttrs,
  })
  .meta({ id: 'Fact', description: 'A fact extracted from one BPMN model revision.' });
export type Fact = z.infer<typeof Fact>;

/** A `bpmn:process` of a model. */
export const ProcessInfo = z
  .object({
    ref: Ref,
    processId: ElementId,
    name: z.string().nullable(),
    /** Name of the participant (pool) referencing the process, if any. */
    participantName: z.string().nullable(),
    isExecutable: z.boolean(),
  })
  .meta({ id: 'ProcessInfo', description: 'A BPMN process defined in a model.' });
export type ProcessInfo = z.infer<typeof ProcessInfo>;

/** A message flow inside one collaboration file: a fact without lifecycle, never a relation. */
export const MessageFlowInfo = z
  .object({
    ref: Ref,
    elementId: ElementId,
    name: z.string().nullable(),
    /** Ref of the source element or participant. */
    from: Ref,
    /** Ref of the target element or participant. */
    to: Ref,
    /** Name of the referenced `bpmn:message`, if any. */
    messageName: z.string().nullable(),
  })
  .meta({ id: 'MessageFlowInfo', description: 'A message flow within one collaboration file.' });
export type MessageFlowInfo = z.infer<typeof MessageFlowInfo>;

/** All facts of one model (head revision), as consumed by `@proa/relations`. */
export const ModelFacts = z
  .object({
    modelKey: ModelKey,
    /** `FACTS_VERSION` of the extractor that produced the facts. */
    factsVersion: z.string(),
    processes: z.array(ProcessInfo),
    facts: z.array(Fact),
    messageFlows: z.array(MessageFlowInfo),
  })
  .meta({ id: 'ModelFacts', description: 'Facts of one model revision.' });
export type ModelFacts = z.infer<typeof ModelFacts>;

/** Head facts of every model of a project: the input of rules and candidate generation. */
export const ProjectFacts = z
  .object({ models: z.array(ModelFacts) })
  .meta({ id: 'ProjectFacts', description: "Head facts of all of a project's models." });
export type ProjectFacts = z.infer<typeof ProjectFacts>;
