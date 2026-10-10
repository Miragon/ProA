import type { DocumentCheck } from '@/components/value-chain/chain-canvas-types';

import { formatDateTime } from './labels';
import { MAX_VALUE_CHAIN_BODY_BYTES } from './limits';

/**
 * Importing a `.vc.json` on the value chain page (M4 §3.3): a file a human
 * chose (often one an agent drafted with the MCP prompt `draft_value_chain`)
 * replaces the drawing in edit mode; the human checks and saves it as usual.
 * This module holds the page side: the file input's filter, the size and
 * JSON checks, the German texts. The schema check runs in the lazy canvas
 * chunk (`canvas/check-document.ts`), which owns schema-model and zod.
 */

/** The file input's `accept`: `.vc.json` files and JSON. */
export const IMPORT_ACCEPT = '.vc.json,application/json';

/** Largest file the page imports: what the server accepts as a request body (2 MiB). */
export const MAX_IMPORT_CHAIN_BYTES = MAX_VALUE_CHAIN_BODY_BYTES;

/** A file read for the import, or why it cannot be imported. */
export type ImportRead = { ok: true; text: string; json: unknown } | { ok: false; message: string };

const quote = (name: string) => `„${name}“`;

/**
 * Reads a chosen file: at most {@link MAX_IMPORT_CHAIN_BYTES}, UTF-8 JSON.
 * The schema check follows in the canvas chunk.
 */
export async function readImportFile(file: File): Promise<ImportRead> {
  if (file.size > MAX_IMPORT_CHAIN_BYTES) {
    return {
      ok: false,
      message: `${quote(file.name)} ist größer als 2 MB; ProA nimmt höchstens 2 MB entgegen.`,
    };
  }
  const text = await file.text();
  try {
    return { ok: true, text, json: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      message: `${quote(file.name)} ist keine JSON-Datei. Wähle eine .vc.json-Datei.`,
    };
  }
}

/** The German text of a failed check (`checkDocument`); `null` when the document is valid. */
export function importErrorText(fileName: string, check: DocumentCheck): string | null {
  if (check.ok) return null;
  if (check.kind === 'version') {
    return (
      `${quote(fileName)} hat die Formatversion ${check.version}; ProA kennt höchstens ` +
      `${check.supported}. Exportiere die Kette im älteren Format oder aktualisiere ProA.`
    );
  }
  const where = check.path === null ? '' : ` (Feld ${quote(check.path)})`;
  return (
    `${quote(fileName)} ist keine gültige Wertschöpfungskette${where}: ${check.detail}. ` +
    'Erwartet wird eine .vc.json mit schemaVersion, meta.name, elements und connections.'
  );
}

/** The question before an import replaces a drawing with content or unsaved edits. */
export function importConfirmText(fileName: string): string {
  return `Die aktuelle Zeichnung wird durch ${quote(fileName)} ersetzt.`;
}

/** The question before an import of a new chain replaces the stored draft of one. */
export function importReplacesDraftText(fileName: string, savedAt: string): string {
  return `Du hast am ${formatDateTime(savedAt)} eine neue Kette gezeichnet und nicht gespeichert; ${quote(fileName)} ersetzt diesen Entwurf.`;
}
