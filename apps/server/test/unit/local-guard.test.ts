import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { isLocalHostname } from '../../src/auth/local-guard.ts';
import { fakeDatabase } from '../support/fakes.ts';

const app = createApp({
  config: { authMode: 'local', webDist: null },
  database: fakeDatabase(),
  version: '0',
});

function get(headers: Record<string, string>) {
  return app.request('http://127.0.0.1:7400/health', { headers });
}

describe('local mode Host/Origin guard (CONCEPT §6)', () => {
  it.each(['localhost', '127.0.0.1', '[::1]', 'LOCALHOST'])('accepts %s', (h) => {
    expect(isLocalHostname(h)).toBe(true);
  });

  it.each<Record<string, string>>([
    { host: 'localhost:7400' },
    { host: '127.0.0.1:7401', origin: 'http://localhost:7401' },
    { host: '[::1]:7400', origin: 'https://127.0.0.1' },
  ])('lets local requests through: %o', async (headers) => {
    expect((await get(headers)).status).toBe(200);
  });

  it.each<Record<string, string>>([
    { host: 'evil.example:7400' },
    { host: 'localhost.evil.example' },
    { host: 'localhost:7400', origin: 'https://evil.example' },
    { host: 'localhost:7400', origin: 'null' },
    { host: 'localhost:7400', origin: 'file:///etc/passwd' },
  ])('rejects %o with 403', async (headers) => {
    const res = await get(headers);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'forbidden' });
  });

  it('accepts only the configured origin ports', async () => {
    const strict = createApp({
      config: { authMode: 'local', webDist: null, originPorts: [7400, 7401] },
      database: fakeDatabase(),
      version: '0',
    });
    const get = (origin: string) =>
      strict.request('http://127.0.0.1:7400/health', {
        headers: { host: 'localhost:7400', origin },
      });
    expect((await get('http://localhost:7401')).status).toBe(200);
    expect((await get('http://127.0.0.1:7400')).status).toBe(200);
    expect((await get('http://localhost:3000')).status).toBe(403);
    expect((await get('http://localhost')).status).toBe(403);
  });

  it('guards /mcp too', async () => {
    const res = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: { host: 'attacker.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });
});
