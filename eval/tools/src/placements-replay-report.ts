// Renders the placement part of eval:replay (eval/reports/replay.md, after the
// relations sections) and its console lines. Deterministic: no timestamps,
// stable order. A holdout recording shows aggregate numbers only: its score
// carries no items and no small tags (placements-replay.ts), and this module
// renders no per-item list for it.
import { BASELINE_PREFIX } from '@proa/relations';

import { renderPlacementWhatIf, type PlacementWhatIf } from './auto-accept-whatif.ts';
import { MIN_LIVE_RUNS, SIM_AGENT, gateLabel } from './live-gate.ts';
import { PLACEMENT_RECALL_MARGIN, type PlacementLiveGate } from './placement-live-gate.ts';
import { HOLDOUT_MIN_GROUP, type ScoredItem } from './placements-score.ts';
import type {
  MissedProcess,
  PlacementBaselines,
  PlacementNumbers,
  PlacementReplay,
  PlacementReplayScore,
} from './placements-replay.ts';
import { HIGH_CONFIDENCE } from './replay-score.ts';
import { formatRatio } from './score.ts';

/** The placement part of the replay report (`replay.json` key `placements`). */
export interface PlacementReplayReport extends PlacementReplay {
  /** The placement live gate of every procedure version, landscape and declared model with live runs. */
  liveGate: PlacementLiveGate[];
}

const cell = (s: string | number): string => String(s).replaceAll('|', '\\|');

function table(header: string[], rows: Array<Array<string | number>>): string {
  return [
    `| ${header.map(cell).join(' | ')} |`,
    `|${header.map((_, i) => (i === 0 ? '---' : '--:')).join('|')}|`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

const counts = (r: Record<string, number>): string =>
  Object.entries(r)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ') || 'none';

/** `1 task`, `2 tasks`. */
const tasks = (n: number, what = 'task'): string => `${n} ${what}${n === 1 ? '' : 's'}`;

function title(s: PlacementReplayScore): string {
  return `${s.procedure} / ${s.agent} / ${s.llmModel} / ${s.landscape}`;
}

/** One console line per scored placement recording (eval:replay, eval:live). */
export function placementScoreLine(s: PlacementReplayScore, b?: PlacementBaselines): string {
  const n = s.numbers;
  const baseline = b
    ? ` (${BASELINE_PREFIX} ${formatRatio(b.withVotes.recallAt1)} with votes, ${formatRatio(b.withoutVotes.recallAt1)} without)`
    : '';
  return (
    `${s.file}: ${tasks(s.tasks.lines)}, ${n.proposals} placements; precision ${formatRatio(n.precision)}, ` +
    `recall ${formatRatio(n.recall)}, recall@1 ${formatRatio(n.recallAt1)}${baseline}, ` +
    `area recall@1 ${formatRatio(n.areaRecallAt1)}, F1 ${formatRatio(n.f1)}; trap rate ${formatRatio(n.trapRate)} ` +
    `(${n.trapsHighConfidence} at ≥ ${HIGH_CONFIDENCE}); ${s.unsure} unsure, ${s.skipped} skipped, ${s.invalid} invalid`
  );
}

const NUMBER_HEADER = [
  'placements',
  'precision',
  'recall',
  'recall@1',
  'recall@3',
  'area recall@1',
  'F1',
  'trap rate',
  `traps ≥ ${HIGH_CONFIDENCE}`,
];

function numberCells(n: PlacementNumbers): Array<string | number> {
  return [
    n.proposals,
    formatRatio(n.precision),
    formatRatio(n.recall),
    formatRatio(n.recallAt1),
    formatRatio(n.recallAt3),
    formatRatio(n.areaRecallAt1),
    formatRatio(n.f1),
    formatRatio(n.trapRate),
    n.trapsHighConfidence,
  ];
}

function itemList(items: readonly ScoredItem[]): string {
  if (items.length === 0) return '_none_';
  return items
    .map(
      (i) =>
        `- ${i.process} → \`${i.step}\` (${i.class}, confidence ${(i.confidence ?? 0).toFixed(2)}` +
        `${i.tags.length > 0 ? `; ${i.tags.join(', ')}` : ''})`,
    )
    .join('\n');
}

function missedList(items: readonly MissedProcess[]): string {
  if (items.length === 0) return '_none_';
  return items
    .map((m) => `- ${m.process}: ${m.top === null ? m.class : `\`${m.top}\` (${m.class})`}`)
    .join('\n');
}

function liveGateSection(gates: readonly PlacementLiveGate[]): string {
  const parts: string[] = [];
  parts.push('## Placement live gate');
  parts.push(
    `Per procedure version, landscape and declared llmModel, over the live runs (every agent but \`${SIM_AGENT}\`, ` +
      `one recording per run): **fail** if a run places a process on a must_not step with confidence ≥ ` +
      `${HIGH_CONFIDENCE}, or the mean recall@1 is below the higher recall@1 of the two ${BASELINE_PREFIX} rows ` +
      `(with and without votes) plus ${PLACEMENT_RECALL_MARGIN * 100} points; else **incomplete** with fewer than ` +
      `${MIN_LIVE_RUNS} runs; else **pass**.`,
  );
  if (gates.length === 0) {
    parts.push('_No live runs yet._');
    return parts.join('\n\n');
  }
  parts.push(
    table(
      [
        'Procedure / landscape / llmModel',
        'split',
        'status',
        'runs',
        'recall@1',
        'bar',
        'baseline with votes',
        'without votes',
        'precision',
        'recall',
        `must_not ≥ ${HIGH_CONFIDENCE}`,
      ],
      gates.map((g) => [
        gateLabel(g),
        g.split,
        g.status,
        g.runs,
        formatRatio(g.recallAt1),
        formatRatio(g.baseline.bar),
        formatRatio(g.baseline.withVotes),
        formatRatio(g.baseline.withoutVotes),
        formatRatio(g.precision),
        formatRatio(g.recall),
        g.trapsHighConfidence,
      ]),
    ),
  );
  const reasons = gates
    .filter((g) => g.reasons.length > 0)
    .map((g) => `- ${gateLabel(g)}: ${g.status}: ${g.reasons.join('; ')}`);
  if (reasons.length > 0) parts.push(reasons.join('\n'));
  return parts.join('\n\n');
}

function section(s: PlacementReplayScore, b: PlacementBaselines | undefined): string {
  const parts: string[] = [];
  parts.push(`## ${title(s)}`);
  parts.push(
    `\`${s.file}\` · ${s.split} · ${tasks(s.tasks.lines, 'placement task')} (${s.tasks.submitted} submitted, ` +
      `${s.tasks.dryRun} dry run, ${s.tasks.failed} failed, ${s.tasks.followUps} queued a follow-up) on chain ` +
      `${s.valueChain.revs.map((r) => `r${r}`).join(', ')} (the golden chain) · ${s.items.total} placement items ` +
      `(outcomes: ${counts(s.items.outcomes)}${s.invalid > 0 ? `; invalid: ${counts(s.items.invalid)}` : ''}) · ` +
      `${s.questions} with a question, ${s.outside} on \`@outside\` · ${s.unsure} unsure, ${s.skipped} skipped, ` +
      `${s.processes} processes.`,
  );
  parts.push(
    table(
      ['', ...NUMBER_HEADER],
      [
        ['this run (ranked by confidence)', ...numberCells(s.numbers)],
        ...(b
          ? [
              [`${BASELINE_PREFIX} with votes`, ...numberCells(b.withVotes)],
              [`${BASELINE_PREFIX} without votes`, ...numberCells(b.withoutVotes)],
            ]
          : []),
      ],
    ),
  );
  parts.push('### By tag');
  const tags = Object.entries(s.system.byTag);
  parts.push(
    tags.length === 0
      ? '_none_'
      : table(
          ['Tag', 'processes', 'recall', 'recall@1', 'precision', 'trap processes'],
          tags.map(([tag, m]) => [
            tag,
            m.processes,
            formatRatio(m.all.recall),
            formatRatio(m.at1?.recall ?? null),
            formatRatio(m.all.precision),
            `${m.all.trapProcesses}/${m.withTraps}`,
          ]),
        ),
  );
  if (s.note !== undefined || !s.lists) {
    parts.push(
      `_${s.note ?? `aggregate numbers only (tags with at least ${HOLDOUT_MIN_GROUP} processes)`}._`,
    );
    return parts.join('\n\n');
  }
  parts.push('### Traps');
  parts.push(itemList(s.lists.traps));
  parts.push('### Wrong top-1');
  parts.push(itemList(s.lists.wrongAt1));
  parts.push('### Musts missed (the top-ranked step, `unsure` or `none`)');
  parts.push(missedList(s.lists.missed));
  return parts.join('\n\n');
}

/**
 * The placement sections of replay.md (summary, baselines, live gate, one
 * section per recording) and, when given, the auto-accept what-if after them.
 */
export function renderPlacementReplaySections(
  report: PlacementReplayReport,
  whatIf?: readonly PlacementWhatIf[],
): string[] {
  const parts: string[] = [];
  parts.push('## Placements');
  parts.push(
    'Recorded submissions of `placement` tasks (M4-VALUE-CHAIN.md §6), scored with the eval:placements scorer ' +
      "against each landscape's `expected-placements.yaml`. A recording counts only on the golden chain: every " +
      "line's chain content hash must be the golden file's (else eval:replay exits 1). The run's placements are " +
      'the union of its valid items (applied, duplicate, suppressed, reopened; `@outside` included), one per ' +
      '(process, step) with its highest confidence, ranked per process by confidence (ties by step id). Precision ' +
      '= hit / (hit + trap + wrong) (may and coarse are neutral); recall over every (process, must) pair; recall@1 ' +
      `over each process's most confident step; area recall@1 by top-level area; traps ≥ ${HIGH_CONFIDENCE} are ` +
      `what the live gate allows none of. Holdout recordings show aggregate numbers only, per-tag numbers only for ` +
      `tags with at least ${HOLDOUT_MIN_GROUP} processes.`,
  );
  const baselineOf = (landscape: string) => report.baselines.find((b) => b.landscape === landscape);
  parts.push(
    table(
      ['Recording', 'split', 'tasks', ...NUMBER_HEADER, 'unsure', 'skipped', 'invalid'],
      report.recordings.map((s) => [
        title(s),
        s.split,
        s.tasks.lines,
        ...numberCells(s.numbers),
        s.unsure,
        s.skipped,
        s.invalid,
      ]),
    ),
  );
  parts.push('### Baselines');
  parts.push(
    `${BASELINE_PREFIX} on the golden chain (eval:placements): top-1 and top-3 hints, with votes (the must_link ` +
      "neighbours known on their golden musts) and without (a fresh project's hints).",
  );
  parts.push(
    table(
      ['Landscape', 'split', 'processes', 'row', ...NUMBER_HEADER],
      report.baselines.flatMap((b) => [
        [b.landscape, b.split, b.processes, 'with votes', ...numberCells(b.withVotes)],
        [b.landscape, b.split, b.processes, 'without votes', ...numberCells(b.withoutVotes)],
      ]),
    ),
  );
  parts.push(liveGateSection(report.liveGate));
  for (const s of report.recordings) parts.push(section(s, baselineOf(s.landscape)));
  if (whatIf) parts.push(renderPlacementWhatIf(whatIf));
  return parts;
}
