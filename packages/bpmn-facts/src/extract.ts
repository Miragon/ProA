import { formatRef, isElementId, isModelKey } from '@proa/contracts';
import type {
  EventDef,
  Fact,
  FactAttrs,
  FactKind,
  FactScope,
  MessageFlowInfo,
  ProcessInfo,
  Ref,
} from '@proa/contracts';

import { BpmnInputError } from './errors.ts';
import { factFingerprint } from './fingerprint.ts';
import { assertSafeXml, resolveLimits } from './input.ts';
import type { ParseLimits } from './input.ts';
import {
  child,
  children,
  extensionValues,
  isA,
  isElement,
  ownStr,
  parseBpmn,
  prop,
  str,
} from './moddle.ts';
import type { ModdleElement, ModdleExtension, ParseWarning } from './moddle.ts';
import { normalizeKey } from './normalize.ts';
import { compareFacts, compareStrings } from './order.ts';
import {
  MAX_DOCUMENTATION_LENGTH,
  MAX_KEY_LENGTH,
  MAX_LABEL_LENGTH,
  sanitizeBlock,
  sanitizeLine,
} from './sanitize.ts';
import { FACTS_VERSION } from './version.ts';
import {
  declaredNamespaces,
  localName,
  namespaceOf,
  rootAttributeNS,
  scanXml,
} from './xml-scan.ts';
import type { RootTag } from './xml-scan.ts';

export const BPMN_MODEL_NAMESPACE = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
const CAMUNDA_NAMESPACE = 'http://camunda.org/schema/1.0/bpmn';
const ZEEBE_NAMESPACE = 'http://camunda.org/schema/zeebe/1.0';
const MODELER_NAMESPACE = 'http://camunda.org/schema/modeler/1.0';

/** At most this many warnings are reported, then one `too-many-warnings`. */
export const MAX_WARNINGS = 100;

/** Camunda 7 or Camunda 8. */
export type Engine = 'c7' | 'c8';

const EXECUTION_PLATFORMS: Readonly<Record<string, Engine>> = {
  'Camunda Platform': 'c7',
  'Camunda Cloud': 'c8',
};

export interface ExtractOptions {
  /** Model key the refs are built from, e.g. `finanzen/rechnungsstellung`. */
  modelKey: string;
  /** Overrides of `DEFAULT_PARSE_LIMITS`. */
  limits?: Partial<ParseLimits>;
}

/**
 * A non-fatal observation. Codes: `parse-warning` (bpmn-moddle: unknown or
 * unparsable content, unresolved references, duplicate ids),
 * `missing-id`, `invalid-id`, `duplicate-id` (element skipped),
 * `label-truncated`, `key-truncated`, `documentation-truncated`,
 * `call-without-target`, `multiple-event-definitions`,
 * `message-flow-unresolved`, `too-many-warnings`.
 */
export interface ExtractWarning {
  code: string;
  message: string;
  /** Element the warning is about, if any. */
  elementId?: string;
}

export interface ExtractResult {
  modelKey: string;
  factsVersion: typeof FACTS_VERSION;
  /**
   * From `modeler:executionPlatform` (`Camunda Platform` → `c7`,
   * `Camunda Cloud` → `c8`); without it from the declared namespace (only
   * `camunda` → `c7`, only `zeebe` → `c8`); otherwise `null`.
   */
  engine: Engine | null;
  /** Every `bpmn:process` of the file, with its participant name if it is in a collaboration; sorted by id. */
  processes: ProcessInfo[];
  /** All facts in canonical order: by kind (`FactKind` enum order), then element id. */
  facts: Fact[];
  /** Message flows inside this file (facts without lifecycle, never relations); sorted by id. */
  messageFlows: MessageFlowInfo[];
  warnings: ExtractWarning[];
}

interface Ctx {
  /** Owning process; `null` for collaboration-level elements (message flows). */
  processId: string | null;
  /** Innermost container: the process, an embedded subprocess or an event subprocess. */
  scope: FactScope;
  /** Id of the innermost enclosing (event) subprocess. */
  subprocessId?: string | undefined;
}

interface FactFields {
  eventDef?: EventDef | null;
  /** Raw label; default: the element's name. */
  label?: string | undefined;
  /** Raw key; default: the sanitized label. */
  keyRaw?: string | undefined;
  /** Raw referenced name for the fingerprint (message, signal, call target). */
  refName?: string | null;
  attrs?: FactAttrs;
}

const EVENT_DEFINITIONS: ReadonlyArray<readonly [string, EventDef]> = [
  ['bpmn:MessageEventDefinition', 'message'],
  ['bpmn:SignalEventDefinition', 'signal'],
  ['bpmn:TimerEventDefinition', 'timer'],
  ['bpmn:ConditionalEventDefinition', 'conditional'],
  ['bpmn:ErrorEventDefinition', 'error'],
  ['bpmn:EscalationEventDefinition', 'escalation'],
  ['bpmn:TerminateEventDefinition', 'terminate'],
  ['bpmn:LinkEventDefinition', 'link'],
  ['bpmn:CompensateEventDefinition', 'compensate'],
];

/** `null` for definitions outside the `EventDef` vocabulary (`cancel`, foreign extensions). */
function eventDefOf(definition: ModdleElement): EventDef | null {
  return EVENT_DEFINITIONS.find(([type]) => isA(definition, type))?.[1] ?? null;
}

type Dialect = 'juel' | 'feel';

/** C7 (JUEL): `${…}` or `#{…}` anywhere; C8 (FEEL): a leading `=`. */
function isExpression(value: string, dialects: readonly Dialect[]): boolean {
  return dialects.some((d) => (d === 'juel' ? /[$#]\{/.test(value) : /^\s*=/.test(value)));
}

function oneLine(text: string, max = 500): string {
  return sanitizeLine(text, max).text;
}

/** `value`, unless it is missing or holds nothing but whitespace, control and bidi characters. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && oneLine(value) !== '' ? value : undefined;
}

/** Drops `undefined` members so facts compare, hash and serialize the same everywhere. */
function compact(attrs: FactAttrs): FactAttrs {
  return Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined));
}

/**
 * A free-text attribute value kept in `attrs` (call binding, version,
 * version tag, tenant id, correlation key): sanitized like a key (control
 * and bidi characters removed, whitespace collapsed, at most
 * `MAX_KEY_LENGTH`); `undefined` if nothing is left. Facts hold no control
 * characters anywhere: PostgreSQL `jsonb` cannot store U+0000, and agents
 * read these values (CONCEPT §6).
 */
function attrText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = oneLine(value, MAX_KEY_LENGTH);
  return text === '' ? undefined : text;
}

/** An element id kept in `attrs` (host, subprocess, participant, lane members, readers): only a valid NCName. */
function attrId(value: string | undefined): string | undefined {
  return value !== undefined && isElementId(value) ? value : undefined;
}

/**
 * Zeebe extension element of a type. Files whose zeebe namespace the
 * detection missed hold it as a generic element, matched by local name.
 */
function zeebeExtension(
  el: ModdleElement,
  type: 'CalledElement' | 'Subscription',
): ModdleElement | undefined {
  const values = extensionValues(el);
  return (
    values.find((v) => isA(v, `zeebe:${type}`)) ??
    values.find((v) => localName(v.$type).toLowerCase() === type.toLowerCase())
  );
}

function detectEngine(root: RootTag): { engine: Engine | null; extension: ModdleExtension } {
  const platform = rootAttributeNS(root, MODELER_NAMESPACE, 'executionPlatform');
  const namespaces = declaredNamespaces(root);
  const camunda = namespaces.has(CAMUNDA_NAMESPACE);
  const zeebe = namespaces.has(ZEEBE_NAMESPACE);
  let engine: Engine | null =
    platform !== undefined ? (EXECUTION_PLATFORMS[platform] ?? null) : null;
  if (engine === null && camunda !== zeebe) engine = zeebe ? 'c8' : 'c7';
  const extension: ModdleExtension =
    engine === 'c8' || (engine === null && zeebe) ? 'zeebe' : 'camunda';
  return { engine, extension };
}

class Extraction {
  readonly facts = new Map<string, Fact>();
  readonly warnings: ExtractWarning[] = [];
  private omittedWarnings = 0;
  readonly modelKey: string;
  readonly engine: Engine | null;
  /** Expression syntax of message and signal names: by engine, both if unknown. */
  private readonly nameDialects: readonly Dialect[];

  constructor(modelKey: string, engine: Engine | null) {
    this.modelKey = modelKey;
    this.engine = engine;
    this.nameDialects = engine === 'c7' ? ['juel'] : engine === 'c8' ? ['feel'] : ['juel', 'feel'];
  }

  warn(code: string, message: string, elementId?: string): void {
    if (this.warnings.length >= MAX_WARNINGS) {
      this.omittedWarnings++;
      return;
    }
    const text = oneLine(message, 1000);
    const id = elementId === undefined ? '' : oneLine(elementId, 255);
    this.warnings.push(
      id === '' ? { code, message: text } : { code, message: text, elementId: id },
    );
  }

  finishWarnings(): ExtractWarning[] {
    if (this.omittedWarnings > 0) {
      this.warnings.push({
        code: 'too-many-warnings',
        message: `${this.omittedWarnings} more warnings omitted`,
      });
    }
    return this.warnings;
  }

  /** Ref of an element, or `null` (with a warning) if its id is missing or not an NCName. */
  refOf(el: ModdleElement): Ref | null {
    const id = str(el, 'id');
    if (id === undefined || id === '') {
      this.warn('missing-id', `<${el.$type}> without id skipped`);
      return null;
    }
    try {
      return formatRef(this.modelKey, id);
    } catch {
      const shown = id.length > 80 ? `${id.slice(0, 80)}…` : id;
      this.warn(
        'invalid-id',
        `<${el.$type}> id ${JSON.stringify(shown)} is not a valid element id; skipped`,
      );
      return null;
    }
  }

  line(raw: string | undefined, max: number, code: string, elementId: string): string {
    const { text, truncated } = sanitizeLine(raw ?? '', max);
    if (truncated) this.warn(code, `cut to ${max} characters`, elementId);
    return text;
  }

  documentation(el: ModdleElement, elementId: string): string | undefined {
    const raw = children(el, 'documentation')
      .map((d) => str(d, 'text') ?? '')
      .filter((t) => t.trim() !== '')
      .join('\n\n');
    const { text, truncated } = sanitizeBlock(raw, MAX_DOCUMENTATION_LENGTH);
    if (truncated) {
      this.warn(
        'documentation-truncated',
        `cut to ${MAX_DOCUMENTATION_LENGTH} characters`,
        elementId,
      );
    }
    return text === '' ? undefined : text;
  }

  /** Adds one fact; returns it, or `null` if the element was skipped. */
  add(kind: FactKind, el: ModdleElement, ctx: Ctx, fields: FactFields = {}): Fact | null {
    const ref = this.refOf(el);
    if (ref === null) return null;
    const elementId = ref.slice(ref.indexOf('#') + 1);
    const identity = `${kind}#${elementId}`;
    if (this.facts.has(identity)) {
      this.warn('duplicate-id', `a second ${kind} with id ${elementId} skipped`, elementId);
      return null;
    }
    const eventDef = fields.eventDef ?? null;
    const label = this.line(
      fields.label ?? str(el, 'name'),
      MAX_LABEL_LENGTH,
      'label-truncated',
      elementId,
    );
    const keyRaw =
      fields.keyRaw !== undefined
        ? this.line(fields.keyRaw, MAX_KEY_LENGTH, 'key-truncated', elementId)
        : label;
    const fact: Fact = {
      modelKey: this.modelKey,
      ref,
      kind,
      elementId,
      processId: ctx.processId,
      scope: ctx.scope,
      eventDef,
      label,
      keyRaw,
      keyNorm: normalizeKey(keyRaw),
      fingerprint: factFingerprint({
        kind,
        eventDef,
        keyRaw,
        label,
        scope: ctx.scope,
        refName:
          fields.refName === undefined
            ? null
            : sanitizeLine(fields.refName ?? '', MAX_KEY_LENGTH).text,
      }),
      attrs: compact({
        elementType: el.$type,
        ...fields.attrs,
        subprocessId: ctx.subprocessId,
        documentation: this.documentation(el, elementId),
      }),
    };
    this.facts.set(identity, fact);
    return fact;
  }

  // ------------------------------------------------------------ processes

  process(proc: ModdleElement, participant: ModdleElement | undefined): ProcessInfo | null {
    const processId = str(proc, 'id');
    const name = oneLine(str(proc, 'name') ?? '', MAX_LABEL_LENGTH);
    const participantName = participant
      ? oneLine(str(participant, 'name') ?? '', MAX_LABEL_LENGTH)
      : '';
    const isExecutable = prop(proc, 'isExecutable') === true;
    const fact = this.add(
      'process',
      proc,
      { processId: processId ?? null, scope: 'process' },
      {
        label: nonEmpty(str(proc, 'name')) ?? participantName,
        keyRaw: processId,
        attrs: {
          participantId: participant ? attrId(str(participant, 'id')) : undefined,
          participantName: participantName === '' ? undefined : participantName,
          isExecutable,
        },
      },
    );
    if (fact === null) return null;
    this.walk(proc, fact.elementId);
    return {
      ref: fact.ref,
      processId: fact.elementId,
      name: name === '' ? null : name,
      participantName: participantName === '' ? null : participantName,
      isExecutable,
    };
  }

  /** Walks a process breadth-first with an explicit queue (no recursion: nesting depth is unbounded). */
  private walk(proc: ModdleElement, processId: string): void {
    const nodes: ModdleElement[] = [];
    const stores: Array<{ el: ModdleElement; ctx: Ctx }> = [];
    const queue: Array<{ container: ModdleElement; ctx: Ctx }> = [
      { container: proc, ctx: { processId, scope: 'process' } },
    ];
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (item === undefined) continue;
      this.lanes(item.container, item.ctx);
      for (const el of children(item.container, 'flowElements')) {
        if (isA(el, 'bpmn:SequenceFlow')) continue;
        nodes.push(el);
        if (isA(el, 'bpmn:SubProcess')) {
          queue.push({
            container: el,
            ctx: {
              processId,
              scope: prop(el, 'triggeredByEvent') === true ? 'event_subprocess' : 'subprocess',
              subprocessId: attrId(str(el, 'id')),
            },
          });
        } else if (isA(el, 'bpmn:DataStoreReference')) {
          stores.push({ el, ctx: item.ctx });
        } else {
          this.flowElement(el, item.ctx);
        }
      }
    }
    this.dataStores(stores, nodes);
  }

  /** Gateways, data objects and other flow elements produce no facts. */
  private flowElement(el: ModdleElement, ctx: Ctx): void {
    if (isA(el, 'bpmn:Event')) {
      this.event(el, ctx);
    } else if (isA(el, 'bpmn:CallActivity')) {
      this.call(el, ctx);
    } else if (isA(el, 'bpmn:SendTask')) {
      this.message('msg_throw', el, ctx, null, child(el, 'messageRef'));
    } else if (isA(el, 'bpmn:ReceiveTask')) {
      this.message('msg_catch', el, ctx, null, child(el, 'messageRef'));
    } else if (isA(el, 'bpmn:Task')) {
      this.add('task', el, ctx);
    }
  }

  // --------------------------------------------------------------- events

  private event(el: ModdleElement, ctx: Ctx): void {
    const definitions = [
      ...children(el, 'eventDefinitions'),
      ...children(el, 'eventDefinitionRefs'),
    ];
    const [first] = definitions;
    const eventDef: EventDef | null =
      first === undefined ? 'none' : definitions.length > 1 ? 'multiple' : eventDefOf(first);
    if (eventDef === null) return; // cancel or foreign definitions: no fact in v1
    if (eventDef === 'multiple') {
      this.warn(
        'multiple-event-definitions',
        `${definitions.length} event definitions; message and signal parts become facts with eventDef "multiple"`,
        str(el, 'id'),
      );
    }
    const attrs: FactAttrs = {};
    if (isA(el, 'bpmn:BoundaryEvent')) {
      const host = child(el, 'attachedToRef');
      attrs.attachedTo = host ? attrId(str(host, 'id')) : undefined;
      attrs.interrupting = prop(el, 'cancelActivity') !== false;
    } else if (isA(el, 'bpmn:StartEvent') && ctx.scope === 'event_subprocess') {
      attrs.interrupting = prop(el, 'isInterrupting') !== false;
    }

    const throwing = isA(el, 'bpmn:ThrowEvent');
    const firstRef = (type: string, refName: string): ModdleElement | undefined => {
      for (const d of definitions) {
        const ref = isA(d, type) ? child(d, refName) : undefined;
        if (ref) return ref;
      }
      return undefined;
    };
    if (definitions.some((d) => isA(d, 'bpmn:MessageEventDefinition'))) {
      const message = firstRef('bpmn:MessageEventDefinition', 'messageRef');
      this.message(throwing ? 'msg_throw' : 'msg_catch', el, ctx, eventDef, message, attrs);
    }
    if (definitions.some((d) => isA(d, 'bpmn:SignalEventDefinition'))) {
      const signal = firstRef('bpmn:SignalEventDefinition', 'signalRef');
      this.signal(throwing ? 'sig_throw' : 'sig_catch', el, ctx, eventDef, signal, attrs);
    }
    if (
      isA(el, 'bpmn:StartEvent') &&
      (eventDef === 'none' || eventDef === 'timer' || eventDef === 'conditional')
    ) {
      this.add('evt_start', el, ctx, { eventDef, attrs });
    }
    if (isA(el, 'bpmn:EndEvent') && (eventDef === 'none' || eventDef === 'terminate')) {
      this.add('evt_end', el, ctx, { eventDef, attrs });
    }
  }

  /** `msg_throw` / `msg_catch`: key = message name, else label. */
  private message(
    kind: 'msg_throw' | 'msg_catch',
    el: ModdleElement,
    ctx: Ctx,
    eventDef: EventDef | null,
    message: ModdleElement | undefined,
    attrs: FactAttrs = {},
  ): void {
    const name = message ? nonEmpty(str(message, 'name')) : undefined;
    const subscription = message ? zeebeExtension(message, 'Subscription') : undefined;
    this.add(kind, el, ctx, {
      eventDef,
      keyRaw: name,
      refName: name ?? null,
      attrs: {
        ...attrs,
        messageName: name === undefined ? undefined : oneLine(name, MAX_KEY_LENGTH),
        dynamic: name !== undefined && isExpression(name, this.nameDialects),
        correlationKey: subscription ? attrText(ownStr(subscription, 'correlationKey')) : undefined,
      },
    });
  }

  /** `sig_throw` / `sig_catch`: key = signal name, else label. */
  private signal(
    kind: 'sig_throw' | 'sig_catch',
    el: ModdleElement,
    ctx: Ctx,
    eventDef: EventDef | null,
    signal: ModdleElement | undefined,
    attrs: FactAttrs,
  ): void {
    const name = signal ? nonEmpty(str(signal, 'name')) : undefined;
    this.add(kind, el, ctx, {
      eventDef,
      keyRaw: name,
      refName: name ?? null,
      attrs: {
        ...attrs,
        signalName: name === undefined ? undefined : oneLine(name, MAX_KEY_LENGTH),
        dynamic: name !== undefined && isExpression(name, this.nameDialects),
      },
    });
  }

  // ---------------------------------------------------------------- calls

  /**
   * `call`: key = C7 `calledElement` or C8 `zeebe:calledElement@processId`.
   * In a C7 file the attribute wins over a stray zeebe extension; elsewhere
   * the zeebe extension wins (Zeebe ignores the attribute).
   */
  private call(el: ModdleElement, ctx: Ctx): void {
    const zeebe = zeebeExtension(el, 'CalledElement');
    const attribute = str(el, 'calledElement');
    let target: string | undefined;
    let attrs: FactAttrs;
    if (zeebe && !(this.engine === 'c7' && attribute !== undefined)) {
      target = nonEmpty(ownStr(zeebe, 'processId'));
      attrs = {
        dynamic: target !== undefined && isExpression(target, ['feel']),
        binding: attrText(ownStr(zeebe, 'bindingType')),
        versionTag: attrText(ownStr(zeebe, 'versionTag')),
      };
    } else {
      target = nonEmpty(attribute);
      attrs = {
        dynamic: target !== undefined && isExpression(target, ['juel']),
        binding: attrText(ownStr(el, 'calledElementBinding')),
        version: attrText(ownStr(el, 'calledElementVersion')),
        versionTag: attrText(ownStr(el, 'calledElementVersionTag')),
        tenantId: attrText(ownStr(el, 'calledElementTenantId')),
      };
    }
    const fact = this.add('call', el, ctx, {
      keyRaw: target ?? '',
      refName: target ?? null,
      attrs,
    });
    if (fact !== null && target === undefined) {
      const caseRef = ownStr(el, 'caseRef');
      this.warn(
        'call-without-target',
        caseRef === undefined
          ? 'call activity without calledElement'
          : `call activity calls a CMMN case (camunda:caseRef ${JSON.stringify(caseRef)}), not a process`,
        fact.elementId,
      );
    }
  }

  // ------------------------------------------------------ lanes, data stores

  private lanes(container: ModdleElement, ctx: Ctx): void {
    const queue = children(container, 'laneSets').flatMap((set) => children(set, 'lanes'));
    for (let i = 0; i < queue.length; i++) {
      const lane = queue[i];
      if (lane === undefined) continue;
      const flowNodeRefs = children(lane, 'flowNodeRef')
        .map((node) => attrId(str(node, 'id')))
        .filter((id): id is string => id !== undefined)
        .sort(compareStrings);
      this.add('lane', lane, ctx, { attrs: { flowNodeRefs } });
      queue.push(...children(child(lane, 'childLaneSet'), 'lanes'));
    }
  }

  /** `data_store` per DataStoreReference; who reads and writes comes from the data associations. */
  private dataStores(
    stores: ReadonlyArray<{ el: ModdleElement; ctx: Ctx }>,
    nodes: readonly ModdleElement[],
  ): void {
    if (stores.length === 0) return;
    const readBy = new Map<ModdleElement, Set<string>>();
    const writtenBy = new Map<ModdleElement, Set<string>>();
    const note = (map: Map<ModdleElement, Set<string>>, store: ModdleElement, id: string): void => {
      const ids = map.get(store) ?? new Set<string>();
      ids.add(id);
      map.set(store, ids);
    };
    for (const node of nodes) {
      const id = attrId(str(node, 'id'));
      if (id === undefined) continue;
      for (const assoc of children(node, 'dataInputAssociations')) {
        for (const source of children(assoc, 'sourceRef')) {
          if (isA(source, 'bpmn:DataStoreReference')) note(readBy, source, id);
        }
      }
      for (const assoc of children(node, 'dataOutputAssociations')) {
        const target = child(assoc, 'targetRef');
        if (target && isA(target, 'bpmn:DataStoreReference')) note(writtenBy, target, id);
      }
    }
    for (const { el, ctx } of stores) {
      const store = child(el, 'dataStoreRef');
      this.add('data_store', el, ctx, {
        label: nonEmpty(str(el, 'name')) ?? (store ? str(store, 'name') : undefined),
        attrs: {
          readBy: [...(readBy.get(el) ?? [])].sort(compareStrings),
          writtenBy: [...(writtenBy.get(el) ?? [])].sort(compareStrings),
        },
      });
    }
  }

  // --------------------------------------------------------- message flows

  messageFlow(flow: ModdleElement): MessageFlowInfo | null {
    const source = child(flow, 'sourceRef');
    const target = child(flow, 'targetRef');
    const from = source ? this.endpointRef(source) : null;
    const to = target ? this.endpointRef(target) : null;
    if (from === null || to === null) {
      this.warn(
        'message-flow-unresolved',
        'message flow without a valid source or target skipped',
        str(flow, 'id'),
      );
      return null;
    }
    const message = child(flow, 'messageRef');
    const messageName = message ? nonEmpty(str(message, 'name')) : undefined;
    const fact = this.add(
      'message_flow',
      flow,
      { processId: null, scope: 'process' },
      {
        keyRaw: nonEmpty(str(flow, 'name')) ?? messageName ?? '',
        refName: messageName ?? null,
        attrs: {
          sourceRef: from,
          targetRef: to,
          messageName: messageName === undefined ? undefined : oneLine(messageName, MAX_KEY_LENGTH),
        },
      },
    );
    if (fact === null) return null;
    return {
      ref: fact.ref,
      elementId: fact.elementId,
      name: fact.label === '' ? null : fact.label,
      from,
      to,
      messageName: messageName === undefined ? null : oneLine(messageName, MAX_KEY_LENGTH),
    };
  }

  private endpointRef(el: ModdleElement): Ref | null {
    const id = str(el, 'id');
    if (id === undefined) return null;
    try {
      return formatRef(this.modelKey, id);
    } catch {
      return null;
    }
  }
}

function warningElementId(warning: ParseWarning): string | undefined {
  return isElement(warning.element) ? str(warning.element, 'id') : undefined;
}

/**
 * Extracts the facts of one BPMN file (CONCEPT §2): processes, call
 * activities, message and signal throws/catches (incl. boundary events,
 * event-subprocess starts, send/receive tasks), none/timer/conditional starts
 * and none/terminate ends, data stores, message flows, lanes and tasks, each
 * with `scope`, `eventDef`, sanitized `label`, `keyRaw`, `keyNorm`,
 * `fingerprint` and `attrs`. Timer, conditional, error, escalation, link and
 * compensation events that are neither starts nor ends of the listed kinds
 * produce no facts (out of v1).
 *
 * Runs `assertSafeXml` first, counts elements before parsing, and parses
 * with bpmn-moddle plus the camunda (C7) or zeebe (C8) extension.
 *
 * @throws {BpmnInputError} for hostile, oversized or malformed input, or an invalid model key
 */
export async function extractFacts(
  xml: string | Uint8Array,
  opts: ExtractOptions,
): Promise<ExtractResult> {
  const { modelKey } = opts;
  if (!isModelKey(modelKey)) {
    throw new BpmnInputError(
      'invalid-model-key',
      `invalid model key ${JSON.stringify(modelKey)}: lowercase slug segments separated by /, e.g. billing/dunning`,
    );
  }
  const limits = resolveLimits(opts.limits);
  const text = assertSafeXml(xml, limits);
  const { root } = scanXml(text, limits.maxElements);
  if (
    localName(root.name) !== 'definitions' ||
    namespaceOf(root, root.name) !== BPMN_MODEL_NAMESPACE
  ) {
    throw new BpmnInputError(
      'not-bpmn',
      `root element <${root.name}> is not a BPMN 2.0 <definitions> (${BPMN_MODEL_NAMESPACE})`,
    );
  }
  const { engine, extension } = detectEngine(root);

  let definitions: ModdleElement | undefined;
  let parseWarnings: ParseWarning[];
  try {
    const parsed = await parseBpmn(text, extension);
    definitions = parsed.rootElement;
    parseWarnings = parsed.warnings;
  } catch (err) {
    throw new BpmnInputError(
      'not-xml',
      `BPMN could not be parsed: ${oneLine(err instanceof Error ? err.message : String(err))}`,
    );
  }
  if (!definitions || !isA(definitions, 'bpmn:Definitions')) {
    throw new BpmnInputError('not-bpmn', 'the document is not a BPMN 2.0 <definitions>');
  }

  const x = new Extraction(modelKey, engine);
  for (const w of parseWarnings) x.warn('parse-warning', oneLine(w.message), warningElementId(w));

  const rootElements = children(definitions, 'rootElements');
  const collaborations = rootElements.filter((e) => isA(e, 'bpmn:Collaboration'));
  const participants = new Map<string, ModdleElement>();
  for (const collaboration of collaborations) {
    for (const participant of children(collaboration, 'participants')) {
      const processRef = child(participant, 'processRef');
      const processId = processRef ? str(processRef, 'id') : undefined;
      if (processId !== undefined && !participants.has(processId)) {
        participants.set(processId, participant);
      }
    }
  }

  const processes: ProcessInfo[] = [];
  for (const proc of rootElements.filter((e) => isA(e, 'bpmn:Process'))) {
    const id = str(proc, 'id');
    const info = x.process(proc, id === undefined ? undefined : participants.get(id));
    if (info) processes.push(info);
  }
  const messageFlows: MessageFlowInfo[] = [];
  for (const collaboration of collaborations) {
    for (const flow of children(collaboration, 'messageFlows')) {
      const info = x.messageFlow(flow);
      if (info) messageFlows.push(info);
    }
  }

  return {
    modelKey,
    factsVersion: FACTS_VERSION,
    engine,
    processes: processes.sort((a, b) => compareStrings(a.processId, b.processId)),
    facts: [...x.facts.values()].sort(compareFacts),
    messageFlows: messageFlows.sort((a, b) => compareStrings(a.elementId, b.elementId)),
    warnings: x.finishWarnings(),
  };
}
