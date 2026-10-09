/**
 * `proa value-chain push|pull` against a fake REST API (M4 S2): push saves an
 * existing chain with `If-Match` on `--base` (the revision the file was pulled
 * from), refuses to save without it unless `--force` (the current head),
 * creates a new chain with `If-None-Match: *`, runs a dry run first and stops
 * before stranding placements unless `--yes`; `--dry-run` saves nothing; 412
 * and 422 come back as clear messages; agent tokens are refused before any
 * request. Pull writes the canonical bytes verbatim with any credential.
 */
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRevision, revisionOfEtag } from '../../src/commands/value-chain.ts';
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
let keyFile: string;
let docFile: string;

const CONTENT = '/api/v1/projects/p/value-chains/main/content';
const DOC = { schemaVersion: 1, meta: { name: 'Kette' }, elements: [], connections: [] };
const CANONICAL = '{"connections":[],"elements":[],"meta":{"name":"Kette"},"schemaVersion":1}\n';

beforeAll(async () => {
  dir = await tempDir();
  keyFile = await ownerKeyFile(dir);
  docFile = path.join(dir, 'kette.vc.json');
  await writeFile(docFile, `${JSON.stringify(DOC, null, 2)}\n`);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function impact(
  over: { stranded?: number; toReconfirm?: number; proposalsWithdrawn?: number } = {},
) {
  return {
    structureChanged: true,
    steps: {
      added: [{ elementId: 'step-neu', name: 'Neu' }],
      removed:
        (over.stranded ?? 0) > 0
          ? [
              {
                elementId: 'step-alt',
                generation: 1,
                name: 'Alt',
                placements: { accepted: over.stranded ?? 0, held: 0, proposed: 1 },
              },
            ]
          : [],
      changed:
        (over.toReconfirm ?? 0) > 0
          ? [
              {
                elementId: 'step-x',
                generation: 1,
                before: { name: 'Vorher', parentId: null, kind: 'core' },
                after: { name: 'Nachher', parentId: null, kind: 'core' },
                fingerprintChanged: true,
                placements: { accepted: over.toReconfirm ?? 0, held: 0, proposed: 0 },
              },
            ]
          : [],
    },
    placements: {
      stranded: over.stranded ?? 0,
      toReconfirm: over.toReconfirm ?? 0,
      proposalsWithdrawn: over.proposalsWithdrawn ?? 0,
    },
  };
}

function chain(rev: number) {
  return {
    id: 'vch_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
    key: 'main',
    name: 'Kette',
    headRevisionId: 'vcr_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
    headRev: rev,
    contentHash: 'a'.repeat(64),
    structureHash: 'b'.repeat(64),
    schemaVersion: 1,
    updatedAt: '2026-10-09T00:00:00.000Z',
  };
}

function result(outcome: string, dryRun: boolean, rev: number | null, over = {}) {
  return {
    dryRun,
    outcome,
    valueChain: rev === null ? null : chain(rev),
    revision: null,
    impact: impact(over),
  };
}

const content = (rev: number) => () =>
  new Response(CANONICAL, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', etag: `"r${rev}"` },
  });

interface Put {
  dryRun: boolean;
  ifMatch: string | null;
  ifNoneMatch: string | null;
  body: unknown;
}

/** A fake API whose content PUT answers per call (dry run first, then the save). */
function server(head: number | null, answers: ((put: Put) => Response)[]) {
  const puts: Put[] = [];
  const api = fakeApi({
    [`GET ${CONTENT}`]:
      head === null ? () => problem(404, 'not-found', 'no value chain') : content(head),
    [`PUT ${CONTENT}`]: async (req, url) => {
      const put: Put = {
        dryRun: url.searchParams.get('dryRun') === 'true',
        ifMatch: req.headers.get('if-match'),
        ifNoneMatch: req.headers.get('if-none-match'),
        body: await req.json(),
      };
      puts.push(put);
      const answer = answers[puts.length - 1];
      if (!answer) throw new Error('unexpected PUT');
      return answer(put);
    },
  });
  return { ...api, puts };
}

const owner = (fetch: typeof globalThis.fetch, env: Record<string, string> = {}) =>
  testIo({ PROA_OWNER_KEY_FILE: keyFile, ...env }, fetch, { cwd: dir });

describe('parsing', () => {
  it('reads revisions from ETags and options', () => {
    expect(revisionOfEtag('"r12"')).toBe(12);
    expect(revisionOfEtag('W/"r3"')).toBe(3);
    expect(revisionOfEtag('"12"')).toBeNull();
    expect(revisionOfEtag(null)).toBeNull();
    expect(parseRevision('3', '--rev')).toBe(3);
    expect(parseRevision('r7', '--rev')).toBe(7);
    expect(() => parseRevision('0', '--rev')).toThrow(/revision number/);
    expect(() => parseRevision('head', '--base')).toThrow(/--base/);
  });
});

describe('proa value-chain push', () => {
  it('creates a missing chain with If-None-Match: * after a dry run', async () => {
    const s = server(null, [
      () => json(result('created', true, null)),
      () => json(result('created', false, 1), 201),
    ]);
    const t = owner(s.fetch);
    expect(await runCli(['value-chain', 'push', 'kette.vc.json', '-p', 'p'], t.io)).toBe(0);
    expect(t.err()).toBe('');
    expect(s.puts.map((p) => [p.dryRun, p.ifMatch, p.ifNoneMatch])).toEqual([
      [true, null, '*'],
      [false, null, '*'],
    ]);
    expect(s.puts[1]?.body).toEqual(DOC);
    expect(s.seen.every((r) => r.authorization === `Bearer ${OWNER_KEY}`)).toBe(true);
    expect(t.out()).toContain('p: value chain created r1');
    expect(t.out()).toContain('steps added: step-neu "Neu"');
  });

  it('refuses to save an existing chain without --base: the head may have moved since the pull', async () => {
    const s = server(4, [() => json(result('revised', true, 4))]);
    const t = owner(s.fetch);
    expect(await runCli(['value-chain', 'push', 'kette.vc.json', '-p', 'p'], t.io)).toBe(1);
    expect(s.puts.map((p) => [p.dryRun, p.ifMatch])).toEqual([[true, '"r4"']]);
    expect(t.err()).toContain(
      'the value chain of p exists (head r4): pass --base with the revision your file comes from (pull prints r<rev> on stderr), or --force',
    );
  });

  it('saves on --base, the revision the file was pulled from', async () => {
    const s = server(4, [
      () => json(result('revised', true, 4)),
      () => json(result('revised', false, 5)),
    ]);
    const t = owner(s.fetch);
    expect(
      await runCli(['value-chain', 'push', 'kette.vc.json', '-p', 'p', '--base', 'r4'], t.io),
    ).toBe(0);
    expect(s.puts.map((p) => [p.dryRun, p.ifMatch])).toEqual([
      [true, '"r4"'],
      [false, '"r4"'],
    ]);
    expect(t.out()).toContain('p: value chain revised r5 (from r4)');
    expect(t.out()).toContain('placements: 0 stranded, 0 to re-confirm, 0 proposals withdrawn');
  });

  it('answers "pull first" when the head moved between pull (r5) and push', async () => {
    // r6 was saved elsewhere (it adds steps without placements, so nothing would be stranded).
    const s = server(6, [
      (put) =>
        put.ifMatch === '"r6"'
          ? json(result('revised', true, 6))
          : json(
              {
                type: 'urn:proa:problem:revision-conflict',
                title: 'Revision conflict',
                status: 412,
                code: 'revision-conflict',
                detail: 'the value chain is at r6',
                headRev: 6,
                etag: '"r6"',
              },
              412,
            ),
    ]);
    const t = owner(s.fetch);
    expect(
      await runCli(['value-chain', 'push', 'kette.vc.json', '-p', 'p', '--base', 'r5'], t.io),
    ).toBe(1);
    expect(s.puts.map((p) => [p.dryRun, p.ifMatch])).toEqual([[true, '"r5"']]);
    expect(t.err()).toContain('the value chain is at r6; pull first');
  });

  it('saves on the current head with --force, and refuses --force with --base', async () => {
    const s = server(4, [
      () => json(result('revised', true, 4)),
      () => json(result('revised', false, 5)),
    ]);
    const t = owner(s.fetch);
    expect(await runCli(['value-chain', 'push', 'kette.vc.json', '-p', 'p', '--force'], t.io)).toBe(
      0,
    );
    expect(s.puts.map((p) => p.ifMatch)).toEqual(['"r4"', '"r4"']);
    expect(t.out()).toContain('p: value chain revised r5 (from r4)');

    const none = server(4, []);
    const both = owner(none.fetch);
    expect(
      await runCli(
        ['value-chain', 'push', 'kette.vc.json', '-p', 'p', '--force', '--base', 'r4'],
        both.io,
      ),
    ).toBe(1);
    expect(both.err()).toContain('--base and --force exclude each other');
    expect(none.seen).toEqual([]);
  });

  it('stops after an unchanged dry run', async () => {
    const s = server(4, [() => json({ ...result('unchanged', true, 4), impact: impact() })]);
    const t = owner(s.fetch);
    expect(await runCli(['value-chain', 'push', 'kette.vc.json', '-p', 'p'], t.io)).toBe(0);
    expect(s.puts).toHaveLength(1);
    expect(t.out()).toBe('p: value chain unchanged r4\n');
  });

  it('--dry-run prints the impact and saves nothing', async () => {
    const s = server(4, [() => json(result('revised', true, 4, { stranded: 2, toReconfirm: 1 }))]);
    const t = owner(s.fetch);
    expect(
      await runCli(['value-chain', 'push', 'kette.vc.json', '-p', 'p', '--dry-run'], t.io),
    ).toBe(0);
    expect(s.puts.map((p) => p.dryRun)).toEqual([true]);
    expect(t.out()).toContain('dry run: p: value chain revised r4');
    expect(t.out()).toContain('step removed: step-alt "Alt" (2 accepted, 0 held, 1 proposed)');
    expect(t.out()).toContain(
      'step changed: step-x "Vorher" → "Nachher" (1 accepted, 0 held, 0 proposed, re-confirm)',
    );
    expect(t.out()).toContain('placements: 2 stranded, 1 to re-confirm');
    expect(t.out()).toContain('(against the current head r4; saving needs --base or --force)');
  });

  it('needs --yes to strand placements or send them to re-confirm', async () => {
    const answers = [
      () => json(result('revised', true, 4, { toReconfirm: 1 })),
      () => json(result('revised', false, 5, { toReconfirm: 1 })),
    ];
    const refused = server(4, answers);
    const t = owner(refused.fetch);
    expect(
      await runCli(['value-chain', 'push', 'kette.vc.json', '-p', 'p', '--base', '4'], t.io),
    ).toBe(1);
    expect(refused.puts).toHaveLength(1);
    expect(t.err()).toContain('send 1 to re-confirm; push again with --yes');

    const confirmed = server(4, answers);
    const y = owner(confirmed.fetch);
    expect(
      await runCli(
        ['value-chain', 'push', 'kette.vc.json', '-p', 'p', '--base', '4', '--yes', '--json'],
        y.io,
      ),
    ).toBe(0);
    expect(confirmed.puts.map((p) => p.dryRun)).toEqual([true, false]);
    expect(JSON.parse(y.out())).toMatchObject({ dryRun: false, outcome: 'revised' });
  });

  it('explains 412: the chain moved on, pull first', async () => {
    const s = server(4, [
      () =>
        json(
          {
            type: 'urn:proa:problem:revision-conflict',
            title: 'Revision conflict',
            status: 412,
            code: 'revision-conflict',
            detail: 'the value chain is at r6',
            headRev: 6,
            etag: '"r6"',
          },
          412,
        ),
    ]);
    const t = owner(s.fetch);
    expect(await runCli(['value-chain', 'push', 'kette.vc.json', '-p', 'p'], t.io)).toBe(1);
    expect(t.err()).toContain('the value chain is at r6; pull first');
  });

  it('lists the violations of a refused document with their element ids', async () => {
    const s = server(4, [
      () =>
        json(
          {
            type: 'urn:proa:problem:value-chain-invalid',
            title: 'Value chain invalid',
            status: 422,
            code: 'value-chain-invalid',
            detail: 'the document breaks 2 rules',
            truncated: false,
            violations: [
              {
                reason: 'name-too-long',
                elementId: 'step-a',
                connectionId: null,
                path: 'elements.0.name',
                detail: 'at most 200 characters',
              },
              {
                reason: 'duplicate-connection',
                elementId: null,
                connectionId: 'c2',
                path: null,
                detail: 'same type and pair as c1',
              },
            ],
          },
          422,
        ),
    ]);
    const t = owner(s.fetch);
    expect(await runCli(['value-chain', 'push', 'kette.vc.json', '-p', 'p'], t.io)).toBe(1);
    expect(t.err()).toContain('refused the document (2 violations)');
    expect(t.err()).toContain('name-too-long (element step-a, at elements.0.name): at most 200');
    expect(t.err()).toContain('duplicate-connection (connection c2): same type and pair as c1');
  });

  it('refuses an agent token, a missing, oversized or non-JSON file before any request', async () => {
    const s = server(4, []);
    const agent = owner(s.fetch, { PROA_TOKEN: AGENT_TOKEN });
    expect(await runCli(['value-chain', 'push', 'kette.vc.json', '-p', 'p'], agent.io)).toBe(1);
    expect(agent.err()).toContain('agents never edit the value chain');

    const missing = owner(s.fetch);
    expect(await runCli(['value-chain', 'push', 'fehlt.vc.json', '-p', 'p'], missing.io)).toBe(1);
    expect(missing.err()).toContain('is not a file');

    await writeFile(path.join(dir, 'kaputt.json'), '{"schemaVersion":');
    const broken = owner(s.fetch);
    expect(await runCli(['value-chain', 'push', 'kaputt.json', '-p', 'p'], broken.io)).toBe(1);
    expect(broken.err()).toContain('kaputt.json is not JSON');

    await writeFile(path.join(dir, 'gross.json'), ' '.repeat(2 * 1024 * 1024 + 1));
    const large = owner(s.fetch);
    expect(await runCli(['value-chain', 'push', 'gross.json', '-p', 'p'], large.io)).toBe(1);
    expect(large.err()).toContain('may have at most 2097152');
    expect(s.seen).toEqual([]);
  });
});

describe('proa value-chain pull', () => {
  const hash = createHash('sha256').update(CANONICAL).digest('hex');

  it('writes the head’s canonical bytes verbatim, with an agent token too', async () => {
    const api = fakeApi({ [`GET ${CONTENT}`]: content(3) });
    const t = testIo({ PROA_TOKEN: AGENT_TOKEN }, api.fetch, { cwd: dir });
    expect(await runCli(['value-chain', 'pull', '-p', 'p', '-o', 'pulled.vc.json'], t.io)).toBe(0);
    expect(await readFile(path.join(dir, 'pulled.vc.json'), 'utf8')).toBe(CANONICAL);
    expect(t.err()).toBe(`r3 ${hash}\n`);
    expect(t.out()).toBe('');
    expect(api.seen[0]?.authorization).toBe(`Bearer ${AGENT_TOKEN}`);
  });

  it('prints a revision to stdout with --rev', async () => {
    const api = fakeApi({
      'GET /api/v1/projects/p/value-chains/main/revisions/2/content': content(2),
    });
    const t = owner(api.fetch);
    expect(await runCli(['value-chain', 'pull', '-p', 'p', '--rev', '2'], t.io)).toBe(0);
    expect(t.out()).toBe(CANONICAL);
    expect(t.err()).toBe(`r2 ${hash}\n`);
  });

  it('reports a project without a chain', async () => {
    const api = fakeApi({});
    const t = owner(api.fetch);
    expect(await runCli(['value-chain', 'pull', '-p', 'p'], t.io)).toBe(1);
    expect(t.err()).toContain('read the value chain of p failed (404');
  });
});
