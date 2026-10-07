// zod schemas for the eval corpus files: model specs, landscape.yaml, expected.yaml.
import { z } from 'zod';

import {
  ALL_TAGS,
  EXPECT_VALUES,
  FINDING_KINDS,
  RELATION_TYPES
} from './constants.mjs';

// ---------------------------------------------------------------- primitives

/** XML NCName subset: letters, digits, `_` and `-`; no dots, so refs stay unambiguous. */
export const Id = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, 'must start with a letter or _ and contain only letters, digits, _ and -');

/** Model key: lowercase slug segments separated by `/`, e.g. `finanzen/rechnungsstellung`. */
export const ModelKey = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/,
    'must be lowercase slug segments separated by /, e.g. finanzen/rechnungsstellung'
  );

/** `<model_key>#<element_or_process_id>` */
export const Ref = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*#[A-Za-z_][A-Za-z0-9_-]*$/,
    'must be <model_key>#<id>'
  );

export const Version = z.string().regex(/^\d+\.\d+\.\d+$/, 'must be a full version like 8.9.0');

const Text = z.string().trim().min(1);
const Tag = z.enum(ALL_TAGS);

// ---------------------------------------------------------- event definitions

const MessageDef = z.union([
  Text,
  z.strictObject({ name: Text, correlationKey: Text.optional() })
]);
const SignalDef = z.union([Text, z.strictObject({ name: Text })]);
const TimerDef = z.union([
  z.strictObject({ duration: Text }),
  z.strictObject({ cycle: Text }),
  z.strictObject({ date: Text })
]);
const CodeDef = z.union([
  Text,
  z.strictObject({ code: Text.optional(), name: Text.optional() })
]);
const ConditionalDef = z.union([
  Text,
  z.strictObject({ condition: Text, variableName: Text.optional() })
]);

const eventDefinitionFields = {
  message: MessageDef.optional(),
  signal: SignalDef.optional(),
  timer: TimerDef.optional(),
  error: CodeDef.optional(),
  escalation: CodeDef.optional(),
  conditional: ConditionalDef.optional(),
  terminate: z.literal(true).optional()
};

export const EVENT_DEFINITION_KEYS = Object.keys(eventDefinitionFields);

// --------------------------------------------------------------- flows/next

const FlowTarget = z.union([
  Id,
  z.strictObject({
    to: Id,
    id: Id.optional(),
    name: Text.optional(),
    condition: Text.optional(),
    default: z.boolean().optional()
  })
]);

/** `next`: one id, or a list of ids / flow objects. `[]` means "no outgoing flow". */
const Next = z.union([Id, z.array(FlowTarget)]);

// ----------------------------------------------------------------- elements

const base = {
  id: Id,
  name: Text.optional(),
  documentation: Text.optional()
};

const placed = {
  ...base,
  lane: Id.optional()
};

const BoundaryEvent = z.strictObject({
  ...base,
  interrupting: z.boolean().optional(),
  next: Next,
  ...eventDefinitionFields
});

const activity = {
  ...placed,
  next: Next.optional(),
  reads: z.array(Id).optional(),
  writes: z.array(Id).optional(),
  boundary: z.array(BoundaryEvent).optional()
};

const StartEvent = z.strictObject({
  type: z.literal('startEvent'),
  ...placed,
  next: Next.optional(),
  interrupting: z.boolean().optional(),
  ...eventDefinitionFields
});

const EndEvent = z.strictObject({
  type: z.literal('endEvent'),
  ...placed,
  topic: Text.optional(),
  ...eventDefinitionFields
});

const IntermediateThrowEvent = z.strictObject({
  type: z.literal('intermediateThrowEvent'),
  ...placed,
  next: Next.optional(),
  topic: Text.optional(),
  ...eventDefinitionFields
});

const IntermediateCatchEvent = z.strictObject({
  type: z.literal('intermediateCatchEvent'),
  ...placed,
  next: Next.optional(),
  ...eventDefinitionFields
});

const Task = z.strictObject({ type: z.literal('task'), ...activity });
const ManualTask = z.strictObject({ type: z.literal('manualTask'), ...activity });
const UserTask = z.strictObject({
  type: z.literal('userTask'),
  ...activity,
  assignee: Text.optional(),
  candidateGroups: Text.optional(),
  form: Text.optional()
});
const ServiceTask = z.strictObject({ type: z.literal('serviceTask'), ...activity, topic: Text.optional() });
const BusinessRuleTask = z.strictObject({
  type: z.literal('businessRuleTask'),
  ...activity,
  topic: Text.optional()
});
const SendTask = z.strictObject({
  type: z.literal('sendTask'),
  ...activity,
  topic: Text.optional(),
  message: MessageDef.optional()
});
const ReceiveTask = z.strictObject({ type: z.literal('receiveTask'), ...activity, message: MessageDef });
const ScriptTask = z.strictObject({
  type: z.literal('scriptTask'),
  ...activity,
  script: Text.optional(),
  scriptFormat: Text.optional(),
  resultVariable: Text.optional()
});
const CallActivity = z.strictObject({
  type: z.literal('callActivity'),
  ...activity,
  calledElement: Text,
  binding: z.enum(['latest', 'deployment', 'version', 'versionTag']).optional(),
  version: Text.optional(),
  versionTag: Text.optional()
});

const Gateway = (type) =>
  z.strictObject({ type: z.literal(type), ...placed, next: Next.optional() });

export const Element = z.discriminatedUnion('type', [
  StartEvent,
  EndEvent,
  IntermediateThrowEvent,
  IntermediateCatchEvent,
  Task,
  ManualTask,
  UserTask,
  ServiceTask,
  BusinessRuleTask,
  SendTask,
  ReceiveTask,
  ScriptTask,
  CallActivity,
  z.strictObject({
    type: z.literal('subProcess'),
    ...activity,
    get elements() {
      return z.array(Element).min(1);
    }
  }),
  z.strictObject({
    type: z.literal('eventSubProcess'),
    ...placed,
    get elements() {
      return z.array(Element).min(1);
    }
  }),
  Gateway('exclusiveGateway'),
  Gateway('parallelGateway'),
  Gateway('eventBasedGateway')
]);

export const ELEMENT_TYPES = Element.options.map((o) => o.shape.type.value);

// ---------------------------------------------------------------- processes

const Lane = z.strictObject({ id: Id, name: Text, documentation: Text.optional() });
const DataStore = z.strictObject({ id: Id, name: Text, documentation: Text.optional() });

const Process = z.strictObject({
  id: Id,
  name: Text.optional(),
  isExecutable: z.boolean().optional(),
  documentation: Text.optional(),
  historyTimeToLive: Text.optional(),
  lanes: z.array(Lane).min(1).optional(),
  dataStores: z.array(DataStore).optional(),
  elements: z.array(Element).min(1)
});

const Participant = z.strictObject({
  id: Id,
  name: Text,
  process: Id.optional(),
  documentation: Text.optional()
});

const MessageFlow = z.strictObject({
  id: Id.optional(),
  from: Id,
  to: Id,
  name: Text.optional(),
  message: Text.optional()
});

const Collaboration = z.strictObject({
  id: Id.optional(),
  name: Text.optional(),
  documentation: Text.optional(),
  participants: z.array(Participant).min(1),
  messageFlows: z.array(MessageFlow).optional()
});

export const ModelSpec = z.strictObject({
  key: ModelKey,
  engine: z.enum(['c7', 'c8']),
  engineVersion: Version.optional(),
  name: Text.optional(),
  notes: Text.optional(),
  processes: z.array(Process).min(1),
  collaboration: Collaboration.optional(),
  lint: z
    .strictObject({
      disable: z.array(z.strictObject({ rule: Text, reason: Text })).min(1)
    })
    .optional()
});

// ---------------------------------------------------------------- landscape

export const Landscape = z.strictObject({
  name: Text,
  description: Text,
  lang: z.enum(['de', 'en', 'mixed']),
  split: z.enum(['dev', 'holdout']),
  closed_world: z.boolean(),
  engines: z
    .strictObject({ c7: Version.optional(), c8: Version.optional() })
    .refine((e) => e.c7 || e.c8, 'declare at least one engine'),
  traps_not_applicable: z.partialRecord(z.enum(ALL_TAGS), Text).optional()
});

// ----------------------------------------------------------------- expected

const ExpectedRelation = z.strictObject({
  type: z.enum(RELATION_TYPES),
  from: Ref,
  to: Ref,
  expect: z.enum(EXPECT_VALUES),
  tags: z.array(Tag).min(1),
  rationale: Text
});

const ExpectedFinding = z.strictObject({
  kind: z.enum(FINDING_KINDS),
  refs: z.array(Ref).min(1),
  tags: z.array(Tag).optional(),
  rationale: Text
});

const DataStoreGroup = z.strictObject({
  name: Text,
  labels: z.array(Text).min(2),
  tags: z.array(Tag).optional(),
  rationale: Text.optional()
});

export const Expected = z.strictObject({
  relations: z.array(ExpectedRelation).default([]),
  expected_findings: z.array(ExpectedFinding).default([]),
  data_store_groups: z.array(DataStoreGroup).default([])
});

/** Formats zod issues as `path: message` lines. */
export function formatZodError(error) {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}
