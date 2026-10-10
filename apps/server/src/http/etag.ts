/**
 * Entity tags and conditional requests: relation and placement versions
 * (`"<version>"`, `If-Match` on decisions), value chain revisions (`"r<rev>"`,
 * `If-Match` on content saves, `If-None-Match` on reads), auto-accept rule
 * revisions (`"r<revision>"`, `If-Match` on edits) and the landscape
 * (`"s<seq>"`).
 */
import { DomainError } from '../domain/errors.ts';
import type { ContentPrecondition } from '../domain/use-cases/index.ts';

/** ETag of a relation or placement version: `"<version>"`. */
export function versionEtag(version: number): string {
  return `"${version}"`;
}

/**
 * The version an `If-Match` header names (`"3"`, `W/"3"`, `"v3"`); a header
 * naming no version (`*` aside) can never match: 412.
 */
export function ifMatchVersion(header: string | undefined): number | undefined {
  if (header === undefined || header.trim() === '*') return undefined;
  const m = /^\s*(?:W\/)?"v?(\d{1,9})"\s*$/.exec(header);
  if (!m?.[1]) throw new DomainError('precondition-failed', 'If-Match names no version');
  return Number(m[1]);
}

/** ETag of a value chain revision: `"r<rev>"`. */
export function revisionEtag(rev: number): string {
  return `"r${rev}"`;
}

/** The revision an entity tag names (`"r3"`, also weak), else `undefined`. */
export function revisionOfEtag(tag: string): number | undefined {
  const m = /^\s*(?:W\/)?"r([1-9]\d{0,8})"\s*$/.exec(tag);
  return m?.[1] ? Number(m[1]) : undefined;
}

/**
 * The precondition of a value chain content save (M4 §3.5): `If-Match:
 * "r<rev>"` names the revision the editor started from; `If-None-Match: *`
 * creates the chain. A missing `If-Match`, `*` or a tag naming no revision
 * is `none` (428 once the caller is authorized).
 *
 * @throws {DomainError} `validation-failed` for both headers at once, or an
 *   `If-None-Match` other than `*`
 */
export function contentPrecondition(
  ifMatch: string | undefined,
  ifNoneMatch: string | undefined,
): ContentPrecondition {
  if (ifMatch !== undefined && ifNoneMatch !== undefined) {
    throw new DomainError('validation-failed', 'send either If-Match or If-None-Match: *', {
      errors: [{ path: 'header.if-none-match', message: 'not together with If-Match' }],
    });
  }
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch.trim() !== '*') {
      throw new DomainError('validation-failed', 'If-None-Match on a save must be *', {
        errors: [{ path: 'header.if-none-match', message: 'must be *' }],
      });
    }
    return { kind: 'if-none-match' };
  }
  const rev = ifMatchRevision(ifMatch);
  return rev === undefined ? { kind: 'none' } : { kind: 'if-match', rev };
}

/**
 * The revision an `If-Match` header names with exactly one `"r<rev>"` tag
 * (value chain saves, auto-accept rule edits); `undefined` for a missing
 * header, `*`, several tags or a tag naming no revision.
 */
export function ifMatchRevision(ifMatch: string | undefined): number | undefined {
  if (ifMatch === undefined) return undefined;
  const tags = ifMatch.split(',').map((t) => t.trim());
  return tags.length === 1 && tags[0] !== undefined ? revisionOfEtag(tags[0]) : undefined;
}

/** Whether an `If-None-Match` header matches `etag` (weak comparison, `*` matches anything). */
export function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === etag || t === '*');
}
