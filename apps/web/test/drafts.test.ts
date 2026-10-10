import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearDraft,
  draftKey,
  draftOffer,
  listDrafts,
  readDraft,
  writeDraft,
} from '../src/lib/drafts';

const ref = { project: 'demo', chainId: 'vch_01DEMO', baseRev: 3 };

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('value chain drafts', () => {
  it('keys a draft by project, chain and base revision', () => {
    expect(draftKey(ref)).toBe('proa:vc-draft:demo:vch_01DEMO:r3');
    expect(draftKey({ project: 'demo', chainId: 'new', baseRev: 0 })).toBe(
      'proa:vc-draft:demo:new:r0',
    );
  });

  it('writes, reads, lists (newest base first) and clears', () => {
    const at = new Date('2026-10-09T10:00:00.000Z');
    expect(writeDraft(ref, '{"a":1}', at)).toBe(true);
    expect(writeDraft({ ...ref, baseRev: 1 }, '{"old":1}', at)).toBe(true);
    writeDraft({ ...ref, chainId: 'vch_OTHER' }, '{}', at);
    localStorage.setItem('proa:vc-draft:demo:vch_01DEMO:r9', 'kein json');
    expect(readDraft(ref)).toEqual({ text: '{"a":1}', savedAt: '2026-10-09T10:00:00.000Z' });
    expect(listDrafts('demo', 'vch_01DEMO').map((d) => d.baseRev)).toEqual([3, 1]);
    clearDraft(ref);
    expect(readDraft(ref)).toBeNull();
  });

  it('offers a restore on the current head, a download for an older base, else nothing', () => {
    const drafts = [
      { baseRev: 3, text: 'a', savedAt: 'x' },
      { baseRev: 1, text: 'b', savedAt: 'y' },
    ];
    expect(draftOffer(drafts, 3)).toEqual({ kind: 'restore', draft: drafts[0] });
    expect(draftOffer(drafts.slice(1), 3)).toEqual({ kind: 'download', draft: drafts[1] });
    expect(draftOffer(drafts, 4)).toEqual({ kind: 'download', draft: drafts[0] });
    expect(draftOffer([], 3)).toEqual({ kind: 'none' });
  });

  it('swallows a full quota and a blocked storage (private mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(writeDraft(ref, '{}')).toBe(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(readDraft(ref)).toBeNull();
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => clearDraft(ref)).not.toThrow();
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(listDrafts('demo', 'vch_01DEMO')).toEqual([]);
    expect(writeDraft(ref, '{}')).toBe(false);
  });
});
