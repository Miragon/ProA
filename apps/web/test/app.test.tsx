import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from '../src/app';
import { healthQuery, projectsQuery } from '../src/lib/queries';
import { createAppRouter } from '../src/router';

async function render(path: string, queryClient = new QueryClient()) {
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return renderToString(<App queryClient={queryClient} router={router} />);
}

describe('web app', () => {
  it('renders the projects page in the shell', async () => {
    const html = await render('/');
    expect(html).toContain('Projekte');
    expect(html).toContain('Server wird geprüft…');
  });

  it('shows server health and projects from the query cache', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(healthQuery.queryKey, {
      status: 'ok',
      version: '2.0.0-test',
      db: 'ok',
    });
    queryClient.setQueryData(projectsQuery.queryKey, [
      {
        id: 'prj_01TEST',
        key: 'nordwind-handel',
        name: 'Nordwind Handel',
        role: 'owner',
        lastSeq: 42,
        createdAt: '2026-10-07T09:00:00.000Z',
      },
    ]);
    const html = await render('/', queryClient);
    expect(html).toContain('Server verbunden · 2.0.0-test');
    expect(html).toContain('Nordwind Handel');
    expect(html).toContain('href="/projects/nordwind-handel"');
    expect(html).toContain('Inhaber');
  });

  it('offers an empty state with exactly two actions when there is no project', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(projectsQuery.queryKey, []);
    const html = await render('/', queryClient);
    expect(html).toContain('Noch kein Projekt');
    expect(html).toContain('Neues Projekt');
    expect(html).toContain('Seed-Befehl kopieren');
  });

  it('routes project tabs and the model view', async () => {
    const tabs = await render('/projects/demo/relations');
    expect(tabs).toContain('Relationen');
    expect(tabs).toContain('Agent verbinden');
    const view = await render('/projects/demo/models/vertrieb/auftragsabwicklung?relation=rel_1');
    expect(view).toContain('vertrieb/auftragsabwicklung');
    expect(view).toContain('data-testid="model-view"');
  });

  it('answers unknown paths with a German not-found page', async () => {
    const html = await render('/gibt-es-nicht');
    expect(html).toContain('Seite nicht gefunden');
  });
});
