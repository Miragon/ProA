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
