// M4 §6 (S4): the golden chains in eval/value-chains pass the ProA rules, exactly as a save
// checks them (`prepareRevision`), and their committed bytes are already the canonical form, so
// the sha256 of the file is the `content_hash` a project seeded with it stores (eval:placements
// records it as `golden.contentHash`; recordings of M4b name the revision they worked on). This
// check lives here and not in eval:placements, because eval/tools must not import from an app.
// One chain belongs to the holdout landscape: a failure names the violation reasons with counts,
// or the error code and class, never element ids or messages (as value-chain-schema-model.test.ts).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { canonicalHash, prepareRevision } from '../../src/domain/value-chain/document.ts';
import { DomainError } from '../../src/domain/errors.ts';

const valueChains = new URL('../../../../eval/value-chains/', import.meta.url);
const chainFile = (landscape: string) => new URL(`${landscape}/value-chain.vc.json`, valueChains);
const landscapes = readdirSync(valueChains)
  .filter((entry) => existsSync(chainFile(entry)))
  .sort();

/** Violation reasons with counts, e.g. `step-name-empty ×2`; never ids, paths or details. */
function reasons(err: unknown): string {
  if (!(err instanceof DomainError)) {
    return `${err instanceof Error ? err.constructor.name : typeof err} (message withheld)`;
  }
  const violations = Array.isArray(err.extras['violations'])
    ? (err.extras['violations'] as { reason: string }[])
    : [];
  const counts = new Map<string, number>();
  for (const v of violations) counts.set(v.reason, (counts.get(v.reason) ?? 0) + 1);
  const list = [...counts].map(([reason, n]) => `${reason} ×${n}`).join(', ');
  return `${err.code}${list === '' ? '' : `: ${list}`}`;
}

describe('the golden value chains under the ProA rules', () => {
  it('finds the golden chain of every scored landscape', () => {
    expect(landscapes).toEqual(['nordwind-handel', 'stadtwerke-auental']);
  });

  it.each(landscapes)('%s: prepareRevision accepts it and keeps the bytes', (landscape) => {
    const bytes = readFileSync(chainFile(landscape));
    let outcome: string;
    let prepared: ReturnType<typeof prepareRevision>['prepared'] | null = null;
    try {
      prepared = prepareRevision(JSON.parse(bytes.toString('utf8'))).prepared;
      outcome = 'accepted';
    } catch (err) {
      outcome = reasons(err);
    }
    expect(outcome, `${landscape}: run node eval/value-chains/validate-value-chains.mjs`).toBe(
      'accepted',
    );
    // Compared as booleans and hashes: a byte diff of the holdout chain is not printed.
    const canonical = Buffer.from(prepared?.content ?? new Uint8Array()).equals(bytes);
    expect(canonical, `${landscape}: the committed file is not canonical`).toBe(true);
    const fileHash = createHash('sha256').update(bytes).digest('hex');
    expect(prepared?.contentHash).toBe(fileHash);
    expect(canonicalHash(prepared?.content ?? new Uint8Array())).toBe(fileHash);
  });
});
