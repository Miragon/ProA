/**
 * The claim input (CONCEPT §3 "Claim and lease"), rendered compactly as
 * `proa-claim/1` (documented on `ClaimInput` in `@proa/contracts`). Pure:
 * everything comes in as arguments, so the size test can render every
 * corpus model.
 */
import {
  CLAIM_DOC_CHARS,
  CLAIM_INPUT_FORMAT,
  RELATION_ENDPOINT_KINDS,
  type Candidate,
  type ClaimCandidate,
  type ClaimDecision,
  type ClaimEndpoint,
  type ClaimFact,
  type ClaimInput,
  type ClaimPartnerProcess,
  type ClaimRelation,
  type Engine,
  type Fact,
  type FactKind,
  type Finding,
  type ProcessInfo,
  type ProjectFacts,
  type RevisionId,
} from '@proa/contracts';

import type { RelationRecord, StoredAssertion } from './ports.ts';
import { currentStances, decisionsInForce } from './status.ts';
import { basisOf } from './views.ts';

export interface ClaimModel {
  key: string;
  name: string | null;
  revisionId: RevisionId;
  rev: number;
  engine: Engine | null;
  processes: readonly ProcessInfo[];
}

export interface ClaimInputSource {
  model: ClaimModel;
  /** Head facts of the project. */
  projectFacts: ProjectFacts;
  /** `generateCandidates(projectFacts, model.key)`. */
  candidates: readonly Candidate[];
  /** Non-obsolete relations touching the model. */
  relations: readonly RelationRecord[];
  /** Assertions per relation id, any order. */
  histories: ReadonlyMap<string, readonly StoredAssertion[]>;
  /**
   * The project's findings as clients see them (`visibleFindings`), any
   * order; the input keeps those with a ref in the model.
   */
  findings: readonly Finding[];
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Deterministic, never `localeCompare` (its result depends on the runtime's ICU data). */
const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `bpmn:documentation` cut to {@link CLAIM_DOC_CHARS}, or nothing. */
function docOf(f: Fact): { doc?: string } {
  const doc = f.attrs.documentation;
  return doc ? { doc: truncate(doc, CLAIM_DOC_CHARS) } : {};
}

function compactFact(f: Fact): ClaimFact {
  const { sourceRef, targetRef } = f.attrs;
  return {
    ref: f.ref,
    kind: f.kind,
    ...(f.eventDef === null ? {} : { eventDef: f.eventDef }),
    label: f.label,
    ...(f.keyRaw === '' || f.keyRaw === f.label ? {} : { key: f.keyRaw }),
    ...(f.scope === 'process' ? {} : { scope: f.scope }),
    ...(f.processId === null ? {} : { process: f.processId }),
    ...(f.kind === 'message_flow' && sourceRef !== undefined ? { from: sourceRef } : {}),
    ...(f.kind === 'message_flow' && targetRef !== undefined ? { to: targetRef } : {}),
    ...docOf(f),
  };
}

/**
 * Renders the input of a `relations` task: the model's head facts, the
 * candidates as tuples, the partner endpoints they name and their
 * processes, the existing relations with human decisions, questions and
 * notes, and the findings touching the model.
 */
export function renderClaimInput(src: ClaimInputSource): ClaimInput {
  const { model } = src;
  const prefix = `${model.key}#`;
  const own = src.projectFacts.models.find((m) => m.modelKey === model.key);

  // Facts by ref (an element may carry several, e.g. a message and a signal definition).
  const factsByRef = new Map<string, Fact[]>();
  const processNames = new Map<string, string | null>();
  for (const m of src.projectFacts.models) {
    for (const f of m.facts) {
      const list = factsByRef.get(f.ref) ?? [];
      list.push(f);
      factsByRef.set(f.ref, list);
    }
    for (const p of m.processes) processNames.set(p.ref, p.name ?? p.participantName);
  }
  const processFact = (ref: string) => factsByRef.get(ref)?.find((f) => f.kind === 'process');

  const partners: Record<string, ClaimEndpoint> = {};
  const addPartner = (ref: string, kinds: readonly FactKind[] | null) => {
    if (ref.startsWith(prefix) || partners[ref] !== undefined) return;
    const facts = factsByRef.get(ref);
    const fact = facts?.find((f) => kinds === null || kinds.includes(f.kind)) ?? facts?.[0];
    if (!fact || fact.processId === null) return;
    const processRef = `${fact.modelKey}#${fact.processId}`;
    const c = compactFact(fact);
    const processName = processNames.get(processRef);
    partners[ref] = {
      kind: c.kind,
      ...(c.eventDef === undefined ? {} : { eventDef: c.eventDef }),
      label: c.label,
      ...(c.key === undefined ? {} : { key: c.key }),
      ...(c.scope === undefined ? {} : { scope: c.scope }),
      process: processRef as ClaimEndpoint['process'],
      ...(processName ? { processName } : {}),
      ...(c.doc === undefined ? {} : { doc: c.doc }),
    };
  };

  const candidates: ClaimCandidate[] = src.candidates.map((c) => {
    addPartner(c.from, RELATION_ENDPOINT_KINDS[c.type].from);
    addPartner(c.to, RELATION_ENDPOINT_KINDS[c.type].to);
    return [c.type, c.from, c.to, c.basis, round4(c.score)];
  });

  const relations: ClaimRelation[] = src.relations.map((r) => {
    addPartner(r.fromRef, RELATION_ENDPOINT_KINDS[r.type].from);
    addPartner(r.toRef, RELATION_ENDPOINT_KINDS[r.type].to);
    const history = [...(src.histories.get(r.id) ?? [])].sort((a, b) => a.seq - b.seq);
    const stances = currentStances(history);
    const human = decisionsInForce(history)
      .filter((a) => a.sourceKind === 'human')
      .at(-1);
    const asked = stances
      .filter((a) => a.kind === 'proposal' && a.question !== null && a.question !== '')
      .at(-1);
    const notes = history
      .filter((a) => a.kind === 'note' && a.rationale)
      .map((a) => ({ text: a.rationale ?? '', at: a.createdAt.toISOString() }));
    const decision: ClaimDecision | undefined =
      human?.verdict == null
        ? undefined
        : {
            verdict: human.verdict,
            ...(human.rationale ? { note: human.rationale } : {}),
            ...(human.question ? { question: human.question } : {}),
            ...(human.label ? { label: human.label } : {}),
            at: human.createdAt.toISOString(),
          };
    return {
      id: r.id,
      type: r.type,
      from: r.fromRef,
      to: r.toRef,
      status: r.status,
      tier: r.tier,
      confidence: r.confidence,
      source: basisOf(history)?.sourceKind ?? null,
      endpointState: r.endpointState,
      ...(decision ? { decision } : {}),
      ...(asked?.question ? { question: asked.question } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
  });

  const partnerProcesses: Record<string, ClaimPartnerProcess> = {};
  const processRefs = [...new Set(Object.values(partners).map((p) => p.process))];
  for (const ref of processRefs.sort(compareStrings)) {
    const name = processNames.get(ref);
    const fact = processFact(ref);
    partnerProcesses[ref] = {
      ...(name ? { name } : {}),
      ...(fact ? docOf(fact) : {}),
    };
  }

  const findings = src.findings
    .filter((f) => f.refs.some((ref) => ref.startsWith(prefix)))
    .sort(
      (a, b) =>
        compareStrings(a.kind, b.kind) ||
        compareStrings(a.refs.join(' '), b.refs.join(' ')) ||
        compareStrings(a.detail, b.detail),
    )
    .map((f) => ({ kind: f.kind, refs: [...f.refs], detail: f.detail }));

  return {
    format: CLAIM_INPUT_FORMAT,
    model: {
      key: model.key,
      name: model.name,
      revisionId: model.revisionId,
      rev: model.rev,
      engine: model.engine,
      processes: model.processes.map((p) => ({
        processId: p.processId,
        name: p.name,
        participantName: p.participantName,
      })),
    },
    facts: (own?.facts ?? []).map(compactFact),
    candidates,
    partners,
    ...(processRefs.length > 0 ? { partnerProcesses } : {}),
    relations,
    ...(findings.length > 0 ? { findings } : {}),
  };
}

/** Size of the rendered input in bytes (UTF-8 JSON), as an agent receives it. */
export function claimInputBytes(input: ClaimInput): number {
  return Buffer.byteLength(JSON.stringify(input), 'utf8');
}
