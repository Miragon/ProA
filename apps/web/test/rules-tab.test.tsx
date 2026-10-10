import type { AutoAcceptRule } from '@proa/client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ApplyDialog } from '../src/components/rules/apply-dialog';
import { RevokeDialog } from '../src/components/rules/revoke-dialog';
import { RuleDialog } from '../src/components/rules/rule-dialog';
import { RuleTable } from '../src/components/rules/rule-table';
import { SystemRuleCard } from '../src/components/rules/system-rule-card';
import { agentToken, autoAcceptPreview, autoAcceptRule, ledgerEntry } from './support/fixtures';
import {
  findToast,
  json,
  renderWithQuery,
  renderWithRouter,
  stubApi,
  type Call,
} from './support/render';

const BASE = '/api/v1/projects/demo';
const RULE_ID = 'aar_01J9Z3N4X5Q6R7S8T9V0W1X2Y3';

function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return json({ type: `urn:proa:problem:${code}`, title: code, status, code, ...extra }, status);
}

const detail = (rule: AutoAcceptRule) => ({ ...rule, revisions: [] });

describe('RuleDialog', () => {
  function open(rule: AutoAcceptRule | null, routes: Record<string, (c: Call) => Response> = {}) {
    const calls = stubApi({
      [`POST ${BASE}/auto-accept-rules/preview`]: () => json(autoAcceptPreview()),
      ...routes,
    });
    const saved: AutoAcceptRule[] = [];
    renderWithQuery(
      <RuleDialog
        project="demo"
        rule={rule}
        tokens={[
          agentToken({ id: 'agt_01SIM', name: 'sim', principalId: 'prn_01SIM' }),
          agentToken({
            id: 'agt_01OLD',
            name: 'alt',
            principalId: 'prn_01OLD',
            revokedAt: '2026-10-01T00:00:00.000Z',
          }),
        ]}
        open
        onOpenChange={() => undefined}
        onSaved={(r) => saved.push(r)}
      />,
    );
    return { calls, saved, user: userEvent.setup() };
  }

  it('shows kind-specific fields and the live preview in German', async () => {
    const { calls, user } = open(null);
    const dialog = screen.getByTestId('rule-dialog');
    expect(within(dialog).getByRole('heading', { name: 'Neue Annahmeregel' })).toBeTruthy();
    // Relations: three tiers and a type.
    const tier = within(dialog).getByLabelText('Stufe');
    expect(
      within(tier)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Schlüssel', 'Ähnlich', 'Bedeutung']);
    expect(within(dialog).getByLabelText('Typ')).toBeTruthy();
    // Revoked tokens are marked.
    const agents = within(within(dialog).getByLabelText('Agent')).getAllByRole('option');
    expect(agents.map((o) => o.textContent)).toEqual(['Alle Agenten', 'sim', 'alt (widerrufen)']);
    // The debounced preview: the history with the precision, unreviewed items, open, blocked, curve.
    const preview = await screen.findByTestId('rule-preview');
    expect(within(preview).getByTestId('preview-history').textContent).toBe(
      'Bisher: 15 von 40 entschiedenen Agentenvorschlägen hätte die Regel angenommen – davon 14 angenommen, 1 abgelehnt, 0 korrigiert (Trefferquote 93,3 %).',
    );
    expect(within(preview).getByTestId('preview-unreviewed').textContent).toContain(
      'Automatisch angenommen, nicht geprüft: 2',
    );
    expect(within(preview).getByTestId('preview-open').textContent).toBe(
      'Jetzt offen: 3 würden angenommen',
    );
    expect(within(preview).getByText('Offene Frage eines Agenten')).toBeTruthy();
    const current = within(preview)
      .getAllByTestId('curve-row')
      .find((r) => r.dataset['current'] === 'true');
    expect(current?.textContent).toContain('95 %');
    expect(calls.find((c) => c.path.endsWith('/preview'))?.body).toEqual({
      kind: 'relation',
      tier: 'key',
      minConfidence: 0.95,
      relationType: null,
      agentPrincipalId: null,
      llmModel: null,
      includeAdHoc: false,
    });

    // Placements: two tiers, no type, the @outside hint.
    await user.selectOptions(within(dialog).getByLabelText('Art'), 'placement');
    expect(
      within(within(dialog).getByLabelText('Stufe'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Ähnlich', 'Bedeutung']);
    expect(within(dialog).queryByLabelText('Typ')).toBeNull();
    expect(within(dialog).getByText(/@outside wird nie automatisch angenommen/)).toBeTruthy();
    await waitFor(() =>
      expect(calls.filter((c) => c.path.endsWith('/preview')).at(-1)?.body).toMatchObject({
        kind: 'placement',
        tier: 'lexical',
      }),
    );
  });

  it('validates the name and a confidence of at least 50 %', async () => {
    const { calls, user } = open(null);
    const dialog = screen.getByTestId('rule-dialog');
    const min = within(dialog).getByLabelText('ab Konfidenz (%)');
    await user.clear(min);
    await user.type(min, '40');
    expect(within(dialog).getByText('Gib einen Wert zwischen 50 und 100 % an.')).toBeTruthy();
    await user.click(within(dialog).getByTestId('save-off'));
    expect(within(dialog).getByText('Gib der Regel einen Namen.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/auto-accept-rules'))).toBe(
      false,
    );
  });

  it('creates a rule, off or on', async () => {
    const { calls, saved, user } = open(null, {
      [`POST ${BASE}/auto-accept-rules`]: (c) =>
        json(
          {
            outcome: 'created',
            rule: detail(
              autoAcceptRule({ id: RULE_ID, enabled: (c.body as { enabled: boolean }).enabled }),
            ),
          },
          201,
        ),
    });
    const dialog = screen.getByTestId('rule-dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Schlüssel ab 95 %');
    await user.selectOptions(within(dialog).getByLabelText('Typ'), 'message');
    await user.selectOptions(within(dialog).getByLabelText('Agent'), 'prn_01SIM');
    await user.type(within(dialog).getByLabelText('LLM-Modell'), 'claude-sonnet-5-5');
    await user.click(within(dialog).getByLabelText('Auch Ad-hoc-Vorschläge'));
    await user.click(within(dialog).getByTestId('save-on'));
    await findToast('Regel „Schlüssel ab 95 %“ angelegt und aktiviert');
    expect(
      calls.find((c) => c.method === 'POST' && c.path.endsWith('/auto-accept-rules'))?.body,
    ).toEqual({
      kind: 'relation',
      tier: 'key',
      minConfidence: 0.95,
      relationType: 'message',
      agentPrincipalId: 'prn_01SIM',
      llmModel: 'claude-sonnet-5-5',
      includeAdHoc: true,
      name: 'Schlüssel ab 95 %',
      enabled: true,
      note: null,
    });
    expect(saved.map((r) => r.enabled)).toEqual([true]);
  });

  it('edits with If-Match; on 412 loads the newer revision into the form before saving on it', async () => {
    const rule = autoAcceptRule({ id: RULE_ID, revision: 2, enabled: true, minConfidence: 0.9 });
    // Another owner narrowed the rule to one agent and raised it to 97 % meanwhile.
    const newer = {
      ...rule,
      revision: 3,
      minConfidence: 0.97,
      agentPrincipalId: 'prn_01SIM',
      agent: {
        principalId: 'prn_01SIM',
        handle: 'agent:sim',
        tokenId: 'agt_01SIM',
        revoked: false,
      },
    };
    let attempts = 0;
    const { calls, user } = open(rule, {
      [`PUT ${BASE}/auto-accept-rules/${RULE_ID}`]: (c) => {
        attempts += 1;
        return attempts === 1
          ? problem(412, 'revision-conflict', { headRev: 3 })
          : json({
              outcome: 'revised',
              rule: detail({ ...newer, ...(c.body as object), revision: 4 }),
            });
      },
      [`GET ${BASE}/auto-accept-rules/${RULE_ID}`]: () => json(detail(newer)),
    });
    const dialog = screen.getByTestId('rule-dialog');
    expect(within(dialog).getByText(/Erzeugt eine neue Revision/)).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Art').disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Notiz (optional)'), 'nur die Notiz');
    await user.click(within(dialog).getByTestId('save-on'));
    expect(
      await within(dialog).findByText('Die Regel wurde inzwischen geändert (Revision 3)'),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Neuere Revision laden' }));
    // The form now shows revision 3, and the alert says what changed.
    const reloaded = await within(dialog).findByTestId('reloaded');
    expect(reloaded.textContent).toContain('Revision 3 geladen');
    expect(reloaded.textContent).toContain('ab Konfidenz: 90 % → 97 %');
    expect(reloaded.textContent).toContain('Agent: alle Agenten → agent:sim');
    expect(within(dialog).getByLabelText<HTMLInputElement>('ab Konfidenz (%)').value).toBe('97');
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Agent').value).toBe('prn_01SIM');
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>('Notiz (optional)').value).toBe('');
    await waitFor(() =>
      expect(within(dialog).getByTestId('save-on')).toHaveProperty('disabled', false),
    );
    await user.click(within(dialog).getByTestId('save-on'));
    await findToast('Regel „Schlüssel ab 95 %“ gespeichert (Revision 4)');
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.headers['if-match'])).toEqual(['"r2"', '"r3"']);
    expect(puts[0]?.body).toMatchObject({ minConfidence: 0.9, note: 'nur die Notiz' });
    expect(puts[1]?.body).toMatchObject({
      minConfidence: 0.97,
      agentPrincipalId: 'prn_01SIM',
      note: null,
      enabled: true,
    });
  });

  it('keeps a threshold finer than the field shows unless it is edited, and parses two decimals', async () => {
    const rule = autoAcceptRule({ id: RULE_ID, revision: 2, minConfidence: 0.92345 });
    const { calls, user } = open(rule, {
      [`PUT ${BASE}/auto-accept-rules/${RULE_ID}`]: (c) =>
        json({ outcome: 'revised', rule: detail({ ...rule, ...(c.body as object), revision: 3 }) }),
    });
    const dialog = screen.getByTestId('rule-dialog');
    const min = within(dialog).getByLabelText<HTMLInputElement>('ab Konfidenz (%)');
    expect(min.value).toBe('92,345');
    await user.type(within(dialog).getByLabelText('Notiz (optional)'), 'Notiz');
    await user.click(within(dialog).getByTestId('save-off'));
    await findToast('Regel „Schlüssel ab 95 %“ gespeichert (Revision 3)');
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ minConfidence: 0.92345 });
  });

  it('says that saving takes over a rule whose author is no longer an owner', () => {
    open(autoAcceptRule({ id: RULE_ID, authorIsOwner: false }));
    expect(screen.getByTestId('take-over-hint').textContent).toContain(
      'ist kein Inhaber mehr; bis jemand die Regel neu speichert, nimmt sie nichts an',
    );
  });

  it('names a refused rule in German', async () => {
    const { user } = open(null, {
      [`POST ${BASE}/auto-accept-rules`]: () =>
        problem(422, 'validation-failed', { reason: 'name-taken' }),
    });
    const dialog = screen.getByTestId('rule-dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Doppelt');
    await user.click(within(dialog).getByTestId('save-off'));
    expect(
      await within(dialog).findByText('Eine andere Annahmeregel dieses Projekts heißt schon so.'),
    ).toBeTruthy();
  });
});

describe('RuleTable and the system rule', () => {
  it('lists rules with their numbers, warns when the author is no owner, toggles with If-Match', async () => {
    const rules = [
      autoAcceptRule({
        id: RULE_ID,
        revision: 2,
        enabled: true,
        relationType: 'message',
        stats: { inForce: 5, confirmed: 2, revoked: 1, overruled: 1, lastAcceptedAt: null },
      }),
      autoAcceptRule({
        id: 'aar_01J9Z3N4X5Q6R7S8T9V0W1X2Y4',
        name: 'Platzierungen ab 90 %',
        kind: 'placement',
        tier: 'semantic',
        minConfidence: 0.9,
        authorIsOwner: false,
      }),
    ];
    let attempt = 0;
    const calls = stubApi({
      [`PUT ${BASE}/auto-accept-rules/${RULE_ID}`]: () => {
        attempt += 1;
        return attempt === 1
          ? json({
              outcome: 'revised',
              rule: detail({ ...rules[0]!, revision: 3, enabled: false }),
            })
          : problem(412, 'revision-conflict', { headRev: 4 });
      },
    });
    let reloaded = 0;
    await renderWithRouter(
      <RuleTable
        project="demo"
        rules={rules}
        onEdit={() => undefined}
        onPreview={() => undefined}
        onApply={() => undefined}
        onRevoke={() => undefined}
        onHistory={() => undefined}
        onReload={() => (reloaded += 1)}
      />,
    );
    const user = userEvent.setup();
    const rows = await screen.findAllByTestId('rule-row');
    expect(rows[0]?.textContent).toContain('Typ Nachricht');
    expect(rows[0]?.textContent).toContain('Aktiv');
    // In force (the link's filter shows exactly these), confirmed apart, overruled by name.
    expect(within(rows[0]!).getByTestId('rule-stats').textContent).toBe(
      '5 in Kraft2 bestätigt1 widerrufen1 abgelehnt, korrigiert oder vorgemerkt',
    );
    expect(
      within(within(rows[0]!).getByTestId('rule-stats')).getByRole('link', { name: '5 in Kraft' }),
    ).toBeTruthy();
    expect(rows[0]?.textContent).toContain('r2');
    expect(within(rows[1]!).getByTestId('author-not-owner').textContent).toContain(
      'Urheber ist kein Inhaber mehr',
    );
    expect(within(rows[1]!).getByTestId('rule-criteria').textContent).toBe(
      'Platzierungen · Bedeutung · ab 90 %',
    );

    await user.click(within(rows[0]!).getByTestId('rule-toggle'));
    await findToast('Regel „Schlüssel ab 95 %“ deaktiviert');
    expect(calls[0]).toMatchObject({ method: 'PUT', headers: { 'if-match': '"r2"' } });
    expect(calls[0]?.body).toMatchObject({ enabled: false, relationType: 'message' });

    await user.click(within(rows[0]!).getByTestId('rule-toggle'));
    expect(
      await screen.findByText('Die Regel „Schlüssel ab 95 %“ wurde inzwischen geändert'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Neuere Revision laden' }));
    expect(reloaded).toBe(1);
  });

  it('shows decision 9 read-only with its count', async () => {
    await renderWithRouter(
      <SystemRuleCard
        project="demo"
        system={{
          id: 'proa-rules/1.0.0',
          name: 'Eindeutige Aufrufe',
          description: '',
          kind: 'relation',
          relationType: 'call',
          readOnly: true,
          accepted: 9,
        }}
      />,
    );
    const card = await screen.findByTestId('system-rule');
    expect(card.textContent).toContain('Systemregel: Eindeutige Aufrufe');
    expect(card.textContent).toContain('immer aktiv, nicht änderbar');
    expect(within(card).getByTestId('system-rule-count').textContent).toBe(
      '9 Relationen angenommen',
    );
    expect(within(card).queryByRole('button')).toBeNull();
  });
});

describe('ApplyDialog and RevokeDialog', () => {
  const item = {
    kind: 'relation' as const,
    id: 'rel_01A',
    status: 'proposed' as const,
    endpointState: 'ok' as const,
    type: 'message' as const,
    from: 'a#Send',
    to: 'b#Receive',
    valueChainKey: null,
    step: null,
    process: null,
    triggerId: 'ast_01T',
    agent: { principalId: 'prn_01AGENT', handle: 'agent:claude code' },
    llmModel: 'm',
    tier: 'key' as const,
    confidence: 0.97,
  };
  const applyResult = (
    dryRun: boolean,
    count: number,
    head: { enabled?: boolean; authorIsOwner?: boolean } = {},
  ) => ({
    dryRun,
    ruleId: RULE_ID,
    revision: 2,
    enabled: head.enabled ?? true,
    authorIsOwner: head.authorIsOwner ?? true,
    count,
    items: Array.from({ length: count }, (_, i) => ({
      ...item,
      id: `rel_0${i}`,
      triggerId: `ast_0${i}`,
    })),
    truncated: false,
    blocked: [{ reason: 'human-involved', count: 4 }],
  });

  it('apply: dry run, then the head revision and expectedCount; a 409 reloads the dry run', async () => {
    let dryRuns = 0;
    let real = 0;
    const calls = stubApi({
      [`POST ${BASE}/auto-accept-rules/${RULE_ID}/apply`]: (c) => {
        if (c.search === '?dryRun=true') {
          dryRuns += 1;
          return json(applyResult(true, dryRuns === 1 ? 2 : 3));
        }
        real += 1;
        return real === 1
          ? problem(409, 'conflict', { count: 3, revision: 2 })
          : json(applyResult(false, 3));
      },
    });
    const rule = autoAcceptRule({ id: RULE_ID, revision: 2, enabled: true });
    renderWithQuery(<ApplyDialog project="demo" rule={rule} open onOpenChange={() => undefined} />);
    const user = userEvent.setup();
    const dialog = screen.getByTestId('apply-dialog');
    expect((await within(dialog).findByTestId('apply-summary')).textContent).toBe(
      '2 offene Vorschläge erfüllen die Regel.',
    );
    expect(within(dialog).getAllByTestId('apply-item')[0]?.textContent).toContain(
      'agent:claude code mit 0,97',
    );
    expect(within(dialog).getByText('Ein Mensch war schon beteiligt')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: '2 Vorschläge annehmen' }));
    expect(
      await within(dialog).findByText('Die offenen Vorschläge haben sich geändert'),
    ).toBeTruthy();
    await user.click(await within(dialog).findByRole('button', { name: '3 Vorschläge annehmen' }));
    await findToast('3 Vorschläge automatisch angenommen');
    expect(calls.filter((c) => c.search === '').map((c) => c.body)).toEqual([
      { revision: 2, expectedCount: 2 },
      { revision: 2, expectedCount: 3 },
    ]);
  });

  it('apply: a disabled rule accepts nothing', async () => {
    stubApi({
      [`POST ${BASE}/auto-accept-rules/${RULE_ID}/apply`]: () =>
        json(applyResult(true, 2, { enabled: false })),
    });
    renderWithQuery(
      <ApplyDialog
        project="demo"
        rule={autoAcceptRule({ id: RULE_ID })}
        open
        onOpenChange={() => undefined}
      />,
    );
    const dialog = screen.getByTestId('apply-dialog');
    await within(dialog).findByTestId('apply-summary');
    expect(within(dialog).getByText(/Die Regel ist aus/)).toBeTruthy();
    expect(within(dialog).getByTestId('apply-confirm')).toHaveProperty('disabled', true);
  });

  it('apply: the dry run tells when the author is no longer an owner (the row may be older)', async () => {
    stubApi({
      [`POST ${BASE}/auto-accept-rules/${RULE_ID}/apply`]: () =>
        json(applyResult(true, 2, { authorIsOwner: false })),
    });
    renderWithQuery(
      <ApplyDialog
        project="demo"
        rule={autoAcceptRule({ id: RULE_ID, enabled: true })}
        open
        onOpenChange={() => undefined}
      />,
    );
    const dialog = screen.getByTestId('apply-dialog');
    await within(dialog).findByTestId('apply-summary');
    expect(
      within(dialog).getByText(
        /Der Urheber der Regel ist kein Inhaber mehr\. Speichere die Regel neu/,
      ),
    ).toBeTruthy();
    expect(within(dialog).getByTestId('apply-confirm')).toHaveProperty('disabled', true);
  });

  it('revoke: dry run summary, reason, then expectedCount', async () => {
    const result = (dryRun: boolean) => ({
      dryRun,
      count: 2,
      toProposed: 1,
      toObsolete: 1,
      humanDecidedSince: 1,
      alreadyRevoked: 0,
      items: [
        { ...ledgerEntry({ id: 'rel_01A' }), outcome: 'proposed' },
        { ...ledgerEntry({ id: 'rel_01B', decisionId: 'ast_01B' }), outcome: 'obsolete' },
      ],
      truncated: false,
    });
    const calls = stubApi({
      [`POST ${BASE}/auto-accept-revocations`]: (c) => json(result(c.search === '?dryRun=true')),
    });
    let closed = false;
    renderWithQuery(
      <RevokeDialog
        project="demo"
        open
        onOpenChange={(o) => (closed = !o)}
        selection={{ ruleId: RULE_ID }}
        title="Annahmen der Regel „Schlüssel ab 95 %“ widerrufen"
      />,
    );
    const user = userEvent.setup();
    const dialog = screen.getByTestId('revoke-dialog');
    expect((await within(dialog).findByTestId('revoke-summary')).textContent).toBe(
      '2 automatische Annahmen: 1 geht zurück in die Prüfung (ein Agentenvorschlag ist noch offen); 1 wird veraltet und von den Agenten neu beurteilt (kein offener Vorschlag mehr). 1 wurde inzwischen von einem Menschen entschieden und bleibt unverändert.',
    );
    expect(within(dialog).getAllByTestId('revoke-item')[1]?.textContent).toContain('wird veraltet');
    await user.type(within(dialog).getByLabelText('Grund (optional)'), 'Stichprobe falsch');
    await user.click(within(dialog).getByRole('button', { name: '2 widerrufen' }));
    await findToast('2 automatische Annahmen widerrufen');
    // (The project refresh after the write may run the still mounted dry run once more.)
    expect(calls.slice(0, 2).map((c) => [c.search, c.body])).toEqual([
      ['?dryRun=true', { ruleId: RULE_ID }],
      ['', { ruleId: RULE_ID, expectedCount: 2, reason: 'Stichprobe falsch' }],
    ]);
    expect(closed).toBe(true);
  });
});
