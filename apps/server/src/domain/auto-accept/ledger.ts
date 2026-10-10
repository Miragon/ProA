/**
 * Auto-accept rules (owner decision 19), pure part: the ledger of
 * auto-acceptances, from the marked assertions of the subjects' histories.
 * Each acceptance is `in-force`, `revoked` (an owner revoked it) or
 * `human-decided` (a human decided the item since; that decision wins and a
 * revocation never touches it). The review UI marks items from it, the rule
 * statistics count it, and revocations select from it.
 */
import type {
  AutoAcceptKind,
  AutoAcceptLedgerEntry,
  AutoAcceptLedgerState,
  AutoAcceptRuleId,
  AutoAcceptRuleStats,
  EndpointState,
  PrincipalId,
  RelationStatus,
} from '@proa/contracts';

import type { StanceView } from '../status.ts';

/** What the ledger reads of an assertion. */
export interface LedgerAssertion extends StanceView {
  id: string;
  handle: string;
  createdAt: Date;
  /** A correction's link (`linkedRelationId`, `linkedPlacementId`). */
  linked: string | null;
  llmModel: string | null;
  autoAcceptRuleRevision?: number | null;
  autoAcceptTriggerId?: string | null;
}

/** A relation or placement with the fields the ledger shows. */
export interface LedgerSubject {
  kind: AutoAcceptKind;
  id: string;
  status: RelationStatus;
  endpointState: EndpointState;
  type: 'call' | 'message' | 'signal' | 'trigger' | null;
  from: string | null;
  to: string | null;
  valueChainKey: string | null;
  step: string | null;
  process: string | null;
  history: readonly LedgerAssertion[];
}

/** A ledger entry with the decision's principal, for revocations. */
export interface LedgerItem {
  entry: AutoAcceptLedgerEntry;
  subject: LedgerSubject;
  decision: LedgerAssertion;
}

const iso = (d: Date): string => d.toISOString();

const marked = (a: StanceView): boolean => (a.autoAcceptRuleId ?? null) !== null;

/**
 * Every auto-acceptance of the subjects, oldest first.
 *
 * @param ruleName the rule's name in a revision (the deciding revision's name)
 */
export function ledgerItems(
  subjects: readonly LedgerSubject[],
  ruleName: (ruleId: string, revision: number) => string,
): LedgerItem[] {
  const out: LedgerItem[] = [];
  for (const subject of subjects) {
    const history = [...subject.history].sort((a, b) => a.seq - b.seq);
    for (const d of history) {
      if (d.kind !== 'decision' || !marked(d)) continue;
      const ruleId = d.autoAcceptRuleId as AutoAcceptRuleId;
      const revision = d.autoAcceptRuleRevision ?? 1;
      const revocation = history.find(
        (w) =>
          w.kind === 'withdrawal' &&
          w.principalId === d.principalId &&
          w.autoAcceptRuleId === ruleId &&
          w.seq > d.seq,
      );
      const later = history.find(
        (a) => a.kind === 'decision' && a.sourceKind === 'human' && !marked(a) && a.seq > d.seq,
      );
      const state: AutoAcceptLedgerState =
        revocation && (!later || revocation.seq < later.seq)
          ? 'revoked'
          : later
            ? 'human-decided'
            : 'in-force';
      const trigger = history.find((a) => a.id === d.autoAcceptTriggerId);
      const laterVerdict =
        state !== 'human-decided' || !later?.verdict
          ? null
          : later.verdict === 'reject' && later.linked !== null
            ? 'correct'
            : later.verdict;
      out.push({
        subject,
        decision: d,
        entry: {
          kind: subject.kind,
          id: subject.id as AutoAcceptLedgerEntry['id'],
          status: subject.status,
          endpointState: subject.endpointState,
          type: subject.type,
          from: subject.from as AutoAcceptLedgerEntry['from'],
          to: subject.to as AutoAcceptLedgerEntry['to'],
          valueChainKey: subject.valueChainKey,
          step: subject.step,
          process: subject.process as AutoAcceptLedgerEntry['process'],
          decisionId: d.id as AutoAcceptLedgerEntry['decisionId'],
          triggerId: (d.autoAcceptTriggerId ?? d.id) as AutoAcceptLedgerEntry['triggerId'],
          ruleId,
          revision,
          ruleName: ruleName(ruleId, revision),
          decidedBy: { principalId: d.principalId, handle: d.handle },
          agent: trigger
            ? { principalId: trigger.principalId, handle: trigger.handle }
            : { principalId: d.principalId, handle: d.handle },
          llmModel: trigger?.llmModel ?? null,
          tier: trigger?.tier ?? null,
          confidence: trigger?.confidence ?? null,
          at: iso(d.createdAt),
          state,
          laterVerdict,
          laterAt: state === 'human-decided' && later ? iso(later.createdAt) : null,
          revocationId:
            state === 'revoked' && revocation
              ? (revocation.id as AutoAcceptLedgerEntry['decisionId'])
              : null,
          revokedAt: state === 'revoked' && revocation ? iso(revocation.createdAt) : null,
        },
      });
    }
  }
  return out.sort((a, b) => a.decision.seq - b.decision.seq);
}

/** The ledger entries a query selects. */
export function filterLedger(
  items: readonly LedgerItem[],
  q: {
    kind?: AutoAcceptKind | undefined;
    ruleId?: string | undefined;
    revision?: number | undefined;
    state?: AutoAcceptLedgerState | undefined;
    agentPrincipalId?: PrincipalId | undefined;
    ids?: ReadonlySet<string> | undefined;
  },
): LedgerItem[] {
  return items.filter(
    ({ entry }) =>
      (q.kind === undefined || entry.kind === q.kind) &&
      (q.ruleId === undefined || entry.ruleId === q.ruleId) &&
      (q.revision === undefined || entry.revision === q.revision) &&
      (q.state === undefined || entry.state === q.state) &&
      (q.agentPrincipalId === undefined || entry.agent.principalId === q.agentPrincipalId) &&
      (q.ids === undefined || q.ids.has(entry.id)),
  );
}

/** Statistics per rule from the ledger. */
export function ruleStats(items: readonly LedgerItem[]): Map<string, AutoAcceptRuleStats> {
  const out = new Map<string, AutoAcceptRuleStats>();
  for (const { entry } of items) {
    const s = out.get(entry.ruleId) ?? {
      inForce: 0,
      revoked: 0,
      confirmed: 0,
      overruled: 0,
      lastAcceptedAt: null,
    };
    if (entry.state === 'in-force') s.inForce++;
    else if (entry.state === 'revoked') s.revoked++;
    else if (entry.laterVerdict === 'accept') s.confirmed++;
    else s.overruled++;
    if (s.lastAcceptedAt === null || entry.at > s.lastAcceptedAt) s.lastAcceptedAt = entry.at;
    out.set(entry.ruleId, s);
  }
  return out;
}

/** Empty statistics (a rule that accepted nothing yet). */
export const NO_STATS: Readonly<AutoAcceptRuleStats> = {
  inForce: 0,
  revoked: 0,
  confirmed: 0,
  overruled: 0,
  lastAcceptedAt: null,
};
