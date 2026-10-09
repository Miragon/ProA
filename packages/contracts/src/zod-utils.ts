import { z } from 'zod';

/**
 * `schema | null`. Use this instead of `.nullable()` on schemas that carry a
 * `.meta({ id })`: zod-to-openapi drops the `null` of `.nullable()` on named
 * schemas, while a union becomes `anyOf: [{ $ref }, { type: 'null' }]`.
 */
export function orNull<T extends z.ZodType>(schema: T) {
  return z.union([schema, z.null()]);
}

/**
 * A name people type (project, agent token): 1 to `max` characters, no
 * control characters (PostgreSQL text cannot hold U+0000; the rest has no
 * place in a name). The check is a refinement, so the OpenAPI document keeps
 * a plain string.
 */
export function plainName(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/\p{Cc}/u.test(value), 'must not contain control characters');
}

/**
 * Control characters (`\p{Cc}`) other than tab, line feed and carriage
 * return. PostgreSQL text and jsonb cannot hold U+0000, and the rest has no
 * place in text people or agents write.
 */
export const CONTROL_CHARACTERS = /(?![\t\n\r])\p{Cc}/u;

/** Whether `value` contains a control character other than tab and line breaks. */
export function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

/**
 * Free text people or agents write (reasons, notes, rationales, questions):
 * `schema` plus "no control characters except tab and line breaks". A
 * refinement, so the OpenAPI document keeps a plain string.
 */
export function plainText<T extends z.ZodString>(schema: T): T {
  return schema.refine(
    (value) => !hasControlCharacters(value),
    'must not contain control characters (tab and line breaks are fine)',
  );
}

/**
 * Bidirectional formatting characters (Trojan Source, CVE-2021-42574): the
 * marks ALM, LRM and RLM, the embeddings and overrides U+202A–U+202E and the
 * isolates U+2066–U+2069. `@proa/bpmn-facts` strips the same set from labels.
 */
export const BIDI_CHARACTERS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** Whether `value` contains a bidirectional formatting character. */
export function hasBidiCharacters(value: string): boolean {
  return BIDI_CHARACTERS.test(value);
}
