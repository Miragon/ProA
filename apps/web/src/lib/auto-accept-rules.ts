import type {
  AutoAcceptBlockReason,
  AutoAcceptCriteria,
  AutoAcceptKind,
  AutoAcceptLedgerState,
  AutoAcceptPreview,
  AutoAcceptRelationType,
  AutoAcceptRule,
  AutoAcceptRuleDraft,
  AutoAcceptTier,
} from '@proa/client';

import { RELATION_TYPES, TIERS } from './labels';
import { AUTO_ACCEPT_TIERS, MIN_AUTO_ACCEPT_CONFIDENCE } from './limits';

/**
 * The tab „Regeln“ (owner decision 19): German labels for kinds, tiers,
 * block reasons and ledger states, the percent input of a rule's minimum
 * confidence, drafts and criteria, and the preview's history line. Only the
 * rules page and its dialogs use these (they load with the route); the marks
 * of the review views are in `auto-accept.ts`.
 */

export const AUTO_ACCEPT_KINDS: Record<AutoAcceptKind, { label: string; one: string }> = {
  relation: { label: 'Relationen', one: 'Relation' },
  placement: { label: 'Platzierungen', one: 'Platzierung' },
};

/** The proposal tiers as the review shows them (Schlüssel, Ähnlich, Bedeutung). */
export function tierLabel(tier: AutoAcceptTier): string {
  return TIERS[tier].label;
}

export function tiersOf(kind: AutoAcceptKind): readonly AutoAcceptTier[] {
  return AUTO_ACCEPT_TIERS[kind];
}

export const AUTO_ACCEPT_RELATION_TYPES: readonly AutoAcceptRelationType[] = [
  'call',
  'message',
  'signal',
  'trigger',
];

export function relationTypeLabel(type: AutoAcceptRelationType): string {
  return RELATION_TYPES[type].label;
}

/** Why a rule does not accept an open proposal, in German (preview, dry runs). */
export const AUTO_ACCEPT_BLOCK_LABELS: Record<AutoAcceptBlockReason, string> = {
  'not-agent': 'Kein Agentenvorschlag',
  'no-matching-rule': 'Erfüllt die Regel nicht',
  'stale-proposal': 'Vorschlag beruht auf einem veralteten Stand',
  'not-open': 'Nicht mehr offen',
  'endpoint-not-ok': 'Endpunkt geändert oder fehlt',
  outside: 'Außerhalb der Kette (@outside)',
  'step-removed': 'Schritt entfernt',
  'has-home-step': 'Prozess hat schon einen Heimatschritt',
  'competing-step': 'Weiterer Vorschlag auf einem anderen Schritt',
  'competing-call': 'Weiterer Aufruf vom selben Element',
  'human-involved': 'Ein Mensch war schon beteiligt',
  'agent-question': 'Offene Frage eines Agenten',
  'no-link': 'Einwand eines Agenten („Kein Zusammenhang“)',
  'agent-unsure': 'Ein anderer Agent ist unsicher',
};

export const LEDGER_STATES: Record<AutoAcceptLedgerState, string> = {
  'in-force': 'In Kraft',
  revoked: 'Widerrufen',
  'human-decided': 'Von einem Menschen entschieden',
};

const percentFormat = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
/** A threshold in percent with every decimal it has (up to four: 0.01 ‰ steps). */
const thresholdFormat = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 4 });

/** A ratio such as a precision: `0.9` → `90 %`, `14/15` → `93,3 %` (one decimal). */
export function formatPercent(value: number): string {
  return `${percentFormat.format(Math.round(value * 1000) / 10)} %`;
}

/**
 * A rule's minimum confidence: `0.9` → `90 %`, `0.9004` → `90,04 %`. Never
 * rounded to fewer decimals than it has (up to four of a percent), so a
 * threshold never reads rounder, and looser, than it is.
 */
export function formatThreshold(value: number): string {
  return `${percentInput(value)} %`;
}

/**
 * Reads a minimum confidence typed in percent (`90`, `92,5`, `92.5 %`, up to
 * four decimals, the precision {@link percentInput} shows): the fraction, or
 * `null` for anything outside 50–100 %.
 */
export function parsePercent(text: string): number | null {
  const m = /^\s*(\d{1,3}(?:[.,]\d{1,4})?)\s*%?\s*$/.exec(text);
  if (!m?.[1]) return null;
  const value = Math.round(Number(m[1].replace(',', '.')) * 10_000) / 1_000_000;
  return value >= MIN_AUTO_ACCEPT_CONFIDENCE && value <= 1 ? value : null;
}

/** The percent text of a minimum confidence for the input (`0.925` → `92,5`, `0.9004` → `90,04`). */
export function percentInput(value: number): string {
  return thresholdFormat.format(Math.round(value * 1_000_000) / 10_000);
}

/** The narrowing of a rule as short German phrases (type, agent, model, ad hoc). */
export function narrowingOf(
  rule: Pick<AutoAcceptRule, 'relationType' | 'llmModel' | 'includeAdHoc'> & {
    agentHandle?: string | null;
    agentRevoked?: boolean;
  },
): string[] {
  const out: string[] = [];
  if (rule.relationType) out.push(`Typ ${relationTypeLabel(rule.relationType)}`);
  if (rule.agentHandle)
    out.push(`Agent ${rule.agentHandle}${rule.agentRevoked ? ' (widerrufen)' : ''}`);
  if (rule.llmModel) out.push(`LLM-Modell ${rule.llmModel}`);
  if (rule.includeAdHoc) out.push('auch Ad-hoc');
  return out;
}

/** The criteria of a draft (what a preview takes). */
export function criteriaOf(d: AutoAcceptRuleDraft): AutoAcceptCriteria {
  return {
    kind: d.kind,
    tier: d.tier,
    minConfidence: d.minConfidence,
    relationType: d.relationType ?? null,
    agentPrincipalId: d.agentPrincipalId ?? null,
    llmModel: d.llmModel ?? null,
    includeAdHoc: d.includeAdHoc ?? false,
  };
}

/** The draft of a rule's head revision (what an edit or a switch starts from). */
export function draftOf(rule: AutoAcceptRule): AutoAcceptRuleDraft {
  return {
    name: rule.name,
    enabled: rule.enabled,
    note: rule.note,
    kind: rule.kind,
    tier: rule.tier,
    minConfidence: rule.minConfidence,
    relationType: rule.relationType,
    agentPrincipalId: rule.agentPrincipalId,
    llmModel: rule.llmModel,
    includeAdHoc: rule.includeAdHoc,
  };
}

/** The history line: what the rule would have accepted so far and how humans decided it. */
export function historyText(h: AutoAcceptPreview['history']): string {
  const decided = [
    `${h.accepted} angenommen`,
    `${h.rejected} abgelehnt`,
    `${h.corrected} korrigiert`,
    ...(h.held > 0 ? [`${h.held} vorgemerkt`] : []),
  ].join(', ');
  const precision =
    h.precision === null ? 'noch keine Trefferquote' : `Trefferquote ${formatPercent(h.precision)}`;
  return (
    `Bisher: ${h.wouldAccept} von ${h.decided} entschiedenen Agentenvorschlägen hätte die Regel ` +
    `angenommen – davon ${decided} (${precision})`
  );
}

/**
 * What another owner changed between two revisions, as German phrases: the
 * rule dialog lists them after loading a newer revision (412).
 */
export function revisionChanges(from: AutoAcceptRule, to: AutoAcceptRule): string[] {
  const agent = (r: AutoAcceptRule) =>
    r.agentPrincipalId === null ? 'alle Agenten' : (r.agent?.handle ?? r.agentPrincipalId);
  const out: string[] = [];
  const diff = (label: string, a: string, b: string) => {
    if (a !== b) out.push(`${label}: ${a} → ${b}`);
  };
  diff('Status', from.enabled ? 'aktiv' : 'aus', to.enabled ? 'aktiv' : 'aus');
  diff('Name', `„${from.name}“`, `„${to.name}“`);
  diff('Stufe', tierLabel(from.tier), tierLabel(to.tier));
  diff('ab Konfidenz', formatThreshold(from.minConfidence), formatThreshold(to.minConfidence));
  diff(
    'Typ',
    from.relationType ? relationTypeLabel(from.relationType) : 'alle Typen',
    to.relationType ? relationTypeLabel(to.relationType) : 'alle Typen',
  );
  diff('Agent', agent(from), agent(to));
  diff('LLM-Modell', from.llmModel ?? 'alle Modelle', to.llmModel ?? 'alle Modelle');
  diff('Ad-hoc-Vorschläge', from.includeAdHoc ? 'ja' : 'nein', to.includeAdHoc ? 'ja' : 'nein');
  diff('Notiz', from.note ? `„${from.note}“` : 'keine', to.note ? `„${to.note}“` : 'keine');
  return out;
}
