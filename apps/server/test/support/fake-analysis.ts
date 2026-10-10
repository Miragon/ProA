/**
 * Test doubles for the domain's AnalysisPort. `fakeBpmn(spec)` writes a
 * BPMN-looking document that carries its facts as JSON in a comment;
 * `fakeAnalysis` reads them back and applies a small version of the rule
 * tier (CONCEPT §2): unambiguous calls accepted, duplicate targets proposed,
 * identical message and signal names as key-tier proposals, and the five
 * findings. Candidates and pair assessment come from the real
 * `@proa/relations` over the fake facts.
 */
import { createHash } from 'node:crypto';

import { normalizeKey } from '@proa/bpmn-facts';
import { createPairAssessor, generateCandidates } from '@proa/relations';
import {
  formatRef,
  type DerivedRelation,
  type EventDef,
  type Fact,
  type FactKind,
  type FactScope,
  type Finding,
  type ProcessInfo,
  type ProjectFacts,
} from '@proa/contracts';

import type { AnalysisPort, Extracted } from '../../src/domain/ports.ts';

export interface FakeElement {
  kind: Exclude<FactKind, 'process' | 'message_flow' | 'lane'>;
  id: string;
  /** Label. */
  name?: string;
  /** Message or signal name, or `calledElement`. Defaults to the label. */
  ref?: string;
  scope?: FactScope;
  eventDef?: EventDef;
  elementType?: string;
  /** `bpmn:documentation`: part of the facts hash, not of the fingerprint. */
  doc?: string;
}

export interface FakeProcess {
  id: string;
  name?: string;
  elements?: FakeElement[];
  /** `bpmn:documentation` of the process. */
  doc?: string;
  /** Lane names (one `lane` fact each). */
  lanes?: string[];
}

export interface FakeModelSpec {
  processes: FakeProcess[];
  /** Engine the fake extractor reports (default `null`). */
  engine?: 'c7' | 'c8';
  /** Changes the bytes (like moving shapes) without changing any fact. */
  layout?: string;
}

const MARKER = 'proa-test-facts';

/** A BPMN-looking document whose facts the fake extractor reads back. */
export function fakeBpmn(spec: FakeModelSpec): string {
  const json = JSON.stringify(spec).replaceAll('--', '\\u002d\\u002d');
  const processes = spec.processes
    .map((p) => `  <bpmn:process id="${p.id}" isExecutable="true" />`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1">',
    processes,
    `  <!-- ${MARKER} ${json} -->`,
    '</bpmn:definitions>',
    '',
  ].join('\n');
}

const DEFAULT_EVENT_DEF: Partial<Record<FactKind, EventDef>> = {
  msg_throw: 'message',
  msg_catch: 'message',
  sig_throw: 'signal',
  sig_catch: 'signal',
  evt_start: 'none',
  evt_end: 'none',
};

const DEFAULT_ELEMENT_TYPE: Partial<Record<FactKind, string>> = {
  call: 'bpmn:CallActivity',
  msg_throw: 'bpmn:IntermediateThrowEvent',
  msg_catch: 'bpmn:IntermediateCatchEvent',
  sig_throw: 'bpmn:IntermediateThrowEvent',
  sig_catch: 'bpmn:IntermediateCatchEvent',
  evt_start: 'bpmn:StartEvent',
  evt_end: 'bpmn:EndEvent',
  task: 'bpmn:Task',
  data_store: 'bpmn:DataStoreReference',
};

function fingerprint(
  kind: FactKind,
  eventDef: EventDef | null,
  keyNorm: string,
  label: string,
  scope: FactScope,
) {
  return createHash('sha256')
    .update([kind, eventDef ?? '', keyNorm, normalizeKey(label), scope].join('|'))
    .digest('hex')
    .slice(0, 12);
}

function fact(
  modelKey: string,
  base: { kind: FactKind; elementId: string; processId: string; label: string; keyRaw: string },
  extra: { scope?: FactScope; eventDef?: EventDef | null; attrs?: Fact['attrs'] } = {},
): Fact {
  const scope = extra.scope ?? 'process';
  const eventDef = extra.eventDef ?? null;
  const keyNorm = normalizeKey(base.keyRaw);
  return {
    modelKey,
    ref: formatRef(modelKey, base.elementId),
    kind: base.kind,
    elementId: base.elementId,
    processId: base.processId,
    scope,
    eventDef,
    label: base.label,
    keyRaw: base.keyRaw,
    keyNorm,
    fingerprint: fingerprint(base.kind, eventDef, keyNorm, base.label, scope),
    attrs: extra.attrs ?? {},
  };
}

export function extractFake(xml: string, modelKey: string): Extracted {
  const m = new RegExp(`<!-- ${MARKER} (.*) -->`).exec(xml);
  if (!m?.[1]) throw new Error('not a fake BPMN document');
  const spec = JSON.parse(m[1]) as FakeModelSpec;
  const processes: ProcessInfo[] = [];
  const facts: Fact[] = [];
  for (const p of spec.processes) {
    processes.push({
      ref: formatRef(modelKey, p.id),
      processId: p.id,
      name: p.name ?? null,
      participantName: null,
      isExecutable: true,
    });
    facts.push(
      fact(
        modelKey,
        { kind: 'process', elementId: p.id, processId: p.id, label: p.name ?? '', keyRaw: p.id },
        {
          attrs: {
            elementType: 'bpmn:Process',
            isExecutable: true,
            ...(p.doc === undefined ? {} : { documentation: p.doc }),
          },
        },
      ),
    );
    for (const [i, lane] of (p.lanes ?? []).entries()) {
      facts.push(
        fact(
          modelKey,
          {
            kind: 'lane',
            elementId: `${p.id}_Lane${i}`,
            processId: p.id,
            label: lane,
            keyRaw: lane,
          },
          { attrs: { elementType: 'bpmn:Lane' } },
        ),
      );
    }
    for (const e of p.elements ?? []) {
      const label = e.name ?? '';
      const keyRaw = e.ref ?? label;
      const dynamic = e.kind === 'call' && /^(=|\$\{|#\{)/.test(keyRaw);
      facts.push(
        fact(
          modelKey,
          { kind: e.kind, elementId: e.id, processId: p.id, label, keyRaw },
          {
            scope: e.scope ?? 'process',
            eventDef: e.eventDef ?? DEFAULT_EVENT_DEF[e.kind] ?? null,
            attrs: {
              elementType: e.elementType ?? DEFAULT_ELEMENT_TYPE[e.kind] ?? 'bpmn:Task',
              ...(e.kind === 'call' ? { dynamic } : {}),
              // Like the extractor: names only from real refs (`ref`), never from labels.
              ...((e.kind === 'msg_throw' || e.kind === 'msg_catch') && e.ref !== undefined
                ? { messageName: e.ref }
                : {}),
              ...((e.kind === 'sig_throw' || e.kind === 'sig_catch') && e.ref !== undefined
                ? { signalName: e.ref }
                : {}),
              ...(e.doc === undefined ? {} : { documentation: e.doc }),
            },
          },
        ),
      );
    }
  }
  facts.sort((a, b) => (a.kind + a.elementId < b.kind + b.elementId ? -1 : 1));
  return {
    factsVersion: 'test-1',
    engine: spec.engine ?? null,
    processes,
    facts,
    messageFlows: [],
  };
}

export function fakeFactsHash(facts: readonly Fact[]): string {
  const canonical = facts
    .map((f) => [
      f.kind,
      f.elementId,
      f.processId,
      f.scope,
      f.eventDef,
      f.label,
      f.keyRaw,
      f.fingerprint,
      ...(f.attrs.documentation === undefined ? [] : [f.attrs.documentation]),
    ])
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const byRefs = (
  a: { from: string; to: string; type: string },
  b: { from: string; to: string; type: string },
) => (a.type + a.from + a.to < b.type + b.from + b.to ? -1 : 1);

/** A small rule tier with the semantics of CONCEPT §2 (not the real `runRules`). */
export function fakeRules(projectFacts: ProjectFacts): {
  relations: DerivedRelation[];
  findings: Finding[];
} {
  const all = projectFacts.models.flatMap((m) => m.facts);
  const processes = all.filter((f) => f.kind === 'process');
  const relations: DerivedRelation[] = [];
  const findings: Finding[] = [];

  const byId = new Map<string, Fact[]>();
  for (const p of processes) byId.set(p.elementId, [...(byId.get(p.elementId) ?? []), p]);
  for (const [id, defs] of byId) {
    if (defs.length > 1) {
      findings.push({
        kind: 'duplicate-process-id',
        refs: defs.map((d) => d.ref).sort(),
        detail: `${id} is defined ${defs.length} times`,
      });
    }
  }

  for (const call of all.filter((f) => f.kind === 'call')) {
    if (call.attrs.dynamic) {
      findings.push({
        kind: 'dynamic-call',
        refs: [call.ref],
        detail: `expression ${call.keyRaw}`,
      });
      continue;
    }
    const targets = (byId.get(call.keyRaw) ?? []).filter(
      (p) => !(p.modelKey === call.modelKey && p.elementId === call.processId),
    );
    if (targets.length === 0) {
      findings.push({
        kind: 'unresolved-call',
        refs: [call.ref],
        detail: `no process ${call.keyRaw}`,
      });
    }
    for (const t of targets) {
      relations.push({
        type: 'call',
        from: call.ref,
        to: t.ref,
        status: targets.length === 1 ? 'accepted' : 'proposed',
        tier: targets.length === 1 ? 'rule' : 'key',
        confidence: 1,
        attrs: {},
      });
    }
  }

  for (const [type, throwKind, catchKind] of [
    ['message', 'msg_throw', 'msg_catch'],
    ['signal', 'sig_throw', 'sig_catch'],
  ] as const) {
    const throws = all.filter((f) => f.kind === throwKind);
    const catches = all.filter((f) => f.kind === catchKind);
    const caught = new Set<string>();
    for (const t of throws) {
      let matched = false;
      for (const c of catches) {
        if (c.keyNorm !== t.keyNorm || (c.modelKey === t.modelKey && c.processId === t.processId))
          continue;
        matched = true;
        caught.add(c.ref);
        relations.push({
          type,
          from: t.ref,
          to: c.ref,
          status: 'proposed',
          tier: 'key',
          confidence: 1,
          attrs: {},
        });
      }
      if (!matched)
        findings.push({
          kind: 'dangling-throw',
          refs: [t.ref],
          detail: `nobody catches ${t.keyRaw}`,
        });
    }
    for (const c of catches) {
      if (!caught.has(c.ref)) {
        findings.push({
          kind: 'unmatched-catch',
          refs: [c.ref],
          detail: `nobody throws ${c.keyRaw}`,
        });
      }
    }
  }

  relations.sort(byRefs);
  findings.sort((a, b) => (a.kind + (a.refs[0] ?? '') < b.kind + (b.refs[0] ?? '') ? -1 : 1));
  return { relations, findings };
}

/** The AnalysisPort double: DOCTYPE → `doctype-forbidden`, no marker → `not-bpmn`. */
export function fakeAnalysis(): AnalysisPort & { extractCalls: number } {
  const port = {
    extractCalls: 0,
    extract(xml: Uint8Array, modelKey: string) {
      port.extractCalls++;
      const text = new TextDecoder().decode(xml);
      if (/<!DOCTYPE/i.test(text)) {
        return Promise.resolve({
          ok: false as const,
          error: { code: 'doctype-forbidden', message: 'DOCTYPE is not allowed' },
        });
      }
      try {
        return Promise.resolve({ ok: true as const, value: extractFake(text, modelKey) });
      } catch {
        return Promise.resolve({
          ok: false as const,
          error: { code: 'not-bpmn', message: 'not a BPMN 2.0 document' },
        });
      }
    },
    factsHash: fakeFactsHash,
    runRules: fakeRules,
    candidates: (projectFacts: ProjectFacts, focusModelKey: string) =>
      generateCandidates(projectFacts, focusModelKey),
    pairAssessor: (projectFacts: ProjectFacts) => createPairAssessor(projectFacts),
  };
  return port;
}
