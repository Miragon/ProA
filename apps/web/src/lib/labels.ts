import type {
  AgentScope,
  AssertionKind,
  DeclaredProcedure,
  EndpointState,
  FindingKind,
  LinkKind,
  ModelStage,
  Relation,
  RelationStatus,
  RelationType,
  SourceKind,
  StepKind,
  Tier,
  UnplacedState,
  ValueChainFindingKind,
  ValueChainViolationReason,
  Verdict,
} from '@proa/client';

/** Tone of a badge; maps onto the Miragon status colours (modeler-tool-design §3.3). */
export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'neutral' | 'primary';

export interface Presentation {
  label: string;
  tone: Tone;
  /** One sentence for tooltips and screen readers. */
  hint: string;
}

/** Pipeline stage of a model (CONCEPT §3, view `model_pipeline`). */
export const STAGES: Record<ModelStage, Presentation> = {
  waiting_for_agent: {
    label: 'Wartet auf Agent',
    tone: 'info',
    hint: 'Eine Analyse ist eingeplant; noch hat kein Agent sie übernommen.',
  },
  agent_working: {
    label: 'Agent arbeitet',
    tone: 'info',
    hint: 'Ein Agent hat die Analyse übernommen und arbeitet daran.',
  },
  agent_failed: {
    label: 'Agent gescheitert',
    tone: 'danger',
    hint: 'Die Analyse ist dreimal nicht abgeschlossen worden.',
  },
  waiting_for_review: {
    label: 'Wartet auf Prüfung',
    tone: 'warning',
    hint: 'Es gibt vorgeschlagene Relationen, die ein Mensch prüfen sollte.',
  },
  waiting_for_clarification: {
    label: 'Klärung offen',
    tone: 'warning',
    hint: 'Nur noch vorgemerkte Relationen sind offen.',
  },
  incorporated: {
    label: 'Eingearbeitet',
    tone: 'success',
    hint: 'Analyse fertig, nichts mehr offen.',
  },
};

export const STAGE_ORDER: readonly ModelStage[] = [
  'waiting_for_review',
  'waiting_for_clarification',
  'agent_failed',
  'waiting_for_agent',
  'agent_working',
  'incorporated',
];

export const RELATION_STATUSES: Record<RelationStatus, Presentation> = {
  accepted: { label: 'Angenommen', tone: 'success', hint: 'Die Relation gilt.' },
  proposed: {
    label: 'Vorgeschlagen',
    tone: 'info',
    hint: 'Vorschlag, den ein Mensch noch prüfen muss.',
  },
  held: { label: 'Vorgemerkt', tone: 'warning', hint: 'Vorgemerkt, bis eine Frage geklärt ist.' },
  rejected: { label: 'Abgelehnt', tone: 'danger', hint: 'Ein Mensch hat die Relation abgelehnt.' },
  obsolete: {
    label: 'Veraltet',
    tone: 'neutral',
    hint: 'Kein Vorschlag mehr und keine Entscheidung; ausgeblendet.',
  },
};

export const STATUS_ORDER: readonly RelationStatus[] = [
  'accepted',
  'proposed',
  'held',
  'rejected',
  'obsolete',
];

export const TIERS: Record<Tier, Presentation> = {
  rule: {
    label: 'Regel',
    tone: 'primary',
    hint: 'Eindeutiger Aufruf: calledElement trifft genau eine Prozess-ID, automatisch angenommen.',
  },
  key: {
    label: 'Schlüssel',
    tone: 'info',
    hint: 'Gleicher Nachrichten-, Signal- oder Aufrufname; Vorschlag zum schnellen Bestätigen.',
  },
  lexical: { label: 'Ähnlich', tone: 'neutral', hint: 'Ähnliche Bezeichnungen.' },
  semantic: {
    label: 'Bedeutung',
    tone: 'neutral',
    hint: 'Gleiche Bedeutung mit anderen Worten, von einem Agenten erkannt.',
  },
  manual: { label: 'Manuell', tone: 'neutral', hint: 'Von einem Menschen angelegt.' },
};

export const TIER_ORDER: readonly Tier[] = ['rule', 'key', 'lexical', 'semantic', 'manual'];

export const RELATION_TYPES: Record<RelationType, Presentation> = {
  call: { label: 'Aufruf', tone: 'neutral', hint: 'Call Activity ruft einen Prozess auf.' },
  message: { label: 'Nachricht', tone: 'neutral', hint: 'Nachricht von Sender zu Empfänger.' },
  signal: { label: 'Signal', tone: 'neutral', hint: 'Signal von Sender zu Empfänger.' },
  trigger: {
    label: 'Auslöser',
    tone: 'neutral',
    hint: 'Das Ende eines Prozesses startet einen anderen.',
  },
  manual: { label: 'Manuell', tone: 'neutral', hint: 'Von einem Menschen angelegt.' },
};

export const TYPE_ORDER: readonly RelationType[] = [
  'call',
  'message',
  'signal',
  'trigger',
  'manual',
];

export const ENDPOINT_STATES: Record<EndpointState, Presentation> = {
  ok: { label: 'Endpunkte ok', tone: 'success', hint: 'Beide Endpunkte sind unverändert.' },
  changed: {
    label: 'Endpunkt geändert',
    tone: 'warning',
    hint: 'Ein Endpunkt hat seit der Entscheidung seine Bedeutung geändert.',
  },
  missing: {
    label: 'Endpunkt fehlt',
    tone: 'danger',
    hint: 'Ein Endpunkt existiert im aktuellen Stand nicht mehr.',
  },
};

export const FINDING_KINDS: Record<FindingKind, Presentation> = {
  'unresolved-call': {
    label: 'Aufruf ohne Ziel',
    tone: 'danger',
    hint: 'Das calledElement passt zu keiner Prozess-ID im Projekt.',
  },
  'dynamic-call': {
    label: 'Dynamischer Aufruf',
    tone: 'warning',
    hint: 'Das Ziel ist ein Ausdruck und steht erst zur Laufzeit fest.',
  },
  'duplicate-process-id': {
    label: 'Doppelte Prozess-ID',
    tone: 'danger',
    hint: 'Mehrere Modelle definieren dieselbe Prozess-ID; Aufrufe sind dadurch mehrdeutig.',
  },
  'dangling-throw': {
    label: 'Gesendet, nirgends empfangen',
    tone: 'warning',
    hint: 'Kein Modell empfängt diese Nachricht oder dieses Signal unter gleichem Namen.',
  },
  'unmatched-catch': {
    label: 'Empfangen, nirgends gesendet',
    tone: 'warning',
    hint: 'Kein Modell sendet diese Nachricht oder dieses Signal unter gleichem Namen.',
  },
};

export const FINDING_ORDER: readonly FindingKind[] = [
  'unresolved-call',
  'duplicate-process-id',
  'dynamic-call',
  'dangling-throw',
  'unmatched-catch',
];

export const SCOPES: Record<AgentScope, { label: string; hint: string }> = {
  'proa:read': { label: 'Lesen', hint: 'Modelle, Fakten und Relationen lesen.' },
  'proa:propose': {
    label: 'Vorschlagen',
    hint: 'Relationen vorschlagen und Analysen bearbeiten.',
  },
  'proa:write': { label: 'Schreiben', hint: 'Modelle hochladen und löschen.' },
};

/** Who stands behind a relation: the principal and procedure its status rests on. */
export interface Provenance {
  source: SourceKind;
  label: string;
  detail: string;
}

const RULES_PROCEDURE = 'proa-rules/1.0.0';

/** `proa-rules/1.0.0` for the rule tier (CONCEPT §2), `id@version` for agent procedures. */
export function procedureText(procedure: DeclaredProcedure | null): string | null {
  if (procedure === null) return null;
  return procedure.id === 'proa-rules'
    ? `${procedure.id}/${procedure.version}`
    : `${procedure.id}@${procedure.version}`;
}

/** What the rule tier matched on, from tier, type and attributes. */
function ruleDetail(relation: Pick<Relation, 'tier' | 'type' | 'attrs'>): string {
  const match = typeof relation.attrs['match'] === 'string' ? relation.attrs['match'] : null;
  if (relation.tier === 'rule') return 'eindeutiger Aufruf';
  if (match === 'duplicate-process-id') return 'Prozess-ID mehrdeutig';
  if (match === 'file-stem') return 'Treffer über Dateinamen';
  if (match === 'process-name') return 'Treffer über Prozessnamen';
  if (relation.type === 'message') return 'gleicher Nachrichtenname';
  if (relation.type === 'signal') return 'gleicher Signalname';
  return 'gleicher Schlüssel';
}

/** Past-tense verdicts for provenance and the timeline. */
export const VERDICT_DONE: Record<Verdict, string> = {
  accept: 'angenommen',
  reject: 'abgelehnt',
  hold: 'vorgemerkt',
};

/**
 * Provenance of a relation from the API (`Relation.provenance`): rule
 * relations show `proa-rules/1.0.0` and what matched, agent proposals the
 * principal plus procedure and model they declared, human decisions the
 * handle and the verdict. Relations without provenance fall back to what
 * tier and attributes say.
 */
export function provenanceOf(
  relation: Pick<Relation, 'tier' | 'type' | 'attrs' | 'provenance'>,
): Provenance {
  const p = relation.provenance;
  if (p) {
    switch (p.sourceKind) {
      case 'rule':
        return {
          source: 'rule',
          label: procedureText(p.procedure) ?? RULES_PROCEDURE,
          detail: ruleDetail(relation),
        };
      case 'agent': {
        const declared = [procedureText(p.procedure), p.llmModel].filter(Boolean).join(' · ');
        return {
          source: 'agent',
          label: p.handle,
          detail: declared === '' ? 'Agent-Vorschlag' : declared,
        };
      }
      case 'human':
        return {
          source: 'human',
          label: p.handle,
          detail:
            p.kind === 'decision' && p.verdict
              ? relation.tier === 'manual'
                ? 'manuell angelegt'
                : VERDICT_DONE[p.verdict]
              : p.kind === 'proposal'
                ? 'Vorschlag'
                : 'Notiz',
        };
    }
  }
  switch (relation.tier) {
    case 'rule':
    case 'key':
      return { source: 'rule', label: RULES_PROCEDURE, detail: ruleDetail(relation) };
    case 'lexical':
      if (relation.attrs['match'] === 'process-name')
        return { source: 'rule', label: RULES_PROCEDURE, detail: ruleDetail(relation) };
      return { source: 'agent', label: 'Agent', detail: 'ähnliche Bezeichnung' };
    case 'semantic':
      return { source: 'agent', label: 'Agent', detail: 'gleiche Bedeutung' };
    case 'manual':
      return { source: 'human', label: 'Mensch', detail: 'manuell angelegt' };
  }
}

export const SOURCE_KINDS: Record<SourceKind, string> = {
  rule: 'Regel',
  agent: 'Agent',
  human: 'Mensch',
};

export const ASSERTION_KINDS: Record<AssertionKind, string> = {
  proposal: 'Vorschlag',
  withdrawal: 'Zurückgezogen',
  decision: 'Entscheidung',
  note: 'Notiz',
};

/** `0.8` → `80 %`; `null` → `–`. */
export function formatConfidence(confidence: number | null): string {
  if (confidence === null) return '–';
  return `${Math.round(confidence * 100)} %`;
}

const dateFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const dayFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });

export function formatDateTime(iso: string): string {
  return dateFormat.format(new Date(iso));
}

export function formatDate(iso: string): string {
  return dayFormat.format(new Date(iso));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

// ------------------------------------------------------------ value chain (M4)

/** Kind of a value chain step (M4 §2): core by the predecessor chain, the others by colour. */
export const STEP_KINDS: Record<StepKind, Presentation> = {
  core: {
    label: 'Kern',
    tone: 'primary',
    hint: 'Kernschritt: liegt auf der Vorgänger-Kette der obersten Ebene.',
  },
  management: {
    label: 'Management',
    tone: 'neutral',
    hint: 'Managementschritt: lila eingefärbt, nicht auf der Kern-Kette.',
  },
  support: {
    label: 'Unterstützung',
    tone: 'neutral',
    hint: 'Unterstützungsschritt: grün eingefärbt, nicht auf der Kern-Kette.',
  },
  other: {
    label: 'Sonstige',
    tone: 'neutral',
    hint: 'Weder auf der Kern-Kette noch lila oder grün eingefärbt.',
  },
};

export const STEP_KIND_ORDER: readonly StepKind[] = ['core', 'management', 'support', 'other'];

/** What a step link is (M4 §2 "The link field"). */
export const LINK_KINDS: Record<LinkKind, Presentation> = {
  none: { label: 'Kein Link', tone: 'neutral', hint: 'Der Schritt verweist auf nichts.' },
  process: {
    label: 'ProA-Prozess',
    tone: 'info',
    hint: 'Verweist auf einen Prozess des Projekts; ergibt einen Schlüssel-Vorschlag.',
  },
  url: { label: 'Webadresse', tone: 'neutral', hint: 'Eine http(s)-Adresse.' },
  opaque: {
    label: 'Freier Text',
    tone: 'neutral',
    hint: 'Ein Verweis, den ProA nicht auflöst; er bleibt unverändert.',
  },
};

export const VALUE_CHAIN_FINDING_KINDS: Record<ValueChainFindingKind, Presentation> = {
  'process-without-step': {
    label: 'Prozess ohne Schritt',
    tone: 'warning',
    hint: 'Kein angenommener Schritt (auch nicht „Außerhalb der Kette“) für diesen Prozess.',
  },
  'step-without-process': {
    label: 'Kein Prozess angenommen',
    tone: 'warning',
    hint: 'Weder auf dem Schritt noch darunter ist ein Prozess angenommen.',
  },
  'unresolved-link': {
    label: 'Link nicht auflösbar',
    tone: 'warning',
    hint: 'Der Link ist weder ein Prozess des Projekts noch eine http(s)-Adresse.',
  },
};

export const VALUE_CHAIN_FINDING_ORDER: readonly ValueChainFindingKind[] = [
  'process-without-step',
  'step-without-process',
  'unresolved-link',
];

/** Review state of a process without a home step (`process-without-step`). */
export const UNPLACED_STATES: Record<UnplacedState, Presentation> = {
  none: {
    label: 'Ohne Vorschlag',
    tone: 'neutral',
    hint: 'Niemand hat einen Schritt vorgeschlagen.',
  },
  proposed: {
    label: 'Vorschlag offen',
    tone: 'info',
    hint: 'Ein Vorschlag wartet auf deine Prüfung.',
  },
  held: { label: 'Vorgemerkt', tone: 'warning', hint: 'Eine Platzierung ist vorgemerkt.' },
};

/** The pseudo-step `@outside` and the call roll-up (M4 §2). */
export const OUTSIDE_LABEL = 'Außerhalb der Kette';
export const REACHED_BY_CALL_LABEL = 'Über Aufrufe erreicht';

/**
 * Why the server refused a value chain (422 `value-chain-invalid`), in German
 * for the violations panel. The element or connection is named next to it.
 */
export const VALUE_CHAIN_VIOLATION_TEXTS: Record<ValueChainViolationReason, string> = {
  'not-json': 'Das Dokument ist kein gültiges JSON.',
  'not-an-object': 'Das Dokument ist kein JSON-Objekt.',
  schema: 'Das Dokument passt nicht zum Format der Wertschöpfungskette.',
  'duplicate-id': 'Eine ID kommt mehrfach vor.',
  'unknown-endpoint': 'Eine Verbindung zeigt auf ein Element, das es nicht gibt.',
  'self-connection': 'Eine Verbindung verbindet ein Element mit sich selbst.',
  'connection-not-allowed': 'Diese Verbindungsart ist zwischen diesen Elementen nicht erlaubt.',
  'document-too-large': 'Die Kette ist zu groß (höchstens 1 MB).',
  'too-many-elements': 'Zu viele Elemente (höchstens 500 Schritte und Organisationseinheiten).',
  'too-many-connections': 'Zu viele Verbindungen (höchstens 1.000).',
  'name-required': 'Die Kette braucht einen Namen.',
  'name-too-long': 'Der Name ist zu lang (höchstens 200 Zeichen).',
  'name-characters': 'Der Name enthält Steuer- oder Richtungszeichen.',
  'id-too-long': 'Die ID ist zu lang (höchstens 128 Zeichen).',
  'id-characters': 'Die ID enthält Leer-, Steuer- oder Richtungszeichen.',
  'reserved-id': 'Die ID ist reserviert („vc-root“ oder beginnt mit „@“).',
  'link-too-long': 'Der Link ist zu lang (höchstens 2.000 Zeichen).',
  'link-characters': 'Der Link enthält Steuer- oder Richtungszeichen.',
  'geometry-out-of-range': 'Das Element liegt zu weit außen oder ist zu groß.',
  'multiple-parents': 'Der Schritt hat mehr als einen übergeordneten Schritt.',
  'hierarchy-cycle': 'Die Über-/Unterordnung bildet einen Kreis.',
  'hierarchy-too-deep': 'Zu tief geschachtelt: höchstens zwei Ebenen unter der obersten.',
  'duplicate-connection':
    'Zwischen diesen Schritten gibt es diese Verbindungsart schon (auch in Gegenrichtung).',
  'sequence-cycle': 'Die Vorgänger-Kette bildet einen Kreis.',
};
