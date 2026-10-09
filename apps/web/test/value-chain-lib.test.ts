import { describe, expect, it } from 'vitest';

import { ULID_PATTERN, ulid } from '../src/lib/ulid';
import {
  colorOfKind,
  documentFileName,
  drillDownTarget,
  impactSentence,
  impactSummary,
  isOpenPlacement,
  isWebUrl,
  kindChoiceOf,
  linkProblem,
  needsConfirmation,
  openPlacementCount,
  parseLink,
  placementActions,
  placementEvidenceItems,
  placementQueue,
  placementStepLabel,
  precheck,
  processLink,
  processOptions,
  pushCommand,
  queueNeighbours,
  reconfirmCandidates,
  revisionOfEtag,
  sameImpact,
  openCountsByStep,
  stepBadge,
  stepOptions,
  stepTree,
  stepsMissingFromCanvas,
  violationLine,
} from '../src/lib/value-chain';
import { chainDetail, impact, placement, step } from './support/fixtures';

const steps = [
  step({ elementId: 's-versand', name: 'Versand', rank: 1, childIds: ['s-paket'] }),
  step({
    elementId: 's-vertrieb',
    name: 'Vertrieb',
    rank: 0,
    childIds: ['s-auftrag', 's-bonitaet'],
  }),
  step({ elementId: 's-hr', name: 'Personal', kind: 'support', rank: 0 }),
  step({ elementId: 's-steuerung', name: 'Steuerung', kind: 'management', rank: 0 }),
  step({
    elementId: 's-bonitaet',
    name: 'Bonität',
    parentId: 's-vertrieb',
    rank: 1,
    path: ['Vertrieb', 'Bonität'],
  }),
  step({
    elementId: 's-auftrag',
    name: 'Auftrag',
    parentId: 's-vertrieb',
    rank: 0,
    path: ['Vertrieb', 'Auftrag'],
  }),
  step({ elementId: 's-paket', name: 'Paket', parentId: 's-versand', path: ['Versand', 'Paket'] }),
];

describe('badges and open items', () => {
  const ps = [
    placement({ id: 'plc_1', elementId: 's-auftrag', process: 'a#P1', status: 'accepted' }),
    placement({ id: 'plc_2', elementId: 's-auftrag', process: 'a#P2' }),
    placement({ id: 'plc_3', elementId: 's-auftrag', process: 'a#P3', status: 'held' }),
    placement({ id: 'plc_4', elementId: 's-auftrag', process: 'a#P4', status: 'rejected' }),
    placement({
      id: 'plc_5',
      elementId: 's-paket',
      process: 'a#P5',
      status: 'accepted',
      endpointState: 'changed',
    }),
    placement({ id: 'plc_6', elementId: 's-paket', process: 'a#P6', stepLive: false }),
  ];

  it('counts the processes homed (accepted, held) and the open items per live step', () => {
    expect(stepBadge('s-auftrag', ps)).toEqual({
      text: '2 Prozesse · 1 offen',
      total: 2,
      open: 1,
      tone: 'warning',
    });
    expect(stepBadge('s-paket', ps)).toEqual({
      text: '1 Prozess · 1 offen',
      total: 1,
      open: 1,
      tone: 'warning',
    });
    expect(
      stepBadge('s-x', [
        placement({ id: 'p', elementId: 's-x', process: 'a#P', status: 'accepted' }),
      ]),
    ).toMatchObject({ text: '1 Prozess', tone: 'neutral' });
    // only a proposal: nothing homed yet, one open item (no "1 Prozess" next to "nichts angenommen")
    expect(stepBadge('s-x', [placement({ id: 'p', elementId: 's-x', process: 'a#P' })])).toEqual({
      text: '1 offen',
      total: 0,
      open: 1,
      tone: 'warning',
    });
    expect(stepBadge('s-hr', ps)).toBeNull();
    // the step tree counts open items by the same rule
    expect([...openCountsByStep(ps)]).toEqual([
      ['s-auftrag', 1],
      ['s-paket', 1],
    ]);
  });

  it('open = proposed, or accepted with a changed or missing endpoint (the tab count)', () => {
    expect(isOpenPlacement({ status: 'proposed', endpointState: 'ok' })).toBe(true);
    expect(isOpenPlacement({ status: 'accepted', endpointState: 'missing' })).toBe(true);
    expect(isOpenPlacement({ status: 'accepted', endpointState: 'ok' })).toBe(false);
    expect(isOpenPlacement({ status: 'held', endpointState: 'ok' })).toBe(false);
    expect(openPlacementCount(chainDetail({ placements: ps }))).toBe(3);
  });

  it('walks open placements by band and rank down the path, then @outside, then removed steps', () => {
    const queue = placementQueue(
      [
        placement({ id: 'q-removed', elementId: 's-gone', process: 'a#R', stepLive: false }),
        placement({ id: 'q-outside', elementId: '@outside', process: 'a#O' }),
        placement({ id: 'q-hr', elementId: 's-hr', process: 'a#H' }),
        placement({ id: 'q-paket', elementId: 's-paket', process: 'a#K' }),
        placement({ id: 'q-bon', elementId: 's-bonitaet', process: 'a#B' }),
        placement({ id: 'q-auf-low', elementId: 's-auftrag', process: 'a#A1', confidence: 0.3 }),
        placement({ id: 'q-auf-high', elementId: 's-auftrag', process: 'a#A2', confidence: 0.9 }),
        placement({ id: 'q-done', elementId: 's-auftrag', process: 'a#A3', status: 'accepted' }),
      ],
      steps,
    );
    expect(queue.map((p) => p.id)).toEqual([
      'q-auf-high',
      'q-auf-low',
      'q-bon',
      'q-paket',
      'q-hr',
      'q-outside',
      'q-removed',
    ]);
    expect(queueNeighbours(queue, 'q-bon')).toMatchObject({ index: 2 });
    expect(queueNeighbours(queue, 'q-bon').next?.id).toBe('q-paket');
    expect(queueNeighbours(queue, null)).toMatchObject({ index: -1, previous: null });
    expect(queueNeighbours(queue, null).next?.id).toBe('q-auf-high');
  });

  it('names a removed step by id and generation, @outside in German', () => {
    expect(
      placementStepLabel({ elementId: 's-x', generation: 2, stepName: null, stepLive: false }),
    ).toBe('s-x (Generation 2, entfernt)');
    expect(
      placementStepLabel({ elementId: '@outside', generation: 1, stepName: null, stepLive: true }),
    ).toBe('Außerhalb der Kette');
  });
});

describe('step tree, pickers and drill-down', () => {
  it('orders top-level steps by kind band and rank, sub-steps by childIds', () => {
    const tree = stepTree(steps);
    expect(tree.map((n) => n.step.elementId)).toEqual([
      's-vertrieb',
      's-versand',
      's-steuerung',
      's-hr',
    ]);
    expect(tree[0]!.children.map((n) => n.step.elementId)).toEqual(['s-auftrag', 's-bonitaet']);
    expect(
      stepOptions(steps, { outside: true, exclude: 's-paket' }).map((o) => o.elementId),
    ).toEqual([
      's-vertrieb',
      's-auftrag',
      's-bonitaet',
      's-versand',
      's-steuerung',
      's-hr',
      '@outside',
    ]);
    expect(stepOptions(steps).at(-1)?.path).toBe('Personal');
  });

  it('follows a resolved proa:process link into the model view, else the step view', () => {
    expect(
      drillDownTarget(
        step({
          elementId: 's',
          name: 'S',
          linkKind: 'process',
          linkProcess: 'vertrieb/order#Process_Order',
          linkResolved: true,
        }),
      ),
    ).toEqual({ kind: 'model', modelKey: 'vertrieb/order', elementId: 'Process_Order' });
    expect(
      drillDownTarget(
        step({
          elementId: 's',
          name: 'S',
          linkKind: 'process',
          linkProcess: 'x#Y',
          linkResolved: false,
        }),
      ),
    ).toEqual({ kind: 'step', elementId: 's' });
    expect(drillDownTarget(step({ elementId: 's', name: 'S', linkKind: 'url' }))).toEqual({
      kind: 'step',
      elementId: 's',
    });
  });

  it('splits evidence into refs of known models, relations, steps and text', () => {
    expect(
      placementEvidenceItems(
        [
          'vertrieb/order#Task_1',
          'other/model#X',
          ' rel_01ABC ',
          'step:s-auftrag',
          'step: kaputt',
          'frei',
        ],
        new Set(['vertrieb/order']),
      ),
    ).toEqual([
      {
        kind: 'ref',
        text: 'vertrieb/order#Task_1',
        modelKey: 'vertrieb/order',
        elementId: 'Task_1',
      },
      { kind: 'text', text: 'other/model#X' },
      { kind: 'relation', text: 'rel_01ABC', relationId: 'rel_01ABC' },
      { kind: 'step', text: 'step:s-auftrag', elementId: 's-auftrag' },
      { kind: 'text', text: 'step: kaputt' },
      { kind: 'text', text: 'frei' },
    ]);
  });

  it('lists head steps with placements that the drawing lost', () => {
    const detail = chainDetail({
      steps: [
        step({ elementId: 'a', name: 'A', counts: { accepted: 1, proposed: 0, held: 0 } }),
        step({ elementId: 'b', name: 'B' }),
        step({ elementId: 'c', name: 'C', counts: { accepted: 0, proposed: 0, held: 2 } }),
      ],
    });
    expect(stepsMissingFromCanvas(detail, new Set(['a'])).map((s) => s.elementId)).toEqual(['c']);
  });

  it('builds the process options from the head facts', () => {
    expect(
      processOptions([
        {
          modelKey: 'b/two',
          processes: [{ ref: 'b/two#P', processId: 'P', name: null, participantName: 'Pool' }],
        },
        {
          modelKey: 'a/one',
          processes: [
            { ref: 'a/one#Z', processId: 'Z', name: 'Zeta', participantName: null },
            { ref: 'a/one#Q', processId: 'Q', name: null, participantName: null },
          ],
        },
      ]),
    ).toEqual([
      { ref: 'a/one#Q', name: 'Q', modelKey: 'a/one' },
      { ref: 'a/one#Z', name: 'Zeta', modelKey: 'a/one' },
      { ref: 'b/two#P', name: 'Pool', modelKey: 'b/two' },
    ]);
  });
});

describe('review actions and the bulk re-confirm', () => {
  const p = (o: Parameters<typeof placement>[0]) => placement(o);
  it('limits removed steps and missing processes to reject or correct', () => {
    expect(placementActions(p({ id: 'a', elementId: 's', process: 'm#P' }))).toMatchObject({
      accept: true,
      reject: true,
      hold: true,
      correct: true,
      limited: null,
    });
    expect(
      placementActions(
        p({
          id: 'a',
          elementId: 's',
          process: 'm#P',
          status: 'accepted',
          stepLive: false,
          endpointState: 'missing',
        }),
      ),
    ).toMatchObject({
      accept: false,
      hold: false,
      reject: true,
      correct: true,
      limited: 'removed-step',
    });
    expect(
      placementActions(
        p({
          id: 'a',
          elementId: 's',
          process: 'm#P',
          status: 'accepted',
          endpointState: 'missing',
          endpoints: { step: 'ok', process: 'missing' },
        }),
      ),
    ).toMatchObject({ accept: false, hold: false, limited: 'missing-process' });
    expect(
      placementActions(
        p({
          id: 'a',
          elementId: 's',
          process: 'm#P',
          status: 'accepted',
          endpointState: 'changed',
        }),
      ),
    ).toMatchObject({ accept: true, reconfirm: true });
    expect(
      placementActions(p({ id: 'a', elementId: 's', process: 'm#P', status: 'obsolete' })),
    ).toMatchObject({ accept: false, reject: false, hold: false, correct: false });
  });

  it('re-confirms changed acceptances on live steps; removed steps and missing processes apart', () => {
    const changed = p({
      id: 'c',
      elementId: 's',
      process: 'm#C',
      status: 'accepted',
      endpointState: 'changed',
    });
    const removed = p({
      id: 'r',
      elementId: 's',
      process: 'm#R',
      status: 'accepted',
      endpointState: 'missing',
      stepLive: false,
    });
    const gone = p({
      id: 'g',
      elementId: 's',
      process: 'm#G',
      status: 'accepted',
      endpointState: 'missing',
      endpoints: { step: 'ok', process: 'missing' },
    });
    const ok = p({ id: 'o', elementId: 's', process: 'm#O', status: 'accepted' });
    const proposed = p({ id: 'p', elementId: 's', process: 'm#P', endpointState: 'changed' });
    const { selectable, apart } = reconfirmCandidates([changed, removed, gone, ok, proposed]);
    expect(selectable.map((x) => x.id)).toEqual(['c']);
    expect(apart.map((x) => x.id)).toEqual(['r', 'g']);
  });
});

describe('saving', () => {
  const removed = impact({
    steps: {
      added: [{ elementId: 'n', name: 'Neu' }],
      removed: [
        {
          elementId: 'r',
          generation: 1,
          name: 'Alt',
          placements: { accepted: 1, held: 1, proposed: 2 },
        },
      ],
      changed: [
        {
          elementId: 'c',
          generation: 1,
          before: { name: 'Vorher', parentId: null, kind: 'core' },
          after: { name: 'Nachher', parentId: null, kind: 'core' },
          fingerprintChanged: true,
          placements: { accepted: 2, held: 0, proposed: 0 },
        },
        {
          elementId: 'k',
          generation: 1,
          before: { name: 'Farbe', parentId: null, kind: 'other' },
          after: { name: 'Farbe', parentId: null, kind: 'support' },
          fingerprintChanged: false,
          placements: { accepted: 1, held: 0, proposed: 0 },
        },
      ],
    },
    placements: { stranded: 2, toReconfirm: 2, proposalsWithdrawn: 2 },
  });

  it('asks when placements are stranded, sent to re-confirm or withdrawn', () => {
    expect(needsConfirmation(impact())).toBe(false);
    expect(
      needsConfirmation(
        impact({ placements: { stranded: 0, toReconfirm: 0, proposalsWithdrawn: 1 } }),
      ),
    ).toBe(true);
    expect(needsConfirmation(removed)).toBe(true);
    const summary = impactSummary(removed);
    expect(summary.removed).toEqual([
      { elementId: 'r', name: 'Alt', accepted: 1, held: 1, proposed: 2 },
    ]);
    expect(summary.changed.map((c) => [c.before, c.after, c.accepted])).toEqual([
      ['Vorher', 'Nachher', 2],
    ]);
    expect(summary.kindOnly.map((c) => c.elementId)).toEqual(['k']);
    expect(summary.added).toEqual([{ elementId: 'n', name: 'Neu' }]);
  });

  it('compares the save’s own impact with the dry run’s and words it', () => {
    expect(sameImpact(removed, structuredClone(removed))).toBe(true);
    expect(
      sameImpact(removed, { ...removed, placements: { ...removed.placements, stranded: 3 } }),
    ).toBe(false);
    expect(impactSentence(removed)).toBe(
      'Schritte: 1 neu, 1 entfernt, 2 geändert. 2 Platzierungen bleiben als offene Punkte; 2 Platzierungen musst du erneut bestätigen; 2 Vorschläge zurückgezogen.',
    );
    expect(impactSentence(impact())).toBe('Nur Layout geändert.');
  });

  it('reads the revision from the content ETag', () => {
    expect(revisionOfEtag('"r12"')).toBe(12);
    expect(revisionOfEtag('W/"r3"')).toBe(3);
    expect(revisionOfEtag('"12"')).toBeNull();
    expect(revisionOfEtag('"r0"')).toBeNull();
    expect(revisionOfEtag(null)).toBeNull();
  });

  it('pre-checks the canonical size and the counts only', () => {
    const doc = (elements: number, connections: number) =>
      JSON.stringify({
        elements: Array.from({ length: elements }, (_, i) => ({ id: `e${i}` })),
        connections: Array.from({ length: connections }, (_, i) => ({ id: `c${i}` })),
      });
    expect(precheck(doc(3, 2))).toMatchObject({ elements: 3, connections: 2, problems: [] });
    expect(precheck(doc(501, 0)).problems).toEqual([
      'Die Kette hat 501 Elemente, höchstens 500 sind erlaubt.',
    ]);
    expect(precheck(doc(0, 1001)).problems).toEqual([
      'Die Kette hat 1001 Verbindungen, höchstens 1.000 sind erlaubt.',
    ]);
    expect(precheck(`"${'x'.repeat(1024 * 1024)}"`).problems[0]).toMatch(
      /^Die Kette ist mit .* zu groß/,
    );
  });

  it('words violations in German and names the element', () => {
    expect(
      violationLine(
        { reason: 'sequence-cycle', elementId: 's1', connectionId: null, path: null, detail: 'x' },
        (id) => (id === 's1' ? 'Vertrieb' : null),
      ),
    ).toEqual({
      text: 'Die Vorgänger-Kette bildet einen Kreis.',
      elementId: 's1',
      connectionId: null,
      where: '„Vertrieb“ (s1)',
    });
    expect(
      violationLine(
        {
          reason: 'duplicate-connection',
          elementId: null,
          connectionId: 'c1',
          path: null,
          detail: 'x',
        },
        () => null,
      ).where,
    ).toBe('c1');
  });

  it('names downloads and the CLI command', () => {
    expect(documentFileName('demo', 3, false)).toBe('demo-r3.vc.json');
    expect(documentFileName('demo', 3, true)).toBe('demo-r3-entwurf.vc.json');
    expect(documentFileName('demo', null, true)).toBe('demo-entwurf.vc.json');
    expect(pushCommand('demo')).toBe('proa value-chain push kette.vc.json -p demo');
  });
});

describe('links and kinds', () => {
  it('builds and reads proa:process links', () => {
    expect(processLink('vertrieb/order#Process_Order')).toBe(
      'proa:process/vertrieb/order#Process_Order',
    );
    expect(parseLink(null)).toEqual({ mode: 'none', value: '' });
    expect(parseLink('proa:process/vertrieb/order#P')).toEqual({
      mode: 'process',
      value: 'vertrieb/order#P',
    });
    expect(parseLink('proa:process/kaputt')).toEqual({
      mode: 'other',
      value: 'proa:process/kaputt',
    });
    expect(parseLink('https://wiki/x')).toEqual({ mode: 'other', value: 'https://wiki/x' });
    expect(isWebUrl('https://wiki/x')).toBe(true);
    expect(isWebUrl('operations-detail')).toBe(false);
  });

  it('refuses empty, long, control and bidi links like the server', () => {
    expect(linkProblem('  ')).not.toBeNull();
    expect(linkProblem('x'.repeat(2001))).toBe('Höchstens 2.000 Zeichen.');
    expect(linkProblem('a\nb')).toMatch(/Steuer/);
    expect(linkProblem(`a${String.fromCharCode(0x202e)}b`)).toMatch(/Richtung/);
    expect(linkProblem('operations-detail')).toBeNull();
  });

  it('maps colours to kinds the way the server does', () => {
    expect(kindChoiceOf(undefined)).toBe('none');
    expect(kindChoiceOf('HSL(287,65%,44%)')).toBe('management');
    expect(kindChoiceOf('hsl(150, 86%, 34%)')).toBe('support');
    expect(kindChoiceOf('hsl(205, 100%, 45%)')).toBe('custom');
    expect(colorOfKind('management')).toBe('hsl(287, 65%, 44%)');
    expect(colorOfKind('none')).toBeUndefined();
  });
});

describe('ULIDs', () => {
  it('are 26 Crockford base32 characters, time first', () => {
    expect(ulid()).toMatch(ULID_PATTERN);
    expect(ulid(0, (b) => b.fill(0))).toBe('0'.repeat(26));
    expect(ulid(281474976710655, (b) => b.fill(255))).toBe('7ZZZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(ulid(1, (b) => b.fill(0)) > ulid(0, (b) => b.fill(255))).toBe(true);
  });

  it('do not repeat in 10,000 draws', () => {
    const seen = new Set(Array.from({ length: 10_000 }, () => ulid()));
    expect(seen.size).toBe(10_000);
  });
});
