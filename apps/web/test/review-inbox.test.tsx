import type { AnalysisTask, Landscape, Model, RequeueBody } from '@proa/client';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { App } from '../src/app';
import {
  analysesQuery,
  assertionsQuery,
  landscapeQuery,
  modelsQuery,
  projectQuery,
} from '../src/lib/queries';
import { createAppRouter } from '../src/router';
import { findToast, json, stubApi } from './support/render';
import { model, provenance, relation } from './support/fixtures';

const models: Model[] = [
  model({ key: 'a/held', stage: 'waiting_for_clarification', openItems: 1 }),
  model({ key: 'b/stuck', stage: 'agent_working', openItems: 0 }),
  model({ key: 'c/changed', stage: 'waiting_for_review', openItems: 1 }),
  model({ key: 'd/partner', stage: 'waiting_for_review', openItems: 1 }),
];
const held = relation({
  id: 'rel_01HELD',
  from: 'a/held#S',
  to: 'd/partner#C',
  status: 'held',
  tier: 'semantic',
  provenance: provenance({ kind: 'decision', verdict: 'hold', rationale: 'Fachbereich fragen' }),
});
const changed = relation({
  id: 'rel_01CHANGED',
  from: 'c/changed#S',
  to: 'd/partner#C',
  status: 'accepted',
  endpointState: 'changed',
  tier: 'key',
});
const accepted = relation({
  id: 'rel_01OK',
  from: 'c/changed#T',
  to: 'd/partner#D',
  status: 'accepted',
  tier: 'key',
});
const stuckTask: AnalysisTask = {
  id: 'ana_01STUCK',
  projectId: 'prj_01DEMO',
  modelId: 'mdl_BSTUCK',
  modelKey: 'b/stuck',
  revisionId: 'rev_BSTUCK',
  kind: 'relations',
  state: 'claimed',
  attempts: 3,
  factsHash: 'a'.repeat(64),
  leaseUntil: '2026-10-07T09:15:00.000Z',
  claimedBy: 'agent:sim',
  lastError: null,
  submissionId: null,
  createdAt: '2026-10-07T09:00:00.000Z',
  updatedAt: '2026-10-07T09:00:00.000Z',
};

function setup(path: string) {
  const calls = stubApi({
    'POST /api/v1/projects/demo/analyses/requeue': (call) =>
      json({
        items: (call.body as RequeueBody).modelKeys?.map((modelKey) => ({
          modelKey,
          outcome: 'queued',
          taskId: 'ana_01NEW',
        })),
      }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const landscape: Landscape = {
    projectId: 'prj_01DEMO',
    seq: 1,
    models: [],
    relations: [held, changed, accepted],
    findings: [],
  };
  queryClient.setQueryData(projectQuery('demo').queryKey, {
    id: 'prj_01DEMO',
    key: 'demo',
    name: 'Demo',
    role: 'owner',
    lastSeq: 1,
    createdAt: '2026-10-07T09:00:00.000Z',
  });
  queryClient.setQueryData(landscapeQuery('demo').queryKey, landscape);
  queryClient.setQueryData(modelsQuery('demo').queryKey, models);
  queryClient.setQueryData(analysesQuery('demo', 'claimed').queryKey, [stuckTask]);
  queryClient.setQueryData(assertionsQuery('demo', held.id).queryKey, []);
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<App queryClient={queryClient} router={router} />);
  return { calls, router, user: userEvent.setup() };
}

describe('review inbox', () => {
  it('lists accepted relations whose endpoint changed, and counts them in the tab', async () => {
    setup('/projects/demo/review');
    const rows = await screen.findAllByTestId('queue-row');
    expect(rows.map((r) => r.dataset['relationId'])).toEqual(['rel_01CHANGED']);
    expect(within(rows[0]!).getByTestId('queue-reconfirm').textContent).toContain(
      'Endpunkt geändert',
    );
    const nav = screen.getByRole('navigation', { name: 'Projektbereiche' });
    const tab = within(nav).getByRole('link', { name: /Prüfen/ });
    expect(tab.textContent).toBe('Prüfen1 zu prüfen');
    // Re-confirming is one by one: no bulk accept for it.
    expect(screen.queryByTestId('bulk-open')).toBeNull();
  });

  it('shows the held items of a model waiting for clarification', async () => {
    const { router, user } = setup('/projects/demo/review?stage=waiting_for_clarification');
    const models = await screen.findByTestId('stage-models');
    await user.click(within(models).getByRole('button', { name: 'Vorgemerkte zeigen' }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ model: 'a/held', view: 'held' }),
    );
    const item = await screen.findByTestId('held-item');
    expect(item.dataset['relationId']).toBe('rel_01HELD');
    expect(
      within(item)
        .getByRole('link', { name: /Prüfen/ })
        .getAttribute('href'),
    ).toContain('view=held');
  });

  it('offers a requeue for an expired lease that still says "Agent arbeitet"', async () => {
    const { calls, user } = setup('/projects/demo/review?stage=agent_working');
    const models = await screen.findByTestId('stage-models');
    expect((await within(models).findByTestId('lease-expired')).textContent).toContain(
      'Lease abgelaufen',
    );
    await user.click(within(models).getByRole('button', { name: /Erneut einplanen/ }));
    await findToast('Erneut eingeplant');
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toContainEqual({
      modelKeys: ['b/stuck'],
    });
  });
});
