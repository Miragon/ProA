// The rule tier (CONCEPT §2 "Unambiguous call", relation types table):
// deterministic relations and findings over a project's head facts.
import { normalizeKey } from '@proa/bpmn-facts';
import type { DerivedRelation, Fact, Finding, ProjectFacts, Ref } from '@proa/contracts';

import {
  canLink,
  fileStem,
  indexLandscape,
  type Endpoint,
  type LandscapeIndex,
  type ProcessEntry,
} from './endpoints.ts';
import { compareStrings, compareTriples, round4 } from './order.ts';

/** Output of {@link runRules}. */
export interface RuleResult {
  /** Accepted unambiguous calls (tier `rule`) and proposals, sorted by `(type, from, to)`. */
  relations: DerivedRelation[];
  /** Findings, sorted by `(kind, refs)`. */
  findings: Finding[];
}

/** Confidence of a call proposal whose `calledElement` matches only a model's file stem. */
export const FILE_STEM_CONFIDENCE = 0.8;
/** Confidence of a call proposal whose `calledElement` matches only a process name. */
export const PROCESS_NAME_CONFIDENCE = 0.6;

/** Call attributes that never change the target but travel with the relation (CONCEPT §2). */
const CALL_ATTRS = ['binding', 'version', 'versionTag', 'tenantId'] as const;

function callAttrs(fact: Fact): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const key of CALL_ATTRS) {
    const value = fact.attrs[key];
    if (value !== undefined) attrs[key] = value;
  }
  return attrs;
}

function compact(value: string): string {
  return normalizeKey(value).replaceAll(' ', '');
}

/**
 * Processes a `calledElement` names only indirectly: by the last segment of
 * their model key (bpm-iq file stems) or by their name. Never the caller.
 */
function indirectCallTargets(
  index: LandscapeIndex,
  target: string,
  caller: Ref,
): Array<{ process: ProcessEntry; match: 'file-stem' | 'process-name' }> {
  const key = compact(target);
  if (key === '') return [];
  const out: Array<{ process: ProcessEntry; match: 'file-stem' | 'process-name' }> = [];
  for (const process of index.processes) {
    if (process.ref === caller || process.endpoint === null) continue;
    if (compact(fileStem(process.modelKey)) === key) out.push({ process, match: 'file-stem' });
    else if (process.name !== null && compact(process.name) === key) {
      out.push({ process, match: 'process-name' });
    }
  }
  return out;
}

function callRules(index: LandscapeIndex, relations: DerivedRelation[], findings: Finding[]): void {
  for (const call of index.endpoints.call.from) {
    const fact = call.fact;
    const target = fact.keyRaw;
    if (fact.attrs.dynamic === true) {
      findings.push({
        kind: 'dynamic-call',
        refs: [call.ref],
        detail: `calledElement ${JSON.stringify(target)} is an expression; the target is decided at runtime.`,
      });
      continue;
    }
    if (target.trim() === '') {
      findings.push({
        kind: 'unresolved-call',
        refs: [call.ref],
        detail: 'The call activity has no calledElement.',
      });
      continue;
    }
    const matches = index.processesById.get(target) ?? [];
    const targets = matches.filter((p) => p.ref !== call.process && p.endpoint !== null);
    if (matches.length === 0) {
      findings.push({
        kind: 'unresolved-call',
        refs: [call.ref],
        detail: `calledElement ${JSON.stringify(target)} matches no process id in the project.`,
      });
      for (const { process, match } of indirectCallTargets(index, target, call.process)) {
        relations.push({
          type: 'call',
          from: call.ref,
          to: process.ref,
          status: 'proposed',
          tier: match === 'file-stem' ? 'key' : 'lexical',
          confidence: match === 'file-stem' ? FILE_STEM_CONFIDENCE : PROCESS_NAME_CONFIDENCE,
          attrs: { ...callAttrs(fact), calledElement: target, match },
        });
      }
      continue;
    }
    if (matches.length === 1) {
      // Exactly one process has the id; unless it is the caller itself (recursion), accept.
      const [only] = targets;
      if (only !== undefined) {
        relations.push({
          type: 'call',
          from: call.ref,
          to: only.ref,
          status: 'accepted',
          tier: 'rule',
          confidence: 1,
          attrs: callAttrs(fact),
        });
      }
      continue;
    }
    // Two or more processes share the id: a proposal to every one of them
    // (the duplicate-process-id finding is emitted per id below).
    for (const process of targets) {
      relations.push({
        type: 'call',
        from: call.ref,
        to: process.ref,
        status: 'proposed',
        tier: 'key',
        confidence: round4(1 / matches.length),
        attrs: { ...callAttrs(fact), calledElement: target, match: 'duplicate-process-id' },
      });
    }
  }

  for (const [processId, entries] of index.processesById) {
    const models = new Set(entries.map((e) => e.modelKey));
    if (models.size < 2) continue;
    findings.push({
      kind: 'duplicate-process-id',
      refs: entries.map((e) => e.ref).sort(compareStrings),
      detail: `Process id ${JSON.stringify(processId)} is defined in ${models.size} models; calls to it are ambiguous.`,
    });
  }
}

/**
 * The matching form of a message or signal name: `normalizeKey` (case,
 * umlaut/ß transliteration, diacritics, punctuation) without word
 * separators, so `ZahlungEingegangen`, `Zahlung_Eingegangen` and
 * `zahlung-eingegangen` are one name.
 */
export function nameKey(name: string): string {
  return compact(name);
}

/**
 * Key-tier pairs of one type: a throw and a catch whose message or signal
 * names are equal by {@link nameKey}, in different processes, not already
 * joined by a message flow inside their file. Names from expressions or
 * label fallbacks never match.
 */
export function keyPairs(
  index: LandscapeIndex,
  type: 'message' | 'signal',
): Array<{ from: Endpoint; to: Endpoint }> {
  const catchesByKey = new Map<string, Endpoint[]>();
  for (const c of index.endpoints[type].to) {
    if (c.name === null) continue;
    const key = nameKey(c.name);
    if (key === '') continue;
    const list = catchesByKey.get(key) ?? [];
    list.push(c);
    catchesByKey.set(key, list);
  }
  const pairs: Array<{ from: Endpoint; to: Endpoint }> = [];
  for (const t of index.endpoints[type].from) {
    if (t.name === null) continue;
    for (const c of catchesByKey.get(nameKey(t.name)) ?? []) {
      if (canLink(index, t, c)) pairs.push({ from: t, to: c });
    }
  }
  return pairs;
}

function describeKey(e: Endpoint, type: 'message' | 'signal'): string {
  if (e.name !== null) return `${type} ${JSON.stringify(e.name)}`;
  if (e.fact.attrs.dynamic === true)
    return `${type} name ${JSON.stringify(e.fact.keyRaw)} (an expression)`;
  return `a ${type} without a ${type} name`;
}

function eventRules(
  index: LandscapeIndex,
  relations: DerivedRelation[],
  findings: Finding[],
): void {
  for (const type of ['message', 'signal'] as const) {
    const linkedFrom = new Set<Ref>();
    const linkedTo = new Set<Ref>();
    for (const { from, to } of keyPairs(index, type)) {
      linkedFrom.add(from.ref);
      linkedTo.add(to.ref);
      const nameAttr = type === 'message' ? 'messageName' : 'signalName';
      relations.push({
        type,
        from: from.ref,
        to: to.ref,
        status: 'proposed',
        tier: 'key',
        confidence: 1,
        attrs: {
          [nameAttr]: from.name,
          ...(to.name === from.name ? {} : { [`${nameAttr}To`]: to.name }),
        },
      });
    }
    // A throw or catch nothing can reach by name and that no message flow in
    // its file connects. Expressions may resolve to anything at runtime and
    // are left alone.
    for (const t of index.endpoints[type].from) {
      if (linkedFrom.has(t.ref) || index.messageFlowRefs.has(t.ref)) continue;
      if (t.fact.attrs.dynamic === true) continue;
      findings.push({
        kind: 'dangling-throw',
        refs: [t.ref],
        detail: `Thrown ${describeKey(t, type)} is caught by no other process and reaches no participant by message flow.`,
      });
    }
    for (const c of index.endpoints[type].to) {
      if (linkedTo.has(c.ref) || index.messageFlowRefs.has(c.ref)) continue;
      if (c.fact.attrs.dynamic === true) continue;
      findings.push({
        kind: 'unmatched-catch',
        refs: [c.ref],
        detail: `Caught ${describeKey(c, type)} is thrown by no other process and comes from no participant by message flow.`,
      });
    }
  }
}

function compareFindings(a: Finding, b: Finding): number {
  return compareStrings(a.kind, b.kind) || compareStrings(a.refs.join(' '), b.refs.join(' '));
}

/**
 * The rule tier over a project's head facts (CONCEPT §2):
 * - `call`: a constant `calledElement` that exactly one process in the
 *   project has as id, and that process is not the caller → `accepted`,
 *   tier `rule`, confidence 1.0; binding/version/tenant attributes go to
 *   `attrs`. Two or more processes with the id → a `key`-tier proposal to
 *   each (confidence 1/n) plus `duplicate-process-id`; no match →
 *   `unresolved-call`, plus proposals to processes whose model key ends in
 *   that name (file stem, tier `key`) or whose name it is (tier `lexical`);
 *   an expression → `dynamic-call`. A call to its own process (recursion)
 *   gives nothing.
 * - `message` / `signal`: identical names ({@link nameKey}: `normalizeKey`
 *   without word separators) of real message/signal refs between endpoints
 *   in different processes →
 *   `proposed`, tier `key`, confidence 1.0, unless a message flow inside the
 *   file connects them. Never accepted: names get reused.
 * - `dangling-throw` / `unmatched-catch`: a message or signal endpoint
 *   without such a counterpart and without a message flow. Rules see names
 *   only, so an endpoint that a semantic link (other words, other language)
 *   would connect is still reported here.
 *
 * Never matches on labels; endpoints follow {@link endpointRole}. Output is
 * sorted and independent of the order of the input.
 */
export function runRules(projectFacts: ProjectFacts): RuleResult {
  return rulesFromIndex(indexLandscape(projectFacts));
}

/** {@link runRules} over an existing index. */
export function rulesFromIndex(index: LandscapeIndex): RuleResult {
  const relations: DerivedRelation[] = [];
  const findings: Finding[] = [];
  callRules(index, relations, findings);
  eventRules(index, relations, findings);
  relations.sort(compareTriples);
  findings.sort(compareFindings);
  return { relations, findings };
}
