import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ConnectAgent } from '../src/components/connect-agent';
import { AgentRevoke } from '../src/components/rules/agent-revoke';
import { RelationsView } from '../src/components/relation-table';
import { QueueTable } from '../src/components/review/queue-table';
import { AssertionTimeline } from '../src/components/review/timeline';
import { AutoAcceptProvenance } from '../src/components/rules/auto-accept-provenance';
import { PlacementCard } from '../src/components/value-chain/placement-card';
import { indexLedger } from '../src/lib/auto-accept';
import { useAutoAcceptIndex } from '../src/lib/auto-accept-actions';
import type { RelationFilters } from '../src/lib/relation-filters';
import {
  agentToken,
  assertion,
  ledgerEntry,
  placement,
  relation,
  sampleRelations,
  sampleResolver,
} from './support/fixtures';
import { findToast, json, renderWithQuery, renderWithRouter, stubApi } from './support/render';

const RULE_ID = 'aar_01J9Z3N4X5Q6R7S8T9V0W1X2Y3';
const MESSAGE = sampleRelations[1]!;
const SIGNAL = sampleRelations[0]!;

const projectInfo = (role: 'owner' | 'editor' | 'viewer') => () =>
  json({
    id: 'prj_01DEMO',
    key: 'demo',
    name: 'Demo',
    role,
    lastSeq: 1,
    createdAt: '2026-10-07T09:00:00.000Z',
  });

const index = indexLedger([
  ledgerEntry({ id: MESSAGE.id, decisionId: 'ast_01AUTO' }),
  ledgerEntry({
    id: SIGNAL.id,
    decisionId: 'ast_01OLD',
    state: 'revoked',
    revocationId: 'ast_01REVOKE',
  }),
  ledgerEntry({ id: 'plc_01AUTO', kind: 'placement', decisionId: 'pas_01AUTO' }),
]);

describe('marks in the relation views', () => {
  it('Relations tab: the mark, the preset and the rule filter (reviewers)', async () => {
    const relations = sampleRelations.map((r) =>
      r.id === MESSAGE.id ? { ...r, status: 'accepted' as const } : r,
    );
    let filters: RelationFilters = {};
    const { rerender } = await renderWithRouter(
      <RelationsView
        relations={relations}
        resolve={sampleResolver}
        modelKeys={[]}
        filters={filters}
        onFiltersChange={(next) => (filters = next)}
        autoIndex={index}
        autoRules={[{ id: RULE_ID, name: 'Schlüssel ab 95 %' }]}
      />,
    );
    const row = (await screen.findAllByTestId('relation-row')).find(
      (r) => r.dataset['relationId'] === MESSAGE.id,
    );
    expect(within(row!).getByTestId('auto-accept-mark').textContent).toBe(
      'Automatisch angenommen – Regel „Schlüssel ab 95 %“',
    );
    const preset = screen.getByRole('button', { name: /Automatisch angenommen 1/ });
    await userEvent.setup().click(preset);
    expect(filters).toEqual({ auto: 'any' });
    const select = screen.getByLabelText('Annahmeregel');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'Alle Relationen',
      'Automatisch angenommen (alle Regeln)',
      'Regel „Schlüssel ab 95 %“',
    ]);
    // Filtered by the rule: only the auto-accepted relation is left.
    rerender(
      <RelationsView
        relations={relations}
        resolve={sampleResolver}
        modelKeys={[]}
        filters={{ auto: RULE_ID }}
        onFiltersChange={() => undefined}
        autoIndex={index}
        autoRules={[{ id: RULE_ID, name: 'Schlüssel ab 95 %' }]}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('relation-row').map((r) => r.dataset['relationId'])).toEqual([
        MESSAGE.id,
      ]),
    );
  });

  it('without the ledger (a viewer) there is no preset and no rule filter', async () => {
    await renderWithRouter(
      <RelationsView
        relations={sampleRelations}
        resolve={sampleResolver}
        modelKeys={[]}
        filters={{}}
        onFiltersChange={() => undefined}
      />,
    );
    await screen.findAllByTestId('relation-row');
    expect(screen.queryByRole('button', { name: /Automatisch angenommen/ })).toBeNull();
    expect(screen.queryByLabelText('Annahmeregel')).toBeNull();
    expect(screen.queryByTestId('auto-accept-mark')).toBeNull();
  });

  it('queue rows of revoked acceptances say „widerrufen“', async () => {
    await renderWithRouter(
      <QueueTable
        project="demo"
        items={[
          { relation: SIGNAL, finishes: 0 },
          { relation: relation({ id: 'rel_01OTHER', from: 'a#x', to: 'b#y' }), finishes: 0 },
        ]}
        resolve={sampleResolver}
        filters={{}}
        revoked={index.revoked}
      />,
    );
    const rows = await screen.findAllByTestId('queue-row');
    expect(within(rows[0]!).getByTestId('queue-revoked').textContent).toBe('widerrufen');
    expect(within(rows[1]!).queryByTestId('queue-revoked')).toBeNull();
  });

  it('the timeline names the rule of the decision and of its revocation', () => {
    renderWithQuery(
      <AssertionTimeline
        assertions={[
          assertion({ id: 'ast_01P', tier: 'key', confidence: 0.97 }),
          assertion({
            id: 'ast_01OLD',
            kind: 'decision',
            verdict: 'accept',
            sourceKind: 'human',
            handle: 'owner',
            tier: null,
            confidence: null,
          }),
          assertion({
            id: 'ast_01REVOKE',
            kind: 'withdrawal',
            sourceKind: 'human',
            handle: 'owner',
            tier: null,
            confidence: null,
            rationale: 'Automatische Annahme widerrufen: Stichprobe',
          }),
        ]}
        marks={index.byAssertion}
      />,
    );
    const entries = screen.getAllByTestId('timeline-entry');
    expect(entries[1]?.dataset['auto']).toBe('decision');
    expect(entries[1]?.textContent).toContain('Automatisch angenommen');
    expect(within(entries[1]!).getByTestId('timeline-rule').textContent).toBe(
      'Regel „Schlüssel ab 95 %“ (Revision 2)',
    );
    expect(entries[2]?.textContent).toContain('Automatische Annahme widerrufen');
    expect(entries[0]?.dataset['auto']).toBeUndefined();
  });
});

describe('who sees the marks', () => {
  function Marks() {
    const autoIndex = useAutoAcceptIndex('demo');
    return <p data-testid="marks">{autoIndex.inForce.size}</p>;
  }

  it.each(['owner', 'editor'] as const)(
    'every reviewer reads the ledger (%s), so machine acceptances are marked for them',
    async (role) => {
      const calls = stubApi({
        'GET /api/v1/projects/demo': projectInfo(role),
        'GET /api/v1/projects/demo/auto-accepted': () =>
          json({ items: [ledgerEntry({ id: MESSAGE.id })] }),
      });
      renderWithQuery(<Marks />);
      await waitFor(() => expect(screen.getByTestId('marks').textContent).toBe('1'));
      expect(calls.some((c) => c.path.endsWith('/auto-accepted'))).toBe(true);
    },
  );

  it('a viewer does not ask for it', async () => {
    const calls = stubApi({ 'GET /api/v1/projects/demo': projectInfo('viewer') });
    renderWithQuery(<Marks />);
    await waitFor(() => expect(calls.some((c) => c.path === '/api/v1/projects/demo')).toBe(true));
    expect(screen.getByTestId('marks').textContent).toBe('0');
    expect(calls.some((c) => c.path.endsWith('/auto-accepted'))).toBe(false);
  });
});

describe('provenance and single-item revoke', () => {
  it('shows rule, revision, author, agent and confidence; revokes by id after a dry run', async () => {
    const calls = stubApi({
      'POST /api/v1/projects/demo/auto-accept-revocations': (c) =>
        json({
          dryRun: c.search === '?dryRun=true',
          count: 1,
          toProposed: 1,
          toObsolete: 0,
          humanDecidedSince: 0,
          alreadyRevoked: 0,
          items: [{ ...ledgerEntry({ id: MESSAGE.id }), outcome: 'proposed' }],
          truncated: false,
        }),
    });
    renderWithQuery(
      <AutoAcceptProvenance
        project="demo"
        entries={index.bySubject.get(MESSAGE.id) ?? []}
        canRevoke
      />,
    );
    const box = screen.getByTestId('auto-accept-provenance');
    expect(box.textContent).toContain('Automatisch angenommen – Regel „Schlüssel ab 95 %“');
    expect(box.textContent).toContain(
      'Entschieden durch Regel „Schlüssel ab 95 %“ (Revision 2), aktiviert von owner; ausgelöst von agent:claude code mit 0,97 (Schlüssel)',
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId('revoke-one'));
    const dialog = await screen.findByTestId('revoke-dialog');
    await user.click(await within(dialog).findByRole('button', { name: '1 widerrufen' }));
    await findToast('Automatische Annahme widerrufen');
    expect(calls.slice(0, 2).map((c) => c.body)).toEqual([
      { ids: [MESSAGE.id] },
      { ids: [MESSAGE.id], expectedCount: 1 },
    ]);
  });

  it('a revoked acceptance shows what became of it, without a revoke', () => {
    renderWithQuery(
      <AutoAcceptProvenance
        project="demo"
        entries={index.bySubject.get(SIGNAL.id) ?? []}
        canRevoke
      />,
    );
    const box = screen.getByTestId('auto-accept-provenance');
    expect(box.dataset['state']).toBe('revoked');
    expect(box.textContent).toContain(
      'Automatische Annahme widerrufen – Regel „Schlüssel ab 95 %“',
    );
    expect(screen.queryByTestId('revoke-one')).toBeNull();
  });

  it('a revoked acceptance with a live proposal is back in review', () => {
    renderWithQuery(
      <AutoAcceptProvenance
        project="demo"
        entries={[
          ledgerEntry({
            id: SIGNAL.id,
            status: 'proposed',
            state: 'revoked',
            revocationId: 'ast_01REVOKE',
            revokedAt: '2026-10-10T09:00:00.000Z',
          }),
        ]}
        canRevoke
      />,
    );
    expect(screen.getByTestId('auto-accept-provenance').textContent).toContain(
      'die Relation steht wieder zur Prüfung.',
    );
  });

  it('a revoked acceptance without a live proposal is obsolete, not back in review', () => {
    renderWithQuery(
      <AutoAcceptProvenance
        project="demo"
        entries={[
          ledgerEntry({
            id: SIGNAL.id,
            status: 'obsolete',
            state: 'revoked',
            revocationId: 'ast_01REVOKE',
            revokedAt: '2026-10-10T09:00:00.000Z',
          }),
        ]}
        canRevoke
      />,
    );
    const box = screen.getByTestId('auto-accept-provenance');
    expect(box.textContent).toContain(
      'kein Agentenvorschlag war mehr offen: die Relation ist veraltet, die Agenten beurteilen sie neu.',
    );
    expect(box.textContent).not.toContain('wieder zur Prüfung');
  });
});

describe('the chain page card', () => {
  it('marks a placement an auto-accept rule accepted', async () => {
    stubApi({});
    await renderWithRouter(
      <PlacementCard
        project="demo"
        placement={placement({
          id: 'plc_01AUTO',
          elementId: 'step-a',
          process: 'm/a#P_A',
          status: 'accepted',
        })}
        modelKeys={new Set()}
        stepOptions={[]}
        active={false}
        canReview
        shortcuts={false}
        onActivate={() => undefined}
        onSelectStep={() => undefined}
        onDecided={() => undefined}
        onReload={() => undefined}
        autoIndex={index}
      />,
    );
    const card = await screen.findByTestId('placement-card');
    expect(card.dataset['auto']).toBe('true');
    expect(within(card).getByTestId('auto-accept-mark').textContent).toBe(
      'Automatisch angenommen – Regel „Schlüssel ab 95 %“',
    );
  });

  it.each([
    ['owner', true],
    ['editor', false],
  ] as const)(
    'shows the provenance to a %s, the single-item revoke only to owners',
    async (role, revoke) => {
      stubApi({ 'GET /api/v1/projects/demo': projectInfo(role) });
      await renderWithRouter(
        <PlacementCard
          project="demo"
          placement={placement({
            id: 'plc_01AUTO',
            elementId: 'step-a',
            process: 'm/a#P_A',
            status: 'accepted',
          })}
          modelKeys={new Set()}
          stepOptions={[]}
          active={false}
          canReview
          shortcuts={false}
          onActivate={() => undefined}
          onSelectStep={() => undefined}
          onDecided={() => undefined}
          onReload={() => undefined}
          autoIndex={index}
        />,
      );
      const card = await screen.findByTestId('placement-card');
      await userEvent.setup().click(within(card).getByText('Herkunft'));
      expect(within(card).getByTestId('auto-accept-provenance')).toBeTruthy();
      if (revoke) expect(await within(card).findByTestId('revoke-one')).toBeTruthy();
      else {
        await waitFor(() => expect(within(card).queryByTestId('revoke-one')).toBeNull());
      }
    },
  );
});

describe('rules tab: revoke by agent', () => {
  it('lists the agents with acceptances in force and revokes one agent’s after a dry run', async () => {
    const calls = stubApi({
      'POST /api/v1/projects/demo/auto-accept-revocations': (c) =>
        json({
          dryRun: c.search === '?dryRun=true',
          count: 2,
          toProposed: 0,
          toObsolete: 2,
          humanDecidedSince: 0,
          alreadyRevoked: 0,
          items: [],
          truncated: false,
        }),
    });
    renderWithQuery(<AgentRevoke project="demo" index={index} />);
    const section = screen.getByTestId('agent-revoke');
    expect(
      within(within(section).getByLabelText('Agent'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['agent:claude code (2 in Kraft)']);
    const user = userEvent.setup();
    await user.click(within(section).getByTestId('agent-revoke-open'));
    const dialog = await screen.findByTestId('revoke-dialog');
    expect(within(dialog).getByTestId('revoke-summary').textContent).toBe(
      '2 automatische Annahmen: 2 werden veraltet und von den Agenten neu beurteilt (kein offener Vorschlag mehr).',
    );
    await user.click(within(dialog).getByRole('button', { name: '2 widerrufen' }));
    await findToast('2 automatische Annahmen widerrufen');
    // The dry run, then the revocation with its count (a refetched dry run may follow).
    expect(calls.slice(0, 2).map((c) => [c.search, c.body])).toEqual([
      ['?dryRun=true', { agentPrincipalId: 'prn_01AGENT' }],
      ['', { agentPrincipalId: 'prn_01AGENT', expectedCount: 2 }],
    ]);
  });

  it('shows nothing without acceptances in force', () => {
    renderWithQuery(<AgentRevoke project="demo" index={indexLedger([])} />);
    expect(screen.queryByTestId('agent-revoke')).toBeNull();
  });
});

describe('agents page: token revoke', () => {
  it('offers to revoke the agent’s auto-acceptances after revoking the token', async () => {
    const token = agentToken({ id: 'agt_01OLD', name: 'claude', principalId: 'prn_01AGENT' });
    const calls = stubApi({
      'GET /api/v1/projects/demo/agent-tokens': () => json({ items: [token] }),
      'DELETE /api/v1/projects/demo/agent-tokens/agt_01OLD': () =>
        new Response(null, { status: 204 }),
      'POST /api/v1/projects/demo/auto-accept-revocations': (c) =>
        json({
          dryRun: c.search === '?dryRun=true',
          count: 2,
          toProposed: 2,
          toObsolete: 0,
          humanDecidedSince: 0,
          alreadyRevoked: 0,
          items: [],
          truncated: false,
        }),
    });
    renderWithQuery(
      <ConnectAgent project="demo" origin="http://127.0.0.1:7400" autoIndex={index} />,
    );
    const user = userEvent.setup();
    const table = await screen.findByRole('table', { name: 'Agent-Tokens' });
    await user.click(within(table).getByRole('button', { name: 'Widerrufen' }));
    const dialog = await screen.findByRole('alertdialog');
    const option = within(dialog).getByTestId('revoke-auto-option');
    // Two acceptances in force came from this agent (the placement and the message).
    expect(option.textContent).toContain(
      '2 automatisch angenommene Vorschläge stammen von diesem Agenten',
    );
    await user.click(within(option).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Widerrufen' }));
    await findToast('2 automatische Annahmen widerrufen');
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => [c.method, c.search, c.body])).toEqual([
      ['DELETE', '', undefined],
      ['POST', '?dryRun=true', { agentPrincipalId: 'prn_01AGENT' }],
      [
        'POST',
        '',
        { agentPrincipalId: 'prn_01AGENT', expectedCount: 2, reason: 'Token „claude“ widerrufen' },
      ],
    ]);
  });
});
