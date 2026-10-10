/** Maximum label length in UTF-16 code units (CONCEPT §6). */
export const MAX_LABEL_LENGTH = 200;
/** Maximum documentation length in UTF-16 code units (CONCEPT §6). */
export const MAX_DOCUMENTATION_LENGTH = 2000;
/** Maximum `keyRaw` length; message names and call targets are never this long in practice. */
export const MAX_KEY_LENGTH = 1000;

/**
 * Bidirectional formatting characters (Trojan Source, CVE-2021-42574): the
 * marks LRM, RLM and ALM, the embeddings and overrides U+202A–U+202E and the
 * isolates U+2066–U+2069.
 */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/gu;
const CONTROL = /\p{Cc}/gu;
const CONTROL_EXCEPT_NEWLINE = /[^\P{Cc}\n]/gu;

export interface Sanitized {
  text: string;
  /** The text was longer than the limit and was cut. */
  truncated: boolean;
}

function truncate(text: string, max: number): Sanitized {
  if (text.length <= max) return { text, truncated: false };
  let cut = max;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--; // do not split a surrogate pair
  return { text: text.slice(0, cut).trimEnd(), truncated: true };
}

/**
 * A single-line text as shown to humans and agents (labels, names, keys):
 * every whitespace run (including line breaks) becomes one space, control
 * and bidi characters are removed, and the result is trimmed and cut to
 * `max` UTF-16 code units without splitting a surrogate pair.
 */
export function sanitizeLine(raw: string, max: number): Sanitized {
  const text = raw
    .replace(/\s+/gu, ' ')
    .replace(CONTROL, '')
    .replace(BIDI, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  return truncate(text, max);
}

/**
 * Multi-line text (documentation): like {@link sanitizeLine}, but line
 * breaks survive (normalized to `\n`, at most one empty line in a row).
 */
export function sanitizeBlock(raw: string, max: number): Sanitized {
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(CONTROL_EXCEPT_NEWLINE, '')
    .replace(BIDI, '')
    .replace(/ {2,}/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncate(text, max);
}
