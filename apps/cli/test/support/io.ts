import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import type { CliIo } from '../../src/io.ts';

export interface TestIo {
  io: CliIo;
  out: () => string;
  err: () => string;
}

/** A CLI boundary that records output; no network unless `fetch` is given. */
export function testIo(
  env: Record<string, string> = {},
  fetch?: typeof globalThis.fetch,
  extra: Partial<CliIo> = {},
): TestIo {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env,
    fetch: fetch ?? (() => Promise.reject(new Error('no network in tests'))),
    cwd: process.cwd(),
    home: '/nonexistent-home',
    stdin: new PassThrough(),
    stdoutStream: new PassThrough(),
    ...extra,
  };
  return { io, out: () => out.join(''), err: () => err.join('') };
}

/** A fresh temporary directory. */
export function tempDir(prefix = 'proa-cli-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export const OWNER_KEY = `proa_ok_${'k'.repeat(43)}`;
export const AGENT_TOKEN = `proa_at_${'t'.repeat(49)}`;

/** Writes an owner key file (mode 0600) and returns its path. */
export async function ownerKeyFile(dir: string, key = OWNER_KEY, mode = 0o600): Promise<string> {
  await mkdir(path.join(dir, 'proa'), { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'proa', 'owner-key');
  await writeFile(file, `${key}\n`, { mode });
  return file;
}

export interface Seen {
  method: string;
  path: string;
  authorization: string | null;
  contentType: string | null;
  body: Request;
}

type Handler = (req: Request, url: URL) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  const problem = status >= 400 && typeof body === 'object' && body !== null && 'code' in body;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': problem ? 'application/problem+json' : 'application/json' },
  });
}

export function problem(status: number, code: string, detail: string): Response {
  return json({ type: `urn:proa:problem:${code}`, title: code, status, code, detail }, status);
}

/**
 * A fake ProA REST API: `routes` maps `"METHOD /path"` (path without query)
 * to a handler; unknown routes answer 404. Every request is recorded.
 */
export function fakeApi(routes: Record<string, Handler>): {
  fetch: typeof globalThis.fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    seen.push({
      method: req.method,
      path: url.pathname,
      authorization: req.headers.get('authorization'),
      contentType: req.headers.get('content-type'),
      body: req.clone(),
    });
    const handler = routes[`${req.method} ${decodeURIComponent(url.pathname)}`];
    return handler ? handler(req, url) : problem(404, 'not-found', `${req.method} ${url.pathname}`);
  };
  return { fetch: fetch, seen };
}
