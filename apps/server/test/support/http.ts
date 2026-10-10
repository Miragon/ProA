import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';

/** Serves `fetch` on 127.0.0.1 with an ephemeral port; returns the base URL and a closer. */
export async function listen(
  fetch: (request: Request) => Response | Promise<Response>,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve({ fetch, hostname: '127.0.0.1', port: 0 }, (info: AddressInfo) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}
