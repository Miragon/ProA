import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { RelationsView } from '../src/components/relation-table';
import type { RelationFilters } from '../src/lib/relation-filters';
import { provenance, relation, sampleRelations, sampleResolver } from './support/fixtures';

const MODEL_KEYS = [
  'finance/payment-collection',
  'finanzen/rechnungsstellung',
  'vertrieb/auftragsabwicklung',
];

function Harness({
  initial = {},
  relations = sampleRelations,
  onChange,
}: {
  initial?: RelationFilters;
  relations?: typeof sampleRelations;
  onChange?: (filters: RelationFilters) => void;
}) {
  const [filters, setFilters] = useState<RelationFilters>(initial);
  return (
    <RelationsView
      relations={relations}
      resolve={sampleResolver}
      modelKeys={MODEL_KEYS}
      filters={filters}
      onFiltersChange={(next) => {
        onChange?.(next);
        setFilters(next);
      }}
      renderActions={(r) => <button type="button">Zeigen {r.id}</button>}
    />
  );
}

const rows = () => screen.queryAllByTestId('relation-row');
const rowIds = () => rows().map((row) => row.dataset['relationId']);

describe('RelationsView', () => {
  it('lists rule-accepted calls first, then key-tier proposals', () => {
    render(<Harness />);
    expect(rowIds()).toEqual([
      'rel_01CALL000000000000000000001',
      'rel_01STEM000000000000000000001',
      'rel_01MESSAGE000000000000000001',
      'rel_01SIGNAL0000000000000000001',
    ]);
    const [accepted, stem] = rows();
    expect(accepted!.dataset['status']).toBe('accepted');
    expect(accepted!.dataset['tier']).toBe('rule');
    expect(within(accepted!).getByText('Angenommen')).toBeTruthy();
    expect(within(accepted!).getByText('Regel')).toBeTruthy();
    expect(within(accepted!).getByText('proa-rules/1.0.0')).toBeTruthy();
    expect(within(accepted!).getByText('eindeutiger Aufruf')).toBeTruthy();
    expect(within(stem!).getByText('Vorgeschlagen')).toBeTruthy();
    expect(within(stem!).getByText('Schlüssel')).toBeTruthy();
    expect(within(stem!).getByText('Treffer über Dateinamen')).toBeTruthy();
    expect(within(stem!).getByText('80 %')).toBeTruthy();
    expect(within(stem!).getByText('Endpunkt geändert')).toBeTruthy();
  });

  it('shows element labels, model keys and process names for both endpoints', () => {
    render(<Harness />);
    const message = rows().find(
      (r) => r.dataset['relationId'] === 'rel_01MESSAGE000000000000000001',
    )!;
    const cells = within(message);
    expect(cells.getAllByText('Ware versandbereit')).toHaveLength(2);
    expect(cells.getByText(/vertrieb\/auftragsabwicklung/)).toBeTruthy();
    expect(cells.getByText(/· Auftragsabwicklung/)).toBeTruthy();
    expect(cells.getByText(/finanzen\/rechnungsstellung/)).toBeTruthy();
    expect(cells.getByText('gleicher Nachrichtenname')).toBeTruthy();
    // a process endpoint shows the process name; an unknown element falls back to its id
    const call = rows()[0]!;
    expect(within(call).getByText('Payment collection')).toBeTruthy();
    const signal = rows()[3]!;
    expect(within(signal).getByText('End_RechnungsstellungAbgeschlossen')).toBeTruthy();
  });

  it('quick filters separate rule acceptances from key-tier proposals', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const presets = screen.getByRole('group', { name: 'Schnellfilter' });
    expect(
      within(presets)
        .getByRole('button', { name: /Alle 4/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    await user.click(within(presets).getByRole('button', { name: /Durch Systemregel angenommen/ }));
    expect(rowIds()).toEqual(['rel_01CALL000000000000000000001']);
    await user.click(within(presets).getByRole('button', { name: /Schlüssel-Vorschläge 3/ }));
    expect(
      rows().every((r) => r.dataset['tier'] === 'key' && r.dataset['status'] === 'proposed'),
    ).toBe(true);
    expect(rows()).toHaveLength(3);
    expect(screen.getByText('3 von 4 Relationen')).toBeTruthy();
  });

  it('filters by status, tier, type and model and resets', async () => {
    const user = userEvent.setup();
    const changes: RelationFilters[] = [];
    render(<Harness onChange={(f) => changes.push(f)} />);

    await user.selectOptions(screen.getByLabelText('Typ'), 'call');
    expect(rowIds()).toEqual([
      'rel_01CALL000000000000000000001',
      'rel_01STEM000000000000000000001',
    ]);

    await user.selectOptions(screen.getByLabelText('Status'), 'proposed');
    expect(rowIds()).toEqual(['rel_01STEM000000000000000000001']);

    await user.selectOptions(screen.getByLabelText('Stufe'), 'rule');
    expect(rows()).toHaveLength(0);
    expect(screen.getByText('Keine Relation passt zu den Filtern')).toBeTruthy();

    await user.click(screen.getAllByRole('button', { name: 'Filter zurücksetzen' })[0]!);
    expect(rows()).toHaveLength(4);

    await user.selectOptions(screen.getByLabelText('Modell'), 'vertrieb/auftragsabwicklung');
    expect(rowIds()).toEqual([
      'rel_01CALL000000000000000000001',
      'rel_01MESSAGE000000000000000001',
      'rel_01SIGNAL0000000000000000001',
    ]);
    expect(changes.at(-1)).toEqual({ model: 'vertrieb/auftragsabwicklung' });
    expect(changes).toContainEqual({ type: 'call', status: 'proposed', tier: 'rule' });
  });

  it('expands a row to show refs, version and attributes', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByTestId('relation-details')).toBeNull();
    const first = rows()[0]!;
    await user.click(within(first).getByRole('button', { name: 'Details anzeigen' }));
    const details = screen.getByTestId('relation-details');
    expect(
      within(details).getByText('vertrieb/auftragsabwicklung#Call_ZahlungAbwickeln'),
    ).toBeTruthy();
    expect(within(details).getByText('binding')).toBeTruthy();
    expect(within(details).getByText('latest')).toBeTruthy();
    expect(within(first).getByRole('button', { name: 'Details ausblenden' })).toBeTruthy();
  });

  it('renders the action slot per row (review screen and model view)', () => {
    render(<Harness />);
    expect(screen.getByRole('columnheader', { name: 'Aktion' })).toBeTruthy();
    for (const r of sampleRelations) {
      expect(screen.getByRole('button', { name: `Zeigen ${r.id}` })).toBeTruthy();
    }
  });

  it('explains an empty landscape', () => {
    render(<Harness relations={[]} />);
    expect(screen.getByText('Noch keine Relationen')).toBeTruthy();
  });

  it('shows the provenance the API reports: agent handle, procedure and model', () => {
    render(
      <Harness
        relations={[
          relation({
            id: 'rel_A',
            from: 'a#x',
            to: 'b#y',
            tier: 'lexical',
            confidence: 0.7,
            provenance: provenance({ handle: 'agent:sim', llmModel: null }),
          }),
          relation({
            id: 'rel_B',
            from: 'a#x',
            to: 'c#z',
            status: 'rejected',
            provenance: provenance({
              sourceKind: 'human',
              handle: 'owner',
              kind: 'decision',
              verdict: 'reject',
            }),
          }),
        ]}
      />,
    );
    expect(screen.getByText('agent:sim')).toBeTruthy();
    expect(screen.getByText('proa-relations@0.1.0')).toBeTruthy();
    expect(screen.getByText('owner')).toBeTruthy();
    expect(screen.getByText('abgelehnt')).toBeTruthy();
  });

  it('marks agent proposals and human relations by their provenance', () => {
    render(
      <Harness
        relations={[
          relation({ id: 'rel_A', from: 'a#x', to: 'b#y', tier: 'semantic', confidence: 0.72 }),
          relation({
            id: 'rel_B',
            from: 'a#x',
            to: 'c#z',
            tier: 'manual',
            type: 'manual',
            confidence: null,
          }),
        ]}
      />,
    );
    expect(screen.getByText('Agent')).toBeTruthy();
    expect(screen.getByText('gleiche Bedeutung')).toBeTruthy();
    expect(screen.getByText('Mensch')).toBeTruthy();
    expect(screen.getByText('72 %')).toBeTruthy();
    expect(screen.getByText('–')).toBeTruthy();
  });
});
