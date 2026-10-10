import type { SaveValueChainResult, ValueChainImpact } from '@proa/client';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ImpactDialog, ViolationsPanel } from '../src/components/value-chain/save-dialogs';
import { getToasts } from '../src/lib/toast';
import { impactDialogOf, useChainSave, type SaveBase } from '../src/lib/value-chain-save';
import { chainDetail, impact } from './support/fixtures';
import { json, stubApi, type Call } from './support/render';

const PATH = '/api/v1/projects/demo/value-chains/main/content';
const BASE_TEXT = '{"connections":[],"elements":[],"meta":{"name":"Demo"},"schemaVersion":1}\n';
const EDITED = '{"connections":[],"elements":[],"meta":{"name":"Demo neu"},"schemaVersion":1}\n';

function result(overrides: Partial<SaveValueChainResult> = {}): SaveValueChainResult {
  return {
    dryRun: false,
    outcome: 'revised',
    valueChain: { ...chainDetail().valueChain, headRev: 4 },
    revision: null,
    impact: impact(),
    ...overrides,
  };
}

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  json({ type: `urn:proa:problem:${code}`, title: code, status, code, ...extra }, status);

const stranding: ValueChainImpact = impact({
  steps: {
    added: [],
    removed: [
      {
        elementId: 's-alt',
        generation: 1,
        name: 'Alter Schritt',
        placements: { accepted: 1, held: 0, proposed: 1 },
      },
    ],
    changed: [
      {
        elementId: 's-neu',
        generation: 1,
        before: { name: 'Vertrieb', parentId: null, kind: 'core' },
        after: { name: 'Verkauf', parentId: null, kind: 'core' },
        fingerprintChanged: true,
        placements: { accepted: 2, held: 0, proposed: 0 },
      },
    ],
  },
  placements: { stranded: 1, toReconfirm: 2, proposalsWithdrawn: 1 },
});

function setup(
  answer: (call: Call) => Response | Promise<Response>,
  { base = { rev: 3, text: BASE_TEXT }, text = EDITED }: { base?: SaveBase; text?: string } = {},
) {
  const calls = stubApi({ [`PUT ${PATH}`]: answer });
  const onSaved = vi.fn();
  const exportCanonical = vi.fn(() => text);
  const hook = renderHook(() => useChainSave({ project: 'demo', base, exportCanonical, onSaved }));
  const puts = () => calls.filter((c) => c.path === PATH);
  return { hook, onSaved, exportCanonical, puts };
}

const lastToast = () => getToasts().at(-1);

describe('useChainSave', () => {
  it('saves nothing when the drawing equals its base', () => {
    const { hook, puts, onSaved } = setup(() => json(result()), { text: BASE_TEXT });
    act(() => hook.result.current.save());
    expect(lastToast()?.title).toBe('Keine Änderungen');
    expect(puts()).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('runs the dry run, then saves with the same If-Match when nothing needs a confirmation', async () => {
    const { hook, puts, onSaved } = setup((call) =>
      json(result({ dryRun: call.search === '?dryRun=true' })),
    );
    act(() => hook.result.current.save());
    await waitFor(() => {
      const state = hook.result.current.state;
      // a save nobody had to confirm never shows the impact dialog
      expect(impactDialogOf(state)).toBeNull();
      expect(state.phase).toBe('idle');
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(
      puts().map((c) => [c.search, c.headers['if-match'], c.headers['if-none-match']]),
    ).toEqual([
      ['?dryRun=true', '"r3"', undefined],
      ['', '"r3"', undefined],
    ]);
    // the canonical text goes as the JSON body
    expect(puts()[1]!.body).toEqual(JSON.parse(EDITED));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'revised' }), EDITED);
    expect(hook.result.current.state.phase).toBe('idle');
    expect(lastToast()?.title).toBe('Gespeichert als r4');
  });

  it('creates a chain with If-None-Match: * (no empty revision 1)', async () => {
    const { hook, puts, onSaved } = setup(
      (call) => json(result({ dryRun: call.search !== '', outcome: 'created' }), 201),
      { base: { rev: 0, text: null } },
    );
    act(() => hook.result.current.save());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(puts().map((c) => [c.headers['if-none-match'], c.headers['if-match']])).toEqual([
      ['*', undefined],
      ['*', undefined],
    ]);
    expect(lastToast()?.title).toBe('Angelegt als r4');
  });

  it('asks before stranding or sending to re-confirm; reports a save whose impact differs', async () => {
    const worse = { ...stranding, placements: { ...stranding.placements, stranded: 2 } };
    const { hook, puts, onSaved } = setup((call) =>
      call.search === '?dryRun=true'
        ? json(result({ dryRun: true, impact: stranding }))
        : json(result({ impact: worse })),
    );
    act(() => hook.result.current.save());
    await waitFor(() => expect(hook.result.current.state.phase).toBe('confirm'));
    expect(puts()).toHaveLength(1);
    expect(impactDialogOf(hook.result.current.state)?.impact).toEqual(stranding);
    act(() => hook.result.current.confirm());
    // the confirmed save keeps the dialog open (disabled) while it runs
    expect(hook.result.current.state).toMatchObject({ phase: 'saving', confirmed: true });
    expect(impactDialogOf(hook.result.current.state)?.impact).toEqual(stranding);
    await waitFor(() => expect(hook.result.current.state.phase).toBe('result'));
    expect(onSaved).toHaveBeenCalled();
    const state = hook.result.current.state;
    expect(state.phase === 'result' && state.saved.impact.placements.stranded).toBe(2);
  });

  it('turns a 412 into a conflict with the head revision', async () => {
    const { hook } = setup(() => problem(412, 'revision-conflict', { headRev: 5, etag: '"r5"' }));
    act(() => hook.result.current.save());
    await waitFor(() =>
      expect(hook.result.current.state).toEqual({ phase: 'conflict', text: EDITED, headRev: 5 }),
    );
  });

  it('lists 422 violations, treats 428 as a bug, explains 413 and unsupported versions', async () => {
    const violation = {
      reason: 'hierarchy-too-deep',
      elementId: 's-tief',
      connectionId: null,
      path: null,
      detail: 'x',
    };
    const invalid = setup(() =>
      problem(422, 'value-chain-invalid', { violations: [violation], truncated: true }),
    );
    act(() => invalid.hook.result.current.save());
    await waitFor(() =>
      expect(invalid.hook.result.current.state).toEqual({
        phase: 'invalid',
        violations: [violation],
        truncated: true,
      }),
    );

    const bug = setup(() => problem(428, 'precondition-required'));
    act(() => bug.hook.result.current.save());
    await waitFor(() =>
      expect(bug.hook.result.current.state).toMatchObject({
        phase: 'error',
        title: 'Interner Fehler: Revision unbekannt',
        reload: true,
      }),
    );

    const large = setup(() => problem(413, 'payload-too-large'));
    act(() => large.hook.result.current.save());
    await waitFor(() =>
      expect(large.hook.result.current.state).toMatchObject({
        phase: 'error',
        title: 'Kette zu groß',
      }),
    );

    const newer = setup(() =>
      problem(422, 'value-chain-unsupported-version', { schemaVersion: 9, supported: 1 }),
    );
    act(() => newer.hook.result.current.save());
    await waitFor(() =>
      expect(newer.hook.result.current.state).toMatchObject({
        phase: 'error',
        title: 'Format zu neu',
      }),
    );
  });

  it('answers an unchanged dry run without saving, but moves the base', async () => {
    const { hook, puts, onSaved } = setup(() =>
      json(result({ dryRun: true, outcome: 'unchanged' })),
    );
    act(() => hook.result.current.save());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(puts()).toHaveLength(1);
    expect(lastToast()?.title).toBe('Keine Änderungen');
  });

  it('refuses before any request when the drawing is too large or invalid', () => {
    const big = setup(() => json(result()), { text: `"${'x'.repeat(1024 * 1024 + 1)}"` });
    act(() => big.hook.result.current.save());
    expect(big.hook.result.current.state).toMatchObject({ phase: 'error', title: 'Kette zu groß' });
    expect(big.puts()).toEqual([]);

    const broken = setup(() => json(result()));
    broken.exportCanonical.mockImplementation(() => {
      throw new Error('link: too small');
    });
    act(() => broken.hook.result.current.save());
    expect(broken.hook.result.current.state).toMatchObject({
      phase: 'error',
      title: 'Die Zeichnung ist so kein gültiges Dokument',
    });
  });
});

describe('save dialogs', () => {
  it('lists removed steps (stranded, withdrawn) and renamed ones (re-confirm)', async () => {
    const onConfirm = vi.fn();
    render(
      <ImpactDialog
        dry={result({ dryRun: true, impact: stranding })}
        pending={false}
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    const dialog = screen.getByTestId('impact-dialog');
    expect(dialog.textContent).toContain(
      '1 Platzierung bleibt als offener Punkt, 2 Platzierungen musst du erneut bestätigen, 1 Vorschlag wird zurückgezogen.',
    );
    expect(within(dialog).getByTestId('impact-removed').textContent).toBe(
      'Alter Schritt – 1 angenommene Platzierung bleibt als offener Punkt; 1 Vorschlag wird zurückgezogen',
    );
    expect(within(dialog).getByTestId('impact-changed').textContent).toBe(
      'Vertrieb → Verkauf – 2 angenommene Platzierungen musst du erneut bestätigen',
    );
    // The lists scroll within the dialog (a whole chain replaced by an import), focusable by keyboard.
    const lists = within(dialog).getByRole('region', { name: 'Betroffene Schritte' });
    expect(lists.className).toContain('overflow-y-auto');
    expect(lists.tabIndex).toBe(0);
    await userEvent
      .setup()
      .click(within(dialog).getByRole('button', { name: 'Trotzdem speichern' }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('names the elements of violations; a click selects one', async () => {
    const onSelect = vi.fn();
    render(
      <ViolationsPanel
        violations={[
          {
            reason: 'sequence-cycle',
            elementId: 's-a',
            connectionId: null,
            path: null,
            detail: 'x',
          },
          {
            reason: 'name-required',
            elementId: null,
            connectionId: null,
            path: 'meta.name',
            detail: 'x',
          },
        ]}
        truncated={false}
        nameOf={(id) => (id === 's-a' ? 'Vertrieb' : null)}
        onSelect={onSelect}
        onClose={() => undefined}
      />,
    );
    const items = screen.getAllByTestId('violation');
    expect(items.map((i) => i.textContent)).toEqual([
      'Die Vorgänger-Kette bildet einen Kreis. „Vertrieb“ (s-a)',
      'Die Kette braucht einen Namen.',
    ]);
    await userEvent.setup().click(within(items[0]!).getByRole('button'));
    expect(onSelect).toHaveBeenCalledWith('s-a');
  });
});
