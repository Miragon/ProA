#!/usr/bin/env node
// Validates the golden value chains in eval/value-chains/<landscape>/ (README.md):
//
//   node eval/value-chains/validate-value-chains.mjs [--builtin] [<landscape> ...]
//
// 1. value-chain.vc.json against the value-chain schema. By default loadDocument (migration,
//    zod schema, cross-field rules) and serializeDocument come from the npm package
//    @miragon/value-chain-schema-model (its ESM build), resolved the way eval/tools resolves
//    it: eval/tools/package.json pins it at an exact version, like yaml (pnpm install at the
//    repository root). The installed version must equal that pin and be one of
//    VERIFIED_SCHEMA_MODEL; apps/server/test/unit/runtime-pins.test.ts keeps that pin equal to
//    the server's and the web's, so the gate covers the release the server stores with. A
//    faithful re-implementation below runs alongside and must agree on every document (the
//    output says so); --builtin uses it alone, without the package.
//    Without --builtin, a failed import, a stale install or an unverified version exits 2.
// 2. Notation and layout rules of the renderer (@miragon/value-chain-renderer): one core
//    sequence chain at the top level (at most one chain per group of sibling steps), a
//    hierarchy forest with 2+ sub-steps per parent, one org unit per top-level step, no
//    reserved ids, no step links, waypoints exactly as VcLayouter + contour cropping
//    produce them, no overlapping shapes, no edge through a foreign shape, labels that wrap
//    without cutting words and keep clear of the chevron notch (Arial 12px metrics).
// 3. expected-placements.yaml: the step list matches the document, every process of the
//    landscape (XML scan of eval/corpus/<landscape>/models) is listed exactly once, every
//    referenced step exists and is a step (or the pseudo-step @outside), must/may/must_not
//    are consistent, the hand-over rule for may holds against eval/corpus/<landscape>/
//    expected.yaml, and the derived tags (name-match/semantic, domain-prefix, ...) match.
//
// Exit code 1 on any error, 2 when the check cannot run as configured. Reads only.

import { createRequire, findPackageJSON, registerHooks } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROA_ROOT = resolve(HERE, '../..');
const CORPUS = join(PROA_ROOT, 'eval/corpus');
// eval/value-chains is no workspace package; its dependencies (the schema-model, yaml) are
// pinned in eval/tools/package.json and resolved from there.
const TOOLS_PACKAGE = join(PROA_ROOT, 'eval/tools/package.json');
const SCHEMA_MODEL = '@miragon/value-chain-schema-model';

const USAGE = 'usage: node eval/value-chains/validate-value-chains.mjs [--builtin] [<landscape> ...]';
const HELP = `${USAGE}

Validates the golden value chains in eval/value-chains/<landscape>/ (all landscapes by default).
  --builtin   use only the built-in re-implementation of the schema, not ${SCHEMA_MODEL}
Exit code 1: a finding in the data; 2: the check could not run as configured.`;

const VC_FILE = 'value-chain.vc.json';
const EXPECTED_FILE = 'expected-placements.yaml';

// Versions of @miragon/value-chain-schema-model whose schema this script was checked
// against (the built-in re-implementation below). Add a version only after reading its
// CHANGELOG for schema, migration or serialization changes. 0.2.0 and 0.3.0 publish the
// same dist files as 0.1.0 (only the version fields differ).
const VERIFIED_SCHEMA_MODEL = new Set(['0.1.0', '0.3.0']);
const VERIFIED_SCHEMA_VERSION = 1;

// The pseudo-step for "deliberately outside this chain" (M4); never an element id.
const OUTSIDE = '@outside';
// Reserved by the renderer (io/types.ts ROOT_ID): VcImporter skips such an element.
const RESERVED_IDS = new Set(['vc-root']);

// Colors of the non-core bands (renderer COLOR_OPTIONS "Purple" and "Green").
const KIND_COLOR = { management: 'hsl(287, 65%, 44%)', support: 'hsl(150, 86%, 34%)' };

const TAGS = new Set([
  'name-match',
  'semantic',
  'ambiguous',
  'shared-word',
  'domain-prefix',
  'cross-domain',
  'outdated-copy',
  'support-process',
  'management-process',
  'english-label',
  'integration',
]);
const PLACEMENT_KEYS = new Set(['process', 'name', 'must', 'may', 'must_not', 'tags', 'rationale', 'superseded_by']);
const STEP_KEYS = new Set(['id', 'name', 'kind', 'level', 'parent', 'scope']);
const RATIONALE_MAX = 300;
// Derived tags: a shared word stem has at least this many letters (README, "Tags").
const STEM_MIN = 4;

// Renderer constants (packages/renderer/src/draw/styles.ts, modeling/VcLayouter.ts).
const LABEL_PADDING = 7;
const LINE_HEIGHT = 12 * 1.2;
const TRUNK_MARGIN = 25;
const TRUNK_CLEARANCE = 10;
const BUS_MIN_STUB = 10;
const EXIT_MARGIN = 10;
const ROW_TOLERANCE_Y = 10;
// Own layout rules: gap between shapes, clearance between a label line and the notch apex.
const SHAPE_MARGIN = 10;
const NOTCH_CLEARANCE = 8;
const EPS = 0.5;

// ---------------------------------------------------------------------------------------
// Schema: the npm package or the built-in re-implementation

const displayPath = (path) => {
  const rel = relative(PROA_ROOT, path);
  return rel.split(sep).filter((part) => part === '..').length <= 1 ? rel : path;
};

// One line per zod issue instead of zod's JSON dump.
const errorText = (error) =>
  Array.isArray(error?.issues)
    ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    : String(error?.message ?? error);

// Imports the package's ESM build as eval/tools resolves it (this directory has no
// node_modules of its own) and reports its version next to the pin in eval/tools.
async function loadPackage() {
  const toolsUrl = pathToFileURL(TOOLS_PACKAGE).href;
  registerHooks({
    resolve: (specifier, context, nextResolve) =>
      nextResolve(specifier, specifier === SCHEMA_MODEL ? { ...context, parentURL: toolsUrl } : context),
  });
  const mod = await import(SCHEMA_MODEL);
  const pkg = JSON.parse(readFileSync(findPackageJSON(SCHEMA_MODEL, toolsUrl), 'utf8'));
  const pinned = JSON.parse(readFileSync(TOOLS_PACKAGE, 'utf8')).dependencies?.[SCHEMA_MODEL];
  return {
    label: `npm package ${pkg.name} ${pkg.version} (ESM build, schemaVersion ${mod.CURRENT_SCHEMA_VERSION}; eval/tools pins ${pinned})`,
    name: pkg.name,
    version: pkg.version,
    pinned,
    schemaVersion: mod.CURRENT_SCHEMA_VERSION,
    loadDocument: mod.loadDocument,
    serializeDocument: mod.serializeDocument,
    minStepSize: mod.MIN_STEP_SIZE,
  };
}

// Faithful re-implementation of the schema-model sources (schema.ts, migrations.ts,
// serialize.ts): zod's object parsing strips unknown keys, so this does too.
const builtin = (() => {
  const CURRENT_SCHEMA_VERSION = 1;
  const fail = (path, message) => {
    throw new Error(`${path}: ${message}`);
  };
  const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  const finite = (v, path) => (typeof v === 'number' && Number.isFinite(v) ? v : fail(path, 'expected a finite number'));
  const str = (v, path, min = 0) =>
    typeof v === 'string' && v.length >= min ? v : fail(path, min ? 'expected a non-empty string' : 'expected a string');
  const obj = (v, path) => (isObject(v) ? v : fail(path, 'expected an object'));
  const arr = (v, path, min = 0) =>
    Array.isArray(v) && v.length >= min ? v : fail(path, min ? `expected an array with >= ${min} items` : 'expected an array');
  const point = (v, path) => (obj(v, path), { x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`) });
  const bounds = (v, path) => {
    obj(v, path);
    const b = { x: finite(v.x, `${path}.x`), y: finite(v.y, `${path}.y`), width: finite(v.width, `${path}.width`), height: finite(v.height, `${path}.height`) };
    if (b.width < 1) fail(`${path}.width`, 'must be >= 1');
    if (b.height < 1) fail(`${path}.height`, 'must be >= 1');
    return b;
  };
  function element(v, path) {
    obj(v, path);
    const out = { id: str(v.id, `${path}.id`, 1), name: str(v.name, `${path}.name`), bounds: bounds(v.bounds, `${path}.bounds`) };
    if (v.color !== undefined) out.color = str(v.color, `${path}.color`, 1);
    if (v.elementType === 'step') {
      out.elementType = 'step';
      if (v.link !== undefined) out.link = str(v.link, `${path}.link`, 1);
    } else if (v.elementType === 'orgUnit') {
      out.elementType = 'orgUnit';
    } else {
      fail(`${path}.elementType`, 'expected "step" or "orgUnit"');
    }
    return out;
  }
  function connection(v, path) {
    obj(v, path);
    if (!['sequence', 'hierarchy', 'assignment'].includes(v.connectionType)) {
      fail(`${path}.connectionType`, 'expected sequence, hierarchy or assignment');
    }
    return {
      id: str(v.id, `${path}.id`, 1),
      connectionType: v.connectionType,
      source: str(v.source, `${path}.source`, 1),
      target: str(v.target, `${path}.target`, 1),
      waypoints: arr(v.waypoints, `${path}.waypoints`, 2).map((p, i) => point(p, `${path}.waypoints[${i}]`)),
    };
  }
  function connectionAllowed(type, sourceType, targetType) {
    if (type === 'assignment') {
      return (sourceType === 'orgUnit' && targetType === 'step') || (sourceType === 'step' && targetType === 'orgUnit');
    }
    return sourceType === 'step' && targetType === 'step';
  }
  function loadDocument(data) {
    if (isObject(data)) {
      const raw = data.schemaVersion;
      const version = typeof raw === 'number' && Number.isInteger(raw) ? raw : 1;
      if (version > CURRENT_SCHEMA_VERSION) {
        throw new Error(`Unsupported schemaVersion ${version} (current: ${CURRENT_SCHEMA_VERSION}).`);
      }
    }
    obj(data, 'document');
    if (!(typeof data.schemaVersion === 'number' && Number.isInteger(data.schemaVersion) && data.schemaVersion > 0)) {
      fail('schemaVersion', 'expected a positive integer');
    }
    obj(data.meta, 'meta');
    const doc = {
      schemaVersion: data.schemaVersion,
      meta: { name: str(data.meta.name, 'meta.name') },
      elements: arr(data.elements, 'elements').map((e, i) => element(e, `elements[${i}]`)),
      connections: arr(data.connections, 'connections').map((c, i) => connection(c, `connections[${i}]`)),
    };
    const ids = new Set();
    for (const item of [...doc.elements, ...doc.connections]) {
      if (ids.has(item.id)) throw new Error(`Duplicate id "${item.id}" in document.`);
      ids.add(item.id);
    }
    const typeById = new Map(doc.elements.map((e) => [e.id, e.elementType]));
    for (const c of doc.connections) {
      for (const endpoint of [c.source, c.target]) {
        if (!typeById.has(endpoint)) throw new Error(`Connection "${c.id}" references unknown element "${endpoint}".`);
      }
      if (c.source === c.target) throw new Error(`Connection "${c.id}" must not connect an element to itself.`);
      if (!connectionAllowed(c.connectionType, typeById.get(c.source), typeById.get(c.target))) {
        throw new Error(`Connection "${c.id}" (${c.connectionType}) must not connect ${typeById.get(c.source)} to ${typeById.get(c.target)}.`);
      }
    }
    return doc;
  }
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  function round(value) {
    if (typeof value === 'number') return Math.round(value * 1000) / 1000;
    if (Array.isArray(value)) return value.map(round);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, round(v)]));
    return value;
  }
  function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([k, v]) => [k, sortKeys(v)]));
    }
    return value;
  }
  function serializeDocument(doc) {
    const byId = (a, b) => compare(a.id, b.id);
    const canonical = round({ ...doc, elements: [...doc.elements].sort(byId), connections: [...doc.connections].sort(byId) });
    return `${JSON.stringify(sortKeys(canonical), null, 2)}\n`;
  }
  return {
    label: 'built-in re-implementation of the schema-model (schema, migration check, cross-field rules, serialization)',
    loadDocument,
    serializeDocument,
    minStepSize: { width: 80, height: 40 },
  };
})();

// ---------------------------------------------------------------------------------------
// Geometry helpers mirroring the renderer

const notchDepth = (w, h) => Math.min(h / 2, 0.4 * w);
const mid = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const near = (a, b) => Math.abs(a - b) <= EPS;
const samePoint = (p, q) => near(p.x, q.x) && near(p.y, q.y);
const fmt = (pts) => pts.map((p) => `(${+p.x.toFixed(3)},${+p.y.toFixed(3)})`).join(' ');

// diagram-js ManhattanLayout.withoutRedundantPoints: drop repeated and collinear points.
function withoutRedundantPoints(points) {
  const out = [];
  for (const p of points) {
    if (out.length && samePoint(out[out.length - 1], p)) continue;
    while (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const collinear = (near(a.x, b.x) && near(b.x, p.x)) || (near(a.y, b.y) && near(b.y, p.y));
      if (!collinear) break;
      out.pop();
    }
    out.push(p);
  }
  return out;
}

// Contour crossing of an axis-aligned segment leaving/entering a step (chevron) or org unit
// (ellipse) at its vertical or horizontal mid line; the only cases this layout produces.
function cropAtContour(element, inside, outside) {
  const b = element.bounds;
  const m = mid(b);
  if (near(inside.x, outside.x)) {
    // vertical segment
    const down = outside.y > inside.y;
    if (element.elementType === 'orgUnit') {
      if (!near(inside.x, m.x)) return null;
      return { x: m.x, y: down ? b.y + b.height : b.y };
    }
    const d = notchDepth(b.width, b.height);
    if (inside.x < b.x || inside.x > b.x + b.width - d) return null; // not on the flat edge
    return { x: inside.x, y: down ? b.y + b.height : b.y };
  }
  if (near(inside.y, outside.y) && near(inside.y, m.y)) {
    // horizontal segment through the mid line
    const right = outside.x > inside.x;
    if (element.elementType === 'orgUnit') return { x: right ? b.x + b.width : b.x, y: m.y };
    const d = notchDepth(b.width, b.height);
    return { x: right ? b.x + b.width : b.x + d, y: m.y };
  }
  return null;
}

function croppedPath(points, source, target) {
  const pts = withoutRedundantPoints(points);
  const start = cropAtContour(source, pts[0], pts[1]);
  const end = cropAtContour(target, pts[pts.length - 1], pts[pts.length - 2]);
  if (!start || !end) return null;
  return [start, ...pts.slice(1, -1), end];
}

// VcLayouter.isRowArrangement
function isRowArrangement(children, parent) {
  if (children.length >= 2) {
    const tops = children.map((c) => c.bounds.y);
    return Math.max(...tops) - Math.min(...tops) <= ROW_TOLERANCE_Y;
  }
  const c = children[0].bounds;
  const center = c.x + c.width / 2;
  const p = parent.bounds;
  return center >= p.x + EXIT_MARGIN && center <= p.x + p.width - notchDepth(p.width, p.height) - EXIT_MARGIN;
}

// VcLayouter.hierarchyWaypoints (column/rake case) followed by contour cropping.
function expectedHierarchy(parent, child, siblings) {
  const p = parent.bounds;
  const sourceMid = mid(p);
  const targetMid = mid(child.bounds);
  const bottom = p.y + p.height;
  const topmost = Math.min(...siblings.map((s) => s.bounds.y));
  const busY = Math.max(bottom + BUS_MIN_STUB, (bottom + topmost) / 2);
  const minChildX = Math.min(...siblings.map((s) => s.bounds.x));
  const trunkX = sourceMid.x <= minChildX - TRUNK_CLEARANCE ? sourceMid.x : minChildX - TRUNK_MARGIN;
  return croppedPath(
    [sourceMid, { x: sourceMid.x, y: busY }, { x: trunkX, y: busY }, { x: trunkX, y: targetMid.y }, targetMid],
    parent,
    child,
  );
}

// Arial advance widths (1/1000 em), as used by the browser for the renderer's 12px labels.
const ARIAL = (() => {
  const w = {
    ' ': 278, '!': 278, '"': 355, '&': 667, "'": 191, '(': 333, ')': 333, ',': 278, '-': 333, '.': 278, '/': 278,
    ':': 278, ';': 278, '?': 556, '–': 556,
    A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833,
    N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
    a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833,
    n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
    Ä: 667, Ö: 778, Ü: 722, ä: 556, ö: 556, ü: 556, ß: 611,
  };
  for (const digit of '0123456789') w[digit] = 556;
  return w;
})();
const textWidth = (s) => ([...s].reduce((sum, ch) => sum + (ARIAL[ch] ?? 556), 0) * 12) / 1000;

// diagram-js util/Text layoutNext/shortenLine/semanticShorten with estimated widths.
function layoutLabel(text, maxWidth) {
  const lines = [];
  let cut = false;
  const queue = [text];
  while (queue.length) {
    const original = queue.shift();
    let fitLine = original;
    for (;;) {
      const width = fitLine ? textWidth(fitLine) : 0;
      if (fitLine === ' ' || fitLine === '' || width < Math.round(maxWidth) || fitLine.length < 2) break;
      const length = Math.max(fitLine.length * (maxWidth / width), 1);
      const parts = fitLine.split(/(\s|-|­)/g);
      const kept = [];
      let used = 0;
      if (parts.length > 1) {
        for (const part of parts) {
          if (!part) break;
          if (part.length + used < length) {
            kept.push(part);
            used += part.length;
          } else {
            if (part === '-' || part === '­') kept.pop();
            break;
          }
        }
      }
      let shortened = kept.join('');
      if (!shortened) {
        shortened = fitLine.slice(0, Math.max(Math.round(length - 1), 1));
        cut = true;
      }
      fitLine = shortened;
    }
    if (fitLine.length < original.length) queue.unshift(original.slice(fitLine.length).trim());
    lines.push(fitLine);
  }
  return { lines, cut };
}

function checkLabel(element, errors) {
  const { width, height } = element.bounds;
  const step = element.elementType === 'step';
  const d = step ? notchDepth(width, height) : 0;
  const inset = step ? Math.max(7, d - 5) : LABEL_PADDING + 5;
  const { lines, cut } = layoutLabel(element.name, width - 2 * inset);
  if (cut) errors.push(`label of ${element.id} "${element.name}": a word is too long and would be cut (${lines.join(' | ')})`);
  if (lines.length * LINE_HEIGHT > height - 2 * LABEL_PADDING) {
    errors.push(`label of ${element.id} "${element.name}": ${lines.length} lines do not fit into height ${height}`);
  }
  if (step) {
    const limit = width - 2 * (d + NOTCH_CLEARANCE);
    for (const line of lines) {
      if (textWidth(line) > limit) {
        errors.push(`label of ${element.id}: line "${line}" (${textWidth(line).toFixed(0)}px) reaches into the notch/point (limit ${limit}px)`);
      }
    }
  }
}

function segmentHitsBox(a, b, box) {
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  return x2 > box.x + 1 && x1 < box.x + box.width - 1 && y2 > box.y + 1 && y1 < box.y + box.height - 1;
}

// ---------------------------------------------------------------------------------------
// Document checks

function checkDocument(doc, schema, errors) {
  const byId = new Map(doc.elements.map((e) => [e.id, e]));
  const steps = doc.elements.filter((e) => e.elementType === 'step');
  const orgUnits = doc.elements.filter((e) => e.elementType === 'orgUnit');
  const ofType = (type) => doc.connections.filter((c) => c.connectionType === type);

  // Ids: the renderer's root id and ProA's pseudo-steps (@...) are reserved.
  for (const item of [...doc.elements, ...doc.connections]) {
    if (RESERVED_IDS.has(item.id) || item.id.startsWith('@')) errors.push(`${item.id} is a reserved id`);
  }
  // No step links: linking steps to processes is the job under test (and a ProA key-tier rule).
  for (const s of steps) if (s.link !== undefined) errors.push(`step ${s.id} carries a link ("${s.link}"); golden chains have none`);

  const pairs = new Set();
  for (const c of doc.connections) {
    const key = `${c.connectionType}|${[c.source, c.target].sort().join('|')}`;
    if (pairs.has(key)) errors.push(`duplicate ${c.connectionType} between ${c.source} and ${c.target} (${c.id})`);
    pairs.add(key);
  }

  // Hierarchy: a forest, two or more sub-steps per parent, at most two levels below the top.
  const parentOf = new Map();
  const childrenOf = new Map();
  for (const c of ofType('hierarchy')) {
    if (parentOf.has(c.target)) errors.push(`step ${c.target} has more than one superior step`);
    parentOf.set(c.target, c.source);
    if (!childrenOf.has(c.source)) childrenOf.set(c.source, []);
    childrenOf.get(c.source).push(c.target);
  }
  const levelOf = new Map();
  for (const s of steps) {
    let level = 0;
    const seen = new Set([s.id]);
    for (let p = parentOf.get(s.id); p; p = parentOf.get(p)) {
      if (seen.has(p)) {
        errors.push(`hierarchy cycle through ${s.id}`);
        break;
      }
      seen.add(p);
      level += 1;
    }
    levelOf.set(s.id, level);
    if (level > 2) errors.push(`step ${s.id} is nested ${level} levels deep (max 2; deeper belongs into a linked model)`);
  }
  for (const [parent, children] of childrenOf) {
    if (children.length < 2) errors.push(`step ${parent} has a single sub-step (a renaming, not a decomposition)`);
  }

  // Sequence: at most one simple chain per group of sibling steps; the top-level chain is the
  // core value chain (5-8 steps). Sequences never cross sibling groups.
  const groupOf = (id) => parentOf.get(id) ?? '';
  const next = new Map();
  const prev = new Map();
  const groups = new Map();
  for (const c of ofType('sequence')) {
    if (groupOf(c.source) !== groupOf(c.target)) {
      errors.push(`sequence ${c.id} joins steps of different levels or parents (${c.source}, ${c.target})`);
      continue;
    }
    if (next.has(c.source)) errors.push(`step ${c.source} has more than one successor`);
    if (prev.has(c.target)) errors.push(`step ${c.target} has more than one predecessor`);
    next.set(c.source, c.target);
    prev.set(c.target, c.source);
    const group = groups.get(groupOf(c.source)) ?? new Set();
    group.add(c.source).add(c.target);
    groups.set(groupOf(c.source), group);
  }
  let chain = [];
  for (const [group, members] of groups) {
    const heads = [...members].filter((id) => !prev.has(id));
    const where = group ? `the sub-steps of ${group}` : 'the top level';
    if (heads.length !== 1) {
      errors.push(`the sequence relations of ${where} must form one chain (found ${heads.length} starts)`);
      continue;
    }
    const ordered = [];
    const seen = new Set();
    for (let id = heads[0]; id && !seen.has(id); id = next.get(id)) {
      seen.add(id);
      ordered.push(id);
    }
    if (ordered.length !== members.size) errors.push(`the sequence relations of ${where} contain a cycle or a second chain`);
    if (!group) chain = ordered;
  }
  if (!groups.has('')) errors.push('there is no core chain (sequence relations between top-level steps)');
  else if (chain.length < 5 || chain.length > 8) errors.push(`the core chain has ${chain.length} steps (expected 5-8)`);

  // Org unit assignments: one org unit per top-level step, every org unit assigned exactly once.
  const orgsOfStep = new Map();
  const assignmentsOfOrg = new Map();
  for (const c of ofType('assignment')) {
    const [org, step] = byId.get(c.source).elementType === 'orgUnit' ? [c.source, c.target] : [c.target, c.source];
    orgsOfStep.set(step, [...(orgsOfStep.get(step) ?? []), org]);
    assignmentsOfOrg.set(org, (assignmentsOfOrg.get(org) ?? 0) + 1);
  }
  for (const s of steps) {
    const n = (orgsOfStep.get(s.id) ?? []).length;
    if (levelOf.get(s.id) === 0 && n !== 1) errors.push(`top-level step ${s.id} has ${n} org units (expected 1)`);
  }
  for (const o of orgUnits) {
    if (assignmentsOfOrg.get(o.id) !== 1) errors.push(`org unit ${o.id} has ${assignmentsOfOrg.get(o.id) ?? 0} assignments (expected 1)`);
  }

  // Geometry: sizes, no overlaps, waypoints as the renderer routes them.
  for (const e of doc.elements) {
    const { width, height } = e.bounds;
    if (width < schema.minStepSize.width || height < schema.minStepSize.height) {
      errors.push(`${e.id} is smaller than the editor minimum ${schema.minStepSize.width}x${schema.minStepSize.height}`);
    }
    checkLabel(e, errors);
  }
  for (let i = 0; i < doc.elements.length; i += 1) {
    for (let j = i + 1; j < doc.elements.length; j += 1) {
      const a = doc.elements[i].bounds;
      const b = doc.elements[j].bounds;
      if (a.x < b.x + b.width + SHAPE_MARGIN && b.x < a.x + a.width + SHAPE_MARGIN && a.y < b.y + b.height + SHAPE_MARGIN && b.y < a.y + a.height + SHAPE_MARGIN) {
        errors.push(`${doc.elements[i].id} and ${doc.elements[j].id} overlap or are closer than ${SHAPE_MARGIN}px`);
      }
    }
  }
  for (const c of doc.connections) {
    const source = byId.get(c.source);
    const target = byId.get(c.target);
    let expected;
    if (c.connectionType === 'sequence') {
      expected = croppedPath([mid(source.bounds), mid(target.bounds)], source, target);
      if (!expected || !(target.bounds.x > source.bounds.x + source.bounds.width)) {
        errors.push(`sequence ${c.id} must run left to right between steps on one row`);
        continue;
      }
    } else if (c.connectionType === 'hierarchy') {
      const siblings = childrenOf.get(c.source).map((id) => byId.get(id));
      if (target.bounds.y < source.bounds.y + source.bounds.height) {
        errors.push(`hierarchy ${c.id}: sub-step ${c.target} must sit below its superior step`);
        continue;
      }
      if (isRowArrangement(siblings, source)) {
        errors.push(`hierarchy ${c.id}: the sub-steps of ${c.source} form a row; this check only covers the column (rake) arrangement`);
        continue;
      }
      expected = expectedHierarchy(source, target, siblings);
    } else {
      expected = croppedPath([mid(source.bounds), mid(target.bounds)], source, target);
      if (!expected) {
        errors.push(`assignment ${c.id} must be a vertical line between the centers of org unit and step`);
        continue;
      }
    }
    if (!expected) {
      errors.push(`${c.id}: cannot derive the renderer route`);
      continue;
    }
    if (expected.length !== c.waypoints.length || !expected.every((p, i) => samePoint(p, c.waypoints[i]))) {
      errors.push(`${c.id}: waypoints ${fmt(c.waypoints)} differ from the renderer route ${fmt(expected)}`);
    }
    for (let i = 0; i + 1 < c.waypoints.length; i += 1) {
      for (const e of doc.elements) {
        if (e.id === c.source || e.id === c.target) continue;
        if (segmentHitsBox(c.waypoints[i], c.waypoints[i + 1], e.bounds)) errors.push(`${c.id} runs through ${e.id}`);
      }
    }
  }

  return { steps, orgUnits, chain, parentOf, childrenOf, levelOf, byId, orgsOfStep };
}

// ---------------------------------------------------------------------------------------
// Landscape processes (simple XML scan of the generated BPMN)

const decodeXml = (s) =>
  s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
    if (named) return named;
    return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });

function listBpmn(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...listBpmn(path));
    else if (entry.endsWith('.bpmn')) out.push(path);
  }
  return out;
}

// Processes by ref, plus the owning process of every element ref and the top-level start
// events (start events outside any subprocess), for the hand-over rule.
function landscapeProcesses(landscape) {
  const modelsDir = join(CORPUS, landscape, 'models');
  const processes = new Map();
  const ownerOf = new Map();
  const topStarts = new Set();
  for (const file of listBpmn(modelsDir).sort()) {
    const key = relative(modelsDir, file).split(sep).join('/').replace(/\.bpmn$/, '');
    const xml = readFileSync(file, 'utf8');
    for (const match of xml.matchAll(/<(?:[\w-]+:)?process\b([^>]*?)(\/?)>/g)) {
      const attrs = Object.fromEntries([...match[1].matchAll(/([\w:.-]+)="([^"]*)"/g)].map((m) => [m[1], decodeXml(m[2])]));
      if (!attrs.id) continue;
      const ref = `${key}#${attrs.id}`;
      processes.set(ref, { ref, model: key, id: attrs.id, name: attrs.name ?? '' });
      ownerOf.set(ref, ref);
      if (match[2]) continue;
      const end = xml.slice(match.index).search(/<\/(?:[\w-]+:)?process>/);
      const body = xml.slice(match.index + match[0].length, end < 0 ? undefined : match.index + end);
      for (const m of body.matchAll(/\bid="([^"]+)"/g)) ownerOf.set(`${key}#${m[1]}`, ref);
      // Drop (event) subprocesses, innermost first, so only the process's own start events remain.
      const innermost = /<((?:[\w-]+:)?(?:subProcess|transaction|adHocSubProcess))\b(?:(?!<(?:[\w-]+:)?(?:subProcess|transaction|adHocSubProcess)\b)[\s\S])*?<\/\1>/g;
      let outsideSubprocesses = body;
      for (let before = ''; before !== outsideSubprocesses; ) {
        before = outsideSubprocesses;
        outsideSubprocesses = outsideSubprocesses.replace(innermost, '');
      }
      for (const m of outsideSubprocesses.matchAll(/<(?:[\w-]+:)?startEvent\b[^>]*\bid="([^"]+)"/g)) topStarts.add(`${key}#${m[1]}`);
    }
  }
  return { processes, ownerOf, topStarts };
}

// ---------------------------------------------------------------------------------------
// Derived tags (README, "Tags"): word stems after lower-casing and transliteration.

const words = (s) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .split(/[^a-z]+/)
    .filter((w) => w.length >= STEM_MIN);

// The longest leading part (>= STEM_MIN letters) of one word that occurs in the other.
function sharedStem(a, b) {
  for (let n = a.length; n >= STEM_MIN; n -= 1) if (b.includes(a.slice(0, n))) return a.slice(0, n);
  for (let n = b.length; n >= STEM_MIN; n -= 1) if (a.includes(b.slice(0, n))) return b.slice(0, n);
  return null;
}

// name-match: a stem of the process name or model key (folders included) occurs in the must
// step's name and in no sibling step's name. Returns the stem or null (semantic).
function nameMatchStem(placement, steps, parentOf) {
  const must = steps.find((s) => s.id === placement.must);
  const siblings = steps.filter((s) => s.id !== must.id && parentOf.get(s.id) === parentOf.get(must.id));
  const processWords = [...words(placement.name), ...words(placement.process.split('#')[0])];
  for (const p of processWords) {
    for (const w of words(must.name)) {
      const stem = sharedStem(p, w);
      if (stem && !siblings.some((s) => words(s.name).some((x) => x.includes(stem)))) return stem;
    }
  }
  return null;
}

// domain-prefix: a folder of the model key shares a stem with a step or org unit name in some
// top-level area (a top-level step and its subtree with their org units), but with none in
// the must step's area. Returns the names it points to, or null.
function domainPrefixTargets(placement, areaNames, rootOf) {
  const folders = placement.process.split('#')[0].split('/').slice(0, -1).flatMap(words);
  const hits = new Map();
  for (const f of folders) for (const { word, area, label } of areaNames) if (sharedStem(f, word)) hits.set(area, label);
  return hits.size && !hits.has(rootOf(placement.must)) ? [...hits.values()] : null;
}

// ---------------------------------------------------------------------------------------
// expected-placements.yaml checks

function checkExpected(landscape, expected, docInfo, corpus, relations, errors) {
  const { steps, chain, parentOf, childrenOf, levelOf, byId, orgsOfStep } = docInfo;
  const { processes, ownerOf, topStarts } = corpus;
  if (expected?.landscape !== landscape) errors.push(`landscape must be "${landscape}"`);
  if (expected?.value_chain !== VC_FILE) errors.push(`value_chain must be "${VC_FILE}"`);
  if (expected?.closed_world !== true) errors.push('closed_world must be true');

  // Kind per step: core = chain + descendants; otherwise from the band color.
  const kindOf = new Map();
  const rootOf = (id) => (parentOf.has(id) ? rootOf(parentOf.get(id)) : id);
  for (const s of steps) {
    const root = rootOf(s.id);
    if (chain.includes(root)) {
      kindOf.set(s.id, 'core');
      if (s.color) errors.push(`core step ${s.id} must not carry a band color`);
    } else {
      const kind = Object.keys(KIND_COLOR).find((k) => KIND_COLOR[k] === byId.get(root).color);
      if (!kind) errors.push(`step ${s.id} is neither in the core chain nor colored as management/support`);
      else if (s.color !== KIND_COLOR[kind]) errors.push(`step ${s.id} must carry the ${kind} color like its superior step`);
      kindOf.set(s.id, kind);
    }
  }

  const listed = new Map();
  for (const [i, s] of (expected?.steps ?? []).entries()) {
    const where = `steps[${i}] ${s?.id ?? ''}`;
    for (const key of Object.keys(s ?? {})) if (!STEP_KEYS.has(key)) errors.push(`${where}: unknown key "${key}"`);
    const element = byId.get(s?.id);
    if (!element || element.elementType !== 'step') {
      errors.push(`${where}: not a step of ${VC_FILE}`);
      continue;
    }
    if (listed.has(s.id)) errors.push(`${where}: listed twice`);
    listed.set(s.id, s);
    if (s.name !== element.name) errors.push(`${where}: name "${s.name}" differs from the document ("${element.name}")`);
    if (s.kind !== kindOf.get(s.id)) errors.push(`${where}: kind "${s.kind}" differs from the document (${kindOf.get(s.id)})`);
    if (s.level !== levelOf.get(s.id)) errors.push(`${where}: level ${s.level} differs from the document (${levelOf.get(s.id)})`);
    if ((s.parent ?? undefined) !== parentOf.get(s.id)) errors.push(`${where}: parent ${s.parent} differs from the document (${parentOf.get(s.id)})`);
    if (typeof s.scope !== 'string' || !s.scope.trim() || s.scope.includes('\n')) errors.push(`${where}: scope must be one line`);
  }
  for (const s of steps) if (!listed.has(s.id)) errors.push(`step ${s.id} is missing in steps`);

  const isStep = (id) => byId.get(id)?.elementType === 'step';
  const isTarget = (id) => id === OUTSIDE || isStep(id);
  const subtree = (id) => [id, ...(childrenOf.get(id) ?? []).flatMap(subtree)];
  const ancestors = (id) => (parentOf.has(id) ? [parentOf.get(id), ...ancestors(parentOf.get(id))] : []);
  // Step and org unit names per top-level area, for the derived domain-prefix tag.
  const areaNames = [];
  for (const s of steps) for (const word of words(s.name)) areaNames.push({ word, area: rootOf(s.id), label: s.name });
  for (const [step, orgs] of orgsOfStep) {
    for (const org of orgs) for (const word of words(byId.get(org).name)) areaNames.push({ word, area: rootOf(step), label: byId.get(org).name });
  }

  const entries = new Map();
  const counts = { processes: 0, must: 0, outside: 0, may: 0, mustNot: 0, withMay: 0, withMustNot: 0, tags: {} };

  for (const [i, a] of (expected?.placements ?? []).entries()) {
    const where = `placements[${i}] ${a?.process ?? ''}`;
    for (const key of Object.keys(a ?? {})) if (!PLACEMENT_KEYS.has(key)) errors.push(`${where}: unknown key "${key}"`);
    const proc = processes.get(a?.process);
    if (!proc) {
      errors.push(`${where}: no such process in eval/corpus/${landscape}/models`);
      continue;
    }
    if (entries.has(a.process)) errors.push(`${where}: listed twice`);
    entries.set(a.process, a);
    if (a.name !== proc.name) errors.push(`${where}: name "${a.name}" differs from the BPMN process name "${proc.name}"`);

    const may = a.may ?? [];
    const mustNot = a.must_not ?? [];
    const tags = a.tags ?? [];
    if (!Array.isArray(may) || !Array.isArray(mustNot) || !Array.isArray(tags)) {
      errors.push(`${where}: may, must_not and tags must be lists`);
      continue;
    }
    if (!isTarget(a.must)) errors.push(`${where}: must "${a.must}" is neither a step nor ${OUTSIDE}`);
    else if (childrenOf.has(a.must)) errors.push(`${where}: must "${a.must}" has sub-steps; must names the most specific step`);
    for (const id of may) if (!isTarget(id)) errors.push(`${where}: may "${id}" is neither a step nor ${OUTSIDE}`);
    for (const id of mustNot) if (!isStep(id)) errors.push(`${where}: must_not "${id}" is not a step`);
    if (new Set(may).size !== may.length || new Set(mustNot).size !== mustNot.length) errors.push(`${where}: duplicate step in may or must_not`);
    if (may.includes(a.must)) errors.push(`${where}: must is repeated in may`);
    for (const id of may) if (ancestors(a.must).includes(id)) errors.push(`${where}: may ${id} is an ancestor of must (that counts as too coarse)`);
    for (const trap of mustNot) {
      const covered = subtree(trap);
      if (covered.includes(a.must)) errors.push(`${where}: must lies inside must_not ${trap}`);
      for (const id of may) if (covered.includes(id)) errors.push(`${where}: may ${id} lies inside must_not ${trap}`);
      for (const other of mustNot) if (other !== trap && covered.includes(other)) errors.push(`${where}: must_not ${other} is already covered by ${trap}`);
    }

    for (const tag of tags) if (!TAGS.has(tag)) errors.push(`${where}: unknown tag "${tag}"`);
    if (new Set(tags).size !== tags.length) errors.push(`${where}: duplicate tag`);
    if (a.must === OUTSIDE) {
      if (tags.includes('name-match') || tags.includes('semantic')) errors.push(`${where}: a process outside the chain is neither name-match nor semantic`);
    } else if (isStep(a.must)) {
      if (tags.includes('name-match') === tags.includes('semantic')) errors.push(`${where}: exactly one of name-match and semantic`);
      const stem = nameMatchStem(a, steps, parentOf);
      if (stem && !tags.includes('name-match')) errors.push(`${where}: derived tag name-match (stem "${stem}" singles out ${a.must}), not tagged name-match`);
      if (!stem && tags.includes('name-match')) errors.push(`${where}: derived tag semantic (no stem singles out ${a.must}), not tagged semantic`);
      const away = domainPrefixTargets(a, areaNames, rootOf);
      if (Boolean(away) !== tags.includes('domain-prefix')) {
        errors.push(`${where}: derived domain-prefix ${away ? `(the folder points to ${away.join(', ')})` : 'absent'} differs from the tags`);
      }
    }
    if (tags.includes('ambiguous') !== may.length > 0) errors.push(`${where}: tag ambiguous if and only if may is not empty`);
    if (tags.includes('shared-word') && !mustNot.length) errors.push(`${where}: tag shared-word needs a must_not trap`);
    const kind = kindOf.get(a.must);
    if (tags.includes('support-process') !== (kind === 'support')) errors.push(`${where}: tag support-process if and only if must is a support step`);
    if (tags.includes('management-process') !== (kind === 'management')) errors.push(`${where}: tag management-process if and only if must is a management step`);
    if (tags.includes('outdated-copy') !== (a.superseded_by !== undefined)) errors.push(`${where}: tag outdated-copy if and only if superseded_by is set`);
    if (typeof a.rationale !== 'string' || !a.rationale.trim() || a.rationale.includes('\n') || a.rationale.length > RATIONALE_MAX) {
      errors.push(`${where}: rationale must be one line of at most ${RATIONALE_MAX} characters`);
    }

    counts.processes += 1;
    counts.must += 1;
    if (a.must === OUTSIDE) counts.outside += 1;
    counts.may += may.length;
    counts.mustNot += mustNot.length;
    if (may.length) counts.withMay += 1;
    if (mustNot.length) counts.withMustNot += 1;
    for (const tag of tags) counts.tags[tag] = (counts.tags[tag] ?? 0) + 1;
  }
  for (const ref of processes.keys()) if (!entries.has(ref)) errors.push(`process ${ref} is not listed in placements`);

  // Outdated copies: per duplicated process id exactly one current entry; copies point to it,
  // lie outside the chain and tolerate (may) the current version's step.
  const byProcessId = new Map();
  for (const p of processes.values()) byProcessId.set(p.id, [...(byProcessId.get(p.id) ?? []), p.ref]);
  for (const [id, refs] of byProcessId) {
    const current = refs.filter((ref) => entries.get(ref) && entries.get(ref).superseded_by === undefined);
    if (refs.length > 1 && current.length !== 1) errors.push(`process id ${id} is defined in ${refs.length} models; exactly one must be current (others outdated-copy)`);
  }
  for (const a of entries.values()) {
    if (a.superseded_by === undefined) continue;
    const target = entries.get(a.superseded_by);
    const proc = processes.get(a.process);
    if (!target) errors.push(`${a.process}: superseded_by ${a.superseded_by} is not listed`);
    else if (target.superseded_by !== undefined) errors.push(`${a.process}: superseded_by must point to the current version`);
    else if (processes.get(a.superseded_by).id !== proc.id) errors.push(`${a.process}: superseded_by must define the same process id`);
    else if (a.must !== OUTSIDE) errors.push(`${a.process}: an outdated copy lies outside the chain (must ${OUTSIDE})`);
    else if (!(a.may ?? []).includes(target.must)) errors.push(`${a.process}: an outdated copy lists the current version's step ${target.must} in may`);
  }

  // Hand-over rule (README, "may"): the step of a process that calls this one, or that starts
  // this cross-domain process at a top-level message start event, is in may unless it is the
  // must, an ancestor of it, or inside a named trap. Signals, event subprocesses and outdated
  // copies do not count; must_link and may_link relations of expected.yaml do.
  if (relations) {
    for (const r of relations) {
      if (r?.expect !== 'must_link' && r?.expect !== 'may_link') continue;
      const from = entries.get(ownerOf.get(r.from));
      const to = entries.get(ownerOf.get(r.to));
      if (!from || !to || from === to || from.superseded_by !== undefined || to.superseded_by !== undefined) continue;
      const why = r.type === 'call' ? 'calls it' : r.type === 'message' && topStarts.has(r.to) && (to.tags ?? []).includes('cross-domain') ? 'starts it' : null;
      const step = from.must;
      if (!why || step === OUTSIDE || step === to.must || ancestors(to.must).includes(step)) continue;
      if ((to.may ?? []).includes(step) || (to.must_not ?? []).some((trap) => subtree(trap).includes(step))) continue;
      errors.push(`${to.process}: hand-over rule: ${step} (${from.process} ${why}, ${r.expect}) belongs in may or under a must_not trap`);
    }
  }

  const used = new Set([...entries.values()].map((a) => a.must));
  counts.unused = steps.filter((s) => !childrenOf.has(s.id) && !used.has(s.id)).map((s) => s.id);
  return { counts, kindOf };
}

// ---------------------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  const forceBuiltin = args.includes('--builtin');
  const unknown = args.filter((a) => a.startsWith('-') && a !== '--builtin');
  if (unknown.length) {
    console.error(`unknown option ${unknown.join(' ')}\n${USAGE}`);
    process.exit(2);
  }
  let landscapes = args.filter((a) => !a.startsWith('-'));
  if (!landscapes.length) {
    landscapes = readdirSync(HERE).filter((d) => existsSync(join(HERE, d, VC_FILE))).sort();
  }
  const unknownLandscapes = landscapes.filter((d) => !existsSync(join(HERE, d, VC_FILE)));
  if (unknownLandscapes.length) {
    console.error(`no ${VC_FILE} for ${unknownLandscapes.join(', ')} in ${displayPath(HERE)}`);
    process.exit(2);
  }

  // The npm package is the reference; the built-in copy replaces it only on request, so a
  // missing install, a stale one or an unverified release never passes silently.
  let npmSchema = null;
  if (!forceBuiltin) {
    try {
      npmSchema = await loadPackage();
    } catch (error) {
      console.error(
        `cannot import ${SCHEMA_MODEL} as eval/tools resolves it (${String(error?.message ?? error).split('\n')[0]})\n` +
          'run pnpm install at the repository root, or run with --builtin to use the built-in re-implementation only',
      );
      process.exit(2);
    }
    if (npmSchema.version !== npmSchema.pinned) {
      console.error(
        `${npmSchema.name} ${npmSchema.version} is installed, but eval/tools/package.json pins ${npmSchema.pinned}; run pnpm install at the repository root`,
      );
      process.exit(2);
    }
    if (!VERIFIED_SCHEMA_MODEL.has(npmSchema.version) || npmSchema.schemaVersion !== VERIFIED_SCHEMA_VERSION) {
      console.error(
        `${npmSchema.name} ${npmSchema.version} (schemaVersion ${npmSchema.schemaVersion}) is not verified for this script ` +
          `(verified: ${[...VERIFIED_SCHEMA_MODEL].join(', ')}, schemaVersion ${VERIFIED_SCHEMA_VERSION}); ` +
          'read its CHANGELOG, update the built-in re-implementation if needed, then add the version to VERIFIED_SCHEMA_MODEL',
      );
      process.exit(2);
    }
  }
  const schema = npmSchema ?? builtin;
  console.log(`schema: ${schema.label}`);
  if (npmSchema) console.log(`  cross-check: ${builtin.label}`);
  else console.log(`  --builtin: ${SCHEMA_MODEL} is not consulted`);

  const require = createRequire(TOOLS_PACKAGE);
  let YAML;
  try {
    YAML = require('yaml');
  } catch {
    console.error('cannot load "yaml" from eval/tools; run pnpm install at the repository root');
    process.exit(2);
  }

  let failed = false;
  let agreed = 0;
  for (const landscape of landscapes) {
    const errors = [];
    const dir = join(HERE, landscape);
    const vcText = readFileSync(join(dir, VC_FILE), 'utf8');
    let doc = null;
    try {
      doc = schema.loadDocument(JSON.parse(vcText));
      if (schema.serializeDocument(doc) !== vcText) errors.push(`${VC_FILE} is not in canonical form (serializeDocument: sorted ids and keys, 3 decimals)`);
    } catch (error) {
      errors.push(`${VC_FILE}: ${errorText(error)}`);
    }
    // Cross-check: both accept the document and serialize it to the same bytes, or both reject it.
    if (npmSchema) {
      let builtinResult;
      try {
        builtinResult = builtin.serializeDocument(builtin.loadDocument(JSON.parse(vcText)));
      } catch (error) {
        builtinResult = error;
      }
      const npmOk = doc !== null;
      const builtinOk = typeof builtinResult === 'string';
      if (npmOk !== builtinOk || (npmOk && builtinResult !== npmSchema.serializeDocument(doc))) {
        errors.push(`the built-in re-implementation disagrees with ${npmSchema.name} ${npmSchema.version}; update it`);
      } else {
        agreed += 1;
      }
    }

    let result = null;
    if (doc) {
      const docInfo = checkDocument(doc, schema, errors);
      const corpus = landscapeProcesses(landscape);
      let relations = null;
      try {
        relations = YAML.parse(readFileSync(join(CORPUS, landscape, 'expected.yaml'), 'utf8'))?.relations ?? [];
      } catch (error) {
        errors.push(`eval/corpus/${landscape}/expected.yaml: ${error.message.split('\n')[0]} (needed for the hand-over rule)`);
      }
      const expectedPath = join(dir, EXPECTED_FILE);
      if (!existsSync(expectedPath)) {
        errors.push(`${EXPECTED_FILE} is missing`);
      } else {
        let expected = null;
        try {
          expected = YAML.parse(readFileSync(expectedPath, 'utf8'));
        } catch (error) {
          errors.push(`${EXPECTED_FILE}: ${error.message}`);
        }
        if (expected) {
          const { counts, kindOf } = checkExpected(landscape, expected, docInfo, corpus, relations, errors);
          const top = (kind) => docInfo.steps.filter((s) => docInfo.levelOf.get(s.id) === 0 && kindOf.get(s.id) === kind).length;
          result = {
            landscape,
            core: top('core'),
            management: top('management'),
            support: top('support'),
            subSteps: docInfo.steps.filter((s) => docInfo.levelOf.get(s.id) > 0).length,
            orgUnits: docInfo.orgUnits.length,
            ...counts,
          };
        }
      }
    }

    console.log(`\n${landscape}: ${errors.length ? `FAIL (${errors.length})` : 'ok'}`);
    for (const e of errors) console.log(`  - ${e}`);
    if (result) {
      console.log(
        `  steps: ${result.core} core + ${result.management} management + ${result.support} support (level 0), ${result.subSteps} sub-steps; org units: ${result.orgUnits}`,
      );
      console.log(
        `  processes: ${result.processes}; must: ${result.must} (${result.outside} ${OUTSIDE}), may: ${result.may} (${result.withMay} processes), must_not: ${result.mustNot} (${result.withMustNot} processes)`,
      );
      console.log(`  tags: ${Object.entries(result.tags).sort(([a], [b]) => (a < b ? -1 : 1)).map(([t, n]) => `${t} ${n}`).join(', ')}`);
      console.log(`  leaf steps without a must process: ${result.unused.join(', ') || 'none'}`);
    }
    if (errors.length) failed = true;
  }
  if (npmSchema) {
    console.log(`\ncross-check: the built-in re-implementation agrees with ${npmSchema.name} ${npmSchema.version} on ${agreed} of ${landscapes.length} documents`);
  }
  process.exit(failed ? 1 : 0);
}

await main();
