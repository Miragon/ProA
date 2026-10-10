import { useQuery } from '@tanstack/react-query';

import { healthQuery } from './queries';

/** Where the read-only demo's source and local setup live (banner and notices link here). */
export const PROA_REPOSITORY_URL = 'https://github.com/Miragon/ProA';

export interface ServerMode {
  /** `/health` has answered (or failed): until then, global write actions stay hidden. */
  known: boolean;
  /**
   * The server is the public read-only demo (`Health.demo`, issue #3):
   * nothing can be changed there, so the UI offers no write action at all.
   */
  demo: boolean;
  /**
   * The demo operator's legal notice (Impressum) and privacy policy
   * (`Health.imprintUrl`, `Health.privacyUrl`), linked from the banner; `null`
   * outside the demo, when unset, or when not an absolute https URL.
   */
  imprintUrl: string | null;
  privacyUrl: string | null;
}

/** `value` if it is an absolute https URL (what the server accepts), else `null`. */
function httpsUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The server's mode from `/health` (polled anyway for the status in the page
 * frame). A failed health check counts as known and not a demo: the UI then
 * behaves as before and the request itself reports the problem.
 */
export function useServerMode(): ServerMode {
  const health = useQuery(healthQuery);
  const demo = health.data?.demo === 'readonly';
  return {
    known: !health.isPending,
    demo,
    imprintUrl: demo ? httpsUrl(health.data?.imprintUrl) : null,
    privacyUrl: demo ? httpsUrl(health.data?.privacyUrl) : null,
  };
}
