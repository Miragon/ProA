/**
 * Unsaved value chain edits in `localStorage` (M4 §4 "Save"): one draft per
 * project, chain and base revision, so a reload or a crashed tab loses
 * nothing. A draft on the current head can be restored; one on an older
 * revision can only be downloaded or discarded (ProA never merges). Storage
 * can be missing or full (private mode, quota): every access is wrapped and
 * a failure only means there is no draft.
 */

const PREFIX = 'proa:vc-draft:';

export interface Draft {
  /** Canonical `.vc.json` text of the edited document. */
  text: string;
  /** ISO time of the last write. */
  savedAt: string;
}

export interface DraftRef {
  project: string;
  /** The chain's `vch_` id, or `new` before the first save. */
  chainId: string;
  /** The revision the edit started from (0 for a chain not created yet). */
  baseRev: number;
}

export function draftKey({ project, chainId, baseRev }: DraftRef): string {
  return `${PREFIX}${project}:${chainId}:r${baseRev}`;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): Draft | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as Draft).text === 'string' &&
      typeof (value as Draft).savedAt === 'string'
    ) {
      return { text: (value as Draft).text, savedAt: (value as Draft).savedAt };
    }
  } catch {
    // a broken entry is no draft
  }
  return null;
}

export function readDraft(ref: DraftRef): Draft | null {
  try {
    return parse(storage()?.getItem(draftKey(ref)) ?? null);
  } catch {
    return null;
  }
}

/** Saves the draft; `false` when the browser refused (quota, private mode). */
export function writeDraft(ref: DraftRef, text: string, now: Date = new Date()): boolean {
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(draftKey(ref), JSON.stringify({ text, savedAt: now.toISOString() }));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(ref: DraftRef): void {
  try {
    storage()?.removeItem(draftKey(ref));
  } catch {
    // nothing to clear
  }
}

export interface FoundDraft extends Draft {
  baseRev: number;
}

/** Every draft of this project's chain (any base revision), newest base first. */
export function listDrafts(project: string, chainId: string): FoundDraft[] {
  const out: FoundDraft[] = [];
  try {
    const store = storage();
    if (!store) return out;
    const prefix = `${PREFIX}${project}:${chainId}:r`;
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (!key?.startsWith(prefix)) continue;
      const baseRev = Number(key.slice(prefix.length));
      if (!Number.isInteger(baseRev) || baseRev < 0) continue;
      const draft = parse(store.getItem(key));
      if (draft) out.push({ ...draft, baseRev });
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => b.baseRev - a.baseRev);
}

/**
 * What entering edit mode offers (M4 §4): `restore` for a draft on the
 * current head (restore or discard), `download` for one on an older base
 * (download or discard; it cannot be applied without merging), else `none`.
 */
export type DraftOffer =
  | { kind: 'none' }
  | { kind: 'restore'; draft: FoundDraft }
  | { kind: 'download'; draft: FoundDraft };

export function draftOffer(drafts: readonly FoundDraft[], headRev: number): DraftOffer {
  const current = drafts.find((d) => d.baseRev === headRev);
  if (current) return { kind: 'restore', draft: current };
  const older = drafts.find((d) => d.baseRev < headRev);
  if (older) return { kind: 'download', draft: older };
  return { kind: 'none' };
}
