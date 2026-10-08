// Renders eval:replay scores as Markdown (eval/reports/replay.md).
// Deterministic: no timestamps, stable order.
import type { ExpectedRelation } from './landscape.ts';
import { MAX_RECALL_DROP, MIN_LIVE_RUNS, SIM_AGENT, baselineLabel, type LiveGate } from './live-gate.ts';
import { formatRatio } from './score.ts';
import { HIGH_CONFIDENCE, type Metrics, type PairClass, type ProposedPair, type ReplayScore } from './replay-score.ts';

export interface ReplayReport {
  recordings: ReplayScore[];
  /** The live gate of every procedure version and landscape with live runs (`liveGates`). */
  liveGate: LiveGate[];
}

/** One console line per scored recording (eval:replay, eval:live). */
export function scoreLine(s: ReplayScore): string {
  return (
    `${s.file}: ${s.tasks.lines} tasks, ${s.pairs} pairs; precision ${formatRatio(s.overall.precision)}, ` +
    `recall ${formatRatio(s.overall.recall)} (∪ rules ${formatRatio(s.withRules.recall)}), ` +
    `F1 ${formatRatio(s.overall.f1)}; must_not_link ${s.mustNotLinkHits.length} ` +
    `(${s.mustNotLinkHighConfidence} at ≥ ${HIGH_CONFIDENCE}); ${s.questions.pairs} questions`
  );
}

const cell = (s: string | number): string => String(s).replaceAll('|', '\\|');

function table(header: string[], rows: Array<Array<string | number>>): string {
  return [
    `| ${header.map(cell).join(' | ')} |`,
    `|${header.map((_, i) => (i === 0 ? '---' : '--:')).join('|')}|`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

const of = (n: number, d: number): string => (d === 0 ? '–' : `${n}/${d}`);

const CLASSES: PairClass[] = ['must_link', 'may_link', 'must_not_link', 'unlisted', 'same_process'];

function metricRow(label: string, m: Metrics): Array<string | number> {
  return [
    label,
    of(m.found, m.mustLink),
    formatRatio(m.recall),
    formatRatio(m.precision),
    formatRatio(m.f1),
    m.mustNotLink,
    m.mayLink,
    m.unlisted,
    m.sameProcess,
  ];
}

const METRIC_HEADER = ['', 'must_link found', 'recall', 'precision', 'F1', 'must_not_link', 'may_link', 'unlisted', 'same process'];
/** Tags come from expected entries only: no unlisted or same-process columns. */
const TAG_HEADER = METRIC_HEADER.slice(0, -2);

function pairList(items: readonly ProposedPair[]): string {
  if (items.length === 0) return '_none_';
  return items
    .map(
      (p) =>
        `- \`${p.type}\` ${p.from} → ${p.to} (confidence ${p.confidence.toFixed(2)}` +
        `${p.question ? ', with a question' : ''}${p.tags.length > 0 ? `; ${p.tags.join(', ')}` : ''})`,
    )
    .join('\n');
}

function relationList(items: readonly ExpectedRelation[]): string {
  if (items.length === 0) return '_none_';
  return items.map((r) => `- \`${r.type}\` ${r.from} → ${r.to} (${r.tags.join(', ')})`).join('\n');
}

const counts = (r: Record<string, number>): string =>
  Object.entries(r)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ') || 'none';

function title(s: ReplayScore): string {
  return `${s.procedure} / ${s.agent} / ${s.llmModel} / ${s.landscape}`;
}

function section(s: ReplayScore): string {
  const parts: string[] = [];
  parts.push(`## ${title(s)}`);
  const invalid = Object.values(s.items.invalid).reduce((a, b) => a + b, 0);
  parts.push(
    `\`${s.file}\` · ${s.split}${s.closedWorld ? ', closed world' : ''} · ${s.tasks.lines} tasks on ` +
      `${s.tasks.models} of ${s.tasks.landscapeModels} models (${s.tasks.submitted} submitted, ` +
      `${s.tasks.dryRun} dry run, ${s.tasks.failed} failed) · ${s.items.total} proposals ` +
      `(outcomes: ${counts(s.items.outcomes)}; invalid ${invalid}${invalid > 0 ? `: ${counts(s.items.invalid)}` : ''}) ` +
      `on ${s.pairs} distinct pairs.`,
  );
  parts.push(
    table(METRIC_HEADER, [metricRow('proposals', s.overall), metricRow('proposals ∪ rule-tier acceptances', s.withRules)]),
  );
  parts.push('### By relation type');
  parts.push(table(METRIC_HEADER, Object.entries(s.byType).map(([k, m]) => metricRow(k, m))));
  parts.push('### By tag');
  parts.push(
    'Only expected entries carry tags, so precision within a tag counts must_not_link hits, not unlisted pairs.',
  );
  parts.push(table(TAG_HEADER, Object.entries(s.byTag).map(([k, m]) => metricRow(k, m).slice(0, -2))));
  parts.push('### Questions and no-links');
  parts.push(
    table(
      ['', ...CLASSES],
      [
        [`questions (${s.questions.pairs} pairs)`, ...CLASSES.map((c) => s.questions.byClass[c])],
        [`no-links (${s.noLinks.pairs} pairs)`, ...CLASSES.map((c) => s.noLinks.byClass[c])],
      ],
    ),
  );
  parts.push('### must_not_link proposed');
  parts.push(
    `${s.mustNotLinkHits.length} hits, ${s.mustNotLinkHighConfidence} with confidence ≥ ${HIGH_CONFIDENCE} ` +
      '(the live gate allows none).',
  );
  parts.push(pairList(s.mustNotLinkHits));
  parts.push('### Unlisted and same-process proposals');
  parts.push(pairList(s.unlistedPairs));
  parts.push('### must_link missed (neither proposed nor accepted by the rule tier)');
  parts.push(relationList(s.missed));
  parts.push('### must_link judged unrelated (no-links)');
  parts.push(relationList(s.noLinks.onMustLink));
  return parts.join('\n\n');
}

function liveGateSection(gates: readonly LiveGate[]): string {
  const parts: string[] = [];
  parts.push('## Live gate');
  parts.push(
    `Per procedure version and landscape, over the live runs (every agent but \`${SIM_AGENT}\`, one recording per ` +
      `run): **fail** if a run proposes a must_not_link pair with confidence ≥ ${HIGH_CONFIDENCE} or the mean recall ` +
      `is more than ${MAX_RECALL_DROP * 100} points below the baseline (the mean recall of the live runs of the ` +
      `highest earlier version of the procedure on that landscape, else the \`${SIM_AGENT}\` recording of the same ` +
      `version); else **incomplete** with fewer than ${MIN_LIVE_RUNS} runs or without a baseline; else **pass**. ` +
      'Recall and precision are the proposals\' (without the rule tier), averaged over the runs.',
  );
  if (gates.length === 0) {
    parts.push('_No live runs yet._');
    return parts.join('\n\n');
  }
  parts.push(
    table(
      [
        'Procedure / landscape',
        'split',
        'status',
        'runs',
        'precision',
        'recall',
        'F1',
        'baseline recall',
        'baseline',
        `must_not_link ≥ ${HIGH_CONFIDENCE}`,
      ],
      gates.map((g) => [
        `${g.procedure} / ${g.landscape}`,
        g.split,
        g.status,
        g.runs,
        formatRatio(g.precision),
        formatRatio(g.recall),
        formatRatio(g.f1),
        formatRatio(g.baseline.recall),
        baselineLabel(g.baseline),
        g.mustNotLinkHighConfidence,
      ]),
    ),
  );
  const reasons = gates
    .filter((g) => g.reasons.length > 0)
    .map((g) => `- ${g.procedure} / ${g.landscape}: ${g.status}: ${g.reasons.join('; ')}`);
  if (reasons.length > 0) parts.push(reasons.join('\n'));
  return parts.join('\n\n');
}

export function renderReplayMarkdown(report: ReplayReport): string {
  const parts: string[] = [];
  parts.push('# eval:replay');
  parts.push(
    'Generated by `pnpm eval:replay` (eval/tools/src/replay.ts); do not edit. Scores the recorded ' +
      'submissions in `eval/recordings` (CONCEPT §7: `<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl`) ' +
      "against each landscape's `expected.yaml`. The agent's link set is the union of the valid proposals of " +
      'all its submissions, by `(from, to)`. Precision counts must_not_link, same-process and (closed world) ' +
      'unlisted pairs as false positives; may_link pairs are neutral. Recall counts must_link pairs; ' +
      '"∪ rule-tier acceptances" adds the unambiguous calls the rule tier accepts at ingest, which agents ' +
      'do not propose again.',
  );
  if (report.recordings.length === 0) {
    parts.push('_No recordings._');
    return `${parts.join('\n\n')}\n`;
  }
  parts.push(
    table(
      [
        'Recording',
        'split',
        'tasks',
        'pairs',
        'precision',
        'recall',
        'F1',
        'recall ∪ rules',
        `must_not_link (≥ ${HIGH_CONFIDENCE})`,
        'questions',
        'no-links',
        'invalid',
      ],
      report.recordings.map((s) => [
        title(s),
        s.split,
        s.tasks.lines,
        s.pairs,
        formatRatio(s.overall.precision),
        formatRatio(s.overall.recall),
        formatRatio(s.overall.f1),
        formatRatio(s.withRules.recall),
        `${s.mustNotLinkHits.length} (${s.mustNotLinkHighConfidence})`,
        s.questions.pairs,
        s.noLinks.pairs,
        Object.values(s.items.invalid).reduce((a, b) => a + b, 0),
      ]),
    ),
  );
  parts.push(liveGateSection(report.liveGate));
  for (const s of report.recordings) parts.push(section(s));
  return `${parts.join('\n\n')}\n`;
}
