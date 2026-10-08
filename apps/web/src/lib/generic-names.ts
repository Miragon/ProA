import type { Fact, Relation } from '@proa/client';

/**
 * Flags for the bulk accept preview (M2 item 7): key-tier proposals match on
 * identical names, which is right for "RechnungVersendet" and risky for
 * "Antwort" or "Daten aktualisiert". A pair is flagged when its message or
 * signal name, or an end's label, consists of generic words only, or when
 * more than two processes use the same name ({@link genericFlags}); and,
 * once agents work the pipeline, when the proposal asks the reviewer a
 * question or a call target is not unique ({@link bulkFlags}).
 */

/** Words that say nothing about the business object (DE/EN, normalized like {@link nameWords}). */
export const GENERIC_WORDS: ReadonlySet<string> = new Set([
  // nouns
  'antwort',
  'rueckmeldung',
  'rueckantwort',
  'nachricht',
  'meldung',
  'mitteilung',
  'benachrichtigung',
  'info',
  'information',
  'informationen',
  'daten',
  'datensatz',
  'status',
  'statusmeldung',
  'ergebnis',
  'ereignis',
  'anfrage',
  'signal',
  'event',
  'message',
  'response',
  'reply',
  'answer',
  'request',
  'data',
  'result',
  'notification',
  'update',
  'feedback',
  'callback',
  'trigger',
  // verbs: infinitives, participles, adjectives
  'senden',
  'versenden',
  'versendet',
  'schicken',
  'melden',
  'gemeldet',
  'informieren',
  'informiert',
  'benachrichtigen',
  'aktualisieren',
  'pruefen',
  'bearbeiten',
  'verarbeiten',
  'abschliessen',
  'starten',
  'beenden',
  'send',
  'receive',
  'notify',
  'check',
  'process',
  'start',
  'finish',
  'erhalten',
  'empfangen',
  'eingegangen',
  'eingetroffen',
  'gesendet',
  'verschickt',
  'aktualisiert',
  'geaendert',
  'geprueft',
  'bearbeitet',
  'verarbeitet',
  'abgeschlossen',
  'erledigt',
  'fertig',
  'gestartet',
  'beendet',
  'begonnen',
  'erfolgt',
  'bereit',
  'vorhanden',
  'neu',
  'ok',
  'done',
  'received',
  'sent',
  'updated',
  'changed',
  'checked',
  'processed',
  'completed',
  'finished',
  'started',
  'ended',
  'ready',
  'new',
]);

const STOP_WORDS: ReadonlySet<string> = new Set([
  'der',
  'die',
  'das',
  'den',
  'dem',
  'des',
  'ein',
  'eine',
  'einer',
  'einen',
  'ist',
  'wurde',
  'wird',
  'sind',
  'und',
  'oder',
  'von',
  'vom',
  'zum',
  'zur',
  'fuer',
  'liegt',
  'vor',
  'the',
  'a',
  'an',
  'is',
  'was',
  'has',
  'been',
  'of',
  'for',
  'to',
  'and',
]);

const FOLD: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** Words of a label or name: camelCase split, umlauts folded, lowercase, punctuation dropped. */
export function nameWords(text: string): string[] {
  return text
    .normalize('NFKC')
    .replace(/([a-zäöüß0-9])([A-ZÄÖÜ])/g, '$1 $2')
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => FOLD[c] ?? c)
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}

/** Name key like the key tier's: case, umlauts, punctuation and word separators ignored. */
export function nameKey(text: string): string {
  return nameWords(text).join('');
}

/** True if every meaningful word of `text` is generic ("Antwort erhalten", "Daten aktualisiert"). */
export function isGenericName(text: string): boolean {
  const words = nameWords(text).filter((w) => !STOP_WORDS.has(w));
  return words.length > 0 && words.every((w) => GENERIC_WORDS.has(w));
}

type Family = 'message' | 'signal';

function familyOf(kind: Fact['kind']): Family | null {
  if (kind === 'msg_throw' || kind === 'msg_catch') return 'message';
  if (kind === 'sig_throw' || kind === 'sig_catch') return 'signal';
  return null;
}

/** The message or signal name a fact matches on: the referenced name, else its label. */
function matchName(fact: Pick<Fact, 'attrs' | 'label'>): string {
  const attrs = fact.attrs;
  return attrs.messageName ?? attrs.signalName ?? fact.label;
}

/** Processes that use one message or signal name, and which of them send or receive it. */
export interface NameUse {
  processes: ReadonlySet<string>;
  senders: ReadonlySet<string>;
  receivers: ReadonlySet<string>;
}

/** `family:nameKey` → its {@link NameUse}. */
export type NameUsage = ReadonlyMap<string, NameUse>;

/** Which processes send and receive each message and signal name (from the head facts). */
export function nameUsage(facts: readonly Fact[]): NameUsage {
  const usage = new Map<
    string,
    { processes: Set<string>; senders: Set<string>; receivers: Set<string> }
  >();
  for (const f of facts) {
    const family = familyOf(f.kind);
    if (family === null || f.processId === null) continue;
    const key = nameKey(matchName(f));
    if (key === '') continue;
    const id = `${family}:${key}`;
    let use = usage.get(id);
    if (!use)
      usage.set(id, (use = { processes: new Set(), senders: new Set(), receivers: new Set() }));
    const process = `${f.modelKey}#${f.processId}`;
    use.processes.add(process);
    (f.kind.endsWith('_throw') ? use.senders : use.receivers).add(process);
  }
  return usage;
}

export interface GenericFlag {
  kind: 'generic-word' | 'shared-name' | 'agent-question' | 'ambiguous-target';
  /** The name or label the flag is about. */
  text: string;
  /** One German sentence for the preview. */
  detail: string;
}

/**
 * Why a pair deserves a second look before a bulk accept; empty when nothing
 * is suspicious. `labelOf` resolves an end's label (element name).
 */
export function genericFlags(
  relation: Pick<Relation, 'type' | 'from' | 'to' | 'attrs'>,
  labelOf: (ref: string) => string | null,
  usage: NameUsage,
): GenericFlag[] {
  const flags: GenericFlag[] = [];
  const attrs = relation.attrs;
  const declared =
    typeof attrs['messageName'] === 'string'
      ? attrs['messageName']
      : typeof attrs['signalName'] === 'string'
        ? attrs['signalName']
        : null;
  const fromLabel = labelOf(relation.from);
  const toLabel = labelOf(relation.to);
  const name = declared ?? fromLabel;
  const seen = new Set<string>();
  for (const text of [name, fromLabel, toLabel]) {
    if (text === null || text.trim() === '' || seen.has(nameKey(text))) continue;
    seen.add(nameKey(text));
    if (isGenericName(text)) {
      flags.push({
        kind: 'generic-word',
        text,
        detail: `„${text}“ ist allgemein formuliert und passt auf viele Vorgänge.`,
      });
    }
  }
  const family = relation.type === 'message' || relation.type === 'signal' ? relation.type : null;
  if (family !== null && name !== null) {
    const use = usage.get(`${family}:${nameKey(name)}`);
    if (use && use.processes.size > 2) {
      const senders = use.senders.size === 1 ? '1 sendet' : `${use.senders.size} senden`;
      const receivers = use.receivers.size === 1 ? '1 empfängt' : `${use.receivers.size} empfangen`;
      flags.push({
        kind: 'shared-name',
        text: name,
        detail: `„${name}“ kommt in ${use.processes.size} Prozessen vor (${senders}, ${receivers}); prüfe, ob genau dieses Paar zusammengehört.`,
      });
    }
  }
  return flags;
}

/** Longest question shown in a bulk preview row; the review screen shows it in full. */
const MAX_FLAG_QUESTION = 160;

/**
 * Everything that makes a pair need more than a glance before a bulk accept:
 * {@link genericFlags}, plus
 * - `agent-question`: the proposal the status rests on asks the reviewer a
 *   question (the review screen shows it; a bulk accept would skip it);
 * - `ambiguous-target`: a call whose process id several models define
 *   (`duplicate-process-id`), where accepting every target is rarely right.
 */
export function bulkFlags(
  relation: Pick<Relation, 'type' | 'from' | 'to' | 'attrs' | 'provenance'>,
  labelOf: (ref: string) => string | null,
  usage: NameUsage,
): GenericFlag[] {
  const flags = genericFlags(relation, labelOf, usage);
  const question = relation.provenance?.question?.trim();
  if (question) {
    const shown =
      question.length > MAX_FLAG_QUESTION
        ? `${question.slice(0, MAX_FLAG_QUESTION - 1).trimEnd()}…`
        : question;
    flags.push({
      kind: 'agent-question',
      text: question,
      detail: `Der Agent fragt nach: „${shown}“`,
    });
  }
  if (relation.type === 'call' && relation.attrs['match'] === 'duplicate-process-id') {
    const target = relation.attrs['calledElement'];
    const id = typeof target === 'string' ? target : '';
    flags.push({
      kind: 'ambiguous-target',
      text: id,
      detail: `Die Prozess-ID „${id}“ ist mehrfach definiert; meist ist nur eines der Ziele gemeint.`,
    });
  }
  return flags;
}
