import type { Fact, Landscape, Model, RelationAssertion } from '@proa/client';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../src/app';
import type { CanvasHighlight } from '../src/lib/bpmn-elements';
import {
  assertionsQuery,
  contentQuery,
  factsQuery,
  landscapeQuery,
  modelsQuery,
  relationQuery,
} from '../src/lib/queries';
import { createAppRouter } from '../src/router';
import { assertion, fact, model, relation } from './support/fixtures';
import { stubApi } from './support/render';

// bpmn-js needs a real browser: the canvas shows what it was asked to highlight and focus.
vi.mock('@/components/bpmn-canvas', () => ({
  default: ({ highlights, focus }: { highlights: CanvasHighlight[]; focus: string | null }) => (
    <div
      data-testid="canvas"
      data-highlights={highlights.map((h) => `${h.label}:${h.elementId}`).join(',')}
      data-focus={focus ?? ''}
    />
  ),
}));

const models: Model[] = [
  model({ key: 'a/one' }),
  model({ key: 'b/two' }),
  model({ key: 'c/three' }),
];
const facts: Fact[] = [
  fact({ modelKey: 'a/one', elementId: 'S', kind: 'msg_throw', label: 'Ware versandbereit' }),
  fact({ modelKey: 'a/one', elementId: 'T', kind: 'task', label: 'Ware verpacken' }),
  fact({ modelKey: 'b/two', elementId: 'C', kind: 'msg_catch', label: 'Ware angekommen' }),
  fact({ modelKey: 'b/two', elementId: 'U', kind: 'task', label: 'Rechnung prüfen' }),
  fact({ modelKey: 'c/three', elementId: 'Z', kind: 'task', label: 'Archivieren' }),
];

const X = relation({
  id: 'rel_01X',
  from: 'a/one#S',
  to: 'b/two#C',
  tier: 'semantic',
  confidence: 0.8,
});
const M = relation({
  id: 'rel_01M',
  type: 'manual',
  from: 'a/one#S',
  to: 'c/three#Z',
  tier: 'manual',
  status: 'accepted',
});
const D = relation({
  id: 'rel_01D',
  from: 'a/one#S',
  to: 'gone/model#C',
  status: 'accepted',
  endpointState: 'missing',
});
const history: Record<string, RelationAssertion[]> = {
  rel_01X: [
    assertion({
      id: 'asr_1',
      evidence: ['a/one#T', 'b/two#U', 'c/three#Z', 'frei formuliert'],
      rationale: 'gleiche Ware',
    }),
  ],
  rel_01M: [],
  rel_01D: [],
};

function setup(path: string) {
  stubApi({});
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const landscape: Landscape = {
    projectId: 'prj_01DEMO',
    seq: 1,
    models: [],
    relations: [X, M, D],
    findings: [],
  };
  queryClient.setQueryData(landscapeQuery('demo').queryKey, landscape);
  queryClient.setQueryData(modelsQuery('demo').queryKey, models);
  for (const r of [X, M, D]) {
    queryClient.setQueryData(relationQuery('demo', r.id).queryKey, r);
    queryClient.setQueryData(assertionsQuery('demo', r.id).queryKey, history[r.id] ?? []);
  }
  for (const m of models) {
    const ref = { project: 'demo', modelId: m.id, revisionId: m.headRevisionId };
    queryClient.setQueryData(factsQuery(ref).queryKey, {
      modelKey: m.key,
      revisionId: m.headRevisionId,
      factsVersion: '1',
      processes: [],
      facts: facts.filter((f) => f.modelKey === m.key),
      messageFlows: [],
    });
    queryClient.setQueryData(contentQuery(ref).queryKey, { xml: `<xml model="${m.key}"/>` });
  }
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<App queryClient={queryClient} router={router} />);
  return { router, user: userEvent.setup() };
}

const canvases = () =>
  screen.queryAllByTestId('canvas').map((c) => ({
    highlights: c.dataset['highlights'],
    focus: c.dataset['focus'],
  }));

describe('review screen', () => {
  it('shows a cited element in its pane, switching panes if needed, and forgets it on another relation', async () => {
    const { router, user } = setup('/projects/demo/review/rel_01X');
    await waitFor(() => expect(canvases()).toEqual([{ highlights: 'Von:S', focus: 'S' }]));
    const refs = await screen.findAllByTestId('evidence-ref');
    expect(refs.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Ware verpacken'),
      expect.stringContaining('Rechnung prüfen'),
    ]);
    // A ref into a model without a pane opens the model view at that element.
    const link = screen.getByTestId('evidence-link');
    expect(link.getAttribute('href')).toBe('/projects/demo/models/c/three?element=Z');

    // Narrow screen, only "Von" shown: a ref into the "Nach" model switches the pane …
    await user.click(refs[1]!);
    await waitFor(() => expect(canvases()).toEqual([{ highlights: 'Nach:C,Beleg:U', focus: 'U' }]));
    expect(router.state.location.search).toMatchObject({ pane: 'to' });
    // … and one into the "Von" model switches back.
    await user.click(refs[0]!);
    await waitFor(() => expect(canvases()).toEqual([{ highlights: 'Von:S,Beleg:T', focus: 'T' }]));
    expect(router.state.location.search).toMatchObject({ pane: 'from' });

    // Another relation by link or history, with a pane on the same model: nothing of X.
    await act(() =>
      router.navigate({
        to: '/projects/$project/review/$relation',
        params: { project: 'demo', relation: 'rel_01M' },
      }),
    );
    await waitFor(() => expect(canvases()).toEqual([{ highlights: 'Von:S', focus: 'S' }]));
    // Back on the first relation, its own cited element is still marked.
    await act(async () => {
      router.history.back();
      await Promise.resolve();
    });
    await waitFor(() => expect(canvases()).toEqual([{ highlights: 'Von:S,Beleg:T', focus: 'T' }]));
  });

  it('says so when an endpoint’s model was deleted, instead of loading forever', async () => {
    setup('/projects/demo/review/rel_01D?pane=to');
    const missing = await screen.findByTestId('pane-missing-model');
    expect(missing.textContent).toContain('Modell „gone/model“ gibt es nicht mehr');
    const pane = screen.getByTestId('review-pane');
    expect(pane.getAttribute('aria-label')).toBe('Nach: gone/model');
    expect(within(pane).queryByRole('status')).toBeNull();
  });
});
