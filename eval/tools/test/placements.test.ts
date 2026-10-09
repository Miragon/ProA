// Tests for eval:placements (src/placements.ts, placements-load.ts, placements-score.ts,
// placements-report.ts). Holdout hygiene: assertions on real landscapes name gate titles and
// counts only, and the holdout's per-item fields are checked with `=== undefined`, never printed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { evaluatePlacements, runPlacements, type PlacementsIo } from '../src/placements.ts';
import { PlacementDataError, loadPlacementRun } from '../src/placements-load.ts';
import { renderPlacementsMarkdown } from '../src/placements-report.ts';
import {
  HOLDOUT_MIN_GROUP,
  HOLDOUT_NOTE,
  OUTSIDE,
  baselineProposals,
  classifyArea,
  classifyPlacement,
  redactHoldout,
  rulePlacements,
  scorePlacementProposals,
  scorePlacementRun,
  type Golden,
  type PlacementRun,
} from '../src/placements-score.ts';

test('every scored landscape passes; the report is deterministic and redacts the holdout', async () => {
  const report = await evaluatePlacements();
  assert.deepEqual(
    report.landscapes.map((s) => [s.name, s.split]),
    [
      ['nordwind-handel', 'dev'],
      ['stadtwerke-auental', 'holdout'],
    ],
  );
  // Gates only: a property of the holdout's data (how many rule proposals it gets) is no test.
  for (const s of report.landscapes) {
    for (const g of s.gates) assert.ok(g.pass, `${s.name}: ${g.title}: ${g.value}`);
  }
  assert.equal(report.pass, true);

  const again = await evaluatePlacements();
  assert.ok(renderPlacementsMarkdown(again) === renderPlacementsMarkdown(report), 'Markdown differs between runs');
  assert.ok(JSON.stringify(again) === JSON.stringify(report), 'JSON differs between runs');

  const holdout = report.landscapes.find((s) => s.split === 'holdout');
  assert.ok(holdout !== undefined, 'no holdout landscape');
  assert.ok(holdout.note === HOLDOUT_NOTE, 'holdout note missing');
  for (const [name, system] of Object.entries(holdout.systems)) {
    assert.ok(system.items === undefined, `holdout ${name}: per-item fields present`);
  }
  // No number over fewer than HOLDOUT_MIN_GROUP processes: no rule tier beyond its gate and count,
  // no per-tag numbers of a small tag (checked without naming a tag).
  assert.ok(holdout.systems.rules === undefined, 'holdout: rule tier numbers present');
  const smallTags = Object.entries(holdout.counts.tags)
    .filter(([, n]) => n < HOLDOUT_MIN_GROUP)
    .map(([tag]) => tag);
  for (const [name, system] of Object.entries(holdout.systems)) {
    assert.ok(
      Object.values(system.byTag).every((m) => m.processes >= HOLDOUT_MIN_GROUP),
      `holdout ${name}: per-tag numbers of a tag with fewer than ${HOLDOUT_MIN_GROUP} processes`,
    );
    assert.ok(smallTags.every((tag) => !(tag in system.byTag)), `holdout ${name}: a small tag has numbers`);
  }
  const markdown = renderPlacementsMarkdown(report);
  const section = markdown.slice(markdown.indexOf(`## ${holdout.name}`));
  assert.ok(section.includes(HOLDOUT_NOTE), 'holdout section without the note');
  assert.ok(!section.includes('→'), 'holdout section lists items');
  assert.ok(!section.includes('rule hits/proposals'), 'holdout section with per-tag rule cells');
  assert.ok(!section.includes('| rule tier'), 'holdout section with rule tier numbers');
  assert.ok(smallTags.every((tag) => !section.includes(`| ${tag} |`)), 'holdout section with a small tag row');
  const summary = markdown.split('\n').find((l) => l.startsWith(`| ${holdout.name} |`));
  assert.ok(summary?.includes('(not split)'), 'holdout summary splits the rule proposals');

  // The dev landscape: the four rule proposals of M4 S2 (equal names), each a hit, by process.
  const dev = report.landscapes.find((s) => s.name === 'nordwind-handel');
  assert.equal(dev?.counts.ruleProposals, 4);
  assert.deepEqual(
    dev?.systems.rules?.items?.map((i) => [i.step, i.class]),
    [
      ['step-mahnwesen', 'hit'],
      ['step-rechnungsstellung', 'hit'],
      ['step-zahlungseingang', 'hit'],
      ['step-wareneingang', 'hit'],
    ],
  );
  // baseline-prefix/1 is frozen: the dev numbers the committed report pins.
  const top1 = dev?.systems.baseline.leaf.at1;
  assert.deepEqual(
    top1 && [top1.hit, top1.may, top1.coarse, top1.trap, top1.wrong, top1.none],
    [14, 5, 1, 7, 5, 0],
  );
  const noVotes = dev?.systems.baselineNoVotes.leaf.at1;
  assert.deepEqual(
    noVotes && [noVotes.hit, noVotes.may, noVotes.coarse, noVotes.trap, noVotes.wrong, noVotes.none],
    [15, 3, 0, 7, 4, 3],
  );
  // Level 0 counts only top-level must_not: 3 of the 24 processes with a must_not have one.
  const area = dev?.systems.baseline.area;
  assert.deepEqual(
    area && [area.withTraps, area.at1?.trapProcesses, area.at1?.trapRate, dev?.systems.baseline.leaf.withTraps],
    [3, 3, 1, 24],
  );
});

test('loads the dev chain: steps from the document, hierarchy source = parent, the content hash', async () => {
  const run = await loadPlacementRun('nordwind-handel');
  const bytes = await readFile(path.resolve(import.meta.dirname, '../../value-chains/nordwind-handel/value-chain.vc.json'));
  assert.equal(run.golden.contentHash, createHash('sha256').update(bytes).digest('hex'));
  const steps = new Map(run.chainSteps.map((s) => [s.id, s]));
  for (const g of run.golden.steps) {
    assert.equal(steps.get(g.id)?.name, g.name, g.id);
    assert.equal(steps.get(g.id)?.parentId, g.parent, g.id);
  }
  assert.equal(run.chainSteps.length, run.golden.steps.length);
  assert.ok(run.chainSteps.every((s) => s.link === null));
  // Neighbours are symmetric and never the process itself.
  for (const [p, qs] of run.neighbours) {
    assert.ok(!qs.includes(p), p);
    for (const q of qs) assert.ok(run.neighbours.get(q)?.includes(p), `${q} → ${p}`);
  }
});

test('a scored landscape without golden data is a data error; a wrong call is a usage error', async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), 'proa-placements-'));
  try {
    await assert.rejects(loadPlacementRun('nordwind-handel', { valueChainsDir: empty }), PlacementDataError);
    const out: string[] = [];
    const io: PlacementsIo = { stdout: (t) => out.push(t), stderr: (t) => out.push(t), cwd: empty };
    assert.equal(await runPlacements(['nordwind-handel', '--no-write'], io, { valueChainsDir: empty }), 1);
    assert.match(out.join(''), /nordwind-handel: no golden value chain/);
    for (const argv of [['--bogus'], ['atlantis'], ['_sample'], ['--out']]) {
      out.length = 0;
      assert.equal(await runPlacements(argv, io), 2, argv.join(' '));
      assert.match(out.join(''), /usage: pnpm eval:placements/);
    }
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

// A synthetic chain: areas a, b (with sub-steps) and c (a top-level leaf).
const GOLDEN: Golden = {
  landscape: 'synthetic',
  contentHash: '0'.repeat(64),
  steps: [
    { id: 'area-a', name: 'Alpha', kind: 'core', level: 0, parent: null },
    { id: 'a-1', name: 'Alpha Eins', kind: 'core', level: 1, parent: 'area-a' },
    { id: 'a-2', name: 'Alpha Zwei', kind: 'core', level: 1, parent: 'area-a' },
    { id: 'area-b', name: 'Bravo', kind: 'core', level: 0, parent: null },
    { id: 'b-1', name: 'Bravo Eins', kind: 'core', level: 1, parent: 'area-b' },
    { id: 'b-2', name: 'Bravo Zwei', kind: 'core', level: 1, parent: 'area-b' },
    { id: 'area-c', name: 'Charlie', kind: 'support', level: 0, parent: null },
  ],
  placements: [
    { process: 'm/p1#P1', name: 'Prozess Eins', must: 'a-1', may: ['b-1'], mustNot: ['a-2'], tags: ['name-match'], supersededBy: null },
    { process: 'm/p2#P2', name: 'Archiv', must: OUTSIDE, may: ['a-2'], mustNot: ['area-b'], tags: ['outdated-copy'], supersededBy: 'm/p1#P1' },
    { process: 'm/p3#P3', name: 'Bravo Zwei', must: 'b-2', may: [OUTSIDE], mustNot: [], tags: ['name-match', 'semantic'], supersededBy: null },
  ],
};

test('classifies hit, may, coarse, trap (a subtree) and wrong, @outside as must and as may', () => {
  const c = (process: string, step: string) => classifyPlacement(GOLDEN, process, step);
  assert.equal(c('m/p1#P1', 'a-1'), 'hit');
  assert.equal(c('m/p1#P1', 'b-1'), 'may');
  assert.equal(c('m/p1#P1', 'area-a'), 'coarse');
  assert.equal(c('m/p1#P1', 'a-2'), 'trap');
  assert.equal(c('m/p1#P1', 'b-2'), 'wrong');
  assert.equal(c('m/p1#P1', OUTSIDE), 'wrong');
  assert.equal(c('m/p1#P1', 'step-unknown'), 'wrong');
  assert.equal(c('m/p2#P2', OUTSIDE), 'hit');
  assert.equal(c('m/p2#P2', 'a-2'), 'may');
  assert.equal(c('m/p2#P2', 'area-b'), 'trap');
  assert.equal(c('m/p2#P2', 'b-1'), 'trap');
  assert.equal(c('m/p2#P2', 'area-c'), 'wrong');
  assert.equal(c('m/p3#P3', OUTSIDE), 'may');
  assert.equal(c('x/unlisted#P', 'a-1'), 'wrong');
  // Level 0: areas. A sub-step trap does not cover its area; a top-level trap does.
  assert.equal(classifyArea(GOLDEN, 'm/p1#P1', 'a-2'), 'hit');
  assert.equal(classifyArea(GOLDEN, 'm/p1#P1', 'b-2'), 'may');
  assert.equal(classifyArea(GOLDEN, 'm/p2#P2', 'b-2'), 'trap');
  assert.equal(classifyArea(GOLDEN, 'm/p2#P2', 'a-1'), 'may');
  assert.equal(classifyArea(GOLDEN, 'm/p3#P3', 'area-c'), 'wrong');
});

test('scores ranked proposals: recall@1/@3, precision, level 0, none, trap rate, tags', () => {
  const s = scorePlacementProposals(GOLDEN, [
    { process: 'm/p1#P1', step: 'a-2', rank: 1 },
    { process: 'm/p1#P1', step: 'a-1', rank: 2 },
    { process: 'm/p2#P2', step: OUTSIDE, rank: 1 },
    { process: 'x/unlisted#P', step: 'a-1', rank: 1 },
  ]);
  assert.equal(s.ranked, true);
  const at1 = s.leaf.at1;
  assert.deepEqual(at1 && [at1.proposals, at1.hit, at1.trap, at1.wrong, at1.none], [3, 1, 1, 1, 1]);
  assert.equal(at1?.precision, 1 / 3);
  assert.equal(at1?.recall, 1 / 3);
  assert.equal(at1?.trapRate, 1 / 2);
  assert.equal(s.leaf.at3?.recall, 2 / 3);
  assert.equal(s.leaf.at3?.precision, 2 / 4);
  assert.equal(s.area.at1?.recall, 2 / 3);
  assert.equal(s.leaf.all.f1, 2 * (0.5 * (2 / 3)) / (0.5 + 2 / 3));
  assert.deepEqual(Object.keys(s.byTag), ['name-match', 'outdated-copy', 'semantic']);
  assert.equal(s.byTag['name-match']?.processes, 2);
  assert.equal(s.byTag['name-match']?.at3?.recall, 1 / 2);
  assert.equal(s.byTag['semantic']?.at1?.none, 1);
  assert.deepEqual(
    s.items?.map((i) => `${i.process} ${i.rank} ${i.step} ${i.class}`),
    ['m/p1#P1 1 a-2 trap', 'm/p1#P1 2 a-1 hit', 'm/p2#P2 1 @outside hit', 'x/unlisted#P 1 a-1 wrong'],
  );
});

test('the level-0 trap rate counts processes with a top-level must_not only', () => {
  // m/p1#P1 has a sub-step trap only (a-2), m/p2#P2 a top-level one (area-b).
  const s = scorePlacementProposals(GOLDEN, [
    { process: 'm/p1#P1', step: 'a-2', rank: 1 },
    { process: 'm/p2#P2', step: 'b-1', rank: 1 },
  ]);
  assert.equal(s.leaf.withTraps, 2);
  assert.deepEqual(s.leaf.at1 && [s.leaf.at1.trap, s.leaf.at1.trapProcesses, s.leaf.at1.trapRate], [2, 2, 1]);
  // At level 0, a-2 lies in the must's area (a hit), b-1 in the trapped area b.
  assert.equal(s.area.withTraps, 1);
  const area = s.area.at1;
  assert.deepEqual(area && [area.hit, area.trap, area.trapProcesses, area.trapRate], [1, 1, 1, 1]);
  // A process with only a sub-step trap never counts at level 0.
  const subOnly = scorePlacementProposals(GOLDEN, [{ process: 'm/p1#P1', step: 'b-2', rank: 1 }]);
  assert.equal(subOnly.area.at1?.trapProcesses, 0);
  assert.equal(subOnly.area.at1?.trapRate, 0);
  assert.equal(subOnly.byTag['name-match']?.withTraps, 1);
});

test('scores an unranked set with confidence, as S5 passes recorded items', () => {
  const s = scorePlacementProposals(GOLDEN, [
    { process: 'm/p1#P1', step: 'a-1', confidence: 0.9 },
    { process: 'm/p1#P1', step: 'a-2', confidence: 0.6 },
    { process: 'm/p1#P1', step: 'a-2', confidence: 0.85 },
    { process: 'm/p2#P2', step: 'b-1', confidence: 0.95 },
    { process: 'm/p3#P3', step: OUTSIDE, confidence: 0.7 },
  ]);
  assert.equal(s.ranked, false);
  assert.equal(s.leaf.at1, null);
  assert.equal(s.leaf.at3, null);
  assert.equal(s.proposals, 4);
  assert.deepEqual([s.leaf.all.hit, s.leaf.all.may, s.leaf.all.trap, s.leaf.all.none], [1, 1, 2, 0]);
  assert.equal(s.leaf.all.trapRate, 1);
  // The live gate's "must_not at ≥ 0.8": a duplicate keeps its highest confidence.
  assert.equal(s.trapsHighConfidence, 2);
});

function syntheticRun(): PlacementRun {
  return {
    name: 'synthetic',
    split: 'dev',
    golden: GOLDEN,
    chainSteps: GOLDEN.steps.map((s) => ({ id: s.id, name: s.name, parentId: s.parent, link: null })),
    processes: [
      { ref: 'm/p1#P1', label: 'Prozess Eins', name: 'Prozess Eins', modelKey: 'm/p1' },
      { ref: 'm/p2#P2', label: 'Archiv', name: 'Archiv', modelKey: 'm/p2' },
      { ref: 'm/p3#P3', label: 'Bravo Zwei', name: 'Bravo Zwei', modelKey: 'm/p3' },
    ],
    neighbours: new Map(),
    validator: { exitCode: 0, summary: [] },
  };
}

const failed = (run: PlacementRun) =>
  scorePlacementRun(run)
    .gates.filter((g) => !g.pass)
    .map((g) => `${g.id}: ${g.value}`);

test('passes a synthetic landscape whose rule proposal is the must', () => {
  const run = syntheticRun();
  assert.deepEqual(
    rulePlacements(run).map((p) => [p.process, p.step, p.byName]),
    [['m/p3#P3', 'b-2', true]],
  );
  assert.deepEqual(failed(run), []);
});

test('fails the gates on a coarse, trap or unlisted rule proposal, a process mismatch and the validator', () => {
  const coarse = syntheticRun();
  coarse.processes[0] = { ref: 'm/p1#P1', label: 'ALPHA', name: 'ALPHA', modelKey: 'm/p1' };
  assert.deepEqual(failed(coarse), ['rule-proposals: 1/2']);

  const trap = syntheticRun();
  trap.chainSteps = trap.chainSteps.map((s) => (s.id === 'b-1' ? { ...s, link: 'proa:process/m/p2#P2' } : s));
  assert.deepEqual(failed(trap), ['rule-proposals: 1/2']);

  const unlisted = syntheticRun();
  unlisted.chainSteps = unlisted.chainSteps.map((s) => (s.id === 'area-c' ? { ...s, link: 'proa:process/m/p1#P1' } : s));
  assert.deepEqual(failed(unlisted), ['rule-proposals: 1/2']);

  const extraFact = syntheticRun();
  extraFact.processes.push({ ref: 'm/p4#P4', label: '', name: null, modelKey: 'm/p4' });
  assert.deepEqual(failed(extraFact), ['coverage: 3 listed, 4 process facts, 1 missing, 0 extra']);

  const missingFact = syntheticRun();
  missingFact.processes.pop();
  assert.deepEqual(failed(missingFact), ['coverage: 3 listed, 2 process facts, 0 missing, 1 extra']);

  const invalid = syntheticRun();
  invalid.validator = { exitCode: 1, summary: ['synthetic: FAIL'] };
  const score = scorePlacementRun(invalid);
  assert.deepEqual(failed(invalid), ['validator: exit 1']);
  assert.equal(score.pass, false);
  assert.match(renderPlacementsMarkdown({ pass: false, landscapes: [score] }), /\*\*Result: FAIL\*\*/);
});

test('baseline-prefix/1 with votes is leave-one-out: a process’s own must never votes for it', () => {
  const golden: Golden = {
    landscape: 'votes',
    contentHash: '0'.repeat(64),
    steps: [
      { id: 's-x', name: 'Xylophon', kind: 'core', level: 0, parent: null },
      { id: 's-z', name: 'Zebrastreifen', kind: 'core', level: 0, parent: null },
    ],
    placements: [
      { process: 'm/foo#P', name: 'Foo', must: 's-x', may: [], mustNot: [], tags: [], supersededBy: null },
      { process: 'm/bar#Q', name: 'Bar', must: 's-z', may: [], mustNot: [], tags: [], supersededBy: null },
      { process: 'm/old#R', name: 'Alt', must: OUTSIDE, may: [], mustNot: [], tags: [], supersededBy: null },
    ],
  };
  const run: PlacementRun = {
    ...syntheticRun(),
    golden,
    chainSteps: golden.steps.map((s) => ({ id: s.id, name: s.name, parentId: null, link: null })),
    processes: [
      { ref: 'm/bar#Q', label: 'Bar', name: 'Bar', modelKey: 'm/bar' },
      { ref: 'm/foo#P', label: 'Foo', name: 'Foo', modelKey: 'm/foo' },
      { ref: 'm/old#R', label: 'Alt', name: 'Alt', modelKey: 'm/old' },
    ],
    neighbours: new Map([
      ['m/foo#P', ['m/bar#Q', 'm/old#R']],
      ['m/bar#Q', ['m/foo#P']],
      ['m/old#R', ['m/foo#P']],
    ]),
  };
  const voted = baselineProposals(run, { votes: true }).map((p) => `${p.process} ${p.step} ${p.rank}`);
  // Each gets its neighbour's must, never its own; @outside never votes.
  assert.deepEqual(voted, ['m/bar#Q s-x 1', 'm/foo#P s-z 1', 'm/old#R s-x 1']);
  assert.deepEqual(baselineProposals(run, { votes: false }), []);
});

test('redacts a holdout score by construction', () => {
  const score = scorePlacementRun({ ...syntheticRun(), split: 'holdout' });
  const redacted = redactHoldout(score);
  assert.equal(redacted.note, HOLDOUT_NOTE);
  for (const system of Object.values(redacted.systems)) assert.equal(system.items, undefined);
  assert.equal(redactHoldout(scorePlacementRun(syntheticRun())).note, undefined);
  const md = renderPlacementsMarkdown({ pass: true, landscapes: [redacted] });
  assert.ok(!md.includes('### Rule proposals'));
  assert.ok(!md.includes('m/p3#P3'));
  assert.ok(!JSON.stringify(redacted).includes('m/p3#P3'));
  // One rule proposal: its gate and count stay, its class split and per-tag cells go.
  assert.equal(score.systems.rules?.proposals, 1);
  assert.equal(redacted.systems.rules, undefined);
  assert.equal(redacted.counts.ruleProposals, 1);
  assert.deepEqual(
    redacted.gates.map((g) => [g.id, g.value]),
    score.gates.map((g) => [g.id, g.value]),
  );
  assert.match(md, /\| synthetic \| holdout \| 3 \| ok \| ok \| 1 \(not split\) \|/);
  assert.ok(!md.includes('rule hits/proposals'));
  assert.ok(!md.includes('| rule tier'));
  // Every synthetic tag has fewer than HOLDOUT_MIN_GROUP processes.
  for (const system of Object.values(redacted.systems)) assert.deepEqual(system.byTag, {});
  assert.ok(!/\| (name-match|outdated-copy|semantic) \|/.test(md), 'a small tag row');
  assert.match(md, /3 of 3 tags left out \(fewer than 5 processes\)/);
  // The dev rendering keeps all of it.
  const dev = renderPlacementsMarkdown({ pass: true, landscapes: [scorePlacementRun(syntheticRun())] });
  assert.match(dev, /\| name-match \| 2 \| 1\/1 \|/);
  assert.match(dev, /\| outdated-copy \| 1 \| 0\/0 \|/);
  assert.ok(dev.includes('| rule tier'));
});

test('keeps the per-tag numbers of a holdout tag with at least HOLDOUT_MIN_GROUP processes', () => {
  const extra = Array.from({ length: HOLDOUT_MIN_GROUP - 1 }, (_, i) => `m/q${i}#Q${i}`);
  const golden: Golden = {
    ...GOLDEN,
    placements: [
      ...GOLDEN.placements,
      ...extra.map((process) => ({
        process,
        name: 'Charlie',
        must: 'area-c',
        may: [],
        mustNot: [],
        tags: ['semantic'],
        supersededBy: null,
      })),
    ],
  };
  const run: PlacementRun = {
    ...syntheticRun(),
    split: 'holdout',
    golden,
    processes: [
      ...syntheticRun().processes,
      ...extra.map((ref) => ({ ref, label: 'Charlie', name: 'Charlie', modelKey: ref.split('#')[0] ?? '' })),
    ],
  };
  const score = scorePlacementRun(run);
  assert.equal(score.counts.tags['semantic'], HOLDOUT_MIN_GROUP);
  const redacted = redactHoldout(score);
  for (const system of Object.values(redacted.systems)) assert.deepEqual(Object.keys(system.byTag), ['semantic']);
  const md = renderPlacementsMarkdown({ pass: true, landscapes: [redacted] });
  assert.match(md, new RegExp(`\\| semantic \\| ${HOLDOUT_MIN_GROUP} \\| \\d`));
  assert.match(md, /2 of 3 tags left out/);
});
