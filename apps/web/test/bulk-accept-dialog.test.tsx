import type { BulkDecisionBody, Relation } from '@proa/client';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { BulkAcceptDialog } from '../src/components/review/bulk-accept-dialog';
import { nameUsage } from '../src/lib/generic-names';
import { buildRefIndex, resolverOf } from '../src/lib/refs';
import { fact, noLink, provenance, relation } from './support/fixtures';
import { findToast, json, renderWithQuery, stubApi, type Call } from './support/render';

const PATH = '/api/v1/projects/demo/decisions';

const facts = [
  fact({
    modelKey: 'vertrieb/auftrag',
    elementId: 'Send_Rechnung',
    kind: 'msg_throw',
    eventDef: 'message',
    processId: 'P_auftrag',
    label: 'Rechnung versenden',
    attrs: { messageName: 'RechnungVersendet' },
  }),
  fact({
    modelKey: 'finanzen/debitoren',
    elementId: 'Catch_Rechnung',
    kind: 'msg_catch',
    eventDef: 'message',
    processId: 'P_deb',
    label: 'Rechnung erhalten',
    attrs: { messageName: 'RechnungVersendet' },
  }),
  fact({
    modelKey: 'vertrieb/angebot',
    elementId: 'Send_Antwort',
    kind: 'msg_throw',
    eventDef: 'message',
    processId: 'P_angebot',
    label: 'Antwort senden',
    attrs: { messageName: 'Antwort' },
  }),
  fact({
    modelKey: 'einkauf/anfrage',
    elementId: 'Catch_Antwort',
    kind: 'msg_catch',
    eventDef: 'message',
    processId: 'P_anfrage',
    label: 'Antwort erhalten',
    attrs: { messageName: 'Antwort' },
  }),
  fact({
    modelKey: 'service/ticket',
    elementId: 'Catch_Antwort',
    kind: 'msg_catch',
    eventDef: 'message',
    processId: 'P_ticket',
    label: 'Kunde hat geantwortet',
    attrs: { messageName: 'Antwort' },
  }),
  fact({
    modelKey: 'lager/versand',
    elementId: 'Send_Ware',
    kind: 'msg_throw',
    eventDef: 'message',
    processId: 'P_versand',
    label: 'Ware versandbereit',
    attrs: { messageName: 'WareVersandbereit' },
  }),
  fact({
    modelKey: 'finanzen/debitoren',
    elementId: 'Catch_Ware',
    kind: 'msg_catch',
    eventDef: 'message',
    processId: 'P_deb',
    label: 'Ware versandbereit',
    attrs: { messageName: 'WareVersandbereit' },
  }),
];
const resolve = resolverOf(buildRefIndex(facts, []));
const usage = nameUsage(facts);

const pairs: Relation[] = [
  relation({
    id: 'rel_01RECHNUNG',
    from: 'vertrieb/auftrag#Send_Rechnung',
    to: 'finanzen/debitoren#Catch_Rechnung',
    version: 2,
    attrs: { messageName: 'RechnungVersendet' },
  }),
  relation({
    id: 'rel_01ANTWORT',
    from: 'vertrieb/angebot#Send_Antwort',
    to: 'einkauf/anfrage#Catch_Antwort',
    version: 1,
    attrs: { messageName: 'Antwort' },
  }),
  relation({
    id: 'rel_01WARE',
    from: 'lager/versand#Send_Ware',
    to: 'finanzen/debitoren#Catch_Ware',
    version: 5,
    attrs: { messageName: 'WareVersandbereit' },
  }),
];

function Harness({
  initialOpen = true,
  relations = pairs,
}: {
  initialOpen?: boolean;
  relations?: Relation[];
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        öffnen
      </button>
      <BulkAcceptDialog
        project="demo"
        tier="key"
        relations={relations}
        resolve={resolve}
        usage={usage}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

function setup(answer?: (call: Call) => Response, relations: Relation[] = pairs) {
  const calls = stubApi({
    [`POST ${PATH}`]:
      answer ??
      ((call) => {
        const body = call.body as BulkDecisionBody;
        return json({
          items: body.items.map((i) => ({
            ...relations.find((p) => p.id === i.id),
            status: 'accepted',
            version: i.version + 1,
          })),
        });
      }),
  });
  const user = userEvent.setup();
  renderWithQuery(<Harness relations={relations} />);
  return { calls, user };
}

const rows = () => screen.getAllByTestId('bulk-row');
const row = (id: string) => rows().find((r) => r.dataset['relationId'] === id)!;
const bodies = (calls: Call[]) => calls.filter((c) => c.path === PATH).map((c) => c.body);

describe('BulkAcceptDialog', () => {
  it('lists every pair and flags generic or widely shared names', async () => {
    setup();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('3 Vorschläge der Stufe Schlüssel annehmen?')).toBeTruthy();
    expect(rows().map((r) => r.dataset['relationId'])).toEqual([
      'rel_01RECHNUNG',
      'rel_01ANTWORT',
      'rel_01WARE',
    ]);
    // both ends with labels and model keys
    expect(within(row('rel_01RECHNUNG')).getByText('Rechnung versenden')).toBeTruthy();
    expect(within(row('rel_01RECHNUNG')).getByText('finanzen/debitoren')).toBeTruthy();

    const antwort = row('rel_01ANTWORT');
    expect(antwort.dataset['flagged']).toBe('true');
    const flags = within(antwort).getAllByTestId('generic-flag');
    expect(flags.map((f) => f.dataset['flag'])).toEqual([
      'generic-word',
      'generic-word',
      'generic-word',
      'shared-name',
    ]);
    expect(flags[0]!.textContent).toContain('„Antwort“ ist allgemein formuliert');
    expect(flags[3]!.textContent).toContain('in 3 Prozessen vor (1 sendet, 2 empfangen)');
    expect(row('rel_01RECHNUNG').dataset['flagged']).toBe('false');
    expect(row('rel_01WARE').dataset['flagged']).toBe('false');
  });

  it('leaves flagged pairs unchecked and accepts the rest with ids, versions, tier and count', async () => {
    const { calls, user } = setup();
    await screen.findByRole('dialog');
    expect(screen.getByTestId('bulk-summary').textContent).toBe('2 von 3 ausgewählt · 1 markiert');
    expect(within(row('rel_01ANTWORT')).getByRole('checkbox').getAttribute('aria-checked')).toBe(
      'false',
    );
    await user.click(screen.getByRole('button', { name: '2 annehmen' }));
    await findToast('2 Relationen angenommen');
    expect(bodies(calls)).toEqual([
      {
        verdict: 'accept',
        tier: 'key',
        items: [
          { id: 'rel_01RECHNUNG', version: 2 },
          { id: 'rel_01WARE', version: 5 },
        ],
        expectedCount: 2,
      },
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('includes a flagged pair only when checked on purpose', async () => {
    const { calls, user } = setup();
    await screen.findByRole('dialog');
    await user.click(within(row('rel_01ANTWORT')).getByRole('checkbox'));
    await user.click(within(row('rel_01WARE')).getByRole('checkbox'));
    expect(screen.getByTestId('bulk-summary').textContent).toBe('2 von 3 ausgewählt · 1 markiert');
    await user.click(screen.getByRole('button', { name: '2 annehmen' }));
    await findToast('2 Relationen angenommen');
    expect((bodies(calls)[0] as BulkDecisionBody).items).toEqual([
      { id: 'rel_01RECHNUNG', version: 2 },
      { id: 'rel_01ANTWORT', version: 1 },
    ]);
  });

  it('selects all or nothing with the header checkbox', async () => {
    const { user } = setup();
    await screen.findByRole('dialog');
    const all = screen.getByRole('checkbox', { name: 'Alle auswählen' });
    expect(all.getAttribute('aria-checked')).toBe('mixed');
    // some selected shows a dash, never the tick of "all selected"
    expect(all.querySelector('svg.lucide-minus')).not.toBeNull();
    expect(all.querySelector('svg.lucide-check')).toBeNull();
    await user.click(all);
    expect(screen.getByTestId('bulk-summary').textContent).toContain('3 von 3');
    expect(all.querySelector('svg.lucide-check')).not.toBeNull();
    await user.click(all);
    expect(screen.getByTestId('bulk-summary').textContent).toContain('0 von 3');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '0 annehmen' }).disabled).toBe(
      true,
    );
  });

  it('keeps the dialog open with a clear message when the list changed (409)', async () => {
    const { user } = setup(() =>
      json(
        {
          type: 'urn:proa:problem:conflict',
          title: 'Conflict',
          status: 409,
          code: 'conflict',
          detail: 'the relations changed; reload and decide again',
          mismatches: [{ id: 'rel_01WARE', reason: 'version', version: 6 }],
        },
        409,
      ),
    );
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: '2 annehmen' }));
    const conflict = await screen.findByTestId('bulk-conflict');
    expect(conflict.textContent).toContain('Eine Relation hat sich seit dem Laden geändert');
    expect(conflict.textContent).toContain('Es wurde nichts entschieden');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('after a 409 reload, unchecks pairs that are flagged now or changed since a deliberate check', async () => {
    let answered = 0;
    const calls = stubApi({
      [`POST ${PATH}`]: (call) => {
        answered++;
        if (answered === 1) {
          return json(
            {
              type: 'urn:proa:problem:conflict',
              title: 'Conflict',
              status: 409,
              code: 'conflict',
              detail: 'the relations changed; reload and decide again',
              mismatches: [{ id: 'rel_01WARE', reason: 'version', version: 6 }],
            },
            409,
          );
        }
        const body = call.body as BulkDecisionBody;
        return json({ items: body.items.map((i) => ({ ...pairs[1]!, version: i.version + 1 })) });
      },
    });
    // The list after the reload: the agent asked a question on WARE, ANTWORT moved on.
    const reloaded = [
      pairs[0]!,
      relation({ ...pairs[1]!, version: 2 }),
      relation({
        ...pairs[2]!,
        version: 6,
        provenance: provenance({ tier: 'key', confidence: 1, question: 'Wirklich versandbereit?' }),
      }),
    ];
    function Reloading() {
      const [relations, setRelations] = useState(pairs);
      return (
        <>
          <button type="button" onClick={() => setRelations(reloaded)}>
            neu laden
          </button>
          <BulkAcceptDialog
            project="demo"
            tier="key"
            relations={relations}
            resolve={resolve}
            usage={usage}
            open
            onOpenChange={() => undefined}
          />
        </>
      );
    }
    const user = userEvent.setup();
    renderWithQuery(<Reloading />);
    await screen.findByRole('dialog');
    // A deliberate check of the flagged ANTWORT (version 1), RECHNUNG unchecked on purpose.
    await user.click(within(row('rel_01ANTWORT')).getByRole('checkbox'));
    await user.click(within(row('rel_01RECHNUNG')).getByRole('checkbox'));
    expect(screen.getByTestId('bulk-summary').textContent).toBe('2 von 3 ausgewählt · 1 markiert');
    await user.click(screen.getByRole('button', { name: '2 annehmen' }));
    await screen.findByTestId('bulk-conflict');

    fireEvent.click(screen.getByRole('button', { name: 'neu laden', hidden: true }));
    const checked = (id: string) =>
      within(row(id)).getByRole('checkbox').getAttribute('aria-checked');
    await waitFor(() => expect(row('rel_01WARE').dataset['flagged']).toBe('true'));
    expect(checked('rel_01WARE')).toBe('false');
    expect(checked('rel_01ANTWORT')).toBe('false');
    expect(checked('rel_01RECHNUNG')).toBe('false');
    expect(screen.getByTestId('bulk-summary').textContent).toBe('0 von 3 ausgewählt · 2 markiert');

    // A new deliberate check holds for the version now shown.
    await user.click(within(row('rel_01ANTWORT')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: '1 annehmen' }));
    await findToast('1 Relation angenommen');
    expect(bodies(calls).map((b) => (b as BulkDecisionBody).items)).toEqual([
      [
        { id: 'rel_01ANTWORT', version: 1 },
        { id: 'rel_01WARE', version: 5 },
      ],
      [{ id: 'rel_01ANTWORT', version: 2 }],
    ]);
  });

  it('flags an open agent question and an ambiguous call target and leaves them unchecked', async () => {
    const agentPairs = [
      pairs[0]!,
      relation({
        ...pairs[2]!,
        provenance: provenance({
          tier: 'key',
          confidence: 1,
          question: 'Ist die Ware hier wirklich versandbereit oder nur kommissioniert?',
        }),
      }),
      relation({
        id: 'rel_01CALLDUP',
        type: 'call',
        from: 'einkauf/anforderung#Call_Freigabe',
        to: 'einkauf/archiv/freigabe-2019#Process_Freigabe',
        confidence: 0.5,
        attrs: { match: 'duplicate-process-id', calledElement: 'Process_Freigabe' },
      }),
    ];
    const { calls, user } = setup(undefined, agentPairs);
    await screen.findByRole('dialog');
    expect(screen.getByTestId('bulk-summary').textContent).toBe('1 von 3 ausgewählt · 2 markiert');

    const question = row('rel_01WARE');
    expect(question.dataset['flagged']).toBe('true');
    const [asked] = within(question).getAllByTestId('generic-flag');
    expect(asked!.dataset['flag']).toBe('agent-question');
    expect(asked!.textContent).toContain(
      'Der Agent fragt nach: „Ist die Ware hier wirklich versandbereit oder nur kommissioniert?“',
    );
    expect(within(question).getByRole('checkbox').getAttribute('aria-checked')).toBe('false');

    const call = row('rel_01CALLDUP');
    expect(call.dataset['flagged']).toBe('true');
    const [ambiguous] = within(call).getAllByTestId('generic-flag');
    expect(ambiguous!.dataset['flag']).toBe('ambiguous-target');
    expect(ambiguous!.textContent).toContain('„Process_Freigabe“ ist mehrfach definiert');

    await user.click(screen.getByRole('button', { name: '1 annehmen' }));
    await findToast('1 Relation angenommen');
    expect((bodies(calls)[0] as BulkDecisionBody).items).toEqual([
      { id: 'rel_01RECHNUNG', version: 2 },
    ]);
  });

  it('flags every agent no-link on a pair and leaves it unchecked', async () => {
    const long = `near-miss: ${'Die Ware ist kommissioniert, aber nicht versandbereit; '.repeat(5)}Ende.`;
    const objected = [
      pairs[0]!,
      relation({
        ...pairs[2]!,
        noLinks: [
          noLink({ id: 'nlk_01A', handle: 'agent:claude code', reason: long }),
          noLink({ id: 'nlk_02B', handle: 'agent:codex', reason: '<b>kein</b> HTML' }),
        ],
      }),
    ];
    const { calls, user } = setup(undefined, objected);
    await screen.findByRole('dialog');
    expect(screen.getByRole('dialog').textContent).toContain(
      'Paare ohne Zusammenhang laut einem Agenten',
    );
    expect(screen.getByTestId('bulk-summary').textContent).toBe('1 von 2 ausgewählt · 1 markiert');

    const ware = row('rel_01WARE');
    expect(ware.dataset['flagged']).toBe('true');
    expect(within(ware).getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
    const flags = within(ware).getAllByTestId('generic-flag');
    expect(flags.map((f) => f.dataset['flag'])).toEqual(['agent-no-link', 'agent-no-link']);
    expect(flags[0]!.textContent).toMatch(
      /^agent:claude code sieht keinen Zusammenhang: „near-miss: Die Ware .*…“$/,
    );
    expect(flags[0]!.textContent.length).toBeLessThan(220);
    expect(flags[1]!.textContent).toBe('agent:codex sieht keinen Zusammenhang: „<b>kein</b> HTML“');
    expect(ware.querySelector('b')).toBeNull();

    await user.click(screen.getByRole('button', { name: '1 annehmen' }));
    await findToast('1 Relation angenommen');
    expect((bodies(calls)[0] as BulkDecisionBody).items).toEqual([
      { id: 'rel_01RECHNUNG', version: 2 },
    ]);
  });
});
