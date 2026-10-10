// Renders eval:placements scores as Markdown (eval/reports/placements.md).
// Deterministic: no timestamps, stable order, ratios through formatRatio.
// A holdout landscape shows aggregate numbers only: redactHoldout leaves out
// its items, its rule tier and its small tags, so they cannot be rendered.
import {
  BASELINE_PREFIX,
  PREFIX_ANCESTOR_VOTE,
  PREFIX_ANCESTOR_WEIGHT,
  PREFIX_FOLDER_WEIGHT,
  PREFIX_NAME_WEIGHT,
  PREFIX_TOP,
  PREFIX_VOTE,
  RULES_VERSION,
} from '@proa/relations';

import {
  HOLDOUT_MIN_GROUP,
  type Cut,
  type Metrics,
  type PlacementScore,
  type ScoredItem,
  type SystemScore,
} from './placements-score.ts';
import { HIGH_CONFIDENCE } from './replay-score.ts';
import { formatRatio } from './score.ts';

export interface PlacementsReport {
  pass: boolean;
  landscapes: PlacementScore[];
}

/** Where the ProA rules check of the golden chains runs (not in eval:placements: it needs the server's prepareRevision). */
export const PROA_RULES_CHECK = 'apps/server/test/unit/value-chain-golden.test.ts';

const cell = (s: string | number): string => String(s).replaceAll('|', '\\|');

function table(header: string[], rows: Array<Array<string | number>>): string {
  return [
    `| ${header.map(cell).join(' | ')} |`,
    `|${header.map((_, i) => (i === 0 ? '---' : '--:')).join('|')}|`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

const of = (n: number, d: number): string => (d === 0 ? '–' : `${n}/${d}`);

function cutRow(label: string, c: Cut | null, m: Metrics): Array<string | number> {
  if (c === null) return [label, '–', '–', '–', '–', '–', '–', '–', '–', '–', '–', '–'];
  return [
    label,
    c.proposals,
    c.hit,
    c.may,
    c.coarse,
    c.trap,
    c.wrong,
    c.none,
    formatRatio(c.precision),
    `${formatRatio(c.recall)} (${c.hit}/${m.processes})`,
    formatRatio(c.f1),
    `${formatRatio(c.trapRate)} (${of(c.trapProcesses, m.withTraps)})`,
  ];
}

const CUT_HEADER = ['System', 'proposals', 'hit', 'may', 'coarse', 'trap', 'wrong', 'none', 'precision', 'recall', 'F1', 'trap rate'];

function levelRow(label: string, s: SystemScore, pick: (m: Metrics) => Cut | null): Array<string | number> {
  const leaf = pick(s.leaf);
  const area = pick(s.area);
  return [
    label,
    formatRatio(leaf?.recall ?? null),
    formatRatio(leaf?.precision ?? null),
    formatRatio(area?.recall ?? null),
    formatRatio(area?.precision ?? null),
  ];
}

/** The tags with numbers: all of them, for the holdout those redactHoldout kept. */
function shownTags(s: PlacementScore): Array<[string, number]> {
  return Object.entries(s.counts.tags).filter(([tag]) => tag in s.systems.baseline.byTag);
}

function tagTable(s: PlacementScore): string {
  const { baseline, baselineNoVotes, rules } = s.systems;
  const rows = shownTags(s).map(([tag, n]) => {
    const b = baseline.byTag[tag];
    const nv = baselineNoVotes.byTag[tag];
    const r = rules?.byTag[tag];
    return [
      tag,
      n,
      ...(rules ? [r ? `${r.all.hit}/${r.all.proposals}` : '–'] : []),
      formatRatio(b?.at1?.recall ?? null),
      formatRatio(b?.at3?.recall ?? null),
      formatRatio(b?.at1?.precision ?? null),
      b?.at1 ? of(b.at1.trapProcesses, b.withTraps) : '–',
      formatRatio(nv?.at1?.recall ?? null),
      formatRatio(nv?.at3?.recall ?? null),
    ];
  });
  if (rows.length === 0) return '_none_';
  return table(
    [
      'Tag',
      'processes',
      ...(rules ? ['rule hits/proposals'] : []),
      'baseline recall@1',
      'recall@3',
      'precision@1',
      'trap hits@1',
      'no votes: recall@1',
      'recall@3',
    ],
    rows,
  );
}

function itemList(items: readonly ScoredItem[], withClass = false): string {
  if (items.length === 0) return '_none_';
  return items
    .map(
      (i) =>
        `- ${i.process} → \`${i.step}\`${withClass ? ` (${i.class})` : ''}${i.tags.length > 0 ? ` [${i.tags.join(', ')}]` : ''}`,
    )
    .join('\n');
}

function missedAt3(s: SystemScore): string[] {
  const found = new Set((s.items ?? []).filter((i) => i.rank !== null && i.rank <= 3 && i.class === 'hit').map((i) => i.process));
  return [...new Set((s.items ?? []).map((i) => i.process))].filter((p) => !found.has(p));
}

function devLists(s: PlacementScore): string[] {
  const { rules, baseline, baselineNoVotes } = s.systems;
  const parts: string[] = [];
  parts.push('### Rule proposals');
  parts.push(itemList(rules?.items ?? [], true));
  const top1 = (sys: SystemScore) => (sys.items ?? []).filter((i) => i.rank === 1);
  for (const [label, sys] of [
    ['with votes', baseline],
    ['without votes', baselineNoVotes],
  ] as const) {
    parts.push(`### ${BASELINE_PREFIX} ${label}: top-1 traps`);
    parts.push(itemList(top1(sys).filter((i) => i.class === 'trap')));
    parts.push(`### ${BASELINE_PREFIX} ${label}: top-1 wrong`);
    parts.push(itemList(top1(sys).filter((i) => i.class === 'wrong')));
  }
  parts.push(`### ${BASELINE_PREFIX} with votes: musts missed at @3`);
  parts.push('Processes with hints but none on the must (processes without any hint are counted as `none`).');
  const missed = missedAt3(baseline);
  parts.push(missed.length === 0 ? '_none_' : missed.map((p) => `- ${p}`).join('\n'));
  parts.push(`### ${BASELINE_PREFIX}: steps that attract wrong proposals`);
  parts.push('Trap and wrong proposals at ranks ≤ 3, with and without votes.');
  const counts = new Map<string, [number, number]>();
  for (const [i, sys] of [baseline, baselineNoVotes].entries()) {
    for (const item of sys.items ?? []) {
      if (item.class !== 'trap' && item.class !== 'wrong') continue;
      const c = counts.get(item.step) ?? [0, 0];
      c[i] = (c[i] ?? 0) + 1;
      counts.set(item.step, c);
    }
  }
  const rows = [...counts]
    .sort(([a, x], [b, y]) => y[0] + y[1] - (x[0] + x[1]) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([step, [v, nv]]) => [`\`${step}\``, v, nv]);
  parts.push(rows.length === 0 ? '_none_' : table(['Step', 'with votes', 'without votes'], rows));
  return parts;
}

function landscapeSection(s: PlacementScore): string {
  const { rules, baseline, baselineNoVotes } = s.systems;
  const c = s.counts;
  const parts: string[] = [];
  parts.push(`## ${s.name} (${s.split})`);
  parts.push(
    `${c.steps} steps (${c.topLevel} top-level), ${c.processes} process facts; golden: ${c.placements} placements ` +
      `(${c.outside} \`@outside\`), ${c.may} may, ${c.mustNot} must_not.`,
  );
  parts.push('### Gates');
  parts.push(
    table(
      ['Gate', 'Value', 'Target', 'Result'],
      s.gates.map((g) => [g.title, g.value, g.target, g.pass ? 'pass' : '**FAIL**']),
    ),
  );
  parts.push('### Systems');
  parts.push(
    'Top-1 is each process\'s best hint; top-3 every hint. Precision = hit / (hit + trap + wrong); may and coarse ' +
      'are neutral; recall over every (process, must) pair, `@outside` included; trap rate = processes with a trap ' +
      'proposal / processes with must_not.',
  );
  parts.push(
    table(CUT_HEADER, [
      ...(rules ? [cutRow(`rule tier (${RULES_VERSION}: key proposals)`, rules.leaf.all, rules.leaf)] : []),
      cutRow(`${BASELINE_PREFIX} top-1`, baseline.leaf.at1, baseline.leaf),
      cutRow(`${BASELINE_PREFIX} top-3`, baseline.leaf.at3, baseline.leaf),
      cutRow(`${BASELINE_PREFIX} top-1, no votes`, baselineNoVotes.leaf.at1, baselineNoVotes.leaf),
      cutRow(`${BASELINE_PREFIX} top-3, no votes`, baselineNoVotes.leaf.at3, baselineNoVotes.leaf),
    ]),
  );
  parts.push('### Leaf and level 0');
  parts.push(
    'Level 0 compares top-level areas: the proposal\'s area against the must\'s area (`@outside` is its own area), ' +
      'the may steps\' areas and the top-level must_not steps.',
  );
  parts.push(
    table(
      ['System', 'leaf recall', 'leaf precision', 'level-0 recall', 'level-0 precision'],
      [
        ...(rules ? [levelRow('rule tier', rules, (m) => m.all)] : []),
        levelRow(`${BASELINE_PREFIX} top-1`, baseline, (m) => m.at1),
        levelRow(`${BASELINE_PREFIX} top-3`, baseline, (m) => m.at3),
        levelRow(`${BASELINE_PREFIX} top-1, no votes`, baselineNoVotes, (m) => m.at1),
        levelRow(`${BASELINE_PREFIX} top-3, no votes`, baselineNoVotes, (m) => m.at3),
      ],
    ),
  );
  parts.push('### By tag');
  parts.push(tagTable(s));
  const tags = Object.keys(s.counts.tags).length;
  const hidden = tags - shownTags(s).length;
  if (hidden > 0) parts.push(`${hidden} of ${tags} tags left out (fewer than ${HOLDOUT_MIN_GROUP} processes).`);
  if (s.note !== undefined) parts.push(`_${s.note}._`);
  else parts.push(...devLists(s));
  return parts.join('\n\n');
}

export function renderPlacementsMarkdown(report: PlacementsReport): string {
  const parts: string[] = [];
  parts.push('# eval:placements');
  parts.push(
    'Generated by `pnpm eval:placements` (eval/tools/src/placements.ts); do not edit. The LLM-free placement eval ' +
      'of M4-VALUE-CHAIN.md §6 over every scored landscape: the golden chains and placements in ' +
      '`eval/value-chains` against the process facts of `eval/corpus`.',
  );
  parts.push(
    '**Gates** per landscape: `validate-value-chains.mjs <landscape>` exits 0; the golden placements name exactly ' +
      'the process facts; every key-tier rule proposal derived from the golden chain ' +
      `(${RULES_VERSION}, \`derivePlacementRules\`) is the process's must or one of its may steps. The ProA rules ` +
      `on the golden chains run in \`pnpm test\`: ${PROA_RULES_CHECK}. The baselines are a floor, not a gate; this ` +
      'report and the CI drift check pin their numbers.',
  );
  parts.push(
    table(
      ['Proposal', 'Class', 'Counts as'],
      [
        ['the must step (or `@outside` where that is the must)', 'hit', 'recall, precision'],
        ['a may step', 'may', 'neutral'],
        ['an ancestor of the must step', 'coarse', 'neutral, reported'],
        ['a step in a must_not subtree', 'trap', 'false positive, trap hit'],
        ['any other step, or `@outside` where it is neither must nor may', 'wrong', 'false positive (closed world)'],
        ['no proposal for a process', 'none', 'miss'],
      ],
    ),
  );
  parts.push(
    `**${BASELINE_PREFIX}** (frozen, \`@proa/relations\`): ${PREFIX_NAME_WEIGHT} × process name or file stem words ` +
      `on the step's name + ${PREFIX_ANCESTOR_WEIGHT} × on an ancestor's name + ${PREFIX_FOLDER_WEIGHT} × model key ` +
      `folder words on the step or an ancestor + ${PREFIX_VOTE} per neighbour known on the step, ` +
      `${PREFIX_ANCESTOR_VOTE} per neighbour known below it; top ${PREFIX_TOP}. With votes, neighbours are the ` +
      'must_link neighbours of expected.yaml and a neighbour is known on its golden must (leave-one-out: a ' +
      'process\'s own must is never read; `@outside` never votes); without votes neither, as a fresh project\'s ' +
      `hints. Live gate (M4b, not here): no must_not at confidence ≥ ${HIGH_CONFIDENCE}, recall at least 20 points ` +
      'above the baseline.',
  );
  parts.push(`**Result: ${report.pass ? 'pass' : 'FAIL'}**`);
  parts.push(
    table(
      [
        'Landscape',
        'split',
        'processes',
        'validator',
        'coverage',
        'rule proposals (hit/may/other)',
        'baseline recall@1',
        'recall@3',
        'precision@1',
        'area recall@1',
        'recall@1 no votes',
        'result',
      ],
      report.landscapes.map((s) => {
        const gate = (id: string) => s.gates.find((g) => g.id === id);
        const r = s.systems.rules?.leaf.all;
        const b = s.systems.baseline;
        return [
          s.name,
          s.split,
          s.counts.processes,
          gate('validator')?.pass ? 'ok' : '**FAIL**',
          gate('coverage')?.pass ? 'ok' : '**FAIL**',
          r ? `${r.hit}/${r.may}/${r.coarse + r.trap + r.wrong}` : `${s.counts.ruleProposals} (not split)`,
          formatRatio(b.leaf.at1?.recall ?? null),
          formatRatio(b.leaf.at3?.recall ?? null),
          formatRatio(b.leaf.at1?.precision ?? null),
          formatRatio(b.area.at1?.recall ?? null),
          formatRatio(s.systems.baselineNoVotes.leaf.at1?.recall ?? null),
          s.pass ? 'pass' : '**FAIL**',
        ];
      }),
    ),
  );
  for (const s of report.landscapes) parts.push(landscapeSection(s));
  return `${parts.join('\n\n')}\n`;
}
