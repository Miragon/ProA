import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';

import { Toaster } from '../../src/components/toaster';

export function renderWithQuery(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        {ui}
        <Toaster />
      </QueryClientProvider>,
    ),
  };
}

/**
 * Renders `ui` as the only page of a throwaway router, for components with
 * `Link`s (hrefs are built from the route path and params).
 */
export async function renderWithRouter(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <>
        {ui}
        <Toaster />
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  return {
    queryClient,
    router,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

export interface Call {
  method: string;
  path: string;
  body: unknown;
  /** The query string (`?dryRun=true`), `''` without one. */
  search: string;
  /** Request headers, lowercased names. */
  headers: Record<string, string>;
}

type Handler = (call: Call) => Response | Promise<Response>;

/** Replaces `fetch` with a tiny router; returns the recorded calls. */
export function stubApi(routes: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      let body: unknown;
      if (request.headers.get('content-type')?.startsWith('multipart/form-data')) {
        const form = await request.formData();
        body = form.getAll('files').map((part) => (part as File).name);
      } else if (request.method !== 'GET') {
        const text = await request.text();
        body = text === '' ? undefined : (JSON.parse(text) as unknown);
      }
      const call: Call = {
        method: request.method,
        path: url.pathname,
        body,
        search: url.search,
        headers: Object.fromEntries(request.headers.entries()),
      };
      const handler = routes[`${request.method} ${url.pathname}`];
      // The owner session is opened before the first API request; answer it unless a test cares.
      if (!handler && call.method === 'POST' && call.path === '/api/v1/session') {
        return json({ principalId: 'prn_1', kind: 'user', handle: 'owner', authMode: 'local' });
      }
      calls.push(call);
      if (!handler) return json({ title: 'Not Found', status: 404, code: 'not-found' }, 404);
      return handler(call);
    }),
  );
  return calls;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

/**
 * The toast with `text`. Radix also announces toasts in a live region, so
 * the plain text can appear twice; the toast itself is unique.
 */
export function findToast(text: string): Promise<HTMLElement> {
  return waitFor(() => {
    const toast = screen.queryAllByTestId('toast').find((t) => t.textContent.includes(text));
    if (!toast) throw new Error(`no toast with "${text}"`);
    return toast;
  });
}
