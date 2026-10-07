import type { MiddlewareHandler } from 'hono';

import { isReservedPath } from './web-ui.ts';

/**
 * Content Security Policy of the web UI (`apps/web/dist`): scripts, styles,
 * fonts and API calls from the ProA origin only (bpmn-js and Radix set inline
 * styles, the bpmn.io watermark is a data: image), no plugins, no framing.
 */
export const WEB_UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Content Security Policy of everything else (REST, MCP, health): a response
 * opened in a browser runs and loads nothing. Uploaded BPMN is served from
 * `/api/…/content`, so an XHTML `<script>` inside it stays inert even if a
 * browser renders the XML.
 */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
};

/**
 * Security headers on every response, errors included (CONCEPT §6): nosniff,
 * no framing, no referrer, same-origin resource and opener policies, and a
 * CSP: {@link WEB_UI_CSP} for the web UI, {@link API_CSP} for API, MCP and
 * health paths. Register first, so it also wraps the local guard's 403.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const headers: Record<string, string> = {
      ...COMMON_HEADERS,
      'content-security-policy': isReservedPath(c.req.path) ? API_CSP : WEB_UI_CSP,
    };
    try {
      for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
    } catch {
      // Immutable headers (a Response passed through from fetch): copy it.
      const res = new Response(c.res.body, c.res);
      for (const [name, value] of Object.entries(headers)) res.headers.set(name, value);
      c.res = res;
    }
  };
}
