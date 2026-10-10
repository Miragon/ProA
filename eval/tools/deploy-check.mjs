#!/usr/bin/env node
// Deploys the generated models to real Camunda 7 and Camunda 8 engines
// (engines.compose.yaml) and reports what the engines reject.
//
//   node deploy-check.mjs <landscape-dir>... [--keep] [--json]
//   node deploy-check.mjs --all [--keep] [--json]
//
// Per landscape and engine:
//   1. every model on its own, deleted again right after the check, so models
//      never see each other (c7: deployment deleted with cascade; c8: its
//      process definitions deleted through /v2/resources/{key}/deletion);
//   2. all models of the engine in one deployment, which surfaces cross-file
//      conflicts (duplicate process ids, c7 message start names). If the
//      bundle has executable processes with the same id, the engine must reject
//      it; that is the intentional trap when expected.yaml lists those models in
//      a duplicate-process-id finding. The bundle is then deployed once per
//      copy: all other models plus that copy.
// A deployment passes when the engine accepts it and creates a process
// definition for every executable process of its models. Models come from
// models/; a directory without models/ (generator fixtures) is generated in
// memory from spec/. c7 deployments carry the landscape name as tenant id, so
// landscapes never conflict on c7 message start names.
//
// Engines: PROA_C7_URL (default http://127.0.0.1:18080/engine-rest) and
// PROA_C8_URL (default http://127.0.0.1:18088). --keep leaves the first passing
// bundle per landscape and engine deployed, as demo data for Cockpit and
// Operate. c8 has no tenants here, so keep one landscape at a time there: the
// landscapes reuse process ids (Process_Kundenbenachrichtigung) and would
// become versions of each other.
// Exit 1 on any unexpected rejection, 2 on usage errors or unreachable engines.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ENGINES, compareVersions, engineFromExecutionPlatform, majorMinor } from './lib/constants.mjs';
import { createModdle } from './lib/moddle.mjs';
import { exists, findLandscapeDir, listFiles, listLandscapes, loadLandscape, readYaml } from './lib/landscape.mjs';

const C7_URL = (process.env.PROA_C7_URL ?? 'http://127.0.0.1:18080/engine-rest').replace(/\/$/, '');
const C8_URL = (process.env.PROA_C8_URL ?? 'http://127.0.0.1:18088').replace(/\/$/, '');
const TIMEOUT_MS = 120_000;
const SOURCE = 'proa-eval deploy-check';

const args = process.argv.slice(2);
const all = args.includes('--all');
const keep = args.includes('--keep');
const asJson = args.includes('--json');
const unknown = args.filter((a) => a.startsWith('--') && !['--all', '--keep', '--json'].includes(a));
const targets = args.filter((a) => !a.startsWith('--'));
if (unknown.length || (!all && !targets.length)) {
  console.error('usage: node deploy-check.mjs <landscape-dir>... | --all [--keep] [--json]');
  process.exit(2);
}

// ---------------------------------------------------------------- engines

async function request(url, init = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return { ok: false, status: 0, body: null, text: `${url}: ${e.cause?.code ?? e.message}` };
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  return { ok: res.ok, status: res.status, body, text };
}

const resourceName = (key) => `${key}.bpmn`;

function multipart(fields, models, partName) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const m of models) {
    const name = resourceName(m.key);
    form.append(partName ?? name, new Blob([m.xml], { type: 'application/xml' }), name);
  }
  return form;
}

/** c7 ParseException details or plain message, one line per problem. */
function c7Errors(res) {
  const b = res.body;
  if (b?.details && typeof b.details === 'object') {
    const lines = [];
    for (const [resource, d] of Object.entries(b.details)) {
      for (const e of d.errors ?? []) {
        const where = e.mainElementId ? ` ${e.mainElementId}` : '';
        lines.push(`${resource}${where}: ${e.message}`);
      }
    }
    if (lines.length) return lines;
  }
  return [`HTTP ${res.status}: ${b?.message ?? res.text}`];
}

/** c8 problem detail, one line per problem (Zeebe lists them as "- ERROR: ..." lines). */
function c8Errors(res) {
  const b = res.body;
  const detail = b?.detail ?? b?.title ?? res.text;
  return [`HTTP ${res.status}: ${String(detail).trim()}`];
}

const engines = {
  c7: {
    url: C7_URL,
    async version() {
      const r = await request(`${C7_URL}/version`);
      return r.ok ? r.body?.version : null;
    },
    async deploy(models, { name, tenant }) {
      const form = multipart(
        {
          'deployment-name': name,
          'deployment-source': SOURCE,
          'enable-duplicate-filtering': 'false',
          'deploy-changed-only': 'false',
          'tenant-id': tenant
        },
        models
      );
      const r = await request(`${C7_URL}/deployment/create`, { method: 'POST', body: form });
      if (!r.ok) return { ok: false, errors: c7Errors(r) };
      const defs = Object.values(r.body?.deployedProcessDefinitions ?? {});
      return { ok: true, id: r.body.id, processIds: defs.map((d) => d.key) };
    },
    async undeploy(deployment) {
      const url = `${C7_URL}/deployment/${encodeURIComponent(deployment.id)}?cascade=true`;
      const r = await request(url, { method: 'DELETE' });
      return r.ok ? null : `could not delete c7 deployment ${deployment.id}: HTTP ${r.status} ${r.text}`;
    }
  },
  c8: {
    url: C8_URL,
    async version() {
      const r = await request(`${C8_URL}/v2/topology`);
      return r.ok ? r.body?.gatewayVersion : null;
    },
    async deploy(models) {
      const r = await request(`${C8_URL}/v2/deployments`, { method: 'POST', body: multipart({}, models, 'resources') });
      if (!r.ok) return { ok: false, errors: c8Errors(r) };
      const defs = (r.body?.deployments ?? []).map((d) => d.processDefinition).filter(Boolean);
      return {
        ok: true,
        id: r.body.deploymentKey,
        processIds: defs.map((d) => d.processDefinitionId),
        resourceKeys: defs.map((d) => d.processDefinitionKey)
      };
    },
    async undeploy(deployment) {
      // Zeebe deletes resources (process definitions), not deployments
      for (const key of deployment.resourceKeys) {
        const r = await request(`${C8_URL}/v2/resources/${encodeURIComponent(key)}/deletion`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        });
        if (!r.ok) return `could not delete c8 process definition ${key}: HTTP ${r.status} ${r.text}`;
      }
      return null;
    }
  }
};

// ---------------------------------------------------------------- models

async function readModel(key, xml) {
  const platform = /modeler:executionPlatform="([^"]*)"/.exec(xml)?.[1];
  const version = /modeler:executionPlatformVersion="([^"]*)"/.exec(xml)?.[1] ?? null;
  const engine = engineFromExecutionPlatform(platform);
  if (!engine) return { key, xml, engine: null, version, processes: [], error: `unknown executionPlatform "${platform}"` };
  const { rootElement } = await createModdle(engine).fromXML(xml, 'bpmn:Definitions');
  const processes = (rootElement.rootElements ?? [])
    .filter((e) => e.$type === 'bpmn:Process')
    .map((p) => ({ id: p.id, executable: p.isExecutable === true }));
  return { key, xml, engine, version, processes, error: null };
}

async function loadModels(dir) {
  const modelsDir = path.join(dir, 'models');
  const rels = await listFiles(modelsDir, ['.bpmn']);
  if (rels.length) {
    return Promise.all(
      rels.map(async (rel) => readModel(rel.replace(/\.bpmn$/, ''), await readFile(path.join(modelsDir, rel), 'utf8')))
    );
  }
  // no models/: generator fixtures, generated in memory
  const ls = await loadLandscape(dir);
  const broken = ls.specs.filter((s) => s.errors.length);
  if (broken.length) throw new Error(`spec errors in ${broken.map((s) => s.rel).join(', ')}; run validate.mjs`);
  return Promise.all(ls.specs.map((s) => readModel(s.spec.key, s.xml)));
}

/** processId -> Set(model keys) from duplicate-process-id findings of expected.yaml. */
async function expectedDuplicates(dir) {
  const map = new Map();
  const file = path.join(dir, 'expected.yaml');
  if (!(await exists(file))) return map;
  const expected = await readYaml(file);
  for (const f of expected.expected_findings ?? []) {
    if (f.kind !== 'duplicate-process-id') continue;
    for (const ref of f.refs ?? []) {
      const [key, id] = ref.split('#');
      if (!map.has(id)) map.set(id, new Set());
      map.get(id).add(key);
    }
  }
  return map;
}

const executableIds = (models) => models.flatMap((m) => m.processes.filter((p) => p.executable).map((p) => p.id));

/** Compares what the engine created with the executable processes of the deployed models. */
function definitionProblems(models, processIds) {
  const want = executableIds(models).sort();
  const got = [...processIds].sort();
  if (JSON.stringify(want) === JSON.stringify(got)) return [];
  const missing = want.filter((id) => !got.includes(id));
  const extra = got.filter((id) => !want.includes(id));
  return [
    `engine created ${got.length} process definition(s), expected ${want.length}` +
      `${missing.length ? `; missing ${missing.join(', ')}` : ''}${extra.length ? `; unexpected ${extra.join(', ')}` : ''}`
  ];
}

// ---------------------------------------------------------------- checks

async function deployAndVerify(engine, models, { name, tenant, keepIt }) {
  const client = engines[engine];
  const res = await client.deploy(models, { name, tenant });
  if (!res.ok) return { ok: false, errors: res.errors };
  const errors = definitionProblems(models, res.processIds);
  const definitions = res.processIds.length;
  if (!keepIt || errors.length) {
    const err = await client.undeploy(res);
    if (err) errors.push(err);
  }
  return { ok: errors.length === 0, errors, definitions, kept: keepIt && errors.length === 0 };
}

async function checkEngine(landscape, engine, models, expectedDups, engineVersion) {
  const out = { engine, engineVersion, models: [], bundle: null, versionErrors: [], notes: [] };
  const tenant = landscape;

  // the engine must be at least the model's target minor (newer is fine)
  for (const m of models) {
    if (m.version && compareVersions(majorMinor(engineVersion), majorMinor(m.version)) < 0) {
      out.versionErrors.push(`engine ${engineVersion} is older than the target ${m.version} of ${m.key}`);
    }
  }

  // 1. every model on its own
  for (const m of models) {
    const r = await deployAndVerify(engine, [m], { name: `${landscape} ${m.key}`, tenant, keepIt: false });
    out.models.push({ key: m.key, ok: r.ok, errors: r.errors ?? [], definitions: r.definitions ?? 0 });
  }

  // 2. the whole landscape in one deployment
  const byId = new Map();
  for (const m of models) {
    for (const p of m.processes.filter((x) => x.executable)) {
      if (!byId.has(p.id)) byId.set(p.id, []);
      byId.get(p.id).push(m.key);
    }
  }
  const dups = [...byId].filter(([, keys]) => keys.length > 1).map(([id, keys]) => ({ id, keys }));
  const unexpectedDups = dups.filter((d) => !d.keys.every((k) => expectedDups.get(d.id)?.has(k)));
  const bundle = { size: models.length, duplicates: dups, status: null, errors: [], variants: [] };
  out.bundle = bundle;

  const full = await deployAndVerify(engine, models, { name: `${landscape} (all ${engine})`, tenant, keepIt: keep });
  if (full.ok) {
    bundle.status = 'ok';
    bundle.definitions = full.definitions;
    if (dups.length) out.notes.push(`engine accepted duplicate process ids ${dups.map((d) => d.id).join(', ')} in one deployment`);
    return out;
  }
  bundle.errors = full.errors;
  // c7 names only the first duplicate key; the per-copy deployments below
  // catch any other problem hidden behind it
  const text = full.errors.join('\n');
  if (!dups.length || unexpectedDups.length || !dups.some((d) => text.includes(d.id))) {
    bundle.status = 'failed';
    if (unexpectedDups.length) {
      bundle.errors.push(
        ...unexpectedDups.map((d) => `duplicate process id ${d.id} in ${d.keys.join(', ')} is not an expected duplicate-process-id finding`)
      );
    }
    return out;
  }
  // rejected because of the intentional duplicates: deploy all other models plus one copy at a time
  bundle.status = 'expected-rejection';
  const dupKeys = new Set(dups.flatMap((d) => d.keys));
  const rest = models.filter((m) => !dupKeys.has(m.key));
  const rounds = Math.max(...dups.map((d) => d.keys.length));
  let kept = false;
  for (let i = 0; i < rounds; i++) {
    const copies = [...new Set(dups.map((d) => d.keys[i % d.keys.length]))];
    const variant = [...rest, ...models.filter((m) => copies.includes(m.key))];
    const keepIt = keep && !kept;
    const r = await deployAndVerify(engine, variant, { name: `${landscape} (all ${engine}, copy ${i + 1})`, tenant, keepIt });
    if (r.kept) kept = true;
    bundle.variants.push({ copies, size: variant.length, ok: r.ok, errors: r.errors ?? [], definitions: r.definitions ?? 0 });
  }
  return out;
}

async function checkLandscape(dir, engineVersions) {
  const landscape = path.basename(dir);
  const result = { landscape, dir, engines: [], errors: [] };
  let models;
  try {
    models = await loadModels(dir);
  } catch (e) {
    result.errors.push(e.message);
    return result;
  }
  for (const m of models) if (m.error) result.errors.push(`${m.key}: ${m.error}`);
  const expectedDups = await expectedDuplicates(dir);
  for (const engine of Object.keys(ENGINES)) {
    const own = models.filter((m) => m.engine === engine);
    if (!own.length) continue;
    if (!engineVersions[engine]) {
      result.errors.push(`${ENGINES[engine].label} is not reachable at ${engines[engine].url} (docker compose -f engines.compose.yaml up -d --wait)`);
      continue;
    }
    result.engines.push(await checkEngine(landscape, engine, own, expectedDups, engineVersions[engine]));
  }
  return result;
}

const passed = (e) =>
  !e.versionErrors.length &&
  e.models.every((m) => m.ok) &&
  (e.bundle.status === 'ok' || (e.bundle.status === 'expected-rejection' && e.bundle.variants.every((v) => v.ok)));

// ---------------------------------------------------------------- report

function format(results) {
  const lines = [];
  const indent = (s, n) => s.replace(/\n/g, `\n${' '.repeat(n)}`);
  for (const r of results) {
    const ok = !r.errors.length && r.engines.every(passed);
    lines.push(`${r.landscape}: ${ok ? 'ok' : 'FAILED'}`);
    for (const e of r.errors) lines.push(`  error: ${indent(e, 9)}`);
    for (const e of r.engines) {
      const good = e.models.filter((m) => m.ok).length;
      const defs = e.models.reduce((s, m) => s + m.definitions, 0);
      lines.push(`  ${e.engine} ${e.engineVersion}: ${good}/${e.models.length} models deployed on their own (${defs} process definitions)`);
      for (const v of e.versionErrors) lines.push(`    FAILED ${v}`);
      for (const m of e.models.filter((x) => !x.ok)) {
        lines.push(`    FAILED ${m.key}`);
        for (const err of m.errors) lines.push(`      ${indent(err, 6)}`);
      }
      const b = e.bundle;
      if (b.status === 'ok') {
        lines.push(`    all ${b.size} models in one deployment: ok (${b.definitions} process definitions)`);
      } else if (b.status === 'expected-rejection') {
        const what = b.duplicates.map((d) => `${d.id} in ${d.keys.join(' + ')}`).join('; ');
        lines.push(`    all ${b.size} models in one deployment: rejected as expected (duplicate-process-id trap: ${what})`);
        lines.push(`      engine: ${indent(b.errors.join('\n'), 14)}`);
        for (const v of b.variants) {
          lines.push(`    ${v.size} models with copy ${v.copies.join(', ')}: ${v.ok ? `ok (${v.definitions} process definitions)` : 'FAILED'}`);
          for (const err of v.errors) lines.push(`      ${indent(err, 6)}`);
        }
      } else {
        lines.push(`    all ${b.size} models in one deployment: FAILED`);
        for (const err of b.errors) lines.push(`      ${indent(err, 6)}`);
      }
      for (const n of e.notes) lines.push(`    note: ${n}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- main

const dirs = all ? await listLandscapes() : [];
for (const t of targets) {
  const dir = await findLandscapeDir(t);
  if (!dir) {
    console.error(`${t}: no landscape.yaml found in this directory or its parents`);
    process.exit(2);
  }
  dirs.push(dir);
}

const engineVersions = {};
for (const [engine, client] of Object.entries(engines)) engineVersions[engine] = await client.version();
if (!Object.values(engineVersions).some(Boolean)) {
  console.error(`no engine reachable at ${C7_URL} or ${C8_URL}; start them with: docker compose -f engines.compose.yaml up -d --wait`);
  process.exit(2);
}

const results = [];
for (const dir of dirs) results.push(await checkLandscape(dir, engineVersions));

const ok = results.every((r) => !r.errors.length && r.engines.every(passed));
const unreachable = results.some((r) => r.errors.some((e) => e.includes('is not reachable')));
if (asJson) console.log(JSON.stringify({ ok, engineVersions, results }, null, 2));
else console.log(format(results));
process.exit(unreachable ? 2 : ok ? 0 : 1);
