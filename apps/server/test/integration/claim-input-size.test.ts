/**
 * The claim input stays small (CONCEPT §3: "≤ ~100 KB"; M2 item 2): both
 * scored corpus landscapes are imported with the real libraries, every task
 * is claimed (all at once, so later claims list what earlier ones were
 * assigned in `skip` instead of `candidates`), and every input is checked against the contract and measured
 * as the agent receives it (UTF-8 JSON). A third run seeds LLM-sized
 * judgements (judge each pair once): the partners of the largest model
 * judge every key and lexical pair and some compatible ones with long
 * texts, and the largest model's claim lists them in `judged`. Prints only
 * sizes and counts, never the content of a model's input.
 */
import { randomUUID } from 'node:crypto';

import { ClaimInput, ClaimedAnalysis, type SubmitAnalysisInput } from '@proa/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { libraryAnalysis } from '../../src/analysis.ts';
import { claimInputBytes } from '../../src/domain/claim-input.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import { corpusFiles, importAll } from '../support/corpus.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { RELATIONS_PROCEDURE, asAgent, claim, submit } from '../support/pipeline.ts';

const LANDSCAPES = ['nordwind-handel', 'stadtwerke-auental'] as const;
const LIMIT_BYTES = 100 * 1024;
/** The model with the largest claim input of the eval corpus (DEVELOPMENT.md). */
const LARGEST = 'vertrieb/order-handling';
/** Texts as long as an LLM writes them (rationale about 400 characters, reasons beyond the cut). */
const RATIONALE =
  `${'Die Nachricht wird im Sender ausgelöst und im Empfänger erwartet; '.repeat(6)}`.slice(0, 400);
const REASON = `no-evidence: ${'Die Bezeichnungen ähneln sich, beschreiben aber verschiedene Vorgänge. '.repeat(3)}`;

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

describe('claim input after LLM-sized judgements', () => {
  it(`lists them in judged and stays below ${LIMIT_BYTES / 1024} KB for ${LARGEST}`, async () => {
    const project = 'judged';
    await t.createProject(project);
    const owner = (path: string, init?: RequestInit) => t.asOwner(path, init);
    const files = await corpusFiles('nordwind-handel');
    await importAll(owner, project, files);
    const token = await t.createToken(project, ['proa:read', 'proa:propose']);
    const agent = asAgent(t, token.secret);
    // Every partner first, one task at a time: each judges its whole assignment.
    for (const key of files.map((f) => f.key).filter((k) => k !== LARGEST)) {
      const [c] = await claim(agent, { projectId: project, modelKey: key });
      if (!c) throw new Error(`no task for ${key}`);
      // Judged and skipped pairs are not among the candidates: all of them are open.
      const open = c.input.candidates;
      let compatible = 0;
      const body: SubmitAnalysisInput = {
        leaseToken: c.leaseToken,
        submissionId: randomUUID(),
        procedure: RELATIONS_PROCEDURE,
        llmModel: 'claude-sonnet-5-5',
        relations: open
          .filter(([, , , basis]) => basis === 'key')
          .slice(0, 200)
          .map(([type, from, to]) => ({
            type,
            from,
            to,
            confidence: 0.95,
            rationale: RATIONALE,
            evidence: [from, to],
            question: null,
          })),
        noLinks: open
          .filter(
            ([, , , basis]) => basis === 'lexical' || (basis === 'compatible' && compatible++ < 10),
          )
          .slice(0, 500)
          .map(([type, from, to]) => ({ type, from, to, reason: REASON })),
        summary: 'Alle Kandidaten beurteilt.',
      };
      await submit(agent, c.taskId, body);
    }
    const [largest] = await claim(agent, { projectId: project, modelKey: LARGEST });
    if (!largest) throw new Error(`no task for ${LARGEST}`);
    const bytes = claimInputBytes(largest.input);
    const judged = largest.input.judged ?? [];
    console.log(
      `${LARGEST} after LLM-sized judgements: ${(bytes / 1024).toFixed(1)} KB, ` +
        `${judged.filter((j) => 'relation' in j).length} link verdicts and ` +
        `${judged.filter((j) => !('relation' in j)).length} no-links in judged`,
    );
    expect(ClaimInput.parse(largest.input)).toEqual(largest.input);
    expect(judged.length).toBeGreaterThan(20);
    expect(bytes).toBeLessThan(LIMIT_BYTES);
  }, 120_000);
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
