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
}

/**
 * The server's mode from `/health` (polled anyway for the status in the page
 * frame). A failed health check counts as known and not a demo: the UI then
 * behaves as before and the request itself reports the problem.
 */
export function useServerMode(): ServerMode {
  const health = useQuery(healthQuery);
  return {
    known: !health.isPending,
    demo: health.data?.demo === 'readonly',
  };
}
