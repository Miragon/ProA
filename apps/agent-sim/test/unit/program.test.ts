import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RelationRecordingLine } from '@proa/contracts';
import { afterAll, describe, expect, it } from 'vitest';

import type { AgentReport } from '../../src/agent.ts';
import { CHECKOUT_BRIDGE, bridgeCommand, mcpUrl } from '../../src/connect.ts';
import { runSim, type SimIo } from '../../src/program.ts';
import { TOKEN, fakeProa, type FakeProa } from '../support/fake-proa.ts';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function io(proa: FakeProa | null, env: Record<string, string> = {}, cwd = os.tmpdir()) {
  const out: string[] = [];
  const err: string[] = [];
  const value: SimIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: { PROA_URL: 'http://proa.test', ...env },
    cwd,
    ...(proa ? { fetch: proa.fetch } : {}),
  };
  return { io: value, out: () => out.join(''), err: () => err.join('') };
}

describe('proa-agent-sim', () => {
  it('works the pipeline with PROA_TOKEN and prints a summary', async () => {
    const proa = fakeProa({ tasks: 2 });
    const t = io(proa, { PROA_TOKEN: TOKEN });
    expect(await runSim([], t.io)).toBe(0);
    expect(proa.submissions).toHaveLength(2);
    expect(t.out()).toBe(
      [
        'agent-sim: 2 tasks (2 submitted, 0 dry run, 0 failed); stopped: no-work',
        '  relations: 2 tasks, 8 proposals (2 with a question), 2 no-links',
        '    results: applied 8, duplicate 0, suppressed 0, reopened 0, invalid 0; withdrawn by supersession 0',
        '  placement: 0 tasks, 0 placements (0 with a question), 0 unsure, 0 skipped, 0 follow-ups',
        '    results: applied 0, duplicate 0, suppressed 0, reopened 0, invalid 0; withdrawn by supersession 0',
        '',
      ].join('\n'),
    );
    expect(t.err()).toMatch(/^procedure proa-relations@0\.0\.1/);
  });

  it('records relative to the invoking directory, with options for the policy and the declared model', async () => {
    const proa = fakeProa({ tasks: 1 });
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-sim-cli-'));
    dirs.push(cwd);
    const t = io(proa, {}, cwd);
    const code = await runSim(
      [
        '--token',
        TOKEN,
        '--record',
        'recordings',
        '--record-input',
        'summary',
        '--no-record-ids',
        '--propose-at',
        '0.9',
        '--ask-at',
        '0.75',
        '--llm-model',
        'policy x',
        '--quiet',
        '--json',
      ],
      t.io,
    );
    expect(code).toBe(0);
    expect(t.err()).toBe('');
    const report = JSON.parse(t.out()) as AgentReport;
    const file = path.join(cwd, 'recordings/proa-relations@0.0.1/agent-sim/policy-x/demo.jsonl');
    expect(report.recordings).toEqual([file]);
    const line = RelationRecordingLine.parse(JSON.parse(await readFile(file, 'utf8')));
    expect(line.llmModel).toBe('policy x');
    expect(line.task).toBeUndefined();
    expect(line.input).toMatchObject({ summary: true });
    // proposeAt 0.9 / askAt 0.75: the 0.8 pair becomes a question, the 0.58 pair a no-link.
    expect(line.submission.relations.map((r) => [r.confidence, r.question !== null])).toEqual([
      [1, false],
      [1, false],
      [0.8, true],
    ]);
    expect(proa.submissions[0]?.['llmModel']).toBe('policy x');
  });

  it('claims the kinds --kinds names and summarizes them', async () => {
    const proa = fakeProa({ tasks: 1, placements: 1 });
    const t = io(proa, { PROA_TOKEN: TOKEN });
    expect(await runSim(['--kinds', 'placement', '-q'], t.io)).toBe(0);
    expect(proa.claims.map((c) => c['kinds'])).toEqual([['placement'], ['placement']]);
    expect(t.out()).toBe(
      [
        'agent-sim: 1 tasks (1 submitted, 0 dry run, 0 failed); stopped: no-work',
        '  placement: 1 tasks, 6 placements (2 with a question), 2 unsure, 0 skipped, 0 follow-ups',
        '    results: applied 6, duplicate 0, suppressed 0, reopened 0, invalid 0; withdrawn by supersession 0',
        '',
      ].join('\n'),
    );
    const both = fakeProa({ tasks: 0, placements: 1 });
    const t2 = io(both, { PROA_TOKEN: TOKEN });
    expect(await runSim(['--kinds', 'relations,placement', '-q'], t2.io)).toBe(0);
    expect(both.claims[0]?.['kinds']).toEqual(['relations', 'placement']);
  });

  it('dry run exits 0 and submits nothing', async () => {
    const proa = fakeProa({ tasks: 2 });
    const t = io(proa, { PROA_TOKEN: TOKEN });
    expect(await runSim(['--dry-run', '-n', '1', '-q'], t.io)).toBe(0);
    expect(proa.submissions).toHaveLength(0);
    expect(proa.releases).toHaveLength(1);
    expect(t.out()).toMatch(
      /^agent-sim: 1 tasks \(0 submitted, 1 dry run, 0 failed\); stopped: max-tasks/,
    );
  });

  it('exits 1 when a submission fails', async () => {
    const proa = fakeProa({
      tasks: 1,
      submitProblem: () => ({ code: 'task-cancelled', status: 409, detail: 'new revision' }),
    });
    const t = io(proa, { PROA_TOKEN: TOKEN });
    expect(await runSim([], t.io)).toBe(1);
    expect(t.err()).toMatch(/FAILED task-cancelled: new revision/);
  });

  it('needs an agent token and refuses the owner key', async () => {
    const missing = io(fakeProa());
    expect(await runSim([], missing.io)).toBe(1);
    expect(missing.err()).toMatch(/an agent token is needed: --token or PROA_TOKEN/);
    const owner = io(fakeProa(), { PROA_TOKEN: `proa_ok_${'k'.repeat(43)}` });
    expect(await runSim([], owner.io)).toBe(1);
    expect(owner.err()).toMatch(/that is the owner key/);
    const other = io(fakeProa(), { PROA_TOKEN: 'secret' });
    expect(await runSim([], other.io)).toBe(1);
    expect(other.err()).toMatch(/starts with proa_at_/);
  });

  it('exits 2 on usage errors and 0 for --help and --version', async () => {
    for (const argv of [
      ['--propose-at', '1.5'],
      ['--max-tasks', '0'],
      ['--record-input', 'all'],
      ['--kinds', 'decide'],
      ['--kinds', 'placement,placement'],
      ['--bogus'],
    ]) {
      const t = io(null);
      expect(await runSim(argv, t.io), argv.join(' ')).toBe(2);
      expect(t.err()).not.toBe('');
    }
    const help = io(null);
    expect(await runSim(['--help'], help.io)).toBe(0);
    expect(help.out()).toMatch(/--stdio-command <command>/);
    const version = io(null);
    expect(await runSim(['--version'], version.io)).toBe(0);
    expect(version.out()).toBe('0.0.0\n');
  });
});

describe('connections', () => {
  it('derives the MCP endpoint and the bridge command', () => {
    expect(mcpUrl('http://127.0.0.1:7400/').href).toBe('http://127.0.0.1:7400/mcp');
    expect(mcpUrl('https://proa.example/base').href).toBe('https://proa.example/base/mcp');
    expect(() => mcpUrl('ftp://x')).toThrow(/http\(s\)/);
    expect(bridgeCommand()).toEqual({ command: process.execPath, args: [CHECKOUT_BRIDGE, 'mcp'] });
    expect(CHECKOUT_BRIDGE).toMatch(/apps[/\\]cli[/\\]src[/\\]main\.ts$/);
    expect(bridgeCommand(' docker exec -i -e PROA_TOKEN proa2-proa-1 proa mcp ')).toEqual({
      command: 'docker',
      args: ['exec', '-i', '-e', 'PROA_TOKEN', 'proa2-proa-1', 'proa', 'mcp'],
    });
    expect(() => bridgeCommand('  ')).toThrow(/empty/);
  });
});
