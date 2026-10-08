/**
 * Lease tokens (CONCEPT §3, §6 "Lease replay"): 256 random bits, shown once
 * at the claim, stored only as a hash that binds the token to the task and
 * to the principal that claimed it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { LEASE_TOKEN_PREFIX } from '@proa/contracts';

/** `proa_lt_` + 43 base64url characters (256 bits). */
export function newLeaseToken(): string {
  return `${LEASE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** sha256 (hex) of `taskId|principalId|token`: useless for another task or caller. */
export function leaseTokenHash(taskId: string, principalId: string, token: string): string {
  return createHash('sha256').update(`${taskId}|${principalId}|${token}`, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex hashes; `false` if either is missing. */
export function sameLeaseHash(a: string | null, b: string | null): boolean {
  if (a === null || b === null || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
