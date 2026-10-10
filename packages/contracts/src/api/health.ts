import { z } from 'zod';

/** `GET /health`: liveness plus a database ping. */
export const Health = z
  .object({
    status: z.enum(['ok', 'degraded']),
    /** ProA version, e.g. `2.0.0-alpha.0`. */
    version: z.string(),
    db: z.enum(['ok', 'down']),
    /**
     * Present only on a read-only demo (`PROA_DEMO=readonly`, issue #3): every
     * write answers 403 `demo-readonly`, MCP is off, the session is a viewer's.
     * Absent in local mode, whose answer stays as before.
     */
    demo: z
      .literal('readonly')
      .optional()
      .meta({ description: 'Present only on a read-only demo: nothing can be changed.' }),
  })
  .meta({ id: 'Health', description: 'Server health.' });
export type Health = z.infer<typeof Health>;
