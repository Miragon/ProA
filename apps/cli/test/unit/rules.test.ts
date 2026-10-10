import { rm } from 'node:fs/promises';

import type { AgentToken } from '@proa/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  draftOf,
  formatPercent,
  mergeFlags,
  parseConfidence,
  resolveAgent,
} from '../../src/commands/rules.ts';
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

beforeAll(async () => {
  dir = await tempDir();
  keyFile = await ownerKeyFile(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const RULE_ID = 'aar_01J9Z3N4X5Q6R7S8T9V0W1X2Y3';
const BASE = '/api/v1/projects/p';
const AT = '2026-10-10T08:00:00.000Z';
const OWNER = { principalId: 'prn_01J9Z3N4X5Q6R7S8T9V0W1X2Y0', handle: 'owner' };
const AGENT_PRN = 'prn_01J9Z3N4X5Q6R7S8T9V0W1X2YA';
const AGENT_PRN_2 = 'prn_01J9Z3N4X5Q6R7S8T9V0W1X2YB';

function token(
  id: string,
  name: string,
  principalId: string,
  revokedAt: string | null = null,
): AgentToken {
  return {
    id,
    principalId,
    name,
    prefix: 'abcdefgh',
    scopes: ['proa:read', 'proa:propose'],
    expiresAt: '2027-01-05T00:00:00.000Z',
    revokedAt,
    lastUsedAt: null,
    createdAt: AT,
  };
}

const TOKENS = [
  token('agt_01J9Z3N4X5Q6R7S8T9V0W1X2YA', 'claude', AGENT_PRN),
  token('agt_01J9Z3N4X5Q6R7S8T9V0W1X2YB', 'sim', AGENT_PRN_2, AT),
  token('agt_01J9Z3N4X5Q6R7S8T9V0W1X2YC', 'sim', 'prn_01J9Z3N4X5Q6R7S8T9V0W1X2YC'),
  token('agt_01J9Z3N4X5Q6R7S8T9V0W1X2YD', 'twin', 'prn_01J9Z3N4X5Q6R7S8T9V0W1X2YD'),
  token('agt_01J9Z3N4X5Q6R7S8T9V0W1X2YE', 'twin', 'prn_01J9Z3N4X5Q6R7S8T9V0W1X2YE'),
];

function rule(overrides: Record<string, unknown> = {}) {
  const head = {
    id: RULE_ID,
    kind: 'relation',
    revision: 2,
    name: 'Schlüssel ab 95 %',
    enabled: false,
    note: null,
    tier: 'key',
    minConfidence: 0.95,
    relationType: null,
    agentPrincipalId: null,
    agent: null,
    llmModel: null,
    includeAdHoc: false,
    author: OWNER,
    authorIsOwner: true,
    createdBy: OWNER,
    createdAt: AT,
    updatedAt: AT,
    stats: { inForce: 3, revoked: 1, confirmed: 0, overruled: 0, lastAcceptedAt: AT },
    ...overrides,
  };
  const revision = (n: number) => ({
    revision: n,
    name: head.name,
    enabled: n === head.revision ? head.enabled : false,
    note: head.note,
    kind: head.kind,
    tier: head.tier,
    minConfidence: head.minConfidence,
    relationType: head.relationType,
    agentPrincipalId: head.agentPrincipalId,
    llmModel: head.llmModel,
    includeAdHoc: head.includeAdHoc,
    author: OWNER,
    clientId: 'proa-cli',
    at: AT,
  });
  return {
    ...head,
    revisions: Array.from({ length: head.revision }, (_, i) => revision(i + 1)),
  };
}

const SYSTEM = {
  id: 'proa-rules/1.0.0',
  name: 'Eindeutige Aufrufe',
  description: 'x',
  kind: 'relation',
  relationType: 'call',
  readOnly: true,
  accepted: 31,
};

function preview(open = 2) {
  const point = (minConfidence: number) => ({
    minConfidence,
    wouldAccept: 10,
    accepted: 9,
    rejected: 1,
    corrected: 0,
    held: 0,
    precision: 0.9,
    open,
  });
  return {
    kind: 'relation',
    history: {
      decided: 20,
      wouldAccept: 10,
      accepted: 9,
      rejected: 1,
      corrected: 0,
      held: 0,
      autoUnreviewed: 2,
      undecided: 1,
      precision: 0.9,
    },
    open: {
      count: open,
      items: [],
      blocked: [{ reason: 'agent-question', count: 1 }],
    },
    curve: [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1].map(point),
    agents: [],
    llmModels: [],
  };
}

const ITEM = {
  kind: 'relation',
  id: 'rel_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
  status: 'proposed',
  endpointState: 'ok',
  type: 'message',
  from: 'a/b#Send',
  to: 'c/d#Receive',
  valueChainKey: null,
  step: null,
  process: null,
  triggerId: 'ast_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
  agent: { principalId: AGENT_PRN, handle: 'agent:claude' },
  llmModel: 'claude-opus-5-5',
  tier: 'key',
  confidence: 0.97,
};

function applyResult(
  dryRun: boolean,
  count: number,
  head: { enabled?: boolean; authorIsOwner?: boolean } = {},
) {
  return {
    dryRun,
    ruleId: RULE_ID,
    revision: 2,
    enabled: head.enabled ?? true,
    authorIsOwner: head.authorIsOwner ?? true,
    count,
    items: Array.from({ length: count }, () => ITEM),
    truncated: false,
    blocked: [],
  };
}

const LEDGER_ENTRY = {
  ...ITEM,
  status: 'accepted',
  decisionId: 'ast_01J9Z3N4X5Q6R7S8T9V0W1X2Y4',
  ruleId: RULE_ID,
  revision: 2,
  ruleName: 'Schlüssel ab 95 %',
  decidedBy: OWNER,
  at: AT,
  state: 'in-force',
  laterVerdict: null,
  laterAt: null,
  revocationId: null,
  revokedAt: null,
};

function revocation(dryRun: boolean, count: number) {
  return {
    dryRun,
    count,
    toProposed: count,
    toObsolete: 0,
    humanDecidedSince: 1,
    alreadyRevoked: 0,
    items: Array.from({ length: count }, () => ({ ...LEDGER_ENTRY, outcome: 'proposed' })),
    truncated: false,
  };
}

const env = () => ({ PROA_OWNER_KEY_FILE: keyFile });

describe('formatPercent', () => {
  it('shows every decimal a threshold has (never rounder, and looser, than it is)', () => {
    expect(formatPercent(0.9)).toBe('90%');
    expect(formatPercent(0.925)).toBe('92.5%');
    expect(formatPercent(0.9004)).toBe('90.04%');
    expect(formatPercent(0.92345)).toBe('92.345%');
  });
});

describe('parseConfidence', () => {
  it('reads fractions and percentages between 50% and 100%, inclusive', () => {
    expect(parseConfidence('0.9')).toBe(0.9);
    expect(parseConfidence('90%')).toBe(0.9);
    expect(parseConfidence(' 92.5 % ')).toBe(0.925);
    expect(parseConfidence('0,95')).toBe(0.95);
    expect(parseConfidence('1')).toBe(1);
    expect(parseConfidence('50%')).toBe(0.5);
    expect(parseConfidence('100%')).toBe(1);
    for (const bad of ['95', 'high', '', '0.9.1', '-0.9']) {
      expect(() => parseConfidence(bad), bad).toThrow(/invalid minimum confidence/);
    }
    for (const low of ['0.49', '40%', '101%']) {
      expect(() => parseConfidence(low), low).toThrow(/between 50% and 100%/);
    }
  });
});

describe('resolveAgent', () => {
  it('finds a token by id, principal or name (the live one of a name)', () => {
    expect(resolveAgent(TOKENS, 'agt_01J9Z3N4X5Q6R7S8T9V0W1X2YA')).toBe(AGENT_PRN);
    expect(resolveAgent(TOKENS, AGENT_PRN)).toBe(AGENT_PRN);
    expect(resolveAgent(TOKENS, 'claude')).toBe(AGENT_PRN);
    // Two tokens named sim, one revoked: the live one.
    expect(resolveAgent(TOKENS, 'sim')).toBe('prn_01J9Z3N4X5Q6R7S8T9V0W1X2YC');
    expect(() => resolveAgent(TOKENS, 'twin')).toThrow(/several agent tokens are named "twin"/);
    expect(() => resolveAgent(TOKENS, 'nobody')).toThrow(/no agent token "nobody"/);
  });
});

describe('mergeFlags', () => {
  it('changes only the given fields; any drops a narrowing; the kind never changes', async () => {
    const base = draftOf({
      ...rule({ relationType: 'message', llmModel: 'm1', agentPrincipalId: AGENT_PRN }),
    } as never);
    const tokens = () => Promise.resolve(TOKENS);
    expect(await mergeFlags(base, { min: '97%', type: 'any', model: 'any' }, tokens)).toEqual({
      ...base,
      minConfidence: 0.97,
      relationType: null,
      llmModel: null,
    });
    expect(await mergeFlags(base, { agent: 'any', adHoc: true, note: 'x' }, tokens)).toMatchObject({
      agentPrincipalId: null,
      includeAdHoc: true,
      note: 'x',
    });
    expect((await mergeFlags({ ...base, note: 'old' }, { note: '' }, tokens)).note).toBeNull();
    await expect(mergeFlags(base, { kind: 'placement' }, tokens)).rejects.toThrow(
      /kind of a rule never changes/,
    );
    await expect(mergeFlags(base, { tier: 'rule' }, tokens)).rejects.toThrow(
      /one of the tiers key, lexical, semantic/,
    );
    const placement = { ...base, kind: 'placement' as const, tier: 'lexical' as const };
    await expect(mergeFlags(placement, { tier: 'key' }, tokens)).rejects.toThrow(
      /a placement rule names one of the tiers lexical, semantic/,
    );
    await expect(mergeFlags(placement, { type: 'call' }, tokens)).rejects.toThrow(
      /only a relation rule has a relation type/,
    );
  });
});

describe('proa rules list and show', () => {
  it('lists the system rule and the rules', async () => {
    const api = fakeApi({
      [`GET ${BASE}/auto-accept-rules`]: () =>
        json({
          items: [rule({ enabled: true, relationType: 'call', authorIsOwner: false })],
          system: SYSTEM,
        }),
    });
    const t = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'list', '-p', 'p'], t.io)).toBe(0);
    expect(api.seen[0]?.authorization).toBe(`Bearer ${OWNER_KEY}`);
    expect(t.out()).toContain(
      'system rule proa-rules/1.0.0 "Eindeutige Aufrufe": call relations, always on, read-only; 31 accepted',
    );
    expect(t.out()).toContain(
      `${RULE_ID}  "Schlüssel ab 95 %"  on  relation key ≥ 95%, type call  r2 by owner  in force 3, revoked 1, confirmed 0, overruled 0 (author is no longer an owner: matches nothing until an owner saves it again, e.g. proa rules edit ${RULE_ID})`,
    );
  });

  it('says so without rules, and prints JSON with --json', async () => {
    const api = fakeApi({
      [`GET ${BASE}/auto-accept-rules`]: () => json({ items: [], system: SYSTEM }),
    });
    const t = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'list', '-p', 'p'], t.io)).toBe(0);
    expect(t.out()).toContain(
      'no auto-accept rules in p: you decide every agent proposal yourself',
    );
    const j = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'list', '-p', 'p', '--json'], j.io)).toBe(0);
    expect(JSON.parse(j.out())).toEqual({ items: [], system: SYSTEM });
  });

  it('shows the revisions', async () => {
    const api = fakeApi({ [`GET ${BASE}/auto-accept-rules/${RULE_ID}`]: () => json(rule()) });
    const t = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'show', RULE_ID, '-p', 'p'], t.io)).toBe(0);
    expect(t.out()).toMatch(
      /revisions:\n {2}r1 {2}2026-10-10T08:00:00.000Z {2}owner \(proa-cli\) {2}off/,
    );
    expect(t.out()).toMatch(/\n {2}r2 /);
  });
});

describe('proa rules add', () => {
  it('validates the flags before any request', async () => {
    const api = fakeApi({});
    for (const [argv, message] of [
      [['--name', 'x', '--kind', 'relation', '--tier', 'key'], /needs --min/],
      [
        ['--name', 'x', '--kind', 'placement', '--tier', 'key', '--min', '0.9'],
        /lexical, semantic/,
      ],
      [['--name', 'x', '--kind', 'relation', '--tier', 'key', '--min', '30%'], /between 50%/],
      [['--name', 'x', '--kind', 'edge', '--tier', 'key', '--min', '0.9'], /unknown kind "edge"/],
    ] as const) {
      const t = testIo(env(), api.fetch);
      expect(await runCli(['rules', 'add', '-p', 'p', ...argv], t.io)).toBe(1);
      expect(t.err()).toMatch(message);
    }
    expect(api.seen).toHaveLength(0);
  });

  it('creates a rule off by default, resolves the agent and prints the preview', async () => {
    let created: unknown;
    const api = fakeApi({
      [`GET ${BASE}/agent-tokens`]: () => json({ items: TOKENS }),
      [`POST ${BASE}/auto-accept-rules`]: async (req) => {
        created = await req.json();
        return json({ outcome: 'created', rule: rule({ revision: 1 }) }, 201);
      },
      [`POST ${BASE}/auto-accept-rules/preview`]: () => json(preview()),
    });
    const t = testIo(env(), api.fetch);
    const code = await runCli(
      [
        'rules',
        'add',
        '-p',
        'p',
        '--name',
        'Schlüssel ab 95 %',
        '--kind',
        'relation',
        '--tier',
        'key',
        '--min',
        '95%',
        '--type',
        'message',
        '--agent',
        'claude',
        '--model',
        'claude-opus-5-5',
      ],
      t.io,
    );
    expect(t.err()).toBe('');
    expect(code).toBe(0);
    expect(created).toEqual({
      name: 'Schlüssel ab 95 %',
      enabled: false,
      note: null,
      kind: 'relation',
      tier: 'key',
      minConfidence: 0.95,
      relationType: 'message',
      agentPrincipalId: AGENT_PRN,
      llmModel: 'claude-opus-5-5',
      includeAdHoc: false,
    });
    expect(t.out()).toContain(`off: enable it with proa rules enable ${RULE_ID} -p p`);
    expect(t.out()).toContain(
      'history: of 20 agent-proposed items a human decided, the rule would have accepted 10: 9 accepted, 1 rejected, 0 corrected, 0 held (precision 90%)',
    );
    expect(t.out()).toContain('blocked by a safeguard: agent-question 1');
    expect(t.out()).toMatch(/\n {2}95% +10 +9 +1 +0 +0 +90% +2\n/);
  });

  it('--enable creates it on and points to apply for open matches', async () => {
    const api = fakeApi({
      [`POST ${BASE}/auto-accept-rules`]: async (req) =>
        json(
          {
            outcome: 'created',
            rule: rule({
              revision: 1,
              enabled: ((await req.json()) as { enabled: boolean }).enabled,
            }),
          },
          201,
        ),
      [`POST ${BASE}/auto-accept-rules/preview`]: () => json(preview(4)),
    });
    const t = testIo(env(), api.fetch);
    const args = [
      '--name',
      'n',
      '--kind',
      'relation',
      '--tier',
      'key',
      '--min',
      '0.95',
      '--enable',
    ];
    expect(await runCli(['rules', 'add', '-p', 'p', ...args], t.io)).toBe(0);
    expect(t.out()).toContain(`accept the 4 open proposals with proa rules apply ${RULE_ID} -p p`);
  });

  it('explains a refused rule', async () => {
    const api = fakeApi({
      [`POST ${BASE}/auto-accept-rules`]: () =>
        json(
          {
            type: 'urn:proa:problem:validation-failed',
            title: 'validation-failed',
            status: 422,
            code: 'validation-failed',
            detail: 'another auto-accept rule of the project has this name',
            reason: 'name-taken',
          },
          422,
        ),
    });
    const t = testIo(env(), api.fetch);
    const args = ['--name', 'n', '--kind', 'relation', '--tier', 'key', '--min', '0.95'];
    expect(await runCli(['rules', 'add', '-p', 'p', ...args], t.io)).toBe(1);
    expect(t.err()).toContain('the server refused the rule (name-taken)');
  });
});

describe('proa rules edit, enable, disable', () => {
  it('merges the flags into the head and saves with If-Match', async () => {
    let put: { ifMatch: string | null; body: unknown } | undefined;
    const api = fakeApi({
      [`GET ${BASE}/auto-accept-rules/${RULE_ID}`]: () => json(rule({ relationType: 'call' })),
      [`PUT ${BASE}/auto-accept-rules/${RULE_ID}`]: async (req) => {
        put = { ifMatch: req.headers.get('if-match'), body: await req.json() };
        return json({ outcome: 'revised', rule: rule({ revision: 3, minConfidence: 0.97 }) });
      },
    });
    const t = testIo(env(), api.fetch);
    expect(
      await runCli(['rules', 'edit', RULE_ID, '-p', 'p', '--min', '0.97', '--type', 'any'], t.io),
    ).toBe(0);
    expect(put?.ifMatch).toBe('"r2"');
    expect(put?.body).toMatchObject({ minConfidence: 0.97, relationType: null, enabled: false });
    expect(t.out()).toContain('revised');
    expect(t.out()).toContain('earlier acceptances keep the revision that accepted them');
  });

  it('takes over a rule whose author is no longer an owner, also without a change', async () => {
    let body: unknown;
    const api = fakeApi({
      [`GET ${BASE}/auto-accept-rules/${RULE_ID}`]: () =>
        json(rule({ enabled: true, authorIsOwner: false })),
      [`PUT ${BASE}/auto-accept-rules/${RULE_ID}`]: async (req) => {
        body = await req.json();
        return json({ outcome: 'revised', rule: rule({ revision: 3, enabled: true }) });
      },
    });
    const t = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'edit', RULE_ID, '-p', 'p'], t.io)).toBe(0);
    expect(body).toMatchObject({ enabled: true, minConfidence: 0.95 });
    expect(t.out()).toContain(`taken over ${RULE_ID}`);
  });

  it('names the fields the schema refused (422 without a reason)', async () => {
    const api = fakeApi({
      [`GET ${BASE}/auto-accept-rules/${RULE_ID}`]: () => json(rule()),
      [`PUT ${BASE}/auto-accept-rules/${RULE_ID}`]: () =>
        json(
          {
            type: 'urn:proa:problem:validation-failed',
            title: 'validation-failed',
            status: 422,
            code: 'validation-failed',
            detail: 'request validation failed',
            errors: [{ path: 'json.note', message: 'must not contain control characters' }],
          },
          422,
        ),
    });
    const t = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'edit', RULE_ID, '-p', 'p', '--note', 'x'], t.io)).toBe(1);
    expect(t.err()).toContain(
      'the server refused the rule: note: must not contain control characters',
    );
  });

  it('reports a newer revision (412)', async () => {
    const api = fakeApi({
      [`GET ${BASE}/auto-accept-rules/${RULE_ID}`]: () => json(rule()),
      [`PUT ${BASE}/auto-accept-rules/${RULE_ID}`]: () =>
        json(
          {
            type: 'urn:proa:problem:revision-conflict',
            title: 'revision-conflict',
            status: 412,
            code: 'revision-conflict',
            headRev: 3,
          },
          412,
        ),
    });
    const t = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'edit', RULE_ID, '-p', 'p', '--min', '0.97'], t.io)).toBe(1);
    expect(t.err()).toContain(`auto-accept rule ${RULE_ID} was changed meanwhile (now r3)`);
  });

  it('enable reports the open matches; disable does not look', async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      [`GET ${BASE}/auto-accept-rules/${RULE_ID}`]: () => json(rule()),
      [`PUT ${BASE}/auto-accept-rules/${RULE_ID}`]: async (req) => {
        const body = (await req.json()) as { enabled: boolean };
        bodies.push(body);
        return json({ outcome: 'revised', rule: rule({ revision: 3, enabled: body.enabled }) });
      },
      [`POST ${BASE}/auto-accept-rules/${RULE_ID}/apply`]: (_req, url) => {
        expect(url.searchParams.get('dryRun')).toBe('true');
        return json(applyResult(true, 5));
      },
    });
    const on = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'enable', RULE_ID, '-p', 'p'], on.io)).toBe(0);
    expect(on.out()).toContain('enabled: ');
    expect(on.out()).toContain(
      `5 open proposals match the rule already; rules are never retroactive: run proa rules apply ${RULE_ID} -p p`,
    );
    const off = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'disable', RULE_ID, '-p', 'p'], off.io)).toBe(0);
    expect(off.out()).toContain('disabled: ');
    expect(bodies).toEqual([
      expect.objectContaining({ enabled: true }),
      expect.objectContaining({ enabled: false }),
    ]);
    expect(api.seen.filter((s) => s.path.endsWith('/apply'))).toHaveLength(1);
  });
});

describe('proa rules preview', () => {
  it('previews an unsaved rule from flags', async () => {
    let body: unknown;
    const api = fakeApi({
      [`POST ${BASE}/auto-accept-rules/preview`]: async (req) => {
        body = await req.json();
        return json(preview());
      },
    });
    const t = testIo(env(), api.fetch);
    expect(
      await runCli(
        [
          'rules',
          'preview',
          '-p',
          'p',
          '--kind',
          'placement',
          '--tier',
          'semantic',
          '--min',
          '80%',
        ],
        t.io,
      ),
    ).toBe(0);
    expect(body).toEqual({
      kind: 'placement',
      tier: 'semantic',
      minConfidence: 0.8,
      relationType: null,
      agentPrincipalId: null,
      llmModel: null,
      includeAdHoc: false,
    });
    expect(t.out()).toContain('preview: placement semantic ≥ 80%');
  });

  it('previews a saved rule changed by flags', async () => {
    let body: unknown;
    const api = fakeApi({
      [`GET ${BASE}/auto-accept-rules/${RULE_ID}`]: () => json(rule()),
      [`POST ${BASE}/auto-accept-rules/preview`]: async (req) => {
        body = await req.json();
        return json(preview());
      },
    });
    const t = testIo(env(), api.fetch);
    expect(
      await runCli(['rules', 'preview', RULE_ID, '-p', 'p', '--min', '0.9', '--json'], t.io),
    ).toBe(0);
    expect(body).toMatchObject({ kind: 'relation', tier: 'key', minConfidence: 0.9 });
    expect(JSON.parse(t.out())).toMatchObject({ history: { precision: 0.9 } });
  });
});

describe('proa rules apply and revoke', () => {
  function applyApi(
    count: number,
    real?: (body: unknown) => Response,
    head: { enabled?: boolean; authorIsOwner?: boolean } = {},
  ) {
    return fakeApi({
      [`POST ${BASE}/auto-accept-rules/${RULE_ID}/apply`]: async (req, url) => {
        if (url.searchParams.get('dryRun') === 'true') return json(applyResult(true, count, head));
        const body: unknown = await req.json();
        return real ? real(body) : json(applyResult(false, count));
      },
    });
  }

  it('prints the dry run and accepts nothing without --yes', async () => {
    const api = applyApi(2);
    const t = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'apply', RULE_ID, '-p', 'p'], t.io)).toBe(1);
    expect(t.out()).toContain(`dry run: rule ${RULE_ID} r2 would accept 2 open proposals in p`);
    expect(t.out()).toContain(
      '  relation message a/b#Send → c/d#Receive  (agent:claude, claude-opus-5-5, key, 0.97)',
    );
    expect(t.err()).toContain(
      `run proa rules apply ${RULE_ID} -p p --yes to accept the 2 proposals`,
    );
    expect(api.seen).toHaveLength(1);
    const dry = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'apply', RULE_ID, '-p', 'p', '--dry-run', '--yes'], dry.io)).toBe(
      0,
    );
    expect(api.seen).toHaveLength(2);
  });

  it('--yes applies with the revision and the dry run count', async () => {
    let real: unknown;
    const api = applyApi(2, (body) => {
      real = body;
      return json(applyResult(false, 2));
    });
    const t = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'apply', RULE_ID, '-p', 'p', '--yes'], t.io)).toBe(0);
    expect(real).toEqual({ revision: 2, expectedCount: 2 });
    expect(t.out()).toContain(`rule ${RULE_ID} r2 accepted 2 proposals in p`);
  });

  it('a rule that is off: the dry run says to enable it first, never to run --yes', async () => {
    const api = applyApi(3, undefined, { enabled: false });
    const t = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'apply', RULE_ID, '-p', 'p'], t.io)).toBe(1);
    expect(t.out()).toContain(`dry run: rule ${RULE_ID} r2 (off) would accept 3 open proposals`);
    expect(t.err()).toContain(
      `nothing accepted: the rule is off: enable it first with proa rules enable ${RULE_ID} -p p`,
    );
    expect(t.err()).not.toContain('--yes');
    // --yes changes nothing: only the two dry runs went out.
    const yes = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'apply', RULE_ID, '-p', 'p', '--yes'], yes.io)).toBe(1);
    expect(api.seen).toHaveLength(2);
  });

  it('a rule whose author is no longer an owner: says how to take it over', async () => {
    const t = testIo(env(), applyApi(2, undefined, { authorIsOwner: false }).fetch);
    expect(await runCli(['rules', 'apply', RULE_ID, '-p', 'p', '--yes'], t.io)).toBe(1);
    expect(t.err()).toContain(
      `nothing accepted: the rule’s author is no longer an owner, so it accepts nothing: take it over with proa rules edit ${RULE_ID} -p p`,
    );
    expect(t.err()).not.toContain('Run proa rules apply');
  });

  it('a rule switched off meanwhile (409 rule-disabled) is not worth running again', async () => {
    const api = applyApi(2, () =>
      json(
        {
          type: 'urn:proa:problem:conflict',
          title: 'conflict',
          status: 409,
          code: 'conflict',
          detail: 'the rule is disabled; enable it first',
          count: 2,
          revision: 2,
          reason: 'rule-disabled',
        },
        409,
      ),
    );
    const t = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'apply', RULE_ID, '-p', 'p', '--yes'], t.io)).toBe(1);
    expect(t.err()).toContain(
      `nothing changed: the rule is off: enable it first with proa rules enable ${RULE_ID} -p p`,
    );
    expect(t.err()).not.toContain('Run proa rules apply');
  });

  it('nothing to apply is no error', async () => {
    const t = testIo(env(), applyApi(0).fetch);
    expect(await runCli(['rules', 'apply', RULE_ID, '-p', 'p'], t.io)).toBe(0);
    expect(t.out()).toContain('would accept 0 open proposals');
  });

  it('reports a changed selection (409)', async () => {
    const api = applyApi(2, () =>
      json(
        {
          type: 'urn:proa:problem:conflict',
          title: 'conflict',
          status: 409,
          code: 'conflict',
          detail: 'the rule would accept 3 proposals now; preview it again',
          count: 3,
          revision: 2,
        },
        409,
      ),
    );
    const t = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'apply', RULE_ID, '-p', 'p', '--yes'], t.io)).toBe(1);
    expect(t.err()).toContain(
      `the rule would accept 3 proposals now; preview it again; nothing changed. Run proa rules apply ${RULE_ID} again`,
    );
  });

  it('revokes by agent name: the dry run, then --yes with expectedCount', async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      [`GET ${BASE}/agent-tokens`]: () => json({ items: TOKENS }),
      [`POST ${BASE}/auto-accept-revocations`]: async (req, url) => {
        bodies.push(await req.json());
        return json(revocation(url.searchParams.get('dryRun') === 'true', 1));
      },
    });
    const t = testIo(env(), api.fetch);
    expect(
      await runCli(
        ['rules', 'revoke', '-p', 'p', '--agent', 'claude', '--reason', 'Token geleakt', '--yes'],
        t.io,
      ),
    ).toBe(0);
    expect(bodies).toEqual([
      { agentPrincipalId: AGENT_PRN, reason: 'Token geleakt' },
      { agentPrincipalId: AGENT_PRN, reason: 'Token geleakt', expectedCount: 1 },
    ]);
    expect(t.out()).toContain('1 auto-acceptance revoked: 1 back to review, 0 obsolete');
    expect(t.out()).toContain('1 decided by a human since stay unchanged');
  });

  it('revoke needs a selection; --revision needs a rule; ids are split', async () => {
    const t = testIo(env(), fakeApi({}).fetch);
    expect(await runCli(['rules', 'revoke', '-p', 'p'], t.io)).toBe(1);
    expect(t.err()).toContain('name a rule id, --agent or --ids');
    const r = testIo(env(), fakeApi({}).fetch);
    expect(
      await runCli(['rules', 'revoke', '-p', 'p', '--ids', 'rel_x', '--revision', '2'], r.io),
    ).toBe(1);
    expect(r.err()).toContain('--revision needs a rule id');
    let body: unknown;
    const api = fakeApi({
      [`POST ${BASE}/auto-accept-revocations`]: async (req) => {
        body = await req.json();
        return json(revocation(true, 0));
      },
    });
    const ids = testIo(env(), api.fetch);
    expect(
      await runCli(
        [
          'rules',
          'revoke',
          RULE_ID,
          '-p',
          'p',
          '--revision',
          'r1',
          '--kind',
          'relation',
          '--ids',
          'rel_a,rel_b',
          'plc_c',
        ],
        ids.io,
      ),
    ).toBe(0);
    expect(body).toEqual({
      ruleId: RULE_ID,
      revision: 1,
      kind: 'relation',
      ids: ['rel_a', 'rel_b', 'plc_c'],
    });
    expect(ids.out()).toContain('dry run: 0 auto-acceptances would be revoked');
  });
});

describe('credentials', () => {
  it('refuses an agent token before any request', async () => {
    const api = fakeApi({});
    for (const argv of [
      ['rules', 'list', '-p', 'p'],
      ['rules', 'apply', RULE_ID, '-p', 'p', '--yes'],
      [
        'rules',
        'add',
        '-p',
        'p',
        '--name',
        'n',
        '--kind',
        'relation',
        '--tier',
        'key',
        '--min',
        '0.9',
      ],
    ]) {
      const t = testIo({ ...env(), PROA_TOKEN: AGENT_TOKEN }, api.fetch);
      expect(await runCli(argv, t.io)).toBe(1);
      expect(t.err()).toContain('auto-accept rules are owner-only and agents never see them');
    }
    expect(api.seen).toHaveLength(0);
  });

  it('reports a 403 of the server', async () => {
    const api = fakeApi({
      [`GET ${BASE}/auto-accept-rules`]: () => problem(403, 'forbidden', 'owners only'),
    });
    const t = testIo(env(), api.fetch);
    expect(await runCli(['rules', 'list', '-p', 'p'], t.io)).toBe(1);
    expect(t.err()).toContain('list auto-accept rules of p failed (403 forbidden): owners only');
  });
});
