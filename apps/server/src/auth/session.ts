/**
 * Local-mode owner session (CONCEPT §6): an HttpOnly, SameSite=Strict cookie
 * the server issues on `POST /api/v1/session`. It carries no identity of its
 * own: local mode has exactly one human, the owner. The cookie only proves
 * that this server issued it to a client on localhost, for one interactive
 * client (`proa-web` or `proa-cli`), within its lifetime.
 *
 * Format: `v1.<client>.<issuedAt seconds>.<nonce>.<HMAC-SHA256>` (base64url),
 * signed with `PROA_SESSION_SECRET` or, without it, a random key per server
 * process (a restart then ends every session).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { InteractiveClient, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from '@proa/contracts';

export interface SessionClaims {
  client: InteractiveClient;
  /** Seconds since the epoch. */
  issuedAt: number;
}

export interface SessionCodec {
  readonly maxAgeSeconds: number;
  issue(client: InteractiveClient, now?: Date): string;
  /** The claims of a valid, unexpired cookie value; `null` otherwise. */
  verify(value: string, now?: Date): SessionClaims | null;
}

/** Tolerated clock skew for cookies issued "in the future". */
const SKEW_SECONDS = 60;

export function createSessionCodec(
  secret: string | Uint8Array = randomBytes(32),
  maxAgeSeconds: number = SESSION_MAX_AGE_SECONDS,
): SessionCodec {
  const key = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  const sign = (payload: string) => createHmac('sha256', key).update(payload).digest();

  return {
    maxAgeSeconds,
    issue(client, now = new Date()) {
      const payload = `v1.${client}.${Math.floor(now.getTime() / 1000)}.${randomBytes(16).toString('base64url')}`;
      return `${payload}.${sign(payload).toString('base64url')}`;
    },
    verify(value, now = new Date()) {
      const parts = value.split('.');
      if (parts.length !== 5 || parts[0] !== 'v1') return null;
      const [, client, iat, , mac] = parts;
      const parsedClient = InteractiveClient.safeParse(client);
      const issuedAt = Number(iat);
      if (!parsedClient.success || !Number.isSafeInteger(issuedAt) || !mac) return null;
      const expected = sign(parts.slice(0, 4).join('.'));
      const given = Buffer.from(mac, 'base64url');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      const nowSeconds = Math.floor(now.getTime() / 1000);
      if (issuedAt > nowSeconds + SKEW_SECONDS || nowSeconds - issuedAt >= maxAgeSeconds) {
        return null;
      }
      return { client: parsedClient.data, issuedAt };
    },
  };
}

/** `Set-Cookie` attributes of the session cookie (no `Secure`: local mode is plain http on localhost). */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'Strict' as const,
    maxAge: maxAgeSeconds,
  };
}

export { SESSION_COOKIE };
