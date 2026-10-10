import { DomainError } from './errors.ts';

/**
 * Opaque keyset cursors: base64url of a JSON array holding the sort key of
 * the last item of a page. Clients never parse them.
 */
export function encodeCursor(key: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** Largest value of a PostgreSQL `integer` column. */
const MAX_INT4 = 2_147_483_647;

/**
 * @param shape the expected element types, e.g. `['string', 'number']`;
 *   `'int'` is a number compared with an `integer` column (`rev`,
 *   `generation`): a whole number from 0 to 2^31 − 1, so a crafted cursor is a
 *   validation error rather than a database error
 * @throws {DomainError} `validation-failed` for a cursor that is not ours (we never
 *   issue one holding U+0000, which PostgreSQL text cannot hold)
 */
export function decodeCursor<const T extends readonly ('string' | 'number' | 'int')[]>(
  cursor: string,
  shape: T,
): { [K in keyof T]: T[K] extends 'string' ? string : number } {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    value = undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length !== shape.length ||
    value.some((v, i) => !fits(v, shape[i]))
  ) {
    throw new DomainError('validation-failed', 'invalid cursor', {
      errors: [{ path: 'query.cursor', message: 'invalid cursor' }],
    });
  }
  return value as { [K in keyof T]: T[K] extends 'string' ? string : number };
}

function fits(v: unknown, kind: 'string' | 'number' | 'int' | undefined): boolean {
  if (kind === 'int') return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_INT4;
  if (kind === 'string') return typeof v === 'string' && !v.includes('\u0000');
  return typeof v === kind;
}

/**
 * Builds a page from `limit + 1` fetched items: the extra item only signals
 * that there is a next page.
 */
export function toPage<T>(
  fetched: readonly T[],
  limit: number,
  keyOf: (item: T) => readonly (string | number)[],
): { items: T[]; nextCursor: string | null } {
  const items = fetched.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: fetched.length > limit && last !== undefined ? encodeCursor(keyOf(last)) : null,
  };
}
