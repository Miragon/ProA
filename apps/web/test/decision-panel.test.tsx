import type { DecisionBody, Relation } from '@proa/client';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DecisionPanel } from '../src/components/review/decision-panel';
import { buildRefIndex, resolverOf } from '../src/lib/refs';
import { fact, provenance, relation } from './support/fixtures';
import { findToast, json, renderWithQuery, stubApi, type Call } from './support/render';

const ID = 'rel_01REVIEW000000000000000001';
const PATH = `/api/v1/projects/demo/relations/${ID}/decision`;

const facts = [
  fact({
    modelKey: 'shop',
    elementId: 'Throw',
    kind: 'msg_throw',
    eventDef: 'message',
    processId: 'P_shop',
    label: 'Ware versandbereit',
  }),
  fact({
    modelKey: 'billing',
    elementId: 'Wrong',
    kind: 'msg_catch',
    eventDef: 'message',
    processId: 'P_bill',
    label: 'Zahlung eingegangen',
  }),
  fact({
    modelKey: 'billing',
    elementId: 'Right',
    kind: 'msg_catch',
    eventDef: 'message',
    processId: 'P_bill',
    label: 'Ware ist versandbereit',
  }),
  fact({
    modelKey: 'shipping',
    elementId: 'Other',
    kind: 'msg_catch',
    eventDef: 'message',
    processId: 'P_ship',
    label: 'Versand starten',
  }),
];
const resolve = resolverOf(buildRefIndex(facts, []));

const proposal = relation({
  id: ID,
  type: 'message',
  from: 'shop#Throw',
  to: 'billing#Wrong',
  tier: 'semantic',
  confidence: 0.82,
  version: 3,
  provenance: provenance(),
});

function decided(body: DecisionBody, base: Relation = proposal) {
  const status =
    body.verdict === 'accept' ? 'accepted' : body.verdict === 'hold' ? 'held' : 'rejected';
  return { ...base, status, version: base.version + 1 };
}

function setup(rel: Relation = proposal, answer?: (call: Call) => Response) {
  const calls = stubApi({
    [`POST ${PATH}`]:
      answer ??
      ((call) => {
        const body = call.body as DecisionBody;
        const corrected =
          body.verdict === 'correct'
            ? relation({
                id: 'rel_01MANUAL',
                type: 'manual',
                tier: 'manual',
                status: 'accepted',
                from: body.from,
                to: body.to,
              })
            : null;
        return json({ relation: decided(body, rel), corrected });
      }),
  });
  const onDecided = vi.fn();
  const user = userEvent.setup();
  renderWithQuery(
    <DecisionPanel
      project="demo"
      relation={rel}
      resolve={resolve}
      facts={facts}
      onDecided={onDecided}
    />,
  );
  return { calls, onDecided, user };
}

const decisions = (calls: Call[]) => calls.filter((c) => c.path === PATH).map((c) => c.body);

describe('DecisionPanel', () => {
  it('accepts with the version the reviewer saw', async () => {
    const { calls, onDecided, user } = setup();
    await user.click(screen.getByRole('button', { name: /Annehmen/ }));
    await findToast('Angenommen');
    expect(decisions(calls)).toEqual([{ verdict: 'accept', version: 3 }]);
    expect(onDecided).toHaveBeenCalledWith('accept', expect.objectContaining({ corrected: null }));
    expect((await findToast('Angenommen')).textContent).toContain(
      'Ware versandbereit → Zahlung eingegangen',
    );
  });

  it('accepts with the A key', async () => {
    const { calls } = setup();
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(decisions(calls)).toEqual([{ verdict: 'accept', version: 3 }]));
  });

  it('rejects with R: the reason is required and the key is not a shortcut while typing', async () => {
    const { calls, onDecided, user } = setup();
    fireEvent.keyDown(window, { key: 'r' });
    const form = await screen.findByRole('form', { name: 'Ablehnen' });
    const submit = within(form).getByRole('button', { name: 'Ablehnen' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    const reason = within(form).getByLabelText('Grund der Ablehnung');
    expect(document.activeElement).toBe(reason);
    // "a" typed into the reason never accepts
    await user.type(reason, 'Gleicher Name, aber ein anderer Vorgang');
    expect(decisions(calls)).toEqual([]);
    await user.click(submit);
    await findToast('Abgelehnt');
    expect(decisions(calls)).toEqual([
      { verdict: 'reject', reason: 'Gleicher Name, aber ein anderer Vorgang', version: 3 },
    ]);
    expect(onDecided).toHaveBeenCalledWith('reject', expect.anything());
  });

  it('cancels a form with Escape', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /Ablehnen/ }));
    const reason = screen.getByLabelText('Grund der Ablehnung');
    await user.type(reason, 'x{Escape}');
    expect(screen.queryByRole('form', { name: 'Ablehnen' })).toBeNull();
    expect(screen.getByRole('button', { name: /Annehmen/ })).toBeTruthy();
  });

  it('holds with H: note required, question and label only when given', async () => {
    const { calls, user } = setup();
    fireEvent.keyDown(window, { key: 'h' });
    const form = await screen.findByRole('form', { name: 'Vormerken' });
    await user.type(within(form).getByLabelText('Notiz'), 'Fachbereich fragen');
    await user.click(within(form).getByRole('button', { name: 'Vormerken' }));
    await findToast('Vorgemerkt');
    expect(decisions(calls)).toEqual([{ verdict: 'hold', note: 'Fachbereich fragen', version: 3 }]);
  });

  it('holds with question and label', async () => {
    const { calls, user } = setup();
    await user.click(screen.getByRole('button', { name: /Vormerken/ }));
    await user.type(screen.getByLabelText('Notiz'), 'Unklar');
    await user.type(
      screen.getByLabelText('Frage (optional)'),
      'Gilt das auch für Teillieferungen?',
    );
    await user.type(screen.getByLabelText('Label (optional)'), 'mit Fachbereich Finanzen klären');
    await user.click(screen.getByRole('button', { name: 'Vormerken' }));
    await findToast('Vorgemerkt');
    expect(decisions(calls)).toEqual([
      {
        verdict: 'hold',
        note: 'Unklar',
        question: 'Gilt das auch für Teillieferungen?',
        label: 'mit Fachbereich Finanzen klären',
        version: 3,
      },
    ]);
  });

  it('corrects with C: picks a compatible receiver and sends the manual pair', async () => {
    const { calls, onDecided, user } = setup();
    fireEvent.keyDown(window, { key: 'c' });
    const dialog = await screen.findByRole('dialog', { name: 'Relation korrigieren' });
    const options = within(dialog).getAllByTestId('correction-candidate');
    // only message catches in other processes than the sender, the most similar first
    expect(options.map((o) => o.dataset['ref'])).toEqual(['billing#Right', 'shipping#Other']);
    const submit = within(dialog).getByRole('button', { name: 'Korrigieren' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await user.type(within(dialog).getByLabelText('Passendes Element suchen'), 'versand starten');
    expect(within(dialog).getAllByTestId('correction-candidate')).toHaveLength(1);
    await user.clear(within(dialog).getByLabelText('Passendes Element suchen'));

    await user.click(within(dialog).getAllByTestId('correction-candidate')[0]!);
    expect(within(dialog).getByTestId('correction-pair').textContent).toContain(
      'Ware ist versandbereit',
    );
    await user.type(
      within(dialog).getByLabelText('Begründung'),
      'Die Rechnung wartet auf den Versand.',
    );
    await user.click(submit);
    await findToast('Korrigiert');
    expect(decisions(calls)).toEqual([
      {
        verdict: 'correct',
        from: 'shop#Throw',
        to: 'billing#Right',
        note: 'Die Rechnung wartet auf den Versand.',
        version: 3,
      },
    ]);
    expect(onDecided).toHaveBeenCalledWith('correct', expect.anything());
  });

  it('shows a clear conflict when the relation changed meanwhile', async () => {
    const { calls, onDecided, user } = setup(proposal, () =>
      json(
        {
          type: 'urn:proa:problem:conflict',
          title: 'Conflict',
          status: 409,
          code: 'conflict',
          detail: 'the relation is at version 4',
          version: 4,
        },
        409,
      ),
    );
    await user.click(screen.getByRole('button', { name: /Annehmen/ }));
    const conflict = await screen.findByTestId('decision-conflict');
    expect(conflict.textContent).toContain('Die Relation wurde inzwischen geändert');
    expect(conflict.textContent).toContain('Version 4');
    expect(conflict.textContent).toContain('du hast Version 3 gesehen');
    expect(onDecided).not.toHaveBeenCalled();
    // shortcuts pause until the reviewer has seen the new state
    fireEvent.keyDown(window, { key: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(decisions(calls)).toHaveLength(1);
    await user.click(within(conflict).getByRole('button', { name: /Neuen Stand prüfen/ }));
    expect(screen.queryByTestId('decision-conflict')).toBeNull();
  });

  it('reports other errors as a toast', async () => {
    const { user } = setup(proposal, () =>
      json(
        { title: 'Validation failed', status: 422, code: 'validation-failed', detail: 'bad' },
        422,
      ),
    );
    await user.click(screen.getByRole('button', { name: /Annehmen/ }));
    expect((await findToast('Entscheidung nicht gespeichert')).textContent).toContain('bad');
  });

  it('offers nothing to decide on an obsolete relation and disables the current verdict', () => {
    setup(relation({ ...proposal, status: 'obsolete' }));
    expect(screen.queryByRole('button', { name: /Annehmen/ })).toBeNull();
    expect(screen.getByText(/Veraltet/)).toBeTruthy();
  });

  it('does not accept an accepted relation again', () => {
    setup(relation({ ...proposal, status: 'accepted' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Annehmen/ }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Ablehnen/ }).disabled).toBe(
      false,
    );
    expect(screen.queryByTestId('reconfirm-hint')).toBeNull();
  });

  it('accepts again when an endpoint of an accepted relation changed (an open item)', async () => {
    const { calls } = setup(
      relation({ ...proposal, status: 'accepted', endpointState: 'changed' }),
    );
    const button = screen.getByRole<HTMLButtonElement>('button', { name: /Erneut annehmen/ });
    expect(button.disabled).toBe(false);
    expect(screen.getByTestId('reconfirm-hint').textContent).toContain('Endpunkt');
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(decisions(calls)).toEqual([{ verdict: 'accept', version: 3 }]));
  });

  it('cannot anchor a missing endpoint: reject or correct instead', () => {
    setup(relation({ ...proposal, status: 'accepted', endpointState: 'missing' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Annehmen/ }).disabled).toBe(true);
    expect(screen.getByTestId('reconfirm-hint').textContent).toContain('fehlt');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Ablehnen/ }).disabled).toBe(
      false,
    );
  });

  it('correction: one tab stop, arrow keys pick, Cmd/Ctrl+Enter submits, cancel starts afresh', async () => {
    const { calls, user } = setup();
    fireEvent.keyDown(window, { key: 'c' });
    const dialog = await screen.findByRole('dialog', { name: 'Relation korrigieren' });
    const options = within(dialog).getAllByTestId('correction-candidate');
    expect(options).toHaveLength(2);
    expect(options.every((o) => o.getAttribute('role') === 'radio')).toBe(true);
    // Roving focus: the list is one tab stop, not one per candidate.
    const group = within(dialog).getByRole('radiogroup', { name: 'Kompatible Elemente' });
    expect([group, ...options].filter((o) => o.tabIndex === 0)).toHaveLength(1);
    options[0]!.focus();
    // Held down like a real key press: Radix checks the item that the arrow key focuses.
    await user.keyboard('{ArrowDown>}');
    await waitFor(() => expect(options[1]!.getAttribute('aria-checked')).toBe('true'));
    await user.keyboard('{/ArrowDown}');
    expect(document.activeElement).toBe(options[1]);
    await user.keyboard('{ArrowUp>}');
    await waitFor(() => expect(options[0]!.getAttribute('aria-checked')).toBe('true'));
    await user.keyboard('{/ArrowUp}');
    expect(options.filter((o) => o.tabIndex === 0)).toEqual([options[0]]);

    const note = within(dialog).getByLabelText('Begründung');
    await user.type(note, 'Erst nach Abbruch');
    await user.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Reopened: nothing picked, no reason left over.
    fireEvent.keyDown(window, { key: 'c' });
    const again = await screen.findByRole('dialog', { name: 'Relation korrigieren' });
    expect(
      within(again)
        .getAllByTestId('correction-candidate')
        .some((o) => o.getAttribute('aria-checked') === 'true'),
    ).toBe(false);
    expect(within(again).getByLabelText<HTMLTextAreaElement>('Begründung').value).toBe('');

    await user.click(within(again).getAllByTestId('correction-candidate')[0]!);
    await user.type(within(again).getByLabelText('Begründung'), 'Richtiger Empfänger');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await findToast('Korrigiert');
    expect(decisions(calls)).toEqual([
      {
        verdict: 'correct',
        from: 'shop#Throw',
        to: 'billing#Right',
        note: 'Richtiger Empfänger',
        version: 3,
      },
    ]);
  });
});
