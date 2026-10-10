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
import { readFile } from 'node:fs/promises';

import {
  ClaimInput,
  ClaimedRelationsAnalysis,
  PlacementClaimInput,
  type SubmitAnalysisInput,
} from '@proa/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { libraryAnalysis } from '../../src/analysis.ts';
import { claimInputBytes } from '../../src/domain/claim-input.ts';
import { jsonBytes } from '../../src/domain/payload.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import { corpusFiles, importAll } from '../support/corpus.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import {
  RELATIONS_PROCEDURE,
  asAgent,
  claim,
  claimPlacement,
  placementSubmission,
  submit,
  submitPlacement,
} from '../support/pipeline.ts';

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
const claimed = new Map<string, ClaimedRelationsAnalysis[]>();
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
    const items: ClaimedRelationsAnalysis[] = [];
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
      expect(ClaimedRelationsAnalysis.safeParse(item).success, item.modelKey).toBe(true);
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

/**
 * The placement claim input (M4 §3.2, `proa-claim-placement/1`) stays below
 * the same ceiling: each scored landscape with its golden chain, the first
 * claim (every due process, at most 50, within the 96,000-byte budget), then
 * again after LLM-sized proposals for every process and a structural save,
 * when each process lists its proposals. Prints sizes and counts only (for
 * the holdout no names at all).
 */
describe.each(LANDSCAPES)('placement claim input of %s', (landscape) => {
  const project = `${landscape}-chain`;
  const chainFile = new URL(
    `../../../../eval/value-chains/${landscape}/value-chain.vc.json`,
    import.meta.url,
  );

  it(`stays below ${LIMIT_BYTES / 1024} KB, also with LLM-sized proposals`, async () => {
    await t.createProject(project);
    const owner = (path: string, init?: RequestInit) => t.asOwner(path, init);
    await importAll(owner, project, await corpusFiles(landscape));
    const document = JSON.parse(await readFile(chainFile, 'utf8')) as {
      elements: { elementType: string; name: string }[];
    };
    const created = await t.asOwner(`/api/v1/projects/${project}/value-chains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'main', content: document }),
    });
    expect(created.status).toBe(201);
    const token = await t.createToken(project, ['proa:read', 'proa:propose']);
    const agent = asAgent(t, token.secret);

    const [first] = await claimPlacement(agent, { projectId: project });
    if (!first) throw new Error('no placement task');
    expect(PlacementClaimInput.parse(first.input)).toEqual(first.input);
    const firstBytes = jsonBytes(first.input);
    expect(first.input.processes.length).toBeGreaterThan(0);
    expect(firstBytes).toBeLessThan(LIMIT_BYTES);

    // LLM-sized proposals for every process, then a structural save: each is due again.
    await submitPlacement(
      agent,
      first.taskId,
      placementSubmission(
        first,
        first.input.processes.map((p) => ({
          step: p.hints[0]?.step ?? first.input.steps[0]?.id ?? '@outside',
          process: p.process,
          confidence: 0.6,
          rationale: RATIONALE,
          evidence: [p.process],
          question: 'Gehört der Prozess wirklich auf diesen Schritt oder auf den übergeordneten?',
        })),
      ),
    );
    const step = document.elements.find((e) => e.elementType === 'step');
    if (step) step.name = `${step.name} (neu)`;
    const head = (await (
      await t.asOwner(`/api/v1/projects/${project}/value-chains/main`)
    ).json()) as {
      valueChain: { headRev: number };
    };
    const saved = await t.asOwner(`/api/v1/projects/${project}/value-chains/main/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': `"r${head.valueChain.headRev}"` },
      body: JSON.stringify(document),
    });
    expect(saved.status).toBe(200);
    const [again] = await claimPlacement(agent, { projectId: project });
    if (!again) throw new Error('no placement task after the save');
    expect(PlacementClaimInput.parse(again.input)).toEqual(again.input);
    const againBytes = jsonBytes(again.input);
    const proposals = again.input.processes.reduce((n, p) => n + p.proposals.length, 0);
    expect(proposals).toBeGreaterThan(0);
    expect(againBytes).toBeLessThan(LIMIT_BYTES);
    console.log(
      `${landscape} placement claim: ${first.input.processes.length} processes, ` +
        `${first.input.steps.length} steps, ${(firstBytes / 1024).toFixed(1)} KB; ` +
        `with ${proposals} LLM-sized proposals ${(againBytes / 1024).toFixed(1)} KB` +
        `${again.input.truncated ? ` (truncated, ${again.input.remaining} more)` : ''}`,
    );
  }, 120_000);
});
