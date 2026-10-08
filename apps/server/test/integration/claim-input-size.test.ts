/**
 * The claim input stays small (CONCEPT §3: "≤ ~100 KB"; M2 item 2): both
 * scored corpus landscapes are imported with the real libraries, every task
 * is claimed, and every input is checked against the contract and measured
 * as the agent receives it (UTF-8 JSON). Prints only sizes and counts, never
 * the content of a model's input.
 */
import { ClaimInput, ClaimedAnalysis } from '@proa/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { libraryAnalysis } from '../../src/analysis.ts';
import { claimInputBytes } from '../../src/domain/claim-input.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import { corpusFiles, importAll } from '../support/corpus.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { claim } from '../support/pipeline.ts';

const LANDSCAPES = ['nordwind-handel', 'stadtwerke-auental'] as const;
const LIMIT_BYTES = 100 * 1024;

let database: TestDatabase;
let t: TestApp;
const claimed = new Map<string, ClaimedAnalysis[]>();
const modelCounts = new Map<string, number>();

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database, { analysis: libraryAnalysis });
  const owner = (path: string, init?: RequestInit) => t.asOwner(path, init);
  for (const landscape of LANDSCAPES) {
    await t.createProject(landscape);
    const files = await corpusFiles(landscape);
    modelCounts.set(landscape, files.length);
    const outcomes = await importAll(owner, landscape, files);
    expect(outcomes.every((o) => o.outcome === 'created')).toBe(true);
    const items: ClaimedAnalysis[] = [];
    for (;;) {
      const batch = await claim(owner, { projectId: landscape, max: 5 });
      if (batch.length === 0) break;
      items.push(...batch);
    }
    claimed.set(landscape, items);
  }
}, 240_000);

afterAll(async () => {
  await database.drop();
});

describe.each(LANDSCAPES)('claim input of every model of %s', (landscape) => {
  it('is claimed once per model and matches the contract', () => {
    const items = claimed.get(landscape) ?? [];
    expect(items).toHaveLength(modelCounts.get(landscape) ?? -1);
    expect(new Set(items.map((i) => i.modelKey)).size).toBe(items.length);
    for (const item of items) {
      expect(ClaimedAnalysis.safeParse(item).success, item.modelKey).toBe(true);
      expect(ClaimInput.parse(item.input).facts.length, item.modelKey).toBeGreaterThan(0);
    }
  });

  it(`stays below ${LIMIT_BYTES / 1024} KB per model`, () => {
    const sizes = (claimed.get(landscape) ?? []).map((i) => ({
      model: i.modelKey,
      bytes: claimInputBytes(i.input),
      candidates: i.input.candidates.length,
      partners: Object.keys(i.input.partners).length,
    }));
    const largest = [...sizes].sort((a, b) => b.bytes - a.bytes)[0];
    console.log(
      `${landscape}: ${sizes.length} models, largest claim input ${largest?.model} ` +
        `${((largest?.bytes ?? 0) / 1024).toFixed(1)} KB (${largest?.candidates} candidates, ` +
        `${largest?.partners} partners), mean ${(
          sizes.reduce((n, s) => n + s.bytes, 0) /
          Math.max(1, sizes.length) /
          1024
        ).toFixed(1)} KB`,
    );
    for (const s of sizes) expect(s.bytes, s.model).toBeLessThan(LIMIT_BYTES);
  });

  it('names every candidate end in the facts or the partners', () => {
    for (const item of claimed.get(landscape) ?? []) {
      const own = new Set(item.input.facts.map((f) => f.ref));
      for (const [, from, to] of item.input.candidates) {
        for (const ref of [from, to]) {
          expect(
            own.has(ref) || item.input.partners[ref] !== undefined,
            `${item.modelKey} ${ref}`,
          ).toBe(true);
        }
      }
    }
  });

  it('gives message flows their ends, partners their processes, and only the model’s findings', () => {
    const seen = { messageFlows: 0, partnerDocs: 0, processDocs: 0, findings: 0 };
    for (const item of claimed.get(landscape) ?? []) {
      const { input } = item;
      for (const f of input.facts.filter((x) => x.kind === 'message_flow')) {
        expect(
          [f.from, f.to].every((r) => r?.startsWith(`${item.modelKey}#`)),
          f.ref,
        ).toBe(true);
        seen.messageFlows++;
      }
      expect(Object.keys(input.partnerProcesses ?? {}).sort(), item.modelKey).toEqual(
        [...new Set(Object.values(input.partners).map((p) => p.process))].sort(),
      );
      seen.partnerDocs += Object.values(input.partners).filter((p) => p.doc).length;
      seen.processDocs += Object.values(input.partnerProcesses ?? {}).filter((p) => p.doc).length;
      for (const f of input.findings ?? []) {
        expect(
          f.refs.some((r) => r.startsWith(`${item.modelKey}#`)),
          `${item.modelKey} ${f.kind}`,
        ).toBe(true);
        seen.findings++;
      }
    }
    // Both landscapes exercise every addition.
    for (const [what, n] of Object.entries(seen)) expect(n, what).toBeGreaterThan(0);
  });
});
