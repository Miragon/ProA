import type { Placement, PlacementDecisionBody } from '@proa/client';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PlacementDecisionPanel } from '../src/components/value-chain/placement-decision-panel';
import { stepOptions } from '../src/lib/value-chain';
import { placement, step } from './support/fixtures';
import { findToast, json, renderWithQuery, stubApi, type Call } from './support/render';

const ID = 'plc_01REVIEW';
const PATH = `/api/v1/projects/demo/value-chains/main/placements/${ID}/decision`;
const steps = [
  step({ elementId: 's-vertrieb', name: 'Vertrieb', childIds: ['s-auftrag', 's-bonitaet'] }),
  step({
    elementId: 's-auftrag',
    name: 'Auftrag',
    parentId: 's-vertrieb',
    path: ['Vertrieb', 'Auftrag'],
  }),
  step({
    elementId: 's-bonitaet',
    name: 'Bonitätsprüfung',
    parentId: 's-vertrieb',
    rank: 1,
    path: ['Vertrieb', 'Bonitätsprüfung'],
  }),
];
const options = stepOptions(steps, { outside: true });
const proposal = placement({
  id: ID,
  elementId: 's-auftrag',
  stepName: 'Auftrag',
  process: 'finanzen/kredit#Process_Kredit',
  processName: 'Kreditprüfung',
  version: 4,
});

function setup(
  p: Placement = proposal,
  { answer, shortcuts = true }: { answer?: (call: Call) => Response; shortcuts?: boolean } = {},
) {
  const calls = stubApi({
    [`POST ${PATH}`]:
      answer ??
      ((call) => {
        const body = call.body as PlacementDecisionBody;
        const status =
          body.verdict === 'accept' ? 'accepted' : body.verdict === 'hold' ? 'held' : 'rejected';
        const corrected =
          body.verdict === 'correct'
            ? placement({
                id: 'plc_01MANUAL',
                elementId: body.step,
                stepName: 'Bonitätsprüfung',
                process: p.process,
                status: 'accepted',
                tier: 'manual',
              })
            : null;
        return json({ placement: { ...p, status, version: p.version + 1 }, corrected });
      }),
  });
  const onDecided = vi.fn();
  const onReload = vi.fn();
  const user = userEvent.setup();
  renderWithQuery(
    <PlacementDecisionPanel
      project="demo"
      placement={p}
      processName={p.processName ?? p.process}
      stepOptions={options}
      shortcuts={shortcuts}
      showKeys
      onDecided={onDecided}
      onReload={onReload}
    />,
  );
  return { calls, onDecided, onReload, user };
}

const disabled = (element: HTMLElement) => (element as HTMLButtonElement).disabled;
const decisions = (calls: Call[]) => calls.filter((c) => c.path === PATH).map((c) => c.body);

describe('PlacementDecisionPanel', () => {
  it('accepts with the version the reviewer saw', async () => {
    const { calls, onDecided, user } = setup();
    await user.click(screen.getByRole('button', { name: /Annehmen/ }));
    expect((await findToast('Angenommen')).textContent).toContain('Kreditprüfung → Auftrag');
    expect(decisions(calls)).toEqual([{ verdict: 'accept', version: 4 }]);
    expect(onDecided).toHaveBeenCalledWith('accept', expect.objectContaining({ corrected: null }));
  });

  it('accepts with A, rejects with R (reason required, Cmd/Ctrl+Enter), holds with H', async () => {
    const { calls, user } = setup();
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(decisions(calls)).toEqual([{ verdict: 'accept', version: 4 }]));

    fireEvent.keyDown(window, { key: 'r' });
    const reject = screen.getByRole('form', { name: 'Ablehnen' });
    expect(disabled(within(reject).getByRole('button', { name: /Ablehnen/ }))).toBe(true);
    await user.type(within(reject).getByLabelText('Grund der Ablehnung'), 'Falscher Schritt');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() =>
      expect(decisions(calls).at(-1)).toEqual({
        verdict: 'reject',
        reason: 'Falscher Schritt',
        version: 4,
      }),
    );

    fireEvent.keyDown(window, { key: 'h' });
    const hold = screen.getByRole('form', { name: 'Vormerken' });
    expect(disabled(within(hold).getByRole('button', { name: /Vormerken/ }))).toBe(true);
    await user.type(within(hold).getByLabelText('Notiz'), 'Fachbereich fragen');
    await user.type(within(hold).getByLabelText('Frage (optional)'), 'Wer prüft die Bonität?');
    await user.click(within(hold).getByRole('button', { name: /Vormerken/ }));
    await waitFor(() =>
      expect(decisions(calls).at(-1)).toEqual({
        verdict: 'hold',
        note: 'Fachbereich fragen',
        question: 'Wer prüft die Bonität?',
        version: 4,
      }),
    );
  });

  it('corrects to another step with exactly step, note and version', async () => {
    const { calls, onDecided, user } = setup();
    fireEvent.keyDown(window, { key: 'c' });
    const dialog = await screen.findByRole('dialog');
    const shown = within(dialog)
      .getAllByTestId('correct-step-option')
      .map((o) => o.dataset['step']);
    // its own step is not offered; @outside is
    expect(shown).toEqual(['s-vertrieb', 's-bonitaet', '@outside']);
    await user.type(within(dialog).getByLabelText('Schritt suchen'), 'Bonität');
    expect(within(dialog).getAllByTestId('correct-step-option')).toHaveLength(1);
    await user.click(within(dialog).getByTestId('correct-step-option'));
    expect(disabled(within(dialog).getByRole('button', { name: 'Korrigieren' }))).toBe(true);
    await user.type(within(dialog).getByLabelText('Begründung'), 'Gehört zur Bonitätsprüfung');
    await user.click(within(dialog).getByRole('button', { name: 'Korrigieren' }));
    await findToast('Korrigiert');
    expect(decisions(calls)).toEqual([
      { verdict: 'correct', step: 's-bonitaet', note: 'Gehört zur Bonitätsprüfung', version: 4 },
    ]);
    expect(onDecided).toHaveBeenCalledWith('correct', expect.anything());
  });

  it('offers only reject and correct on a removed step and for a missing process', () => {
    setup(
      placement({
        id: ID,
        elementId: 's-gone',
        process: 'a#P',
        status: 'accepted',
        stepLive: false,
        stepName: null,
        endpointState: 'missing',
        endpoints: { step: 'missing', process: 'ok' },
      }),
    );
    expect(screen.getByTestId('limited-hint').textContent).toContain('nicht mehr in der Kette');
    expect(disabled(screen.getByRole('button', { name: /Annehmen/ }))).toBe(true);
    expect(disabled(screen.getByRole('button', { name: /Vormerken/ }))).toBe(true);
    expect(disabled(screen.getByRole('button', { name: /Ablehnen/ }))).toBe(false);
    expect(disabled(screen.getByRole('button', { name: /Korrigieren/ }))).toBe(false);
  });

  it('limits a placement whose process left the models, too', () => {
    setup(
      placement({
        id: ID,
        elementId: 's-auftrag',
        process: 'a#P',
        status: 'accepted',
        endpointState: 'missing',
        endpoints: { step: 'ok', process: 'missing' },
      }),
    );
    expect(screen.getByTestId('limited-hint').textContent).toContain('in keinem Modell mehr');
    expect(disabled(screen.getByRole('button', { name: /Annehmen/ }))).toBe(true);
  });

  it('re-confirms an accepted placement whose step changed', async () => {
    const { calls, user } = setup(
      placement({
        id: ID,
        elementId: 's-auftrag',
        process: 'a#P',
        status: 'accepted',
        endpointState: 'changed',
        endpoints: { step: 'changed', process: 'ok' },
        version: 7,
      }),
    );
    expect(screen.getByTestId('reconfirm-hint').textContent).toContain('erneut an');
    await user.click(screen.getByRole('button', { name: /Erneut annehmen/ }));
    await waitFor(() => expect(decisions(calls)).toEqual([{ verdict: 'accept', version: 7 }]));
  });

  it('shows a 409 as a conflict, pauses the shortcuts until “Neuen Stand prüfen”', async () => {
    const { calls, onReload, user } = setup(proposal, {
      answer: () =>
        json(
          {
            type: 'urn:proa:problem:conflict',
            title: 'Conflict',
            status: 409,
            code: 'conflict',
            detail: 'the placement is at version 6',
            version: 6,
          },
          409,
        ),
    });
    fireEvent.keyDown(window, { key: 'a' });
    const conflict = await screen.findByTestId('decision-conflict');
    expect(conflict.textContent).toContain('Die Platzierung wurde inzwischen geändert');
    expect(conflict.textContent).toContain('du hast Version 4 gesehen');
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.keyDown(window, { key: 'r' });
    expect(decisions(calls)).toHaveLength(1);
    expect(screen.queryByRole('form', { name: 'Ablehnen' })).toBeNull();
    await user.click(within(conflict).getByRole('button', { name: /Neuen Stand prüfen/ }));
    expect(onReload).toHaveBeenCalled();
  });

  it('ignores the keys when its shortcuts are off (edit mode without panel focus)', () => {
    const { calls } = setup(proposal, { shortcuts: false });
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.keyDown(window, { key: 'r' });
    expect(decisions(calls)).toEqual([]);
    expect(screen.queryByRole('form', { name: 'Ablehnen' })).toBeNull();
  });

  it('turns other errors into a toast', async () => {
    setup(proposal, {
      answer: () =>
        json(
          {
            type: 'urn:proa:problem:validation-failed',
            title: 'Validation failed',
            status: 422,
            code: 'validation-failed',
            detail: 'unknown-step',
          },
          422,
        ),
    });
    fireEvent.keyDown(window, { key: 'a' });
    expect((await findToast('Entscheidung nicht gespeichert')).textContent).toContain(
      'unknown-step',
    );
  });
});
