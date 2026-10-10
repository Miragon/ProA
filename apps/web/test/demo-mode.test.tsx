/**
 * The read-only demo in the web UI (issue #3): the banner while `/health`
 * reports `demo: "readonly"`, and no write action for a viewer, which every
 * demo session is: no project creation, no upload, agent or rules tab, read-
 * only notices on their direct URLs without a request, no bulk accept,
 * requeue or answer field in the inbox, no decision panel (and no A/R/H/C) on
 * the review screen. Outside the demo the same gates follow the role (an
 * editor uploads, only owners connect agents and see rules). Every role reads
 * the agents' no-links in the inbox tab „Kein Zusammenhang“.
 */
import type {
  Health,
  Landscape,
  Model,
  NoLink,
  Project,
  Relation,
  ValueChainDetail,
} from '@proa/client';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { App } from '../src/app';
import { ApiError, DEMO_READONLY_MESSAGE, errorMessage } from '../src/lib/api';
import {
  analysesQuery,
  assertionsQuery,
  contentQuery,
  factsQuery,
  healthQuery,
  landscapeQuery,
  modelsQuery,
  noLinksQuery,
  projectQuery,
  projectsQuery,
  relationQuery,
  valueChainQuery,
} from '../src/lib/queries';
import { createAppRouter } from '../src/router';
import { chainDetail, model, placement, provenance, relation } from './support/fixtures';
import { stubApi, type Call } from './support/render';

const DEMO_HEALTH: Health = { status: 'ok', version: '2.0.0-test', db: 'ok', demo: 'readonly' };
const LOCAL_HEALTH: Health = { status: 'ok', version: '2.0.0-test', db: 'ok' };

function project(role: Project['role']): Project {
  return {
    id: 'prj_01DEMO',
    key: 'demo',
    name: 'Demo',
    role,
    lastSeq: 7,
    createdAt: '2026-10-07T09:00:00.000Z',
  };
}

const models: Model[] = [
  model({ key: 'a/held', stage: 'waiting_for_clarification', openItems: 1 }),
  model({ key: 'b/failed', stage: 'agent_failed', openItems: 0 }),
  model({ key: 'c/review', stage: 'waiting_for_review', openItems: 1 }),
];
const proposal = relation({
  id: 'rel_01PROPOSED',
  from: 'c/review#S',
  to: 'a/held#C',
  provenance: provenance(),
});
const held = relation({
  id: 'rel_01HELD',
  from: 'a/held#S',
  to: 'c/review#C',
  status: 'held',
  tier: 'semantic',
  provenance: provenance({ kind: 'decision', verdict: 'hold', rationale: 'Fachbereich fragen' }),
});
const relations: Relation[] = [proposal, held];

/** Agents' no-links on pairs without a relation, oldest first. */
const noLinks: NoLink[] = [
  {
    id: 'nlk_01FIRST',
    type: 'message',
    from: 'a/held#Throw',
    to: 'b/failed#Catch',
    handle: 'agent:proa-agent-sim',
    origin: 'a/held',
    reason: 'no-evidence: Die Namen ähneln sich nur zufällig.',
    at: '2026-10-07T09:00:00.000Z',
  },
  {
    id: 'nlk_01SECOND',
    type: 'trigger',
    from: 'b/failed#End',
    to: 'c/review#Start',
    handle: 'agent:proa-agent-sim',
    origin: 'c/review',
    reason: 'near-miss: Ein anderes Ende.',
    at: '2026-10-07T09:01:00.000Z',
  },
];

function setup(
  path: string,
  {
    health,
    role,
    modelList = models,
    relationList = relations,
    chain,
  }: {
    health: Health;
    role: Project['role'];
    modelList?: Model[];
    relationList?: Relation[];
    chain?: ValueChainDetail;
  },
): { calls: Call[]; user: ReturnType<typeof userEvent.setup> } {
  const calls = stubApi({});
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(healthQuery.queryKey, health);
  queryClient.setQueryData(projectsQuery.queryKey, [project(role)]);
  queryClient.setQueryData(projectQuery('demo').queryKey, project(role));
  const landscape: Landscape = {
    projectId: 'prj_01DEMO',
    seq: 7,
    models: [],
    relations: relationList,
    findings: [],
  };
  queryClient.setQueryData(landscapeQuery('demo').queryKey, landscape);
  queryClient.setQueryData(modelsQuery('demo').queryKey, modelList);
  queryClient.setQueryData(noLinksQuery('demo').queryKey, noLinks);
  queryClient.setQueryData(analysesQuery('demo', 'failed').queryKey, []);
  queryClient.setQueryData(analysesQuery('demo', 'queued').queryKey, []);
  if (chain) queryClient.setQueryData(valueChainQuery('demo').queryKey, chain);
  for (const r of relationList) {
    queryClient.setQueryData(relationQuery('demo', r.id).queryKey, r);
    queryClient.setQueryData(assertionsQuery('demo', r.id).queryKey, []);
  }
  for (const m of modelList) {
    const ref = { project: 'demo', modelId: m.id, revisionId: m.headRevisionId ?? '' };
    queryClient.setQueryData(factsQuery(ref).queryKey, {
      modelKey: m.key,
      revisionId: m.headRevisionId,
      factsVersion: '1',
      processes: [],
      facts: [],
      messageFlows: [],
    });
    queryClient.setQueryData(contentQuery(ref).queryKey, { xml: `<xml model="${m.key}"/>` });
  }
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<App queryClient={queryClient} router={router} />);
  return { calls, user: userEvent.setup() };
}

/** Calls that would change something (the session aside). */
const writes = (calls: readonly Call[]) =>
  calls.filter((c) => c.method !== 'GET' && c.path !== '/api/v1/session');

describe('the demo banner', () => {
  it('shows on a demo with the repository link and marks the document', async () => {
    setup('/', { health: DEMO_HEALTH, role: 'viewer' });
    const banner = await screen.findByTestId('demo-banner');
    expect(banner.textContent).toContain('Demo – nur lesen.');
    expect(banner.textContent).toContain('Du kannst dir alles ansehen, aber nichts ändern.');
    expect(banner.textContent).not.toMatch(/Nacht|nightly|zurückgesetzt/);
    const link = within(banner).getByRole('link', { name: /ProA auf GitHub/ });
    expect(link.getAttribute('href')).toBe('https://github.com/Miragon/ProA');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    await waitFor(() => expect(document.documentElement.dataset['proaDemo']).toBe('readonly'));
  });

  it('is absent outside the demo, and the document is not marked', async () => {
    setup('/', { health: LOCAL_HEALTH, role: 'owner' });
    await screen.findByText('Projekte', { selector: 'h1' });
    expect(screen.queryByTestId('demo-banner')).toBeNull();
    expect(document.documentElement.dataset['proaDemo']).toBeUndefined();
  });
});

describe('the projects page', () => {
  it('offers no new project and no seed command on the demo; the role says „Leser“', async () => {
    setup('/', { health: DEMO_HEALTH, role: 'viewer' });
    const row = await screen.findByTestId('project-row');
    expect(row.textContent).toContain('Leser');
    expect(screen.queryByRole('button', { name: /Neues Projekt/ })).toBeNull();
    expect(screen.queryByText(/Testlandschaften laden/)).toBeNull();
  });

  it('offers both in local mode', async () => {
    setup('/', { health: LOCAL_HEALTH, role: 'owner' });
    expect(await screen.findByRole('button', { name: /Neues Projekt/ })).toBeDefined();
    expect(screen.getByText(/Testlandschaften laden/)).toBeDefined();
  });
});

describe('project tabs and write pages', () => {
  it('shows a viewer no upload, agent or rules tab', async () => {
    setup('/projects/demo', { health: DEMO_HEALTH, role: 'viewer' });
    const nav = await screen.findByRole('navigation', { name: 'Projektbereiche' });
    const tabs = within(nav)
      .getAllByRole('link')
      .map((l) => l.textContent.replace(/\d+.*/, '').trim());
    expect(tabs).toEqual(['Modelle', 'Prüfen', 'Wertschöpfungskette', 'Relationen', 'Befunde']);
  });

  it('shows an owner every tab outside the demo', async () => {
    setup('/projects/demo', { health: LOCAL_HEALTH, role: 'owner' });
    const nav = await screen.findByRole('navigation', { name: 'Projektbereiche' });
    for (const name of ['Hochladen', 'Agent verbinden', 'Regeln']) {
      expect(within(nav).getByRole('link', { name })).toBeDefined();
    }
  });

  it('shows an editor the upload tab, but neither agents nor rules', async () => {
    setup('/projects/demo', { health: LOCAL_HEALTH, role: 'editor' });
    const nav = await screen.findByRole('navigation', { name: 'Projektbereiche' });
    const tabs = within(nav)
      .getAllByRole('link')
      .map((l) => l.textContent.replace(/\d+.*/, '').trim());
    expect(tabs).toEqual([
      'Modelle',
      'Prüfen',
      'Wertschöpfungskette',
      'Relationen',
      'Befunde',
      'Hochladen',
    ]);
  });

  it.each([
    ['/projects/demo/agents', 'Agent-Tokens erstellen und widerrufen nur die Inhaber'],
    ['/projects/demo/rules', 'Annahmeregeln sehen und pflegen nur die Inhaber'],
  ])('answers %s for an editor with the owner-only notice and no request', async (path, text) => {
    const { calls } = setup(path, { health: LOCAL_HEALTH, role: 'editor' });
    const notice = await screen.findByTestId('read-only-notice');
    expect(notice.textContent).toContain(text);
    expect(within(notice).queryByRole('link', { name: 'ProA auf GitHub' })).toBeNull();
    // Tokens and rules are the owners'; the ledger of auto-acceptances is every reviewer's.
    expect(calls.filter((c) => /agent-tokens|auto-accept-rules/.test(c.path))).toEqual([]);
    expect(writes(calls)).toEqual([]);
  });

  it.each([
    ['viewer', DEMO_HEALTH, [], 'Dieses Projekt hat noch keine Modelle.'],
    ['viewer', LOCAL_HEALTH, [], 'Dieses Projekt hat noch keine Modelle.'],
    ['editor', LOCAL_HEALTH, ['Modelle hochladen'], 'Lade BPMN-Dateien hoch.'],
    ['owner', LOCAL_HEALTH, ['Modelle hochladen', 'Agent verbinden'], 'Lade BPMN-Dateien hoch.'],
  ] as const)(
    'offers an empty project’s %s (%o) only the actions of the role',
    async (role, health, actions, text) => {
      setup('/projects/demo', { health, role, modelList: [], relationList: [] });
      const empty = (await screen.findByText('Noch keine Modelle')).closest('[data-slot="empty"]');
      if (!(empty instanceof HTMLElement)) throw new Error('no empty state');
      expect(empty.textContent).toContain(text);
      expect(
        within(empty)
          .queryAllByRole('link')
          .map((l) => l.textContent.trim()),
      ).toEqual(actions);
    },
  );

  it.each([
    ['/projects/demo/upload', 'In der Demo kannst du keine Modelle hochladen.'],
    ['/projects/demo/agents', 'In der Demo verbindet sich kein Agent'],
    ['/projects/demo/rules', 'In der Demo gibt es keine Annahmeregeln.'],
  ])('answers %s on the demo with a notice and no request', async (path, text) => {
    const { calls } = setup(path, { health: DEMO_HEALTH, role: 'viewer' });
    const notice = await screen.findByTestId('read-only-notice');
    expect(notice.textContent).toContain(text);
    expect(within(notice).getByRole('link', { name: 'ProA auf GitHub' })).toBeDefined();
    expect(screen.queryByTestId('upload-dropzone')).toBeNull();
    expect(calls.filter((c) => /agent-tokens|auto-accept|imports/.test(c.path))).toEqual([]);
    expect(writes(calls)).toEqual([]);
  });

  it('names the role it takes outside the demo', async () => {
    setup('/projects/demo/upload', { health: LOCAL_HEALTH, role: 'viewer' });
    expect((await screen.findByTestId('read-only-notice')).textContent).toContain(
      'Bearbeiter und Inhaber',
    );
  });
});

describe('the review inbox for a viewer', () => {
  it('lists proposals without bulk accept', async () => {
    const { calls } = setup('/projects/demo/review', { health: DEMO_HEALTH, role: 'viewer' });
    expect(await screen.findAllByTestId('queue-row')).toHaveLength(1);
    expect(screen.queryByTestId('bulk-open')).toBeNull();
    expect(writes(calls)).toEqual([]);
  });

  it('lists failed models without „Erneut einplanen“', async () => {
    const { calls } = setup('/projects/demo/review?stage=agent_failed', {
      health: DEMO_HEALTH,
      role: 'viewer',
    });
    expect(await screen.findAllByTestId('stage-model-row')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Erneut einplanen/ })).toBeNull();
    expect(writes(calls)).toEqual([]);
  });

  it('shows held relations with their question, without an answer field', async () => {
    setup('/projects/demo/review?view=held', { health: DEMO_HEALTH, role: 'viewer' });
    const item = await screen.findByTestId('held-item');
    expect(item.textContent).toContain('Fachbereich fragen');
    expect(within(item).queryByRole('form', { name: 'Antwort geben' })).toBeNull();
  });

  it('keeps bulk accept for an owner', async () => {
    setup('/projects/demo/review', { health: LOCAL_HEALTH, role: 'owner' });
    expect(await screen.findAllByTestId('bulk-open')).not.toHaveLength(0);
  });

  it('asks no viewer to connect an agent while models wait for one', async () => {
    setup('/projects/demo/review', {
      health: LOCAL_HEALTH,
      role: 'viewer',
      modelList: [model({ key: 'w/wait', stage: 'waiting_for_agent', openItems: 0 })],
      relationList: [],
    });
    const empty = (await screen.findByText('Keine offenen Vorschläge')).closest(
      '[data-slot="empty"]',
    );
    expect(empty?.textContent).toContain('1 Modell wartet auf einen Agenten.');
    expect(empty?.textContent).not.toContain('Verbinde');
    expect(screen.queryByRole('link', { name: /Agent verbinden/ })).toBeNull();
  });

  it('points a viewer to the placements without asking for a decision', async () => {
    setup('/projects/demo/review', {
      health: DEMO_HEALTH,
      role: 'viewer',
      chain: chainDetail({
        placements: [placement({ id: 'plc_01OPEN', elementId: 's-1', process: 'c/review#P' })],
      }),
    });
    const callout = await screen.findByTestId('placements-callout');
    expect(callout.textContent).toContain('1 Platzierung wartet auf Prüfung');
    expect(callout.textContent).toContain('stehen auf der Wertschöpfungskette');
    expect(callout.textContent).not.toMatch(/deine|prüfst du/);
  });
});

describe('the agents’ no-links in the inbox', () => {
  it('lists them read-only for a viewer on the demo, with the count on the tab', async () => {
    const { calls } = setup('/projects/demo/review?view=no-links', {
      health: DEMO_HEALTH,
      role: 'viewer',
    });
    const items = await screen.findAllByTestId('no-link-item');
    expect(items.map((i) => i.dataset['noLinkId'])).toEqual(['nlk_01FIRST', 'nlk_01SECOND']);
    expect(items[0]?.textContent).toContain('no-evidence: Die Namen ähneln sich nur zufällig.');
    expect(items[0]?.textContent).toContain('agent:proa-agent-sim');
    expect(items[0]?.textContent).toContain('Analyse von a/held');
    expect(screen.getByRole('tab', { name: /Kein Zusammenhang/ }).textContent).toContain('2');
    for (const item of items) expect(within(item).queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('bulk-open')).toBeNull();
    expect(writes(calls)).toEqual([]);
  });

  it('follows the model filter of the inbox', async () => {
    setup('/projects/demo/review?view=no-links&model=c%2Freview', {
      health: LOCAL_HEALTH,
      role: 'owner',
    });
    const items = await screen.findAllByTestId('no-link-item');
    expect(items.map((i) => i.dataset['noLinkId'])).toEqual(['nlk_01SECOND']);
    // A no-link has no tier: the tab offers no tier filter.
    expect(screen.queryByLabelText('Stufe')).toBeNull();
    expect(screen.getByLabelText('Modell')).toBeDefined();
    // A no-link needs no decision: no bulk accept on this tab, also for an owner.
    expect(screen.queryByTestId('bulk-open')).toBeNull();
  });

  it('says so when the filter leaves none', async () => {
    setup('/projects/demo/review?view=no-links&model=x%2Fnone', {
      health: LOCAL_HEALTH,
      role: 'owner',
    });
    expect(await screen.findByText('Kein Paar passt zu den Filtern')).toBeDefined();
  });
});

describe('the review screen for a viewer', () => {
  it('has no decision panel; A, R, H and C do nothing, J/K still walk', async () => {
    const { calls, user } = setup('/projects/demo/review/rel_01PROPOSED', {
      health: DEMO_HEALTH,
      role: 'viewer',
    });
    const line = await screen.findByTestId('read-only-review');
    expect(line.textContent).toBe('Nur lesen – in der Demo entscheidest du nicht.');
    expect(screen.queryByRole('button', { name: /Annehmen/ })).toBeNull();
    await user.keyboard('arhc');
    expect(writes(calls)).toEqual([]);
    expect(screen.getByText(/weiter, zurück/)).toBeDefined();
    expect(screen.queryByText(/entscheiden$/)).toBeNull();
  });

  it('keeps the decision panel for an owner', async () => {
    setup('/projects/demo/review/rel_01PROPOSED', { health: LOCAL_HEALTH, role: 'owner' });
    expect(await screen.findByRole('button', { name: /Annehmen/ })).toBeDefined();
    expect(screen.queryByTestId('read-only-review')).toBeNull();
  });
});

describe('errorMessage', () => {
  it('turns a demo-readonly refusal into a German sentence, never a raw error', () => {
    const error = new ApiError(
      {
        type: 'urn:proa:problem:demo-readonly',
        title: 'Read-only demo',
        status: 403,
        code: 'demo-readonly',
        detail: 'this ProA is a read-only demo',
      },
      403,
    );
    expect(errorMessage(error)).toBe(DEMO_READONLY_MESSAGE);
    expect(DEMO_READONLY_MESSAGE).toBe('Das ist eine Demo: Hier kannst du nichts ändern.');
  });
});
