/**
 * Verbatim storage of agent payloads (CONCEPT §3: "Payloads are stored
 * verbatim for the eval"), within what PostgreSQL jsonb can hold.
 */

const NUL = '\u0000';
const REPLACEMENT = '�';

/**
 * `value` with every U+0000 in strings and keys replaced by U+FFFD:
 * PostgreSQL jsonb cannot hold U+0000, and a submission must not fail as a
 * whole for one stray character in a field that is only stored.
 */
export function storablePayload<T>(value: T): T {
  if (typeof value === 'string') return value.replaceAll(NUL, REPLACEMENT) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => storablePayload(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[storablePayload(k)] = storablePayload(v);
    return out as T;
  }
  return value;
}

/** Size of `value` as JSON in UTF-8 bytes. */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
