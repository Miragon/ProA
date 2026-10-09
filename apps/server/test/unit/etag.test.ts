/** Entity tags and the preconditions of value chain saves (M4 S2). */
import { describe, expect, it } from 'vitest';

import {
  contentPrecondition,
  matchesEtag,
  revisionEtag,
  revisionOfEtag,
  versionEtag,
} from '../../src/http/etag.ts';

describe('revision tags', () => {
  it('formats and parses "r<rev>", also weak ones', () => {
    expect(revisionEtag(7)).toBe('"r7"');
    expect(revisionOfEtag('"r7"')).toBe(7);
    expect(revisionOfEtag(' W/"r12" ')).toBe(12);
    for (const bad of ['"7"', 'r7', '"r0"', '"r-1"', '"r1x"', '*', '"r01"']) {
      expect(revisionOfEtag(bad), bad).toBeUndefined();
    }
    expect(versionEtag(3)).toBe('"3"');
  });
});

describe('contentPrecondition', () => {
  it('takes If-Match: "r<n>" as the edited revision', () => {
    expect(contentPrecondition('"r4"', undefined)).toEqual({ kind: 'if-match', rev: 4 });
    expect(contentPrecondition('W/"r4"', undefined)).toEqual({ kind: 'if-match', rev: 4 });
  });

  it('treats a missing If-Match, *, a list or anything unparsable as none (428 later)', () => {
    for (const header of [undefined, '*', '"4"', '"r1", "r2"', 'garbage', '']) {
      expect(contentPrecondition(header, undefined), String(header)).toEqual({ kind: 'none' });
    }
  });

  it('takes If-None-Match: * as create, refuses other tags and both headers at once', () => {
    expect(contentPrecondition(undefined, '*')).toEqual({ kind: 'if-none-match' });
    expect(contentPrecondition(undefined, ' * ')).toEqual({ kind: 'if-none-match' });
    expect(() => contentPrecondition(undefined, '"r1"')).toThrow(
      expect.objectContaining({ code: 'validation-failed' }) as Error,
    );
    expect(() => contentPrecondition('"r1"', '*')).toThrow(
      expect.objectContaining({ code: 'validation-failed' }) as Error,
    );
  });
});

describe('matchesEtag', () => {
  it('compares weakly and lets * match', () => {
    expect(matchesEtag('"r3"', '"r3"')).toBe(true);
    expect(matchesEtag('W/"r3", "r4"', '"r3"')).toBe(true);
    expect(matchesEtag('*', '"r3"')).toBe(true);
    expect(matchesEtag('"r2"', '"r3"')).toBe(false);
    expect(matchesEtag(undefined, '"r3"')).toBe(false);
  });
});
