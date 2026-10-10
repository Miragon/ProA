// Every model of eval/corpus extracts cleanly, and the facts carry what
// expected.yaml needs: each endpoint resolves to a fact of a compatible kind,
// the deterministic findings follow from the facts, and data store labels
// exist. A compact fact summary per landscape is snapshotted, so any change
// to extraction shows up in review (and needs a FACTS_VERSION bump).
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { FactKind as FactKindSchema, RELATION_ENDPOINT_KINDS } from '@proa/contracts';
import type { Fact, FactKind } from '@proa/contracts';

import { FACTS_VERSION, extractFacts, factsHash } from '../src/index.ts';
import type { ExtractResult } from '../src/index.ts';

import { expectValid } from './support/bpmn.ts';

const CORPUS_DIR = fileURLToPath(new URL('../../../eval/corpus/', import.meta.url));

type RelationType = 'call' | 'message' | 'signal' | 'trigger';

interface Expected {
  relations: Array<{
    type: RelationType;
    from: string;
    to: string;
    expect: 'must_link' | 'must_not_link' | 'may_link';
  }>;
  expected_findings?: Array<{ kind: string; refs: string[] }>;
  data_store_groups?: Array<{ name: string; labels: string[] }>;
}

interface Landscape {
  name: string;
  models: Array<{ key: string; engine: string; result: ExtractResult }>;
  expected: Expected;
}

/**
 * Endpoints in expected.yaml that are deliberately no facts: events outside
 * v1 (CONCEPT §2: timer, conditional, error, escalation). Only
 * `must_not_link` entries may name them; nothing can ever link to them.
 */
const NON_FACT_REFS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'stadtwerke-auental': {
    'abrechnung/schlussrechnung#Event_LieferendeErreicht':
      'timer intermediate catch (event-def-mismatch trap)',
  },
};

/** `must_not_link` entries are checked loosely, as in eval/tools: outgoing → incoming. */
const OUTGOING: ReadonlySet<FactKind> = new Set(['call', 'msg_throw', 'sig_throw', 'evt_end']);
const INCOMING: ReadonlySet<FactKind> = new Set(['process', 'msg_catch', 'sig_catch', 'evt_start']);

/**
 * CONCEPT §2: start and end events inside embedded subprocesses and end
 * events inside event subprocesses are never endpoints; the typed start of
 * an event subprocess is.
 */
function isEndpoint(f: Fact): boolean {
  if (f.attrs.elementType === 'bpmn:StartEvent') {
    return f.scope === 'process' || (f.scope === 'event_subprocess' && f.eventDef !== 'none');
  }
  if (f.attrs.elementType === 'bpmn:EndEvent') return f.scope === 'process';
  return true;
}

async function loadLandscape(name: string): Promise<Landscape> {
  const dir = path.join(CORPUS_DIR, name);
  const files = (await readdir(path.join(dir, 'models'), { recursive: true }))
    .filter((f) => f.endsWith('.bpmn'))
    .sort();
  const models = await Promise.all(
    files.map(async (file) => {
      const key = file.slice(0, -'.bpmn'.length).split(path.sep).join('/');
      const spec = parseYaml(await readFile(path.join(dir, 'spec', `${key}.yaml`), 'utf8')) as {
        engine: string;
      };
      // bytes, as the server receives them
      const result = await extractFacts(await readFile(path.join(dir, 'models', file)), {
        modelKey: key,
      });
      return { key, engine: spec.engine, result };
    }),
  );
  const expected = parseYaml(await readFile(path.join(dir, 'expected.yaml'), 'utf8')) as Expected;
  return { name, models, expected };
}

function summarize(landscape: Landscape): string {
  const facts = landscape.models.flatMap((m) => m.result.facts);
  const counts = new Map<string, number>();
  for (const f of facts) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  const lines = [
    `# ${landscape.name}: ${landscape.models.length} models, ${facts.length} facts, FACTS_VERSION ${FACTS_VERSION}`,
    `# ${FactKindSchema.options
      .filter((k) => counts.has(k))
      .map((k) => `${k} ${counts.get(k) ?? 0}`)
      .join(', ')}`,
    '# kind elementId scope eventDef processId "keyNorm" fingerprint [dynamic] [label-key: no message/signal ref]',
  ];
  for (const { key, result } of landscape.models) {
    lines.push(
      '',
      `## ${key} (${result.engine ?? '-'}) facts_hash ${factsHash(result.facts).slice(0, 16)}`,
    );
    for (const f of result.facts) {
      const flags = [
        f.attrs.dynamic === true ? 'dynamic' : null,
        (f.kind.startsWith('msg_') && f.attrs.messageName === undefined) ||
        (f.kind.startsWith('sig_') && f.attrs.signalName === undefined)
          ? 'label-key'
          : null,
      ].filter((x) => x !== null);
      lines.push(
        [
          f.kind.padEnd(12),
          f.elementId,
          f.scope,
          f.eventDef ?? '-',
          f.processId ?? '-',
          JSON.stringify(f.keyNorm),
          f.fingerprint,
          ...flags,
        ].join(' '),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

const landscapeNames = (await readdir(CORPUS_DIR, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

it('finds the corpus landscapes', () => {
  expect(landscapeNames).toEqual(
    expect.arrayContaining(['_sample', 'nordwind-handel', 'stadtwerke-auental']),
  );
});

describe.each(landscapeNames)('eval/corpus/%s', async (name) => {
  const landscape = await loadLandscape(name);
  const facts = landscape.models.flatMap((m) => m.result.facts);
  const byRef = new Map<string, Fact[]>();
  for (const f of facts) byRef.set(f.ref, [...(byRef.get(f.ref) ?? []), f]);
  const processRefs = new Map<string, string[]>();
  for (const f of facts.filter((x) => x.kind === 'process')) {
    processRefs.set(f.elementId, [...(processRefs.get(f.elementId) ?? []), f.ref]);
  }
  const owner = (f: Fact): string => `${f.modelKey}#${f.processId ?? '-'}`;

  it('extracts every model without warnings, conforming to the contracts', () => {
    expect(landscape.models.length).toBeGreaterThan(0);
    for (const { key, engine, result } of landscape.models) {
      expect(result.warnings, key).toEqual([]);
      expectValid(result);
      expect(result.engine, key).toBe(engine);
      expect(result.processes.length, key).toBeGreaterThan(0);
      for (const p of result.processes) {
        expect(result.facts.some((f) => f.kind === 'process' && f.ref === p.ref)).toBe(true);
      }
    }
  });

  it('resolves every expected.yaml endpoint to a fact of a compatible kind', () => {
    const problems: string[] = [];
    const nonFacts = new Set(Object.keys(NON_FACT_REFS[name] ?? {}));
    for (const r of landscape.expected.relations) {
      const where = `${r.expect} ${r.type} ${r.from} -> ${r.to}`;
      const from = byRef.get(r.from) ?? [];
      const to = byRef.get(r.to) ?? [];
      if (r.expect === 'must_not_link') {
        for (const [side, ref, found, allowed] of [
          ['from', r.from, from, OUTGOING],
          ['to', r.to, to, INCOMING],
        ] as const) {
          if (found.length === 0 && nonFacts.has(ref)) continue;
          if (!found.some((f) => allowed.has(f.kind))) {
            problems.push(
              `${where}: ${side} is ${found.map((f) => f.kind).join('/') || 'no fact'}`,
            );
          }
        }
        continue;
      }
      const kinds = RELATION_ENDPOINT_KINDS[r.type];
      const f = from.find((x) => (kinds.from as readonly FactKind[]).includes(x.kind));
      const t = to.find((x) => (kinds.to as readonly FactKind[]).includes(x.kind));
      if (!f || !t) {
        problems.push(
          `${where}: from is ${from.map((x) => x.kind).join('/') || 'no fact'}, to is ${to.map((x) => x.kind).join('/') || 'no fact'}`,
        );
        continue;
      }
      if (!isEndpoint(f) || !isEndpoint(t))
        problems.push(`${where}: not an endpoint (scope ${f.scope} -> ${t.scope})`);
      if (owner(f) === owner(t)) problems.push(`${where}: both endpoints in ${owner(f)}`);
      if (
        r.type === 'trigger' &&
        (f.eventDef !== 'none' || t.eventDef !== 'none' || !f.label || !t.label)
      ) {
        problems.push(`${where}: trigger needs labelled none events`);
      }
      if (
        r.type === 'call' &&
        r.expect === 'must_link' &&
        (f.attrs.dynamic || f.keyRaw !== t.elementId)
      ) {
        problems.push(
          `${where}: must_link call needs the static calledElement ${JSON.stringify(f.keyRaw)} to equal the process id`,
        );
      }
    }
    for (const ref of nonFacts) {
      if (byRef.has(ref)) problems.push(`${ref} is listed in NON_FACT_REFS but is a fact`);
    }
    expect(problems).toEqual([]);
  });

  it('reproduces the deterministic findings from the facts', () => {
    const calls = facts.filter((f) => f.kind === 'call');
    const computed = {
      'dynamic-call': calls.filter((f) => f.attrs.dynamic === true).map((f) => f.ref),
      'unresolved-call': calls
        .filter((f) => f.attrs.dynamic !== true && f.keyRaw !== '' && !processRefs.has(f.keyRaw))
        .map((f) => f.ref),
      'duplicate-process-id': [...processRefs.values()]
        .filter((refs) => refs.length > 1)
        .map((refs) => refs.sort().join(' ')),
    };
    const findings = landscape.expected.expected_findings ?? [];
    const listed = (kind: string, join = false): string[] =>
      findings
        .filter((x) => x.kind === kind)
        .flatMap((x) => (join ? [[...x.refs].sort().join(' ')] : x.refs));
    expect(computed['dynamic-call'].sort()).toEqual(listed('dynamic-call').sort());
    expect(computed['unresolved-call'].sort()).toEqual(listed('unresolved-call').sort());
    expect(computed['duplicate-process-id'].sort()).toEqual(
      listed('duplicate-process-id', true).sort(),
    );

    const wrongKind = (kind: string, allowed: readonly FactKind[]): string[] =>
      listed(kind).filter((ref) => !(byRef.get(ref) ?? []).some((f) => allowed.includes(f.kind)));
    expect(wrongKind('dangling-throw', ['msg_throw', 'sig_throw'])).toEqual([]);
    expect(wrongKind('unmatched-catch', ['msg_catch', 'sig_catch'])).toEqual([]);
  });

  it('has a data_store fact for every label of the data store groups', () => {
    const labels = new Set(facts.filter((f) => f.kind === 'data_store').map((f) => f.label));
    const missing = (landscape.expected.data_store_groups ?? []).flatMap((g) =>
      g.labels.filter((l) => !labels.has(l)),
    );
    expect(missing).toEqual([]);
  });

  it('matches the fact summary snapshot', async () => {
    await expect(summarize(landscape)).toMatchFileSnapshot(`__snapshots__/${name}.facts.txt`);
  });
});
