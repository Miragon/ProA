import type { AutoAcceptLedgerEntry, AutoAcceptRevocationResult } from '@proa/client';

/**
 * Auto-accept marks in the review views (owner decision 19): the join of the
 * ledger (`GET …/auto-accepted`, every reviewer) onto relations, placements
 * and their histories (the resources themselves carry no marker), the
 * relation filter `auto`, and the texts of the marks and revocations. The
 * tab „Regeln“ (owners) has its own helpers (`auto-accept-rules.ts`).
 */

export const LATER_VERDICTS: Record<NonNullable<AutoAcceptLedgerEntry['laterVerdict']>, string> = {
  accept: 'bestätigt',
  reject: 'abgelehnt',
  hold: 'vorgemerkt',
  correct: 'korrigiert',
};

/** The mark of an item a rule accepted: „Automatisch angenommen – Regel „…““. */
export function autoAcceptLabel(ruleName: string): string {
  return `Automatisch angenommen – Regel „${ruleName}“`;
}

/** `0.93` → `0,93` (a confidence as agents send it). */
export function formatDecimal(value: number): string {
  return value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ------------------------------------------------------------- ledger join

/** What the history marks on one assertion of a relation or placement. */
export interface TimelineMark {
  kind: 'decision' | 'revocation';
  ruleName: string;
  revision: number;
}

/** The ledger, indexed for the review views. */
export interface AutoAcceptIndex {
  /** The acceptance in force per subject (relation or placement id). */
  inForce: ReadonlyMap<string, AutoAcceptLedgerEntry>;
  /** Every acceptance per subject, oldest first. */
  bySubject: ReadonlyMap<string, readonly AutoAcceptLedgerEntry[]>;
  /** Decision and revocation assertions, by assertion id. */
  byAssertion: ReadonlyMap<string, TimelineMark>;
  /** Subjects whose latest acceptance was revoked (back in review, unless decided since). */
  revoked: ReadonlySet<string>;
}

export const EMPTY_AUTO_ACCEPT_INDEX: AutoAcceptIndex = {
  inForce: new Map(),
  bySubject: new Map(),
  byAssertion: new Map(),
  revoked: new Set(),
};

export function indexLedger(entries: readonly AutoAcceptLedgerEntry[]): AutoAcceptIndex {
  const inForce = new Map<string, AutoAcceptLedgerEntry>();
  const bySubject = new Map<string, AutoAcceptLedgerEntry[]>();
  const byAssertion = new Map<string, TimelineMark>();
  for (const e of entries) {
    bySubject.set(e.id, [...(bySubject.get(e.id) ?? []), e]);
    if (e.state === 'in-force') inForce.set(e.id, e);
    byAssertion.set(e.decisionId, { kind: 'decision', ruleName: e.ruleName, revision: e.revision });
    if (e.revocationId) {
      byAssertion.set(e.revocationId, {
        kind: 'revocation',
        ruleName: e.ruleName,
        revision: e.revision,
      });
    }
  }
  const revoked = new Set<string>();
  for (const [id, list] of bySubject) if (list.at(-1)?.state === 'revoked') revoked.add(id);
  return { inForce, bySubject, byAssertion, revoked };
}

/** The relation filter `auto`: every acceptance in force, or those of one rule. */
export type AutoFilter = 'any' | `aar_${string}`;

const RULE_ID = /^aar_[0-9A-HJKMNP-TV-Z]{26}$/;

export function parseAutoFilter(value: unknown): AutoFilter | undefined {
  if (value === 'any') return 'any';
  return typeof value === 'string' && RULE_ID.test(value) ? (value as AutoFilter) : undefined;
}

/** Is the subject accepted by a rule (in force), by `filter`'s rule if it names one? */
export function matchesAuto(
  index: AutoAcceptIndex,
  subjectId: string,
  filter: AutoFilter,
): boolean {
  const entry = index.inForce.get(subjectId);
  return entry !== undefined && (filter === 'any' || entry.ruleId === filter);
}

/**
 * The rules the ledger names, with the name of their latest revision in it,
 * for the rule filter of reviewers who cannot list the rules (editors).
 */
export function ledgerRules(
  index: AutoAcceptIndex,
  kind: AutoAcceptLedgerEntry['kind'],
): { id: string; name: string }[] {
  const latest = new Map<string, AutoAcceptLedgerEntry>();
  for (const list of index.bySubject.values()) {
    for (const e of list) {
      if (e.kind !== kind) continue;
      const prev = latest.get(e.ruleId);
      if (!prev || e.revision > prev.revision) latest.set(e.ruleId, e);
    }
  }
  return [...latest.values()]
    .map((e) => ({ id: e.ruleId, name: e.ruleName }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

/** The agents whose proposals triggered acceptances still in force (per-agent revoke). */
export function inForceAgents(
  index: AutoAcceptIndex,
): { principalId: string; handle: string; count: number }[] {
  const out = new Map<string, { principalId: string; handle: string; count: number }>();
  for (const e of index.inForce.values()) {
    const a = out.get(e.agent.principalId) ?? { ...e.agent, count: 0 };
    a.count += 1;
    out.set(e.agent.principalId, a);
  }
  return [...out.values()].sort((a, b) => a.handle.localeCompare(b.handle, 'de'));
}

/** In-force acceptances triggered by an agent's proposals (the token revoke dialog). */
export function inForceByAgent(index: AutoAcceptIndex, principalId: string): number {
  let n = 0;
  for (const e of index.inForce.values()) if (e.agent.principalId === principalId) n += 1;
  return n;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A revocation in German: how many acceptances, how many of them go back to
 * review (a live proposal remains), how many become obsolete and are judged
 * again by the agents (none remains), and what stays.
 */
export function revocationSummary(r: AutoAcceptRevocationResult): string {
  const outcomes: string[] = [];
  if (r.toProposed > 0) {
    outcomes.push(
      `${plural(r.toProposed, 'geht', 'gehen')} zurück in die Prüfung (ein Agentenvorschlag ist noch offen)`,
    );
  }
  if (r.toObsolete > 0) {
    outcomes.push(
      `${plural(r.toObsolete, 'wird', 'werden')} veraltet und von den Agenten neu beurteilt (kein offener Vorschlag mehr)`,
    );
  }
  const parts = [
    r.count === 0
      ? 'Keine automatische Annahme ist noch in Kraft.'
      : `${plural(r.count, 'automatische Annahme', 'automatische Annahmen')}: ${outcomes.join('; ')}.`,
  ];
  if (r.humanDecidedSince > 0) {
    parts.push(
      `${plural(r.humanDecidedSince, 'wurde', 'wurden')} inzwischen von einem Menschen entschieden und ${r.humanDecidedSince === 1 ? 'bleibt' : 'bleiben'} unverändert.`,
    );
  }
  if (r.alreadyRevoked > 0) {
    parts.push(`${plural(r.alreadyRevoked, 'war', 'waren')} schon widerrufen.`);
  }
  return parts.join(' ');
}
