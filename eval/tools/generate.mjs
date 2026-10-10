#!/usr/bin/env node
// Generates models/<key>.bpmn from spec/<key>.yaml for one or more landscapes.
//
//   node generate.mjs <landscape-dir|spec-file>... [--check]
//   node generate.mjs --all [--check]
//
// models/ is fully owned by the generator: stale .bpmn files without a spec
// are removed (not in single-spec mode). --check writes nothing and exits 1
// when a model is missing, stale or out of date.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  exists,
  findLandscapeDir,
  listFiles,
  listLandscapes,
  loadLandscape,
  modelPath
} from './lib/landscape.mjs';

const args = process.argv.slice(2);
const check = args.includes('--check');
const all = args.includes('--all');
const targets = args.filter((a) => !a.startsWith('--'));

if (!all && !targets.length) {
  console.error('usage: node generate.mjs <landscape-dir|spec-file>... [--check] | --all [--check]');
  process.exit(2);
}

const jobs = [];
if (all) for (const dir of await listLandscapes()) jobs.push({ dir, only: null });
for (const t of targets) {
  const dir = await findLandscapeDir(t);
  if (!dir) {
    console.error(`${t}: no landscape.yaml found in this directory or its parents`);
    process.exit(2);
  }
  const isSpec = /\.ya?ml$/.test(t) && path.resolve(t) !== path.join(dir, 'landscape.yaml');
  jobs.push({ dir, only: isSpec ? path.resolve(t) : null });
}

let failed = false;
for (const { dir, only } of jobs) {
  const ls = await loadLandscape(dir, { only });
  const counts = { written: 0, unchanged: 0, removed: 0, outdated: 0 };
  const problems = [...ls.landscapeErrors];
  const keys = new Set();
  for (const s of ls.specs) {
    if (s.errors.length) {
      problems.push(...s.errors.map((e) => `${s.rel}: ${e}`));
      continue;
    }
    keys.add(s.spec.key);
    const file = modelPath(dir, s.spec.key);
    const current = (await exists(file)) ? await readFile(file, 'utf8') : null;
    if (current === s.xml) {
      counts.unchanged++;
    } else if (check) {
      counts.outdated++;
      problems.push(`models/${s.spec.key}.bpmn is ${current === null ? 'missing' : 'out of date'}`);
    } else {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, s.xml);
      counts.written++;
    }
  }
  if (!only && !ls.specs.some((s) => s.errors.length)) {
    for (const rel of await listFiles(path.join(dir, 'models'), ['.bpmn'])) {
      const key = rel.replace(/\.bpmn$/, '');
      if (keys.has(key)) continue;
      if (check) {
        problems.push(`models/${rel} has no spec`);
      } else {
        await rm(path.join(dir, 'models', rel));
        counts.removed++;
      }
    }
  }
  const summary = check
    ? `${counts.unchanged} in sync, ${counts.outdated} out of date`
    : `${counts.written} written, ${counts.unchanged} unchanged, ${counts.removed} removed`;
  console.log(`${ls.name}: ${ls.specs.length} spec(s); ${summary}${problems.length ? `; ${problems.length} problem(s)` : ''}`);
  for (const p of problems) console.log(`  ${p.replace(/\n/g, '\n  ')}`);
  if (problems.length) failed = true;
}

process.exit(failed ? 1 : 0);
