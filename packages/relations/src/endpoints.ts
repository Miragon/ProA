// Endpoint semantics (CONCEPT §2, eval/README.md "Relation types and
// endpoints") and the landscape index shared by rules, candidates and the
// baseline.
import type { EventDef, Fact, ModelFacts, ProjectFacts, Ref, RelationType } from '@proa/contracts';

import { compareStrings } from './order.ts';

/** Relation types code can derive (`manual` is for humans only). */
export type LinkType = Exclude<RelationType, 'manual'>;

export const LINK_TYPES: readonly LinkType[] = ['call', 'message', 'signal', 'trigger'];

/** Which end of a relation a fact can be. */
export type Side = 'from' | 'to';

/**
 * Event-definition compatibility matrix: the `eventDef` values each end of a
 * relation type accepts (`null` = not an event: call activity, process,
 * send/receive task). Pairs outside this matrix are never rules, never
 * candidates: a timer or conditional start, a terminate end, an error or
 * escalation event never links, and a none end never reaches a message or
 * signal catch (the `event-def-mismatch` trap).
 */
export const EVENT_DEF_COMPATIBILITY: Readonly<
  Record<LinkType, Readonly<Record<Side, readonly (EventDef | null)[]>>>
> = {
  call: { from: [null], to: [null] },
  message: { from: ['message', 'multiple', null], to: ['message', 'multiple', null] },
  signal: { from: ['signal', 'multiple'], to: ['signal', 'multiple'] },
  trigger: { from: ['none'], to: ['none'] },
};

const ROLE_BY_KIND: Partial<Record<Fact['kind'], { type: LinkType; side: Side }>> = {
  call: { type: 'call', side: 'from' },
  process: { type: 'call', side: 'to' },
  msg_throw: { type: 'message', side: 'from' },
  msg_catch: { type: 'message', side: 'to' },
  sig_throw: { type: 'signal', side: 'from' },
  sig_catch: { type: 'signal', side: 'to' },
  evt_end: { type: 'trigger', side: 'from' },
  evt_start: { type: 'trigger', side: 'to' },
};

/**
 * Scope rule for start and end events (CONCEPT §2): start and end events
 * inside embedded subprocesses and end events inside event subprocesses are
 * never endpoints; the typed start of an event subprocess is. Intermediate
 * and boundary events, send/receive tasks and call activities are endpoints
 * in every scope.
 */
export function inEndpointScope(fact: Fact): boolean {
  const type = fact.attrs.elementType;
  if (type === 'bpmn:StartEvent') {
    if (fact.scope === 'process') return true;
    return fact.scope === 'event_subprocess' && fact.eventDef !== null && fact.eventDef !== 'none';
  }
  if (type === 'bpmn:EndEvent') return fact.scope === 'process';
  return true;
}

/**
 * The relation type and side a fact can take part in, or `null` if it is
 * never an endpoint. `trigger` endpoints are labelled none ends and labelled
 * none starts directly in a process.
 */
export function endpointRole(fact: Fact): { type: LinkType; side: Side } | null {
  const role = ROLE_BY_KIND[fact.kind];
  if (role === undefined) return null;
  if (!EVENT_DEF_COMPATIBILITY[role.type][role.side].includes(fact.eventDef)) return null;
  if (role.type === 'trigger' && (fact.label.trim() === '' || fact.scope !== 'process')) {
    return null;
  }
  return inEndpointScope(fact) ? role : null;
}

/** Ref of the process a fact belongs to; `null` for collaboration-level facts. */
export function processRefOf(fact: Fact): Ref | null {
  return fact.processId === null ? null : `${fact.modelKey}#${fact.processId}`;
}

/** A fact that can be the end of a relation. */
export interface Endpoint {
  readonly ref: Ref;
  readonly modelKey: string;
  /** Ref of the owning process. Endpoints of one relation lie in different processes. */
  readonly process: Ref;
  readonly type: LinkType;
  readonly side: Side;
  readonly fact: Fact;
  /**
   * The matching key from a real ref: message or signal name, static
   * `calledElement`, process id. `null` when the fact's key is only its label
   * or an expression (rules never match those).
   */
  readonly name: string | null;
}

/** A process with the names that may identify it. */
export interface ProcessEntry {
  readonly ref: Ref;
  readonly modelKey: string;
  readonly processId: string;
  readonly name: string | null;
  readonly participantName: string | null;
  readonly participantId: string | null;
  /** The endpoint (`to` side of `call`), if the process fact exists. */
  readonly endpoint: Endpoint | null;
}

export interface LandscapeIndex {
  readonly models: readonly ModelFacts[];
  readonly processes: readonly ProcessEntry[];
  /** Process id → every process with that id, ordered by ref. */
  readonly processesById: ReadonlyMap<string, readonly ProcessEntry[]>;
  /** Endpoints per type and side, ordered by ref. */
  readonly endpoints: Readonly<Record<LinkType, Readonly<Record<Side, readonly Endpoint[]>>>>;
  /** `from>to` of every message flow inside a file. */
  readonly messageFlowPairs: ReadonlySet<string>;
  /** Refs that are the source or target of a message flow inside their file. */
  readonly messageFlowRefs: ReadonlySet<Ref>;
}

function nameOf(fact: Fact, type: LinkType): string | null {
  const attrs = fact.attrs;
  switch (type) {
    case 'call':
      if (fact.kind === 'process') return fact.keyRaw;
      return attrs.dynamic === true || fact.keyRaw.trim() === '' ? null : fact.keyRaw;
    case 'message':
      return attrs.dynamic === true ? null : (attrs.messageName ?? null);
    case 'signal':
      return attrs.dynamic === true ? null : (attrs.signalName ?? null);
    case 'trigger':
      return null;
  }
}

/** Builds the index over a project's head facts. Deterministic for any input order. */
export function indexLandscape(projectFacts: ProjectFacts): LandscapeIndex {
  const models = [...projectFacts.models].sort((a, b) => compareStrings(a.modelKey, b.modelKey));
  const endpoints = Object.fromEntries(
    LINK_TYPES.map((t) => [t, { from: [] as Endpoint[], to: [] as Endpoint[] }]),
  ) as Record<LinkType, Record<Side, Endpoint[]>>;
  const processes: ProcessEntry[] = [];
  const messageFlowPairs = new Set<string>();
  const messageFlowRefs = new Set<Ref>();

  for (const model of models) {
    const processFacts = new Map<string, Endpoint>();
    const seen = new Set<string>();
    for (const fact of model.facts) {
      const role = endpointRole(fact);
      const process = processRefOf(fact);
      if (role === null || process === null) continue;
      const identity = `${role.type}|${role.side}|${fact.ref}`;
      if (seen.has(identity)) continue; // e.g. a `multiple` event with two message definitions
      seen.add(identity);
      const endpoint: Endpoint = {
        ref: fact.ref,
        modelKey: model.modelKey,
        process,
        type: role.type,
        side: role.side,
        fact,
        name: nameOf(fact, role.type),
      };
      endpoints[role.type][role.side].push(endpoint);
      if (fact.kind === 'process') processFacts.set(fact.elementId, endpoint);
    }
    for (const info of model.processes) {
      const endpoint = processFacts.get(info.processId) ?? null;
      const participantId = endpoint?.fact.attrs.participantId;
      processes.push({
        ref: info.ref,
        modelKey: model.modelKey,
        processId: info.processId,
        name: info.name,
        participantName: info.participantName,
        participantId: typeof participantId === 'string' ? participantId : null,
        endpoint,
      });
    }
    for (const flow of model.messageFlows) {
      messageFlowPairs.add(`${flow.from}>${flow.to}`);
      messageFlowRefs.add(flow.from);
      messageFlowRefs.add(flow.to);
    }
  }

  for (const type of LINK_TYPES) {
    for (const side of ['from', 'to'] as const) {
      endpoints[type][side].sort((a, b) => compareStrings(a.ref, b.ref));
    }
  }
  processes.sort((a, b) => compareStrings(a.ref, b.ref));
  const processesById = new Map<string, ProcessEntry[]>();
  for (const p of processes) {
    const list = processesById.get(p.processId) ?? [];
    list.push(p);
    processesById.set(p.processId, list);
  }
  return { models, processes, processesById, endpoints, messageFlowPairs, messageFlowRefs };
}

/**
 * Whether two endpoints may form a relation at all: compatible roles of one
 * type, different processes, and no message flow inside one file already
 * connecting them (a fact, not a relation).
 */
export function canLink(index: LandscapeIndex, from: Endpoint, to: Endpoint): boolean {
  return (
    from.type === to.type &&
    from.side === 'from' &&
    to.side === 'to' &&
    from.process !== to.process &&
    !index.messageFlowPairs.has(`${from.ref}>${to.ref}`)
  );
}

/** Last segment of a model key: the file stem (`finanzen/e-rechnung` → `e-rechnung`). */
export function fileStem(modelKey: string): string {
  const slash = modelKey.lastIndexOf('/');
  return slash < 0 ? modelKey : modelKey.slice(slash + 1);
}
