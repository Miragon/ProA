import type { ValueChainStepDetail } from '@proa/client';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from '../src/app';
import { landscapeQuery, modelsQuery, projectQuery } from '../src/lib/queries';
import { createAppRouter } from '../src/router';
import { placement, step } from './support/fixtures';
import { json, stubApi } from './support/render';

const BASE = '/api/v1/projects/demo/value-chains/main';

const detail: ValueChainStepDetail = {
  step: step({
    elementId: 's-auftrag',
    name: 'Auftragsabwicklung',
    parentId: 's-vertrieb',
    path: ['Vertrieb', 'Auftragsabwicklung'],
    childIds: ['s-pruefung'],
    owners: [{ elementId: 'o-vertrieb', name: 'Vertrieb Innendienst' }],
    link: 'https://wiki.example/auftrag',
    linkKind: 'url',
  }),
  breadcrumb: [{ elementId: 's-vertrieb', name: 'Vertrieb' }],
  children: [
    step({
      elementId: 's-pruefung',
      name: 'Prüfung',
      parentId: 's-auftrag',
      counts: { accepted: 2, proposed: 1, held: 0 },
    }),
  ],
  placements: {
    own: [
      placement({
        id: 'plc_own',
        elementId: 's-auftrag',
        process: 'vertrieb/order#Process_Order',
        processName: 'Order Handling',
        status: 'accepted',
      }),
    ],
    subtree: [
      placement({
        id: 'plc_sub',
        elementId: 's-pruefung',
        stepName: 'Prüfung',
        process: 'finanzen/kredit#Process_Kredit',
        processName: 'Kreditprüfung',
      }),
    ],
    reachedByCall: [
      {
        process: 'finanzen/zahlung#Process_Zahlung',
        name: 'Zahlung',
        via: [{ relationId: 'rel_01CALL', caller: 'vertrieb/order#Call_Zahlung' }],
      },
    ],
  },
};

function setup(path: string) {
  stubApi({
    [`GET ${BASE}/steps/s-auftrag`]: () => json(detail),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(projectQuery('demo').queryKey, {
    id: 'prj_01DEMO',
    key: 'demo',
    name: 'Demo',
    role: 'owner',
    lastSeq: 1,
    createdAt: '2026-10-07T09:00:00.000Z',
  });
  queryClient.setQueryData(modelsQuery('demo').queryKey, []);
  queryClient.setQueryData(landscapeQuery('demo').queryKey, {
    projectId: 'prj_01DEMO',
    seq: 1,
    models: [],
    relations: [],
    findings: [],
  });
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<App queryClient={queryClient} router={router} />);
}

describe('step view (drill-down)', () => {
  it('shows breadcrumb, sub-steps and the three groups of processes with their links', async () => {
    setup('/projects/demo/value-chain/steps/s-auftrag');
    const view = await screen.findByTestId('step-view');
    const crumbs = within(screen.getByTestId('step-breadcrumb'));
    expect(screen.getByTestId('step-breadcrumb').textContent).toBe(
      'WertschöpfungsketteVertriebAuftragsabwicklung',
    );
    expect(crumbs.getByRole('link', { name: 'Vertrieb' }).getAttribute('href')).toBe(
      '/projects/demo/value-chain/steps/s-vertrieb',
    );
    // the project tab stays active on the drill-down
    const tabs = within(screen.getByRole('navigation', { name: 'Projektbereiche' }));
    expect(tabs.getByRole('link', { name: /^Wertschöpfungskette/ }).dataset['status']).toBe(
      'active',
    );
    expect(within(view).getByText('Vertrieb Innendienst')).toBeTruthy();
    const external = within(view).getByRole('link', { name: 'https://wiki.example/auftrag' });
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');

    const sub = screen.getByTestId('sub-step');
    expect(sub.getAttribute('href')).toBe('/projects/demo/value-chain/steps/s-pruefung');
    // counted like the canvas badges: accepted or held, and open items from the placements
    expect(sub.textContent).toContain('2 Prozesse · 1 offen');
    // one h1 on the page (the project layout's); the step and its groups below it
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([
      'Demo',
    ]);
    expect(screen.getByRole('heading', { level: 2, name: 'Auftragsabwicklung' })).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 3, name: /Prozesse dieses Schritts/ }),
    ).toBeTruthy();

    const rows = screen.getAllByTestId('step-view-placement');
    expect(rows.map((r) => r.dataset['placementId'])).toEqual(['plc_own', 'plc_sub']);
    const own = within(rows[0]!);
    expect(own.getByRole('link', { name: /Im Modell/ }).getAttribute('href')).toBe(
      '/projects/demo/models/vertrieb/order?element=Process_Order',
    );
    expect(own.getByRole('link', { name: /Auf der Kette zeigen/ }).getAttribute('href')).toBe(
      '/projects/demo/value-chain?placement=plc_own',
    );
    expect(rows[1]!.textContent).toContain('auf Prüfung');

    const called = within(screen.getByTestId('reached-by-call'));
    expect(called.getByText('Zahlung')).toBeTruthy();
    expect(called.getByTestId('via-relation').getAttribute('href')).toBe(
      '/projects/demo/review/rel_01CALL',
    );
  });

  it('says so for a step that is not in the head', async () => {
    setup('/projects/demo/value-chain/steps/s-weg');
    const missing = await screen.findByTestId('step-not-found');
    expect(missing.textContent).toContain(
      'Den Schritt „s-weg“ gibt es in der aktuellen Revision nicht.',
    );
    expect(within(missing).getByRole('link').getAttribute('href')).toBe(
      '/projects/demo/value-chain',
    );
  });
});
