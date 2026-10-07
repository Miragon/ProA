#!/usr/bin/env node
// Validates one or more corpus landscapes.
//
//   node validate.mjs <landscape-dir>...
//   node validate.mjs --all
//
// Sections: landscape.yaml and specs (zod + semantics); sync (regenerate and
// compare bytes); parse (bpmn-moddle + engine extension, no warnings); lint
// (bpmnlint:recommended + camunda-compat for the model's engine/version);
// DI completeness and placement; expected.yaml (refs, endpoint kinds,
// deterministic findings, data store groups, closed-world completeness, trap
// coverage). Exits 1 on any error.
import { findLandscapeDir, listLandscapes } from './lib/landscape.mjs';
import { formatReport, validateLandscape } from './lib/validate-landscape.mjs';

const args = process.argv.slice(2);
const all = args.includes('--all');
const targets = args.filter((a) => !a.startsWith('--'));
if (!all && !targets.length) {
  console.error('usage: node validate.mjs <landscape-dir>... | --all');
  process.exit(2);
}

const dirs = all ? await listLandscapes() : [];
for (const t of targets) {
  const dir = await findLandscapeDir(t);
  if (!dir) {
    console.error(`${t}: no landscape.yaml found in this directory or its parents`);
    process.exit(2);
  }
  dirs.push(dir);
}
if (!dirs.length) {
  console.error('no landscapes found');
  process.exit(2);
}

let failed = false;
for (const dir of dirs) {
  const result = await validateLandscape(dir);
  console.log(formatReport(result));
  if (!result.ok) failed = true;
}
process.exit(failed ? 1 : 0);
