// Loads a landscape directory and generates its models in memory.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { toBpmnXml } from './bpmn.mjs';
import { ENGINES } from './constants.mjs';
import { layoutModel } from './layout.mjs';
import { buildModel, SpecError } from './model.mjs';
import { Expected, formatZodError, Landscape, ModelSpec } from './schema.mjs';

export const TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EVAL_DIR = path.resolve(TOOLS_DIR, '..');
export const CORPUS_DIR = path.join(EVAL_DIR, 'corpus');

const toPosix = (p) => p.split(path.sep).join('/');

export async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Parses YAML strictly (duplicate keys are errors). */
export async function readYaml(file) {
  const text = await readFile(file, 'utf8');
  const doc = YAML.parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors.map((e) => e.message).join('\n'));
  return doc.toJS() ?? {};
}

/** Recursive file listing, relative posix paths, sorted. */
export async function listFiles(dir, extensions) {
  if (!(await exists(dir))) return [];
  const out = [];
  const walk = async (d) => {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (extensions.some((x) => e.name.endsWith(x))) out.push(toPosix(path.relative(dir, full)));
    }
  };
  await walk(dir);
  return out.sort();
}

/** All landscape directories under eval/corpus (those with a landscape.yaml), sorted. */
export async function listLandscapes() {
  if (!(await exists(CORPUS_DIR))) return [];
  const entries = await readdir(CORPUS_DIR, { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    if (e.isDirectory() && (await exists(path.join(CORPUS_DIR, e.name, 'landscape.yaml')))) {
      dirs.push(path.join(CORPUS_DIR, e.name));
    }
  }
  return dirs.sort();
}

/** Walks up from a file or directory to the nearest directory containing landscape.yaml. */
export async function findLandscapeDir(start) {
  let dir = path.resolve(start);
  if (!(await stat(dir)).isDirectory()) dir = path.dirname(dir);
  for (;;) {
    if (await exists(path.join(dir, 'landscape.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Loads landscape.yaml, all specs and expected.yaml and generates every model
 * in memory. Problems are collected, never thrown.
 */
export async function loadLandscape(dir, { only } = {}) {
  const result = {
    dir,
    name: path.basename(dir),
    landscape: null,
    landscapeErrors: [],
    specs: [],
    expected: null,
    expectedErrors: []
  };

  try {
    const parsed = Landscape.safeParse(await readYaml(path.join(dir, 'landscape.yaml')));
    if (parsed.success) result.landscape = parsed.data;
    else result.landscapeErrors.push(...formatZodError(parsed.error).map((m) => `landscape.yaml ${m}`));
  } catch (e) {
    result.landscapeErrors.push(`landscape.yaml: ${e.message}`);
  }
  if (!(await exists(path.join(dir, 'README.md')))) {
    result.landscapeErrors.push('README.md is missing (describe the landscape and its traps)');
  }
  if (result.landscape && result.landscape.name !== result.name) {
    result.landscapeErrors.push(`landscape.yaml name "${result.landscape.name}" must equal the directory name "${result.name}"`);
  }

  const specDir = path.join(dir, 'spec');
  const seenKeys = new Map();
  for (const rel of await listFiles(specDir, ['.yaml', '.yml'])) {
    const file = path.join(specDir, rel);
    if (only && path.resolve(only) !== file) continue;
    const entry = {
      rel: `spec/${rel}`,
      file,
      expectedKey: rel.replace(/\.ya?ml$/, ''),
      spec: null,
      model: null,
      xml: null,
      errors: []
    };
    result.specs.push(entry);
    try {
      const parsed = ModelSpec.safeParse(await readYaml(file));
      if (!parsed.success) {
        entry.errors.push(...formatZodError(parsed.error));
        continue;
      }
      const spec = parsed.data;
      entry.spec = spec;
      if (spec.key !== entry.expectedKey) {
        entry.errors.push(`key "${spec.key}" must match the spec path (expected "${entry.expectedKey}")`);
        continue;
      }
      if (seenKeys.has(spec.key)) {
        entry.errors.push(`key "${spec.key}" is also defined by ${seenKeys.get(spec.key)}`);
        continue;
      }
      seenKeys.set(spec.key, entry.rel);
      const declared = result.landscape?.engines?.[spec.engine];
      if (result.landscape && !declared) {
        entry.errors.push(`engine ${spec.engine} is not declared in landscape.yaml engines`);
        continue;
      }
      const engineVersion = spec.engineVersion ?? declared ?? ENGINES[spec.engine].defaultVersion;
      entry.model = buildModel(spec, { engineVersion });
      const layout = layoutModel(entry.model);
      entry.xml = await toBpmnXml(entry.model, layout, { specRel: `eval/corpus/${result.name}/${entry.rel}` });
    } catch (e) {
      if (e instanceof SpecError) entry.errors.push(...e.errors);
      else entry.errors.push(e.stack ?? String(e));
    }
  }

  const expectedFile = path.join(dir, 'expected.yaml');
  if (await exists(expectedFile)) {
    try {
      const parsed = Expected.safeParse(await readYaml(expectedFile));
      if (parsed.success) result.expected = parsed.data;
      else result.expectedErrors.push(...formatZodError(parsed.error).map((m) => `expected.yaml ${m}`));
    } catch (e) {
      result.expectedErrors.push(`expected.yaml: ${e.message}`);
    }
  } else {
    result.expectedErrors.push('expected.yaml is missing');
  }

  return result;
}

export function modelPath(dir, key) {
  return path.join(dir, 'models', `${key}.bpmn`);
}
