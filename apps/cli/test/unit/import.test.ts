import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MAX_IMPORT_BYTES, MAX_IMPORT_FILES, MAX_MODEL_BYTES } from '@proa/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { batches, findBpmnFiles, type BpmnFile } from '../../src/files.ts';
import { runCli } from '../../src/program.ts';
import {
  AGENT_TOKEN,
  OWNER_KEY,
  fakeApi,
  json,
  ownerKeyFile,
  problem,
  tempDir,
  testIo,
} from '../support/io.ts';

let dir: string;
let models: string;
let keyFile: string;

async function put(rel: string, text = '<bpmn/>'): Promise<void> {
  await mkdir(path.dirname(path.join(models, rel)), { recursive: true });
  await writeFile(path.join(models, rel), text);
}

beforeAll(async () => {
  dir = await tempDir();
  models = path.join(dir, 'models');
  keyFile = await ownerKeyFile(dir);
  await put('finanzen/Rechnungsstellung.bpmn');
  await put('vertrieb/auftrag.bpmn');
  await put('legacy/old.bpmn20.xml');
  await put('notes.txt', 'not bpmn');
  await put('.git/HEAD.bpmn');
  await put('node_modules/x/y.bpmn');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Multipart file names of a recorded import request. */
async function uploaded(req: Request): Promise<string[]> {
  const form = await req.formData();
  return form.getAll('files').map((f) => (f as File).name);
}

describe('findBpmnFiles / batches', () => {
  it('finds BPMN files below the root, sorted, without hidden dirs and node_modules', async () => {
    const files = await findBpmnFiles(models);
    expect(files.map((f) => f.path)).toEqual([
      'finanzen/Rechnungsstellung.bpmn',
      'legacy/old.bpmn20.xml',
      'vertrieb/auftrag.bpmn',
    ]);
    await expect(findBpmnFiles(path.join(dir, 'nope'))).rejects.toThrow(/not a directory/);
  });

  it(`splits into requests of ≤ ${MAX_IMPORT_FILES} files and ≤ 25 MB; oversized files stay local`, () => {
    const file = (i: number, size = 10): BpmnFile => ({
      path: `m${String(i).padStart(3, '0')}.bpmn`,
      bytes: new Uint8Array(size),
    });
    const many = Array.from({ length: MAX_IMPORT_FILES * 2 + 1 }, (_, i) => file(i));
    expect(batches(many).batches.map((b) => b.length)).toEqual([50, 50, 1]);

    // 4 MiB each (below the 5 MiB model limit): six fit into 25 MiB, a seventh does not.
    const big = 4 * 1024 * 1024;
    expect(big).toBeLessThan(MAX_MODEL_BYTES);
    expect(6 * big).toBeLessThanOrEqual(MAX_IMPORT_BYTES);
    const heavy = Array.from({ length: 13 }, (_, i) => file(i, big));
    expect(batches(heavy).batches.map((b) => b.length)).toEqual([6, 6, 1]);

    const { batches: groups, oversized } = batches([
      file(1),
      file(2, MAX_MODEL_BYTES + 1),
      file(3),
    ]);
    expect(groups.map((b) => b.map((f) => f.path))).toEqual([['m001.bpmn', 'm003.bpmn']]);
    expect(oversized.map((f) => f.path)).toEqual(['m002.bpmn']);
  });
});

describe('proa import', () => {
  const outcomes = [
    {
      path: 'finanzen/Rechnungsstellung.bpmn',
      modelKey: 'finanzen/rechnungsstellung',
      outcome: 'created',
      problem: null,
    },
    { path: 'legacy/old.bpmn20.xml', modelKey: 'legacy/old', outcome: 'unchanged', problem: null },
    {
      path: 'vertrieb/auftrag.bpmn',
      modelKey: 'vertrieb/auftrag',
      outcome: 'failed',
      problem: {
        type: 'urn:proa:problem:bpmn-invalid',
        title: 'Invalid BPMN',
        status: 422,
        code: 'bpmn-invalid',
        detail: 'not BPMN',
      },
    },
  ];

  it('uploads every file with its relative path and reports each outcome', async () => {
    const api = fakeApi({ 'POST /api/v1/projects/demo/imports': () => json({ files: outcomes }) });
    const t = testIo({ PROA_OWNER_KEY_FILE: keyFile }, api.fetch, { cwd: dir });
    const code = await runCli(['import', 'models', '--project', 'demo'], t.io);
    expect(code).toBe(1); // one file failed
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0]?.authorization).toBe(`Bearer ${OWNER_KEY}`);
    expect(api.seen[0]?.contentType).toMatch(/^multipart\/form-data/);
    expect(await uploaded(api.seen[0]!.body)).toEqual([
      'finanzen/Rechnungsstellung.bpmn',
      'legacy/old.bpmn20.xml',
      'vertrieb/auftrag.bpmn',
    ]);
    expect(t.out()).toContain('  created   finanzen/rechnungsstellung\n');
    expect(t.out()).toContain('  failed    vertrieb/auftrag  (422 bpmn-invalid: not BPMN)\n');
    expect(t.out()).toContain('demo: 3 files, 1 created, 0 revised, 1 unchanged, 1 failed');
    expect(t.err()).toContain('1 of 3 files failed');
  });

  it('prefers an agent token (proa:write) when one is given', async () => {
    const ok = outcomes.slice(0, 2);
    const api = fakeApi({ 'POST /api/v1/projects/demo/imports': () => json({ files: ok }) });
    const t = testIo({ PROA_TOKEN: AGENT_TOKEN }, api.fetch, { cwd: dir });
    expect(await runCli(['import', 'models', '-p', 'demo', '--json'], t.io)).toBe(0);
    expect(api.seen[0]?.authorization).toBe(`Bearer ${AGENT_TOKEN}`);
    expect(JSON.parse(t.out())).toMatchObject({
      project: 'demo',
      counts: { created: 1, unchanged: 1, revised: 0, failed: 0 },
    });
  });

  it('--create creates a missing project first (owner key)', async () => {
    const api = fakeApi({
      'GET /api/v1/projects/neu': () => problem(404, 'not-found', 'project not found'),
      'POST /api/v1/projects': () =>
        json(
          { id: 'prj_1', key: 'neu', name: 'Neu', role: 'owner', lastSeq: 1, createdAt: '' },
          201,
        ),
      'POST /api/v1/projects/neu/imports': () => json({ files: outcomes.slice(0, 2) }),
    });
    const t = testIo({ PROA_OWNER_KEY_FILE: keyFile, PROA_TOKEN: AGENT_TOKEN }, api.fetch, {
      cwd: dir,
    });
    expect(await runCli(['import', 'models', '-p', 'neu', '--create', '--name', 'Neu'], t.io)).toBe(
      0,
    );
    expect(api.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'GET /api/v1/projects/neu',
      'POST /api/v1/projects',
      'POST /api/v1/projects/neu/imports',
    ]);
    // --create needs the owner: the agent token in PROA_TOKEN is not used.
    expect(api.seen.every((s) => s.authorization === `Bearer ${OWNER_KEY}`)).toBe(true);
    expect(await api.seen[1]?.body.json()).toEqual({ key: 'neu', name: 'Neu' });
    expect(t.out()).toContain('created project neu');
  });

  it('fails clearly for a missing project, an empty directory and an unreachable server', async () => {
    const api = fakeApi({});
    const t = testIo({ PROA_OWNER_KEY_FILE: keyFile }, api.fetch, { cwd: dir });
    expect(await runCli(['import', 'models', '-p', 'ghost'], t.io)).toBe(1);
    expect(t.err()).toContain('import into ghost failed (404');

    await mkdir(path.join(dir, 'empty'), { recursive: true });
    expect(await runCli(['import', 'empty', '-p', 'demo'], t.io)).toBe(1);
    expect(t.err()).toContain('no BPMN files');

    const offline = testIo({ PROA_OWNER_KEY_FILE: keyFile }, undefined, { cwd: dir });
    expect(await runCli(['import', 'models', '-p', 'demo'], offline.io)).toBe(1);
    expect(offline.err()).toContain('cannot reach ProA at http://127.0.0.1:7400');
  });
});
