import type { Placement } from '@proa/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { BulkReconfirmDialog } from '../src/components/value-chain/bulk-reconfirm-dialog';
import { placement } from './support/fixtures';
import { findToast, json, renderWithQuery, stubApi, type Call } from './support/render';

const PATH = '/api/v1/projects/demo/value-chains/main/placements/decisions';
const changed = (id: string, version: number, process = `m#${id}`): Placement =>
  placement({
    id,
    elementId: 's-auftrag',
    stepName: 'Auftrag',
    process,
    status: 'accepted',
    endpointState: 'changed',
    endpoints: { step: 'changed', process: 'ok' },
    version,
  });
const removed = placement({
  id: 'plc_removed',
  elementId: 's-gone',
  stepName: null,
  stepLive: false,
  process: 'm#R',
  processName: 'Retouren',
  status: 'accepted',
  endpointState: 'missing',
  endpoints: { step: 'missing', process: 'ok' },
});
const gone = placement({
  id: 'plc_gone',
  elementId: 's-auftrag',
  process: 'm#G',
  status: 'accepted',
  endpointState: 'missing',
  endpoints: { step: 'ok', process: 'missing' },
});

function setup(placements: Placement[], answer?: (call: Call) => Response) {
  const calls = stubApi({ [`POST ${PATH}`]: answer ?? (() => json({ items: [] })) });
  const onOpenChange = vi.fn();
  const onShowPlacement = vi.fn();
  renderWithQuery(
    <BulkReconfirmDialog
      project="demo"
      placements={placements}
      open
      onOpenChange={onOpenChange}
      onShowPlacement={onShowPlacement}
    />,
  );
  return { calls, onOpenChange, onShowPlacement, user: userEvent.setup() };
}

describe('BulkReconfirmDialog', () => {
  it('re-confirms the changed ones with ids, versions and expectedCount', async () => {
    const { calls, onOpenChange, user } = setup(
      [changed('plc_a', 3), changed('plc_b', 5), removed, gone],
      (call) =>
        json({ items: (call.body as { items: unknown[] }).items.map(() => changed('x', 9)) }),
    );
    const dialog = screen.getByTestId('bulk-reconfirm-dialog');
    expect(
      within(dialog)
        .getAllByTestId('reconfirm-row')
        .map((r) => r.dataset['placementId']),
    ).toEqual(['plc_a', 'plc_b']);
    // removed steps and missing processes are listed apart, not selectable
    expect(
      within(dialog)
        .getAllByTestId('reconfirm-apart-row')
        .map((r) => r.dataset['placementId']),
    ).toEqual(['plc_removed', 'plc_gone']);
    await user.click(within(dialog).getByRole('checkbox', { name: /m#plc_b|plc_b bestätigen/ }));
    await user.click(within(dialog).getByRole('button', { name: '1 erneut bestätigen' }));
    await findToast('Erneut bestätigt');
    expect(calls.filter((c) => c.path === PATH).map((c) => c.body)).toEqual([
      { verdict: 'accept', items: [{ id: 'plc_a', version: 3 }], expectedCount: 1 },
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the dialog open on a 409 with mismatches and says nothing was decided', async () => {
    const { onOpenChange, user } = setup([changed('plc_a', 3)], () =>
      json(
        {
          type: 'urn:proa:problem:conflict',
          title: 'Conflict',
          status: 409,
          code: 'conflict',
          mismatches: [{ id: 'plc_a', reason: 'version' }],
        },
        409,
      ),
    );
    await user.click(screen.getByRole('button', { name: '1 erneut bestätigen' }));
    const conflict = await screen.findByTestId('bulk-reconfirm-conflict');
    expect(conflict.textContent).toContain('Eine Platzierung hat sich seit dem Laden geändert');
    expect(conflict.textContent).toContain('Es wurde nichts entschieden');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('keeps a placement the reviewer unchecked unchecked when a refetch brings a new version', async () => {
    const calls = stubApi({ [`POST ${PATH}`]: () => json({ items: [] }) });
    const view = (placements: Placement[]) => (
      <QueryClientProvider client={queryClient}>
        <BulkReconfirmDialog
          project="demo"
          placements={placements}
          open
          onOpenChange={() => undefined}
          onShowPlacement={() => undefined}
        />
      </QueryClientProvider>
    );
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const user = userEvent.setup();
    const { rerender } = render(view([changed('plc_a', 3), changed('plc_b', 5)]));
    await user.click(screen.getByRole('checkbox', { name: /plc_b bestätigen/ }));
    // B was written meanwhile (another save, a re-import): version 6
    rerender(view([changed('plc_a', 3), changed('plc_b', 6)]));
    expect(
      screen.getByRole<HTMLButtonElement>('checkbox', { name: /plc_b bestätigen/ }).dataset[
        'state'
      ],
    ).toBe('unchecked');
    await user.click(screen.getByRole('button', { name: '1 erneut bestätigen' }));
    await waitFor(() => expect(calls.filter((c) => c.path === PATH)).toHaveLength(1));
    expect(calls.find((c) => c.path === PATH)?.body).toEqual({
      verdict: 'accept',
      items: [{ id: 'plc_a', version: 3 }],
      expectedCount: 1,
    });
  });

  it('opens a card of a placement that can only be rejected or corrected', async () => {
    const { onShowPlacement, onOpenChange, user } = setup([removed]);
    await user.click(screen.getByRole('button', { name: /Retouren/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onShowPlacement).toHaveBeenCalledWith('plc_removed');
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: /erneut bestätigen/ }).disabled,
      ).toBe(true),
    );
  });
});
