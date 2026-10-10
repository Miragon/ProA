import type { APIRequestContext } from '@playwright/test';

/** What answers at PROA_E2E_URL: nothing, a local-mode ProA, or the read-only demo (issue #3). */
export type ServerMode = 'down' | 'local' | 'demo';

/** Why a writing flow skips itself on the read-only demo (`demo.spec.ts` covers that server). */
export const DEMO_SKIP =
  'the server is the read-only demo (PROA_DEMO=readonly); this flow writes, demo.spec.ts covers the demo';

/** Reads `/health`: down when nothing answers, demo when it says `demo: "readonly"`. */
export async function probeServer(request: APIRequestContext): Promise<ServerMode> {
  try {
    const response = await request.get('/health', { timeout: 3000 });
    if (!response.ok()) return 'down';
    const body = (await response.json()) as { demo?: unknown };
    return body.demo === 'readonly' ? 'demo' : 'local';
  } catch {
    return 'down';
  }
}
