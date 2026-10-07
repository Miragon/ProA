import { z } from 'zod';

/** `GET /health`: liveness plus a database ping. */
export const Health = z
  .object({
    status: z.enum(['ok', 'degraded']),
    /** ProA version, e.g. `2.0.0-alpha.0`. */
    version: z.string(),
    db: z.enum(['ok', 'down']),
  })
  .meta({ id: 'Health', description: 'Server health.' });
export type Health = z.infer<typeof Health>;
