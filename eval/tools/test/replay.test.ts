// Tests for eval:replay (src/replay.ts, recordings.ts, replay-score.ts,
// replay-report.ts) on a fixture recording of `_sample` with known answers,
// and on the committed recordings in eval/recordings.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { getProcedure } from '@proa/procedures';

import { CORPUS_DIR } from '../src/corpus.ts';
import { RecordingError, landscapeDir, loadRecordings, parseRecording } from '../src/recordings.ts';
import { renderReplayMarkdown } from '../src/replay-report.ts';
import { replay } from '../src/replay.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/recordings', import.meta.url));
const FIXTURE_FILE = 'proa-relations@0.0.1/fixture-agent/fixture-model/sample.jsonl';
const A = 'vertrieb/auftragsabwicklung';
const R = 'finanzen/rechnungsstellung';
const P = 'finance/payment-collection';

test('scores the fixture recording of _sample exactly', async () => {
  const report = await replay(FIXTURES, CORPUS_DIR);
  assert.equal(report.recordings.length, 1);
  const s = report.recordings[0];
  assert.ok(s);
  assert.deepEqual(
    [s.file, s.procedure, s.agent, s.llmModel, s.landscape, s.split, s.closedWorld],
    [FIXTURE_FILE, 'proa-relations@0.0.1', 'fixture-agent', 'fixture-model', 'sample', 'dev', true],
  );
  assert.deepEqual(s.tasks, { lines: 2, models: 2, landscapeModels: 3, submitted: 1, dryRun: 1, failed: 0 });
  // Invalid: answered by the server (line 1), or checked locally for the unsubmitted line 2.
  assert.deepEqual(s.items, {
    total: 9,
    invalid: { 'type-mismatch': 1, 'type-not-allowed': 1, 'unknown-ref': 1 },
    outcomes: { applied: 3, unsubmitted: 3 },
  });
  // Five distinct pairs: three must_link, one unlisted (proposed twice), one must_not_link.
  assert.equal(s.pairs, 5);
  assert.deepEqual(s.overall, {
    mustLink: 5,
    found: 3,
    mayLink: 0,
    mustNotLink: 1,
    unlisted: 1,
    sameProcess: 0,
    precision: 0.6,
    recall: 0.6,
    f1: 0.6,
  });
  // The rule tier accepts Call_ZahlungAbwickeln → Process_PaymentCollection.
  assert.equal(s.withRules.found, 4);
  assert.equal(s.withRules.recall, 0.8);
  assert.equal(s.withRules.precision, 4 / 6);

  assert.deepEqual(s.byType['call'], {
    mustLink: 1, found: 0, mayLink: 0, mustNotLink: 0, unlisted: 0, sameProcess: 0, precision: null, recall: 0, f1: null,
  });
  assert.deepEqual(
    [s.byType['message']?.found, s.byType['message']?.mustLink, s.byType['message']?.unlisted, s.byType['message']?.precision],
    [1, 2, 1, 0.5],
  );
  assert.deepEqual([s.byType['signal']?.recall, s.byType['signal']?.precision], [1, 1]);
  assert.deepEqual([s.byType['trigger']?.recall, s.byType['trigger']?.mustNotLink, s.byType['trigger']?.precision], [null, 1, 0]);

  assert.deepEqual([s.byTag['collaboration']?.found, s.byTag['collaboration']?.mustLink], [2, 3]);
  assert.equal(s.byTag['signal-broadcast']?.recall, 1);
  assert.equal(s.byTag['de-en']?.recall, 0);
  assert.equal(s.byTag['near-miss']?.mustNotLink, 1);
  assert.equal(s.byTag['subprocess-scope']?.mustNotLink, 0); // the invalid item does not count

  assert.deepEqual(
    s.mustNotLinkHits.map((p) => [p.type, p.from, p.to, p.confidence, p.question]),
    [['trigger', `${P}#End_InvoicePaid`, `${P}#Event_InvoiceSent`, 0.85, false]],
  );
  assert.equal(s.mustNotLinkHighConfidence, 1);
  // Proposed twice: highest confidence, and a question if any proposal asked one.
  assert.deepEqual(
    s.unlistedPairs.map((p) => [p.from, p.to, p.confidence, p.question]),
    [[`${A}#Task_AbsageSenden`, `${P}#Event_PaymentReceived`, 0.7, true]],
  );
  assert.deepEqual(s.missed.map((e) => `${e.from} -> ${e.to}`), [`${R}#Event_RechnungVersendet -> ${P}#Event_InvoiceSent`]);
  assert.deepEqual(s.questions, {
    pairs: 2,
    byClass: { must_link: 1, may_link: 0, must_not_link: 0, unlisted: 1, same_process: 0 },
  });
  // A no-link on a pair the recording also proposes does not count.
  assert.deepEqual(s.noLinks.byClass, { must_link: 1, may_link: 0, must_not_link: 0, unlisted: 1, same_process: 0 });
  assert.equal(s.noLinks.pairs, 2);
  assert.deepEqual(s.noLinks.onMustLink.map((e) => e.tags), [['de-en']]);

  // fixture-agent is a live run (not agent-sim): its must_not_link pair at 0.85 fails the live gate.
  assert.deepEqual(
    report.liveGate.map((g) => [g.procedure, g.landscape, g.status, g.runs, g.mustNotLinkHighConfidence, g.baseline.source]),
    [['proa-relations@0.0.1', 'sample', 'fail', 1, 1, 'none']],
  );
});

test('renders a deterministic report', async () => {
  const report = await replay(FIXTURES, CORPUS_DIR);
  const md = renderReplayMarkdown(report);
  assert.equal(renderReplayMarkdown(await replay(FIXTURES, CORPUS_DIR)), md);
  assert.match(md, /^# eval:replay\n/);
  assert.match(
    md,
    /\| proa-relations@0\.0\.1 \/ fixture-agent \/ fixture-model \/ sample \| dev \| 2 \| 5 \| 60\.0 % \| 60\.0 % \| 60\.0 % \| 80\.0 % \| 1 \(1\) \| 2 \| 2 \| 3 \|/,
  );
  assert.match(md, /- `trigger` finance\/payment-collection#End_InvoicePaid → finance\/payment-collection#Event_InvoiceSent \(confidence 0\.85; near-miss, self-link\)/);
  assert.match(renderReplayMarkdown({ recordings: [], liveGate: [] }), /_No recordings\._/);
  assert.match(
    md,
    /## Live gate\n\n.*\n\n\| Procedure \/ landscape \|.*\n.*\n\| proa-relations@0\.0\.1 \/ sample \| dev \| fail \| 1 \| 60\.0 % \| 60\.0 % \| 60\.0 % \| n\/a \| none \| 1 \|\n/,
  );
  assert.match(md, /- proa-relations@0\.0\.1 \/ sample: fail: 1 must_not_link pair proposed with confidence ≥ 0\.8 \(in 1 of 1 run\); 1 of 3 runs; no baseline/);
  const onlySim = renderReplayMarkdown({
    recordings: report.recordings.map((r) => ({ ...r, agent: 'agent-sim' })),
    liveGate: [],
  });
  assert.match(onlySim, /## Live gate\n\n.*\n\n_No live runs yet\._\n/);
});

test('scores the committed recordings of the simulation agent', async () => {
  const report = await replay();
  const files = report.recordings.map((s) => s.file);
  // The simulation agent declares the procedure the claims name: its current version.
  const current = getProcedure('proa-relations');
  assert.ok(current);
  const dir = `${current.id}@${current.version}/agent-sim/sim-policy-1`;
  assert.ok(files.includes(`${dir}/nordwind-handel.jsonl`), files.join(', '));
  assert.ok(files.includes(`${dir}/stadtwerke-auental.jsonl`), files.join(', '));
  for (const s of report.recordings.filter((r) => r.agent === 'agent-sim')) {
    // Every model analysed once and submitted; the server found nothing invalid.
    assert.equal(s.tasks.lines, s.tasks.landscapeModels, s.file);
    assert.equal(s.tasks.submitted, s.tasks.lines, s.file);
    assert.deepEqual(s.items.invalid, {}, s.file);
    assert.ok(s.overall.recall !== null && s.overall.recall > 0.5, s.file);
    // The rule tier's acceptances are the calls the agent leaves alone.
    assert.ok((s.withRules.recall ?? 0) >= (s.overall.recall ?? 0), s.file);
    assert.ok(s.questions.pairs > 0, s.file);
  }
  // The live gate covers exactly the groups with live runs.
  assert.deepEqual(
    report.liveGate.map((g) => `${g.procedure} ${g.landscape}`),
    [...new Set(report.recordings.filter((r) => r.agent !== 'agent-sim').map((r) => `${r.procedure} ${r.landscape}`))].sort(),
  );
  // The committed report is up to date (regenerate with `pnpm eval:replay`).
  const committed = await readFile(fileURLToPath(new URL('../../reports/replay.md', import.meta.url)), 'utf8');
  assert.equal(committed, renderReplayMarkdown(report));
});

test('refuses unreadable recordings with file and line', async () => {
  const good = await readFile(path.join(FIXTURES, FIXTURE_FILE), 'utf8');
  assert.throws(() => parseRecording('a/b.jsonl', good), /expected <procedure>@<version>\/<agent>\/<llmModel>\/<landscape>\.jsonl/);
  assert.throws(() => parseRecording(FIXTURE_FILE, `${good}{oops\n`), (err: unknown) => {
    assert.ok(err instanceof RecordingError);
    assert.match(err.message, /sample\.jsonl:3: not JSON/);
    return true;
  });
  assert.throws(() => parseRecording(FIXTURE_FILE, '{"format":"proa-recording/2"}\n'), /:1: not a proa-recording\/1 line \(format: /);
  assert.throws(
    () => parseRecording('proa-relations@0.0.1/other/fixture-model/sample.jsonl', good),
    /:1: the line belongs to proa-relations@0\.0\.1\/fixture-agent\/fixture-model\/sample\.jsonl/,
  );
  assert.throws(() => parseRecording(FIXTURE_FILE, '\n'), /no recording lines/);
});

test('finds landscapes by name or as _<name>, and nothing in a missing directory', async () => {
  assert.equal(await landscapeDir(CORPUS_DIR, 'nordwind-handel'), path.join(CORPUS_DIR, 'nordwind-handel'));
  assert.equal(await landscapeDir(CORPUS_DIR, 'sample'), path.join(CORPUS_DIR, '_sample'));
  await assert.rejects(landscapeDir(CORPUS_DIR, 'atlantis'), /no landscape atlantis/);
  assert.deepEqual(await loadRecordings(path.join(os.tmpdir(), 'proa-no-such-recordings')), []);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'proa-replay-'));
  try {
    const file = path.join(dir, 'proa-relations@0.0.1/fixture-agent/fixture-model/atlantis.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    const line = (await readFile(path.join(FIXTURES, FIXTURE_FILE), 'utf8')).split('\n')[0] ?? '';
    await writeFile(file, `${line.replace('"landscape":"sample"', '"landscape":"atlantis"')}\n`);
    await assert.rejects(replay(dir, CORPUS_DIR), /no landscape atlantis/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
