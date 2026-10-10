import { BpmnInputError } from './errors.ts';

/** Parse limits (CONCEPT §3). */
export interface ParseLimits {
  /** Maximum size of one file in bytes (default 5 MB). */
  maxBytes: number;
  /** Maximum number of XML elements (default 50,000). */
  maxElements: number;
}

export const DEFAULT_PARSE_LIMITS: Readonly<ParseLimits> = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxElements: 50_000,
});

/** Defaults merged with overrides. @throws {TypeError} for a limit that is not a positive integer */
export function resolveLimits(limits: Partial<ParseLimits> = {}): ParseLimits {
  const resolved: ParseLimits = {
    maxBytes: limits.maxBytes ?? DEFAULT_PARSE_LIMITS.maxBytes,
    maxElements: limits.maxElements ?? DEFAULT_PARSE_LIMITS.maxElements,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`parse limit ${name} must be a positive integer, got ${String(value)}`);
    }
  }
  return resolved;
}

// Markup declarations are only legal inside a DOCTYPE, so both patterns are
// rejected wherever they appear (also in comments and CDATA: no false
// negatives, and real BPMN never contains them). XML is case-sensitive; the
// checks are not, and they tolerate whitespace after `<!`.
const DOCTYPE = /<!\s*DOCTYPE/i;
const ENTITY = /<!\s*ENTITY/i;

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}

/**
 * Rejects hostile or oversized XML before it reaches the parser: decodes
 * UTF-8 (with or without BOM), enforces `maxBytes`, and rejects any DOCTYPE
 * or ENTITY declaration. Nothing is ever resolved or expanded: without a
 * DOCTYPE there are no external entities (XXE), no entity expansion
 * (billion laughs) and no external DTD.
 *
 * @returns the decoded XML text, without a byte order mark
 * @throws {BpmnInputError} `too-large`, `doctype-forbidden`, `entity-forbidden` or `not-xml`
 */
export function assertSafeXml(xml: string | Uint8Array, limits?: Partial<ParseLimits>): string {
  const { maxBytes } = resolveLimits(limits);
  let text: string;
  if (typeof xml === 'string') {
    // UTF-8 never needs fewer bytes than UTF-16 code units, so the cheap check comes first.
    const bytes = xml.length > maxBytes ? xml.length : Buffer.byteLength(xml, 'utf8');
    if (bytes > maxBytes) throw tooLarge(bytes, maxBytes);
    text = xml.startsWith('﻿') ? xml.slice(1) : xml;
  } else {
    if (xml.byteLength > maxBytes) throw tooLarge(xml.byteLength, maxBytes);
    if (startsWith(xml, [0xfe, 0xff]) || startsWith(xml, [0xff, 0xfe])) {
      throw new BpmnInputError('not-xml', 'BPMN must be UTF-8 encoded; UTF-16 is not supported');
    }
    try {
      text = UTF8.decode(xml); // strips a UTF-8 BOM
    } catch {
      throw new BpmnInputError(
        'not-xml',
        'BPMN must be UTF-8 encoded; the bytes are not valid UTF-8',
      );
    }
  }
  if (DOCTYPE.test(text)) {
    throw new BpmnInputError(
      'doctype-forbidden',
      'DOCTYPE declarations are not allowed in BPMN (external entities, entity expansion)',
    );
  }
  if (ENTITY.test(text)) {
    throw new BpmnInputError('entity-forbidden', 'ENTITY declarations are not allowed in BPMN');
  }
  return text;
}

function tooLarge(bytes: number, maxBytes: number): BpmnInputError {
  return new BpmnInputError(
    'too-large',
    `BPMN file is too large (at least ${bytes} bytes); the limit is ${maxBytes} bytes`,
  );
}
