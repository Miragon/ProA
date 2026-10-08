import type { RelationAssertion } from '@proa/client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { HeldList } from '../src/components/review/held-list';
import { assertion, provenance, relation, sampleResolver } from './support/fixtures';
import { findToast, json, renderWithRouter, stubApi } from './support/render';

const ID = 'rel_01HELD0000000000000000001';
const ASSERTIONS = `/api/v1/projects/demo/relations/${ID}/assertions`;
const NOTES = `/api/v1/projects/demo/relations/${ID}/notes`;

const hold = provenance({
  assertionId: 'ast_01HOLD',
  kind: 'decision',
  verdict: 'hold',
  sourceKind: 'human',
  handle: 'owner',
  clientId: 'proa-web',
  procedure: null,
  llmModel: null,
  tier: null,
  confidence: null,
  rationale: 'Bei Teillieferungen unklar.',
  question: 'Wird bei Teillieferungen auch eine Rechnung gestellt?',
  label: 'mit Fachbereich Finanzen klären',
  at: '2026-10-07T10:00:00.000Z',
});

const held = relation({
  id: ID,
  from: 'vertrieb/auftragsabwicklung#Event_WareVersandbereit',
  to: 'finanzen/rechnungsstellung#Start_WareVersandbereit',
  status: 'held',
  tier: 'lexical',
  provenance: hold,
});

function setup(history: RelationAssertion[]) {
  let items = [...history];
  const calls = stubApi({
    [`GET ${ASSERTIONS}`]: () => json({ items }),
    [`POST ${NOTES}`]: (call) => {
      const note = assertion({
        id: `ast_01NOTE${items.length}`,
        kind: 'note',
        sourceKind: 'human',
        handle: 'owner',
        clientId: 'proa-web',
        procedure: null,
        llmModel: null,
        tier: null,
        confidence: null,
        rationale: (call.body as { text: string }).text,
        at: '2026-10-08T08:00:00.000Z',
      });
      items = [...items, note];
      return json(note, 201);
    },
  });
  return { calls, user: userEvent.setup() };
}

const history = [
  assertion({ id: 'ast_01PROP', rationale: 'Gleiche Bezeichnung' }),
  assertion({
    id: 'ast_01NOTE_OLD',
    kind: 'note',
    sourceKind: 'human',
    handle: 'owner',
    rationale: 'alte Notiz',
  }),
  assertion({
    id: 'ast_01HOLD',
    kind: 'decision',
    verdict: 'hold',
    sourceKind: 'human',
    handle: 'owner',
    rationale: 'Bei Teillieferungen unklar.',
  }),
  assertion({
    id: 'ast_01ANSWER',
    kind: 'note',
    sourceKind: 'human',
    handle: 'owner',
    rationale: 'Finanzen: ja, auch bei Teillieferungen.',
    at: '2026-10-07T12:00:00.000Z',
  }),
];

describe('HeldList', () => {
  it('shows each held relation with note, question, label and the answers so far', async () => {
    setup(history);
    await renderWithRouter(<HeldList project="demo" relations={[held]} resolve={sampleResolver} />);
    const item = screen.getByTestId('held-item');
    expect(within(item).getAllByText('Ware versandbereit')).toHaveLength(2);
    expect(within(item).getByText('Bei Teillieferungen unklar.')).toBeTruthy();
    expect(
      within(item).getByText('Wird bei Teillieferungen auch eine Rechnung gestellt?'),
    ).toBeTruthy();
    expect(within(item).getByText('mit Fachbereich Finanzen klären')).toBeTruthy();
    // only notes after the hold count as answers
    const answers = await within(item).findAllByTestId('held-answer');
    expect(answers).toHaveLength(1);
    expect(answers[0]!.textContent).toContain('Finanzen: ja, auch bei Teillieferungen.');
    expect(within(item).queryByText('alte Notiz')).toBeNull();
    const link = within(item).getByRole('link', { name: /Prüfen/ });
    expect(link.getAttribute('href')).toBe(`/projects/demo/review/${ID}?view=held`);
  });

  it('saves an answer as a note and shows it', async () => {
    const { calls, user } = setup(history.slice(0, 3));
    await renderWithRouter(<HeldList project="demo" relations={[held]} resolve={sampleResolver} />);
    const item = screen.getByTestId('held-item');
    const save = within(item).getByRole('button', { name: /Antwort speichern/ });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    const field = within(item).getByLabelText('Antwort');
    await user.type(field, 'Ja, laut Frau Berg aus Finanzen.');
    await user.click(save);
    await findToast('Antwort gespeichert');
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { text: 'Ja, laut Frau Berg aus Finanzen.' },
    ]);
    expect((field as HTMLTextAreaElement).value).toBe('');
    await waitFor(() =>
      expect(within(item).getByTestId('held-answer').textContent).toContain(
        'Ja, laut Frau Berg aus Finanzen.',
      ),
    );
  });

  it('saves an answer with Cmd/Ctrl+Enter', async () => {
    const { calls, user } = setup(history.slice(0, 3));
    await renderWithRouter(<HeldList project="demo" relations={[held]} resolve={sampleResolver} />);
    const field = within(screen.getByTestId('held-item')).getByLabelText('Antwort');
    await user.type(field, 'Geklärt.');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await findToast('Antwort gespeichert');
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { text: 'Geklärt.' },
    ]);
  });

  it('explains an empty list', async () => {
    stubApi({});
    await renderWithRouter(<HeldList project="demo" relations={[]} resolve={sampleResolver} />);
    expect(screen.getByText('Nichts vorgemerkt')).toBeTruthy();
  });
});
