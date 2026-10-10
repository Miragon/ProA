// Renders eval:candidates scores as Markdown (eval/reports/candidates.md).
// Deterministic: no timestamps, stable order.
import {
  DEFAULT_COMPATIBLE_PER_ENDPOINT,
  DEFAULT_LEXICAL_PER_ENDPOINT,
  PROA1_MAX_DISTANCE,
  RULES_VERSION,
} from '@proa/relations';

import type { ExpectedRelation } from './landscape.ts';
import {
  MUST_LINK_RECALL_TARGET,
  formatRatio,
  type GroupMetrics,
  type LandscapeScore,
  type SystemMetrics,
} from './score.ts';

export interface EvalReport {
  pass: boolean;
  landscapes: LandscapeScore[];
}

const cell = (s: string | number): string => String(s).replaceAll('|', '\\|');

function table(header: string[], rows: Array<Array<string | number>>): string {
  const lines = [
    `| ${header.map(cell).join(' | ')} |`,
    `|${header.map((_, i) => (i === 0 ? '---' : '--:')).join('|')}|`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ];
  return lines.join('\n');
}

const of = (n: number, d: number): string => (d === 0 ? '–' : `${n}/${d}`);

function pct(n: number, d: number): string {
  return d === 0 ? '–' : `${((n / d) * 100).toFixed(0)} % (${n}/${d})`;
}

function systemRow(
  label: string,
  s: SystemMetrics,
  mustLinkTotal: number,
  precision: boolean,
): Array<string | number> {
  return [
    label,
    s.pairs,
    pct(s.mustLink, mustLinkTotal),
    s.mayLink,
    s.mustNotLink,
    s.unlisted,
    s.sameProcess,
    precision ? formatRatio(s.precision) : '–',
  ];
}

function groupRows(groups: Record<string, GroupMetrics>): Array<Array<string | number>> {
  return Object.entries(groups).map(([name, g]) => [
    name,
    g.mustLink === 0 ? '–' : `${g.mustLinkCandidates}/${g.mustLink}`,
    g.mustLink === 0 ? '–' : `${g.mustLinkKeyLexical}/${g.mustLink}`,
    g.mustLink === 0 ? '–' : `${g.mustLinkRules}/${g.mustLink}`,
    g.mustLink === 0 ? '–' : `${g.mustLinkBaseline}/${g.mustLink}`,
    of(g.ruleAcceptedCorrect, g.ruleAccepted),
    g.mustNotLink === 0 ? '–' : `${g.mustNotLinkAccepted}/${g.mustNotLink}`,
    g.mustNotLink === 0 ? '–' : `${g.mustNotLinkRules}/${g.mustNotLink}`,
    g.mustNotLink === 0 ? '–' : `${g.mustNotLinkKeyLexical}/${g.mustNotLink}`,
    g.mustNotLink === 0 ? '–' : `${g.mustNotLinkBaseline}/${g.mustNotLink}`,
    g.mayLink === 0 ? '–' : `${g.mayLinkCandidates}/${g.mayLink}`,
  ]);
}

const GROUP_HEADER = [
  '',
  'must_link in rules ∪ candidates',
  'in rules ∪ key/lexical',
  'in rules',
  'baseline',
  'rule-accepted correct',
  'must_not_link accepted',
  'proposed by rules',
  'in key/lexical',
  'baseline',
  'may_link in candidates',
];

function relationList(items: readonly ExpectedRelation[]): string {
  if (items.length === 0) return '_none_';
  return items.map((r) => `- \`${r.type}\` ${r.from} → ${r.to} (${r.tags.join(', ')})`).join('\n');
}

function landscapeSection(s: LandscapeScore): string {
  const parts: string[] = [];
  parts.push(`## ${s.name} (${s.split}, ${s.lang}${s.closedWorld ? ', closed world' : ''})`);
  parts.push(
    `${s.counts.models} models, ${s.counts.processes} processes, ${s.counts.facts} facts; expected: ` +
      `${s.counts.expected.must_link} must_link, ${s.counts.expected.must_not_link} must_not_link, ` +
      `${s.counts.expected.may_link} may_link, ${s.counts.findings} findings. Rule tier: ` +
      `${s.counts.rules.accepted} accepted, ${s.counts.rules.proposed} proposed. Candidates: ` +
      `${s.counts.candidates.total} (rule ${s.counts.candidates.rule}, key ${s.counts.candidates.key}, ` +
      `lexical ${s.counts.candidates.lexical}, compatible ${s.counts.candidates.compatible}). ` +
      `baseline-proa1: ${s.counts.baseline} pairs.`,
  );
  parts.push('### Gates');
  parts.push(
    table(
      ['Gate', 'Value', 'Target', 'Result'],
      s.gates.map((g) => [g.title, g.value, g.target, g.pass ? 'pass' : '**FAIL**']),
    ),
  );
  const ml = s.counts.expected.must_link;
  parts.push('### ProA 2.0 vs baseline-proa1');
  parts.push(
    'Pairs are compared by `(from, to)`. Unlisted cross-process pairs count as false positives ' +
      '(closed world); same-process pairs are never relations. Precision is shown for the systems ' +
      'that propose relations; the candidate pools are input for agents, who judge them.',
  );
  parts.push(
    table(
      ['System', 'pairs', 'must_link recall', 'may_link', 'must_not_link', 'unlisted', 'same process', 'precision'],
      [
        systemRow(`rule tier (${RULES_VERSION}: accepted + key proposals)`, s.systems.rules, ml, true),
        systemRow('rules ∪ key/lexical candidates', s.systems.keyLexical, ml, false),
        systemRow('rules ∪ all candidates (gate)', s.systems.candidates, ml, false),
        systemRow(`baseline-proa1 (Levenshtein ≤ ${PROA1_MAX_DISTANCE})`, s.systems.baseline, ml, true),
      ],
    ),
  );
  parts.push('### By relation type');
  parts.push(table(GROUP_HEADER, groupRows(s.byType)));
  parts.push('### By tag');
  parts.push(table(GROUP_HEADER, groupRows(s.byTag)));
  parts.push('### must_link outside rules ∪ candidates');
  parts.push(relationList(s.mustLinkMissed));
  parts.push('### must_link reached only through the compatible basis');
  parts.push(
    'Semantic links without lexical evidence: agents find them among the further compatible endpoints.',
  );
  parts.push(relationList(s.mustLinkOnlyCompatible));
  parts.push('### must_not_link proposed by the rule tier');
  parts.push(
    'Key-tier proposals on reused names (never accepted automatically; reviewers reject them).',
  );
  parts.push(relationList(s.mustNotLinkProposed));
  parts.push('### Findings');
  parts.push(
    table(
      ['Kind', 'mode', 'expected', 'computed', 'missing', 'unexpected', 'explained extras'],
      s.findings.map((f) => [
        f.kind,
        f.mode,
        f.expected.length,
        f.computed.length,
        f.missing.join(', ') || '–',
        f.unexpected.join(', ') || '–',
        f.explained.length,
      ]),
    ),
  );
  const explained = s.findings.flatMap((f) =>
    f.explained.map((e) => `- \`${f.kind}\` ${e.finding}: linked by ${e.links.join('; ')}`),
  );
  if (explained.length > 0) {
    parts.push(
      'Explained extras: the rule tier sees names only, so it reports these endpoints; the ground ' +
        'truth links them semantically (agents propose such links).',
    );
    parts.push(explained.join('\n'));
  }
  parts.push('### baseline-proa1: must_not_link hits');
  parts.push(relationList(s.baselineMustNotLink));
  parts.push('### baseline-proa1: must_link misses');
  parts.push(relationList(s.baselineMissed));
  return parts.join('\n\n');
}

export function renderMarkdown(report: EvalReport): string {
  const parts: string[] = [];
  parts.push('# eval:candidates');
  parts.push(
    'Generated by `pnpm eval:candidates` (eval/tools/src/candidates.ts); do not edit. The LLM-free ' +
      'gate of CONCEPT §7 over every scored landscape in `eval/corpus`: rule-tier precision 1.0, no ' +
      `must_not_link accepted, ≥ ${(MUST_LINK_RECALL_TARGET * 100).toFixed(0)} % of must_link pairs among rules ∪ ` +
      'candidates, findings as expected, reported against baseline-proa1 (the 1.x algorithm). ' +
      `Candidates per endpoint: key matches, top ${DEFAULT_LEXICAL_PER_ENDPOINT} lexical, up to ` +
      `${DEFAULT_COMPATIBLE_PER_ENDPOINT} further compatible endpoints.`,
  );
  parts.push(`**Result: ${report.pass ? 'pass' : 'FAIL'}**`);
  parts.push(
    table(
      [
        'Landscape',
        'split',
        'rule precision',
        'must_not_link accepted',
        'must_link in candidates',
        'in key/lexical',
        'baseline recall',
        'baseline precision',
        'findings',
        'result',
      ],
      report.landscapes.map((s) => {
        const gate = (id: string): string => s.gates.find((g) => g.id === id)?.value ?? '';
        return [
          s.name,
          s.split,
          formatRatio(s.ruleTier.precision),
          gate('rule-must-not-link'),
          gate('must-link-recall'),
          formatRatio(s.systems.keyLexical.recall),
          formatRatio(s.systems.baseline.recall),
          formatRatio(s.systems.baseline.precision),
          s.gates.filter((g) => g.id.startsWith('findings')).every((g) => g.pass) ? 'ok' : 'differ',
          s.pass ? 'pass' : '**FAIL**',
        ];
      }),
    ),
  );
  for (const s of report.landscapes) parts.push(landscapeSection(s));
  return `${parts.join('\n\n')}\n`;
}
