import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ReviewDetails } from '../src/components/review/review-details';
import { buildRefIndex, resolverOf } from '../src/lib/refs';
import { assertion, fact, provenance, relation } from './support/fixtures';
import { renderWithRouter, stubApi } from './support/render';

const HOSTILE =
  '<img src=x onerror="alert(1)"><script>alert(2)</script> **fett** [link](javascript:x)';

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
    elementId: 'Catch',
    kind: 'msg_catch',
    eventDef: 'message',
    processId: 'P_bill',
    label: 'Versand gemeldet',
  }),
  fact({
    modelKey: 'billing',
    elementId: 'Task_Rechnung',
    kind: 'task',
    processId: 'P_bill',
    label: 'Rechnung erstellen',
  }),
];
const resolve = resolverOf(buildRefIndex(facts, []));

const rel = relation({
  id: 'rel_01DETAILS0000000000000001',
  type: 'message',
  from: 'shop#Throw',
  to: 'billing#Catch',
  tier: 'semantic',
  confidence: 0.82,
  version: 4,
  provenance: provenance({
    assertionId: 'ast_02',
    rationale: HOSTILE,
    question: 'Gilt das auch für Abholung?',
  }),
});

const history = [
  assertion({ id: 'ast_01', seq: 3, rationale: 'erste Fassung', evidence: [] }),
  assertion({
    id: 'ast_w',
    seq: 4,
    kind: 'withdrawal',
    tier: null,
    confidence: null,
    rationale: 'superseded by submission 7',
  }),
  assertion({
    id: 'ast_02',
    seq: 5,
    rationale: HOSTILE,
    question: 'Gilt das auch für Abholung?',
    evidence: ['billing#Task_Rechnung', 'Fachkonzept Kapitel 4', '<b>shop#Throw</b>'],
  }),
  assertion({
    id: 'ast_03',
    seq: 6,
    kind: 'decision',
    verdict: 'reject',
    sourceKind: 'human',
    handle: 'owner',
    clientId: 'proa-web',
    procedure: null,
    llmModel: null,
    tier: null,
    confidence: null,
    rationale: 'Falscher Empfänger',
    linkedRelationId: 'rel_01MANUAL000000000000000001',
  }),
];

async function setup(onEvidence = vi.fn()) {
  stubApi({});
  await renderWithRouter(
    <ReviewDetails
      project="demo"
      relation={rel}
      assertions={history}
      resolve={resolve}
      modelKeys={new Set(['shop', 'billing'])}
      onEvidence={onEvidence}
    />,
  );
  return { onEvidence, user: userEvent.setup() };
}

describe('ReviewDetails', () => {
  it('renders agent text as plain text, never as HTML', async () => {
    await setup();
    const details = screen.getByTestId('review-details');
    expect(details.querySelector('img, script, a[href^="javascript"], strong')).toBeNull();
    // the rationale appears verbatim (in the details and in the timeline)
    expect(screen.getAllByText(HOSTILE).length).toBeGreaterThanOrEqual(2);
    for (const el of screen.getAllByText(HOSTILE)) {
      expect(el.hasAttribute('data-plain-text')).toBe(true);
    }
  });

  it('shows endpoints, the agent question and the provenance', async () => {
    await setup();
    expect(screen.getByText('Ware versandbereit')).toBeTruthy();
    expect(screen.getByText('Versand gemeldet')).toBeTruthy();
    expect(screen.getByTestId('agent-question').textContent).toContain(
      'Gilt das auch für Abholung?',
    );
    const provenanceList = screen.getByRole('region', { name: 'Herkunft' });
    expect(provenanceList.textContent).toContain('agent:claude code');
    expect(provenanceList.textContent).toContain('agt_01CLAUDE');
    expect(provenanceList.textContent).toContain('proa-relations@0.1.0');
    expect(provenanceList.textContent).toContain('claude-sonnet-5-5');
    expect(provenanceList.textContent).toContain('82 %');
    expect(screen.getByText(/Version 4/)).toBeTruthy();
  });

  it('makes evidence refs into known models clickable, other evidence stays text', async () => {
    const { onEvidence, user } = await setup();
    const refs = screen.getAllByTestId('evidence-ref');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.textContent).toContain('Rechnung erstellen');
    await user.click(refs[0]!);
    expect(onEvidence).toHaveBeenCalledWith({
      kind: 'ref',
      text: 'billing#Task_Rechnung',
      modelKey: 'billing',
      elementId: 'Task_Rechnung',
    });
    const evidence = screen.getByRole('region', { name: 'Belege' });
    expect(within(evidence).getByText('Fachkonzept Kapitel 4')).toBeTruthy();
    expect(within(evidence).getByText('<b>shop#Throw</b>')).toBeTruthy();
  });

  it('lists the history in order with the assertion the status rests on', async () => {
    await setup();
    const entries = screen.getAllByTestId('timeline-entry');
    expect(entries.map((e) => [e.dataset['kind'], e.dataset['verdict'] ?? null])).toEqual([
      ['proposal', null],
      ['withdrawal', null],
      ['proposal', null],
      ['decision', 'reject'],
    ]);
    expect(within(entries[1]!).getByText('Vorschlag zurückgezogen')).toBeTruthy();
    expect(within(entries[2]!).getByText('maßgeblich')).toBeTruthy();
    expect(within(entries[3]!).getByText('Abgelehnt')).toBeTruthy();
    expect(within(entries[3]!).getByText('Falscher Empfänger')).toBeTruthy();
    const link = within(entries[3]!).getByRole('link', { name: /Korrigiert durch/ });
    expect(link.getAttribute('href')).toBe('/projects/demo/review/rel_01MANUAL000000000000000001');
  });
});
