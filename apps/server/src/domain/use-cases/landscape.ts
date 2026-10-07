import { MAX_KEY_LENGTH, normalizeKey, sanitizeLine } from '@proa/bpmn-facts';
import {
  parseRef,
  type EventDef,
  type Fact,
  type FactKind,
  type FindingList,
  type Landscape,
  type ModelId,
  type ModelStage,
  type PageQuery,
  type ProcessInfo,
  type Ref,
  type Relation,
  type RelationId,
  type RelationPage,
  type RelationQuery,
} from '@proa/contracts';
import { nameKey } from '@proa/relations';

import type { Actor } from '../actor.ts';
import { decodeCursor, toPage } from '../cursor.ts';
import { DomainError } from '../errors.ts';
import { policy } from '../policy.ts';
import type { HeadFact } from '../ports.ts';
import { toRelation } from '../views.ts';
import { ALL, type UseCaseDeps } from './deps.ts';

/** What `whichProcessesUse` looks up (CONCEPT §4: "which processes throw message X"). */
export const USAGE_KINDS = ['message', 'signal', 'call', 'data_store'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

const USAGE_FACT_KINDS: Readonly<Record<UsageKind, readonly FactKind[]>> = {
  message: ['msg_throw', 'msg_catch'],
  signal: ['sig_throw', 'sig_catch'],
  call: ['call', 'process'],
  data_store: ['data_store'],
};

const ROLE_OF: Partial<Record<FactKind, string>> = {
  msg_throw: 'throws',
  msg_catch: 'catches',
  sig_throw: 'throws',
  sig_catch: 'catches',
  call: 'calls',
  process: 'defines',
  data_store: 'uses',
};

/** Event kinds `findUnlinkedEvents` looks at by default. */
export const EVENT_KINDS = [
  'msg_throw',
  'msg_catch',
  'sig_throw',
  'sig_catch',
  'evt_end',
  'evt_start',
] as const satisfies readonly FactKind[];
export type EventKind = (typeof EVENT_KINDS)[number];

export interface Usage {
  role: string;
  ref: Ref;
  modelKey: string;
  processId: string | null;
  processName: string | null;
  elementId: string;
  factKind: FactKind;
  label: string;
  keyRaw: string;
}

export interface UnlinkedEvent {
  ref: Ref;
  modelKey: string;
  processId: string | null;
  processName: string | null;
  kind: FactKind;
  eventDef: EventDef | null;
  label: string;
  keyRaw: string;
}

export interface ProcessSummary {
  modelId: ModelId;
  modelKey: string;
  modelName: string | null;
  stage: ModelStage;
  openItems: number;
  processes: ProcessInfo[];
}

export interface ProcessDetail extends ProcessSummary {
  process: ProcessInfo;
  facts: Fact[];
  relations: Relation[];
}

function usage(f: HeadFact): Usage {
  return {
    role: ROLE_OF[f.kind] ?? f.kind,
    ref: f.ref,
    modelKey: f.modelKey,
    processId: f.processId,
    processName: f.processName,
    elementId: f.elementId,
    factKind: f.kind,
    label: f.label,
    keyRaw: f.keyRaw,
  };
}

/**
 * Can this fact be a relation endpoint (CONCEPT §2)? Start and end events in
 * embedded subprocesses and end events in event subprocesses never are;
 * trigger endpoints (`evt_start`, `evt_end`) are labelled none events at
 * process level.
 */
function isEndpoint(f: Fact): boolean {
  const type = f.attrs.elementType;
  if (f.scope === 'subprocess' && (type === 'bpmn:StartEvent' || type === 'bpmn:EndEvent')) {
    return false;
  }
  if (f.scope === 'event_subprocess' && type === 'bpmn:EndEvent') return false;
  if (f.kind === 'evt_start' || f.kind === 'evt_end') {
    return f.scope === 'process' && f.eventDef === 'none' && f.label.trim() !== '';
  }
  return true;
}

export function landscapeUseCases(deps: UseCaseDeps) {
  return {
    /** The project head: models with stage and processes, live relations, findings. */
    async getLandscape(actor: Actor, projectRef: string): Promise<Landscape> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const models = await tx.models.list(project.id, { limit: ALL });
        const relations = await tx.relations.list(project.id, {}, { limit: ALL });
        const findings = await tx.findings.list(project.id);
        return {
          projectId: project.id,
          seq: project.lastSeq,
          models: models.map((m) => ({
            id: m.id,
            key: m.key,
            name: m.name,
            stage: m.stage,
            processes: m.processes,
          })),
          relations: relations.map(toRelation),
          findings,
        };
      });
    },

    /** Relations ordered by `(type, from, to)`; obsolete ones only when asked for by status. */
    async listRelations(
      actor: Actor,
      projectRef: string,
      query: RelationQuery,
    ): Promise<RelationPage> {
      const after = query.cursor
        ? decodeCursor(query.cursor, ['string', 'string', 'string'])
        : undefined;
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const rows = await tx.relations.list(
          project.id,
          { type: query.type, status: query.status, tier: query.tier, modelKey: query.modelKey },
          { after, limit: query.limit + 1 },
        );
        const page = toPage(rows, query.limit, (r) => [r.type, r.fromRef, r.toRef]);
        return { items: page.items.map(toRelation), nextCursor: page.nextCursor };
      });
    },

    async getRelation(actor: Actor, projectRef: string, id: RelationId): Promise<Relation> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const relation = await tx.relations.findInProject(project.id, id);
        if (!relation) throw new DomainError('not-found', 'relation not found');
        return toRelation(relation);
      });
    },

    async listFindings(actor: Actor, projectRef: string): Promise<FindingList> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        return { items: await tx.findings.list(project.id) };
      });
    },

    /**
     * Which processes throw or catch a message or signal, call or define a
     * process id, or use a data store. Head revisions only. Messages and
     * signals match like the rule tier (`nameKey`: case, umlauts,
     * punctuation and word separators ignored, so `ZahlungEingegangen` =
     * `Zahlung_Eingegangen`); data stores by normalized name; calls by the
     * exact process id (sanitized like the extracted `keyRaw`). A name that
     * normalizes to nothing matches nothing.
     */
    async whichProcessesUse(
      actor: Actor,
      projectRef: string,
      input: { kind: UsageKind; name: string },
    ): Promise<{ kind: UsageKind; name: string; keyNorm: string; uses: Usage[] }> {
      const keyNorm = normalizeKey(input.name);
      const filter =
        input.kind === 'call'
          ? { keyRaw: sanitizeLine(input.name, MAX_KEY_LENGTH).text }
          : input.kind === 'data_store'
            ? { keyNorm }
            : { nameKey: nameKey(input.name) };
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const kinds = USAGE_FACT_KINDS[input.kind];
        const facts = Object.values(filter).every((v) => v === '')
          ? []
          : await tx.facts.head(project.id, { kinds, ...filter });
        return { kind: input.kind, name: input.name, keyNorm, uses: facts.map(usage) };
      });
    },

    /**
     * Message and signal throws and catches, and labelled none start and end
     * events, that no live relation (proposed, accepted or held) touches.
     */
    async findUnlinkedEvents(
      actor: Actor,
      projectRef: string,
      input: { modelKey?: string | undefined; kinds?: readonly EventKind[] | undefined },
    ): Promise<{ items: UnlinkedEvent[] }> {
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const facts = await tx.facts.head(project.id, {
          kinds: input.kinds && input.kinds.length > 0 ? input.kinds : EVENT_KINDS,
          ...(input.modelKey ? { modelKey: input.modelKey } : {}),
        });
        const relations = await tx.relations.list(project.id, {}, { limit: ALL });
        const linked = new Set<string>();
        for (const r of relations) {
          if (r.status === 'rejected') continue;
          linked.add(r.fromRef);
          linked.add(r.toRef);
        }
        const items = facts
          .filter((f) => isEndpoint(f) && !linked.has(f.ref))
          .map((f) => ({
            ref: f.ref,
            modelKey: f.modelKey,
            processId: f.processId,
            processName: f.processName,
            kind: f.kind,
            eventDef: f.eventDef,
            label: f.label,
            keyRaw: f.keyRaw,
          }));
        return { items };
      });
    },

    /** MCP `list_processes`: models with stage, open items and their processes. */
    async listProcesses(
      actor: Actor,
      projectRef: string,
      query: PageQuery & { stage?: ModelStage | undefined },
    ): Promise<{ items: ProcessSummary[]; nextCursor: string | null }> {
      const afterKey = query.cursor ? decodeCursor(query.cursor, ['string'])[0] : undefined;
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const rows = await tx.models.list(project.id, {
          stage: query.stage,
          afterKey,
          limit: query.limit + 1,
        });
        const page = toPage(rows, query.limit, (m) => [m.key]);
        return {
          items: page.items.map((m) => ({
            modelId: m.id,
            modelKey: m.key,
            modelName: m.name,
            stage: m.stage,
            openItems: m.openItems,
            processes: m.processes,
          })),
          nextCursor: page.nextCursor,
        };
      });
    },

    /** MCP `get_process`: one process, its facts and the live relations touching them. */
    async getProcess(actor: Actor, projectRef: string, processRef: string): Promise<ProcessDetail> {
      let modelKey: string;
      let processId: string;
      try {
        ({ modelKey, elementId: processId } = parseRef(processRef));
      } catch {
        throw new DomainError(
          'validation-failed',
          `invalid process ref: ${JSON.stringify(processRef)}`,
        );
      }
      return deps.store.read(async (tx) => {
        const { project } = await policy.require(tx, actor, 'read', projectRef);
        const model = await tx.models.viewByKey(project.id, modelKey);
        const process = model?.processes.find((p) => p.processId === processId);
        if (!model || !process)
          throw new DomainError('not-found', `process ${processRef} not found`);
        const facts = await tx.facts.head(project.id, { modelKey, processId });
        const refs = new Set<string>([process.ref, ...facts.map((f) => f.ref)]);
        const relations = (
          await tx.relations.list(project.id, { modelKey }, { limit: ALL })
        ).filter((r) => refs.has(r.fromRef) || refs.has(r.toRef));
        return {
          modelId: model.id,
          modelKey: model.key,
          modelName: model.name,
          stage: model.stage,
          openItems: model.openItems,
          processes: model.processes,
          process,
          facts: facts.map(({ processName: _processName, ...fact }) => fact),
          relations: relations.map(toRelation),
        };
      });
    },
  };
}
