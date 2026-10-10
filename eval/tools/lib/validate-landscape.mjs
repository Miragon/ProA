// Validation of one landscape, shared by validate.mjs and test.mjs.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { checkDi, checkExpected, lintModel, parseModel } from './checks.mjs';
import { TRAP_TAGS } from './constants.mjs';
import { extractFacts } from './facts.mjs';
import { listFiles, loadLandscape } from './landscape.mjs';

/**
 * @param {string} dir landscape directory
 * @param {{ inMemory?: boolean }} options inMemory: check the freshly generated
 *   XML instead of models/ and skip the sync and expected.yaml sections
 *   (used for generator fixtures)
 */
export async function validateLandscape(dir, { inMemory = false } = {}) {
  const ls = await loadLandscape(dir);
  const sections = [];
  const section = (name, errors, summary) => sections.push({ name, errors, summary });

  section('landscape', ls.landscapeErrors, 'landscape.yaml');
  const specErrors = ls.specs.flatMap((s) => s.errors.map((e) => `${s.rel}: ${e}`));
  section('specs', specErrors, `${ls.specs.length} spec(s)`);

  const specByKey = new Map(ls.specs.filter((s) => s.spec).map((s) => [s.spec.key, s]));
  const xmlByKey = new Map();
  if (inMemory) {
    for (const [key, s] of specByKey) if (s.xml) xmlByKey.set(key, s.xml);
  } else {
    // (e) sync: regenerate in memory and compare with the committed models
    const modelFiles = await listFiles(path.join(dir, 'models'), ['.bpmn']);
    const syncErrors = [];
    for (const rel of modelFiles) {
      const key = rel.replace(/\.bpmn$/, '');
      const xml = await readFile(path.join(dir, 'models', rel), 'utf8');
      xmlByKey.set(key, xml);
      const s = specByKey.get(key);
      if (!s) syncErrors.push(`models/${rel}: no spec/${key}.yaml`);
      else if (s.xml !== null && s.xml !== xml) {
        syncErrors.push(`models/${rel}: differs from its spec; run node generate.mjs ${path.relative(process.cwd(), dir) || '.'}`);
      }
    }
    for (const key of specByKey.keys()) if (!xmlByKey.has(key)) syncErrors.push(`models/${key}.bpmn is missing; run generate`);
    section('sync', syncErrors, `${modelFiles.length} model(s) match their specs`);
  }

  // (a) parse, (b) lint, (c) DI
  const parseErrors = [];
  const lintErrors = [];
  const diErrors = [];
  const lintConfigs = new Set();
  const index = new Map();
  for (const [key, xml] of xmlByKey) {
    const spec = specByKey.get(key)?.spec;
    const where = `models/${key}.bpmn`;
    const parsed = await parseModel(xml, spec?.engine);
    parseErrors.push(...parsed.errors.map((e) => `${where}: ${e}`));
    if (!parsed.definitions) continue;
    index.set(key, extractFacts(key, parsed.definitions));
    if (parsed.engine && parsed.version) {
      const lint = await lintModel(parsed.definitions, {
        engine: parsed.engine,
        version: parsed.version,
        disable: spec?.lint?.disable ?? []
      });
      if (lint.config) lintConfigs.add(lint.config);
      lintErrors.push(...lint.errors.map((e) => `${where}: ${e}`));
    }
    diErrors.push(...checkDi(parsed.definitions).map((e) => `${where}: ${e}`));
  }
  section('parse', parseErrors, `${xmlByKey.size} model(s), bpmn-moddle without warnings`);
  section('lint', lintErrors, `bpmnlint:recommended + ${[...lintConfigs].sort().join(', ') || 'n/a'}`);
  section('di', diErrors, `${xmlByKey.size} model(s) complete and in bounds`);

  // (d) expected.yaml
  let trapSummary = null;
  if (!inMemory) {
    const exp = checkExpected(ls, index);
    const st = exp.stats;
    section(
      'expected',
      [...ls.expectedErrors, ...exp.errors],
      `${st.relations} relations (${st.must_link} must, ${st.must_not_link} must-not, ${st.may_link} may), ${st.findings} findings, ${st.groups} data store group(s)`
    );
    const na = Object.keys(ls.landscape?.traps_not_applicable ?? {});
    const tagged = TRAP_TAGS.filter((t) => exp.tags.has(t));
    trapSummary = `${tagged.length}/${TRAP_TAGS.length} traps tagged${na.length ? `; not applicable: ${na.join(', ')}` : ''}`;
  }

  const l = ls.landscape;
  const header = l
    ? `${ls.name}  ${l.closed_world ? 'closed' : 'open'} world, ${l.lang}, ${l.split}, ${Object.entries(l.engines)
        .map(([e, v]) => `${e} ${v}`)
        .join(', ')}`
    : ls.name;
  const ok = sections.every((s) => !s.errors.length);
  return { ls, sections, ok, header, trapSummary, index };
}

export function formatReport({ ls, sections, ok, header, trapSummary }) {
  const lines = [header];
  for (const s of sections) {
    const status = s.errors.length ? `FAIL ${s.errors.length}` : 'ok';
    lines.push(`  ${s.name.padEnd(10)} ${status.padEnd(8)} ${s.summary}`);
    for (const e of s.errors) lines.push(`      ${e.replace(/\n/g, '\n      ')}`);
  }
  if (trapSummary) lines.push(`  ${'traps'.padEnd(10)} ${'info'.padEnd(8)} ${trapSummary}`);
  lines.push(`${ok ? 'PASS' : 'FAIL'} ${ls.name}`);
  return lines.join('\n');
}
