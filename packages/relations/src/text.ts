// Lexical similarity for candidate ranking (CONCEPT §7): normalization with
// transliteration (normalizeKey), German and English stopwords, a short
// DE/EN synonym list, token Jaccard and a label-length-relative Levenshtein
// distance. Deterministic and dependency-free.
import { normalizeKey } from '@proa/bpmn-facts';

import { round4 } from './order.ts';

/** Splits a whitespace-separated word table. */
function words(table: string): string[] {
  return table.trim().split(/\s+/);
}

/** German and English function words, in `normalizeKey` form (`für` → `fuer`). */
export const STOPWORDS: ReadonlySet<string> = new Set(
  words(`
    der die das den dem des ein eine einen einem einer eines und oder aber an am auf aus bei
    beim bis durch fuer gegen im in ins mit nach ohne seit ueber um unter von vom vor zu zum
    zur als auch ist sind war wird werden wurde wurden hat haben nicht noch pro sich wie wo je

    a an the and or but at by for from into of off on onto out over to up with without is are
    was were be been being has have had not no via per as it its this that these those

    process prozess
  `),
);
// The last line: modelling boilerplate in ids and names (`Process_Billing`, "Prozess Rechnung").

/** Multi-word terms joined into one token before matching (normalized form). */
const PHRASES: ReadonlyArray<readonly [string, string]> = [
  ['credit note', 'creditnote'],
  ['master data', 'masterdata'],
  ['purchase order', 'purchaseorder'],
];

const SYNONYM_TABLE = `
  invoice:     rechnung invoice faktur billing
  pay:         zahlung bezahlt gezahlt payment paid pay
  order:       auftrag auftraeg bestellung bestellt order purchaseorder
  deliver:     lieferung geliefert deliver shipment sendung
  send:        versend versandt versand gesendet gesandt senden verschickt verschicken sent send
               dispatch shipped shipping
  receive:     eingegangen eingang erhalten empfangen eingetroffen received receive receipt arrived
  create:      erstell angelegt anlegen created create creation
  request:     angefordert anforder beantragt requested request
  approve:     freigegeben freigabe freigeben genehmigt genehmigung approved approve approval
               released release
  reject:      abgelehnt ablehnung ablehnen rejected reject rejection declined decline
  cancel:      storniert stornierung storno abgebrochen abbruch cancelled canceled cancel
               cancellation aborted abort
  complete:    abgeschlossen abschluss abschliessen erledigt beendet fertig completed complete
               completion finished done
  close:       geschlossen schliessen closed close
  check:       pruef checked check verified verify verification reviewed review kontrolliert
               kontrolle
  confirm:     bestaetig confirmed confirm confirmation
  answer:      antwort beantwortet response reply answer answered
  notify:      benachrichtig informiert notified notify notification informed inform
  report:      gemeldet meldung melden reported report
  change:      geaendert aenderung aendern changed change updated update aktualisiert
               aktualisierung angepasst anpassung adjusted adjust
  lock:        gesperrt sperr blocked block locked lock
  unlock:      entsperrt entsperr unblocked unblock unlocked unlock
  delay:       verspaetet verspaetung verzoegert verzoegerung delayed delay late
  start:       gestartet starten start started begonnen beginn begin
  open:        eroeffnet eroeffnung geoeffnet opened open
  creditnote:  gutschrift creditnote
  return:      retoure ruecksendung rueckgabe returned return
  complaint:   reklamation beschwerde complaint
  reminder:    mahnung erinnerung reminder dunning
  account:     konto account
  customer:    kunde customer client
  supplier:    lieferant supplier vendor
  goods:       ware waren goods artikel article item
  stock:       bestand inventory stock
  contract:    vertrag contract
  error:       fehler error defect defekt
  document:    dokument unterlagen document
  book:        gebucht buchung buchen booked posted posting
  assign:      zugeordnet zuordnung zuordnen assigned assign allocated allocate allocation
  new:         neu neue neuer neues new
  application: antrag application
  dealer:      haendler dealer reseller
  recall:      rueckruf recall
  due:         faellig due
  expire:      abgelaufen ablauf expired expire expiry
  appointment: termin appointment
  address:     adresse anschrift address
  data:        daten data
  masterdata:  stammdaten masterdata
  price:       preis price
  employee:    mitarbeiter employee staff
  period:      periode period zeitraum
  month:       monat month monthly monatlich
  year:        jahr year annual yearly jaehrlich
  transfer:    ueberweisung ueberwiesen transfer transferred
  ready:       bereit ready
  fail:        fehlgeschlagen gescheitert failed fail failure
  success:     erfolgreich successful success succeeded
`;

/**
 * A short DE/EN synonym list of general business-process vocabulary:
 * concept → word stems (in `normalizeKey` form). A token belongs to a
 * concept if it starts with one of the stems and adds at most
 * {@link MAX_INFLECTION} characters (`versend` → `versendet`, `versenden`);
 * stems shorter than five characters match exactly. Deliberately generic: no
 * domain or landscape vocabulary.
 */
export const SYNONYMS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  SYNONYM_TABLE.trim()
    .split(/\n(?=\s*\w+:)/)
    .map((entry) => {
      const [concept = '', stems = ''] = entry.split(':');
      return [concept.trim(), words(stems)];
    }),
);

/** Characters an inflected form may add to a synonym stem. */
export const MAX_INFLECTION = 3;
/** Stems shorter than this match whole tokens only. */
const MIN_PREFIX_STEM = 5;
/** Minimum head length for the German compound rule (`Eilzahlung` → `zahlung`). */
const MIN_COMPOUND_HEAD = 5;

const STEMS: ReadonlyArray<readonly [stem: string, concept: string]> = Object.entries(SYNONYMS)
  .flatMap(([concept, stems]) => stems.map((stem) => [stem, concept] as const))
  .sort((a, b) => b[0].length - a[0].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

function conceptOfWord(token: string): string | undefined {
  for (const [stem, concept] of STEMS) {
    if (token === stem) return concept;
    if (
      stem.length >= MIN_PREFIX_STEM &&
      token.startsWith(stem) &&
      token.length - stem.length <= MAX_INFLECTION
    ) {
      return concept;
    }
  }
  return undefined;
}

/** German compounds take the meaning of their last part: `eilzahlung` → `pay`. */
function conceptOfCompoundHead(token: string): string | undefined {
  for (const [stem, concept] of STEMS) {
    if (
      stem.length >= MIN_COMPOUND_HEAD &&
      token.length >= stem.length + 3 &&
      token.endsWith(stem)
    ) {
      return concept;
    }
  }
  return undefined;
}

const conceptCache = new Map<string, string>();

/**
 * The concept of a normalized token: its synonym group, also for German
 * participles (`ge…`) and compounds, else the token itself.
 */
export function conceptOf(token: string): string {
  const cached = conceptCache.get(token);
  if (cached !== undefined) return cached;
  const concept =
    conceptOfWord(token) ??
    (token.startsWith('ge') && token.length >= 7 ? conceptOfWord(token.slice(2)) : undefined) ??
    conceptOfCompoundHead(token) ??
    token;
  if (conceptCache.size < 50_000) conceptCache.set(token, concept);
  return concept;
}

/** Splits camelCase and PascalCase names into words: `RechnungVersendet` → `Rechnung Versendet`. */
export function splitCamelCase(raw: string): string {
  return raw
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2');
}

/** Normalized words without stopwords, multi-word terms joined: `Antrag prüfen` → `['antrag', 'pruefen']`. */
export function contentWords(raw: string): string[] {
  let text = ` ${normalizeKey(splitCamelCase(raw))} `;
  for (const [phrase, token] of PHRASES) text = text.replaceAll(` ${phrase} `, ` ${token} `);
  return text.split(' ').filter((w) => w !== '' && !STOPWORDS.has(w));
}

/** One text of an endpoint, prepared for comparison. */
export interface TextForm {
  /** Content words in order, joined by spaces (the Levenshtein input). */
  readonly words: string;
  /** Distinct concepts, sorted (the Jaccard input). */
  readonly concepts: readonly string[];
}

export function textForm(raw: string): TextForm {
  const words = contentWords(raw);
  return {
    words: words.join(' '),
    concepts: [...new Set(words.map(conceptOf))].sort(),
  };
}

/** Levenshtein distance (insertions, deletions, substitutions cost 1), over UTF-16 code units. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? 0;
}

/** `1 − distance / length of the longer string`; 0 when either string is empty. */
export function relativeLevenshtein(a: string, b: string): number {
  if (a === '' || b === '') return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** Concepts match if equal, or if they are inflections of one word (`kommissioniert` / `kommissionierung`). */
function conceptsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < MIN_PREFIX_STEM) return false;
  const prefix = commonPrefix(a, b);
  return prefix >= shorter - 1 && Math.max(a.length, b.length) - prefix <= MAX_INFLECTION + 1;
}

/** Token Jaccard over concepts, counting inflection variants as equal (greedy one-to-one matching). */
export function conceptJaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const used = new Array<boolean>(b.length).fill(false);
  let matched = 0;
  for (const x of a) {
    for (let j = 0; j < b.length; j++) {
      if (!used[j] && conceptsMatch(x, b[j] ?? '')) {
        used[j] = true;
        matched++;
        break;
      }
    }
  }
  return matched / (a.length + b.length - matched);
}

/** Weight of the Jaccard signal in the lexical score; the rest is the relative Levenshtein. */
export const JACCARD_WEIGHT = 0.6;

export interface Similarity {
  jaccard: number;
  levenshtein: number;
  /** `JACCARD_WEIGHT · jaccard + (1 − JACCARD_WEIGHT) · levenshtein`, rounded to 4 decimals. */
  score: number;
}

const NO_SIMILARITY: Similarity = { jaccard: 0, levenshtein: 0, score: 0 };

export function similarity(a: TextForm, b: TextForm): Similarity {
  const jaccard = round4(conceptJaccard(a.concepts, b.concepts));
  const lev = round4(relativeLevenshtein(a.words, b.words));
  return {
    jaccard,
    levenshtein: lev,
    score: round4(JACCARD_WEIGHT * jaccard + (1 - JACCARD_WEIGHT) * lev),
  };
}

/** The best similarity over all pairs of texts of two endpoints. */
export function bestSimilarity(a: readonly TextForm[], b: readonly TextForm[]): Similarity {
  let best = NO_SIMILARITY;
  for (const x of a) {
    for (const y of b) {
      const s = similarity(x, y);
      if (
        s.score > best.score ||
        (s.score === best.score &&
          (s.jaccard > best.jaccard ||
            (s.jaccard === best.jaccard && s.levenshtein > best.levenshtein)))
      ) {
        best = s;
      }
    }
  }
  return best;
}

/** Lexical evidence: at least one shared concept, or nearly the same words. */
export const LEXICAL_MIN_LEVENSHTEIN = 0.75;

export function hasLexicalEvidence(s: Similarity): boolean {
  return s.jaccard > 0 || s.levenshtein >= LEXICAL_MIN_LEVENSHTEIN;
}
