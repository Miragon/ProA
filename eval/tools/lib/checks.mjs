// Validator checks: parse, lint, DI completeness, expected.yaml semantics.
import { createRequire } from 'node:module';

import { engineFromExecutionPlatform, lintConfigFor, TRAP_TAGS } from './constants.mjs';
import { INCOMING_KINDS, OUTGOING_KINDS, resolveRef } from './facts.mjs';
import { cmp } from './model.mjs';
import { createModdle } from './moddle.mjs';

const require = createRequire(import.meta.url);
const { Linter } = require('bpmnlint');
const NodeResolver = require('bpmnlint/lib/resolver/node-resolver.js');

const resolver = new NodeResolver({ require });

// ------------------------------------------------------------------ parse

/**
 * (a) Parses with bpmn-moddle and the engine's extension; any warning is an error.
 * @returns {{ definitions, engine, version, errors: string[] }}
 */
export async function parseModel(xml, expectedEngine) {
  const errors = [];
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) errors.push('XML must not contain DOCTYPE or ENTITY declarations');
  const platform = /modeler:executionPlatform="([^"]*)"/.exec(xml)?.[1];
  const version = /modeler:executionPlatformVersion="([^"]*)"/.exec(xml)?.[1];
  const engine = engineFromExecutionPlatform(platform);
  if (!engine) errors.push(`unknown modeler:executionPlatform "${platform}"`);
  if (expectedEngine && engine && engine !== expectedEngine) {
    errors.push(`executionPlatform "${platform}" does not match spec engine ${expectedEngine}`);
  }
  if (!version) errors.push('modeler:executionPlatformVersion is missing');
  let definitions = null;
  try {
    const result = await createModdle(engine ?? expectedEngine ?? 'c7').fromXML(xml);
    definitions = result.rootElement;
    for (const w of result.warnings) errors.push(`moddle: ${w.message}`);
    if (definitions) errors.push(...unknownContent(definitions));
  } catch (e) {
    errors.push(`moddle: ${e.message}`);
  }
  return { definitions, engine, version, errors };
}

/**
 * moddle silently keeps elements and namespaced attributes of unregistered
 * packages (e.g. zeebe:* in a c7 file). Report them: every element and
 * attribute must be known to bpmn + the engine's extension + modeler.
 */
function unknownContent(root) {
  const errors = [];
  const seen = new Set();
  const visit = (el, owner) => {
    if (!el || typeof el !== 'object' || seen.has(el)) return;
    seen.add(el);
    if (Array.isArray(el)) {
      for (const x of el) visit(x, owner);
      return;
    }
    if (!el.$type) return;
    const where = el.id ?? owner;
    if (el.$descriptor?.isGeneric) errors.push(`unknown element <${el.$type}> in ${owner}`);
    for (const attr of Object.keys(el.$attrs ?? {})) {
      if (attr === 'xmlns' || attr.startsWith('xmlns:') || attr === 'xsi:type') continue;
      errors.push(`unknown attribute ${attr} on ${where}`);
    }
    for (const prop of el.$descriptor?.properties ?? []) {
      if (prop.isReference || prop.isAttr) continue;
      visit(el.get(prop.name), where);
    }
    if (el.$descriptor?.isGeneric) for (const child of el.$children ?? []) visit(child, where);
  };
  visit(root, root.id);
  return errors;
}

// ------------------------------------------------------------------- lint

/**
 * (b) bpmnlint:recommended + camunda-compat for engine/version, minus documented overrides.
 * Errors and warnings fail; `info` reports are ignored.
 */
export async function lintModel(definitions, { engine, version, disable = [] }) {
  const errors = [];
  const compat = lintConfigFor(engine, version);
  if (!compat) return { errors: [`no bpmnlint-plugin-camunda-compat config for ${engine} ${version}`], config: null };
  const base = { extends: ['bpmnlint:recommended', compat] };
  const linter = new Linter({ config: base, resolver });
  const known = await linter.resolveConfiguredRules(base);
  const rules = {};
  for (const d of disable) {
    if (!(d.rule in known)) errors.push(`lint.disable: unknown rule "${d.rule}" (known: see bpmnlint:recommended and ${compat})`);
    rules[d.rule] = 'off';
  }
  const config = { ...base, rules };
  const reports = await new Linter({ config, resolver }).lint(definitions);
  for (const rule of Object.keys(reports).sort()) {
    for (const r of reports[rule]) {
      if (r.category === 'error' || r.category === 'warn') {
        errors.push(`${rule} [${r.category}] ${r.id ?? '-'}: ${r.message}`);
      }
    }
  }
  return { errors, config: compat.replace('plugin:camunda-compat/', '') };
}

// --------------------------------------------------------------------- DI

const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
const onOrIn = (p, b, tol = 1) =>
  p.x >= b.x - tol && p.x <= b.x + b.width + tol && p.y >= b.y - tol && p.y <= b.y + b.height + tol;
const validBounds = (b) =>
  b && [b.x, b.y, b.width, b.height].every((v) => Number.isFinite(v)) && b.width > 0 && b.height > 0;

/** (c) Every semantic element that needs DI has exactly one, well-formed and well-placed. */
export function checkDi(definitions) {
  const errors = [];
  const diagrams = definitions.diagrams ?? [];
  if (diagrams.length !== 1) errors.push(`expected exactly one BPMNDiagram, found ${diagrams.length}`);
  const plane = diagrams[0]?.plane;
  if (!plane) return [...errors, 'diagram has no plane'];

  const roots = definitions.rootElements ?? [];
  const collab = roots.find((r) => r.$type === 'bpmn:Collaboration');
  const processes = roots.filter((r) => r.$type === 'bpmn:Process');
  const planeTarget = collab ?? (processes.length === 1 ? processes[0] : null);
  if (!planeTarget) errors.push('several processes without a collaboration cannot be shown on one plane');
  else if (plane.bpmnElement !== planeTarget) errors.push(`plane must show ${planeTarget.id}, shows ${plane.bpmnElement?.id}`);

  const di = new Map();
  for (const pe of plane.planeElement ?? []) {
    if (!pe.bpmnElement) {
      errors.push(`${pe.id}: bpmnElement does not resolve`);
      continue;
    }
    if (di.has(pe.bpmnElement)) errors.push(`${pe.bpmnElement.id}: more than one DI element`);
    di.set(pe.bpmnElement, pe);
  }

  const need = [];
  const shape = (el) => need.push([el, 'bpmndi:BPMNShape']);
  const edge = (el) => need.push([el, 'bpmndi:BPMNEdge']);
  const walk = (container) => {
    for (const el of container.flowElements ?? []) {
      if (el.$type === 'bpmn:SequenceFlow') {
        edge(el);
        continue;
      }
      if (el.$type === 'bpmn:DataObject') continue; // no visual representation
      shape(el);
      for (const a of el.dataInputAssociations ?? []) edge(a);
      for (const a of el.dataOutputAssociations ?? []) edge(a);
      if (el.$type === 'bpmn:SubProcess') walk(el);
    }
    for (const a of container.artifacts ?? []) (a.$type === 'bpmn:Association' ? edge : shape)(a);
  };
  const lanesOf = (laneSets) =>
    (laneSets ?? []).flatMap((ls) => (ls.lanes ?? []).flatMap((l) => [l, ...lanesOf(l.childLaneSet ? [l.childLaneSet] : [])]));
  if (collab) {
    for (const p of collab.participants ?? []) shape(p);
    for (const mf of collab.messageFlows ?? []) edge(mf);
    for (const a of collab.artifacts ?? []) (a.$type === 'bpmn:Association' ? edge : shape)(a);
  }
  for (const p of processes) {
    for (const l of lanesOf(p.laneSets)) shape(l);
    walk(p);
  }

  for (const [el, type] of need) {
    const d = di.get(el);
    if (!d) {
      errors.push(`${el.id}: no DI (${type.replace('bpmndi:', '')})`);
      continue;
    }
    if (d.$type !== type) errors.push(`${el.id}: DI is ${d.$type}, expected ${type}`);
    if (type === 'bpmndi:BPMNShape') {
      if (!validBounds(d.bounds)) errors.push(`${el.id}: invalid bounds`);
      if (d.label?.bounds && !validBounds(d.label.bounds)) errors.push(`${el.id}: invalid label bounds`);
      if (el.$type === 'bpmn:SubProcess' && d.isExpanded !== true) {
        errors.push(`${el.id}: subprocess shape must be expanded (isExpanded="true")`);
      }
      if ((el.$type === 'bpmn:Participant' || el.$type === 'bpmn:Lane') && d.isHorizontal !== true) {
        errors.push(`${el.id}: ${el.$type.slice(5)} must be horizontal`);
      }
    } else {
      const wps = d.waypoint ?? [];
      if (wps.length < 2 || !wps.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
        errors.push(`${el.id}: an edge needs at least two finite waypoints`);
      }
    }
  }
  const b = (el) => di.get(el)?.bounds;

  // containment: pools, lanes, subprocesses, boundary events
  const checkContainer = (container, outer, outerName) => {
    for (const el of container.flowElements ?? []) {
      const eb = b(el);
      if (!eb || el.$type === 'bpmn:SequenceFlow') continue;
      if (el.$type === 'bpmn:BoundaryEvent') {
        const host = b(el.attachedToRef);
        if (host) {
          const cx = eb.x + eb.width / 2;
          const cy = eb.y + eb.height / 2;
          const onH = (Math.abs(cy - host.y) <= 1 || Math.abs(cy - host.y - host.height) <= 1) && cx >= host.x && cx <= host.x + host.width;
          const onV = (Math.abs(cx - host.x) <= 1 || Math.abs(cx - host.x - host.width) <= 1) && cy >= host.y && cy <= host.y + host.height;
          if (!onH && !onV) errors.push(`${el.id}: boundary event is not on the border of ${el.attachedToRef.id}`);
        }
      } else if (outer && !inside(eb, outer)) {
        errors.push(`${el.id}: shape lies outside ${outerName}`);
      }
      if (el.$type === 'bpmn:SubProcess') checkContainer(el, eb, el.id);
    }
  };
  for (const p of processes) {
    const participant = collab?.participants?.find((pt) => pt.processRef === p);
    const pool = participant ? b(participant) : null;
    checkContainer(p, pool, participant?.id);
    const lanes = lanesOf(p.laneSets);
    if (!lanes.length) continue;
    if (!pool) {
      errors.push(`${p.id}: lanes need a participant (pool)`);
      continue;
    }
    const top = (p.laneSets ?? []).flatMap((ls) => ls.lanes ?? []);
    const sorted = top.map((l) => ({ l, lb: b(l) })).filter((x) => x.lb).sort((x, y) => x.lb.y - y.lb.y);
    let y = pool.y;
    for (const { l, lb } of sorted) {
      if (lb.x !== pool.x + 30 || lb.x + lb.width !== pool.x + pool.width) {
        errors.push(`${l.id}: lane must span the pool body (x ${pool.x + 30}..${pool.x + pool.width})`);
      }
      if (lb.y !== y) errors.push(`${l.id}: lanes must tile the pool without gaps or overlaps (expected y=${y}, got ${lb.y})`);
      y = lb.y + lb.height;
    }
    if (sorted.length && y !== pool.y + pool.height) errors.push(`${p.id}: lanes do not fill pool ${participant.id}`);
    const membership = new Map();
    for (const l of lanes) {
      const lb = b(l);
      for (const n of l.flowNodeRef ?? []) {
        membership.set(n, (membership.get(n) ?? 0) + 1);
        const nb = b(n);
        if (!lb || !nb) continue;
        if (n.$type === 'bpmn:BoundaryEvent') {
          const c = { x: nb.x + nb.width / 2, y: nb.y + nb.height / 2 };
          if (!onOrIn(c, lb, 0)) errors.push(`${n.id}: boundary event centre lies outside lane ${l.id}`);
        } else if (!inside(nb, lb)) {
          errors.push(`${n.id}: shape lies outside its lane ${l.id}`);
        }
      }
    }
    for (const el of p.flowElements ?? []) {
      if (el.$type === 'bpmn:SequenceFlow' || el.$type === 'bpmn:DataStoreReference' || el.$type === 'bpmn:DataObjectReference' || el.$type === 'bpmn:DataObject') continue;
      const count = membership.get(el) ?? 0;
      if (count !== 1) errors.push(`${el.id}: must be referenced by exactly one lane (found ${count})`);
    }
  }

  // edge endpoints touch their source/target
  const endpointsOf = (el) => {
    switch (el.$type) {
      case 'bpmn:DataInputAssociation':
        return [el.sourceRef?.[0], el.$parent];
      case 'bpmn:DataOutputAssociation':
        return [el.$parent, el.targetRef];
      default:
        return [el.sourceRef, el.targetRef];
    }
  };
  for (const [el, type] of need) {
    if (type !== 'bpmndi:BPMNEdge') continue;
    const d = di.get(el);
    const wps = d?.waypoint ?? [];
    if (wps.length < 2) continue;
    const [s, t] = endpointsOf(el);
    const sb = s && b(s);
    const tb = t && b(t);
    if (sb && !onOrIn(wps[0], sb)) errors.push(`${el.id}: first waypoint is not on ${s.id}`);
    if (tb && !onOrIn(wps[wps.length - 1], tb)) errors.push(`${el.id}: last waypoint is not on ${t.id}`);
  }
  return errors;
}

// --------------------------------------------------------------- expected

const STRICT = {
  call: { from: (f) => f.kind === 'call', to: (f) => f.kind === 'process', want: 'callActivity -> process' },
  message: { from: (f) => f.kind === 'msg_throw', to: (f) => f.kind === 'msg_catch', want: 'message throw -> message catch' },
  signal: { from: (f) => f.kind === 'sig_throw', to: (f) => f.kind === 'sig_catch', want: 'signal throw -> signal catch' },
  trigger: {
    from: (f) => f.kind === 'evt_end' && f.eventDef === 'none' && Boolean(f.label),
    to: (f) => f.kind === 'evt_start' && f.eventDef === 'none' && Boolean(f.label),
    want: 'labelled none end -> labelled none start'
  }
};

const FINDING_KINDS_OF = {
  'unresolved-call': ['call'],
  'dynamic-call': ['call'],
  'duplicate-process-id': ['process'],
  'dangling-throw': ['msg_throw', 'sig_throw'],
  'unmatched-catch': ['msg_catch', 'sig_catch']
};

/**
 * (d) expected.yaml against the landscape's facts.
 * @param {Map<string, object>} index modelKey -> facts
 */
export function checkExpected({ landscape, expected }, index) {
  const errors = [];
  const stats = { relations: 0, must_link: 0, must_not_link: 0, may_link: 0, findings: 0, groups: 0 };
  if (!expected) return { errors, stats, tags: new Set() };
  const tags = new Set();
  const linked = { from: new Map(), to: new Map() };
  const seen = new Set();

  const mfConnected = (a, b) => {
    if (a.modelKey !== b.modelKey) return false;
    return index.get(a.modelKey).messageFlows.some((mf) => mf.from === a.fact.id && mf.to === b.fact.id);
  };

  expected.relations.forEach((r, i) => {
    const where = `relations[${i}] ${r.type} ${r.from} -> ${r.to}`;
    stats.relations++;
    stats[r.expect]++;
    r.tags.forEach((t) => tags.add(t));
    const key = `${r.type}|${r.from}|${r.to}`;
    if (seen.has(key)) errors.push(`${where}: duplicate entry`);
    seen.add(key);
    const from = resolveRef(index, r.from);
    const to = resolveRef(index, r.to);
    if (from.error) errors.push(`${where}: from ${from.error}`);
    if (to.error) errors.push(`${where}: to ${to.error}`);
    if (from.error || to.error) return;
    const sameProcess = from.modelKey === to.modelKey && from.fact.processId === to.fact.processId;
    if (r.expect === 'must_not_link') {
      if (!OUTGOING_KINDS.has(from.fact.kind)) errors.push(`${where}: from is a ${from.fact.kind}, not an outgoing endpoint (end/throw/call)`);
      if (!INCOMING_KINDS.has(to.fact.kind)) errors.push(`${where}: to is a ${to.fact.kind}, not an incoming endpoint (start/catch/process)`);
      return;
    }
    const s = STRICT[r.type];
    if (!s.from(from.fact)) errors.push(`${where}: from is a ${from.fact.kind}/${from.fact.eventDef ?? '-'}; ${r.type} needs ${s.want}`);
    if (!s.to(to.fact)) errors.push(`${where}: to is a ${to.fact.kind}/${to.fact.eventDef ?? '-'}; ${r.type} needs ${s.want}`);
    if (!from.fact.endpoint) errors.push(`${where}: from lies in a ${from.fact.scope} and is never an endpoint`);
    if (!to.fact.endpoint) errors.push(`${where}: to lies in a ${to.fact.scope} and is never an endpoint`);
    if (sameProcess) errors.push(`${where}: endpoints must be in different processes`);
    if (mfConnected(from, to)) errors.push(`${where}: a message flow in ${from.modelKey} already connects these elements (a fact, not a relation)`);
    if (r.type === 'call' && r.expect === 'must_link' && from.fact.dynamic) {
      errors.push(`${where}: a dynamic calledElement cannot be must_link (use may_link + a dynamic-call finding)`);
    }
    if (r.type === 'call' && r.expect === 'must_link' && !from.fact.dynamic && from.fact.key !== to.fact.id) {
      errors.push(`${where}: must_link call needs calledElement "${from.fact.key}" to equal the process id`);
    }
    for (const [map, ref] of [
      [linked.from, r.from],
      [linked.to, r.to]
    ]) {
      if (!map.has(ref)) map.set(ref, []);
      map.get(ref).push(r);
    }
  });

  // findings
  const findingRefs = new Map(Object.keys(FINDING_KINDS_OF).map((k) => [k, new Set()]));
  const duplicateGroups = new Set();
  expected.expected_findings.forEach((f, i) => {
    const where = `expected_findings[${i}] ${f.kind}`;
    stats.findings++;
    (f.tags ?? []).forEach((t) => tags.add(t));
    const kinds = FINDING_KINDS_OF[f.kind];
    for (const ref of f.refs) {
      const res = resolveRef(index, ref);
      if (res.error) {
        errors.push(`${where}: ${ref}: ${res.error}`);
        continue;
      }
      if (!kinds.includes(res.fact.kind)) errors.push(`${where}: ${ref} is a ${res.fact.kind}, expected ${kinds.join(' or ')}`);
      findingRefs.get(f.kind).add(ref);
      if (f.kind === 'dangling-throw' || f.kind === 'unmatched-catch') {
        const map = f.kind === 'dangling-throw' ? linked.from : linked.to;
        const live = (map.get(ref) ?? []).filter((r) => r.expect !== 'must_not_link' && (r.type === 'message' || r.type === 'signal'));
        if (live.length) errors.push(`${where}: ${ref} has a ${live[0].expect} ${live[0].type} relation, so it is not ${f.kind === 'dangling-throw' ? 'dangling' : 'unmatched'}`);
      }
    }
    if (f.kind === 'duplicate-process-id') {
      const ids = new Set(f.refs.map((r) => r.slice(r.indexOf('#') + 1)));
      if (ids.size !== 1 || f.refs.length < 2) errors.push(`${where}: refs must name the same process id in at least two models`);
      duplicateGroups.add([...f.refs].sort(cmp).join(' '));
    }
  });

  // deterministic findings: recompute and compare
  const processIds = new Map();
  for (const [key, facts] of index) {
    for (const id of facts.processes.keys()) {
      if (!processIds.has(id)) processIds.set(id, []);
      processIds.get(id).push(`${key}#${id}`);
    }
  }
  const computed = { 'unresolved-call': new Set(), 'dynamic-call': new Set() };
  const computedDup = new Set();
  for (const [key, facts] of index) {
    for (const f of facts.elements.values()) {
      if (f.kind !== 'call') continue;
      const ref = `${key}#${f.id}`;
      if (f.dynamic) computed['dynamic-call'].add(ref);
      else if (!processIds.has(f.key)) computed['unresolved-call'].add(ref);
    }
  }
  for (const refs of processIds.values()) if (refs.length > 1) computedDup.add([...refs].sort(cmp).join(' '));
  for (const kind of ['unresolved-call', 'dynamic-call']) {
    for (const ref of computed[kind]) if (!findingRefs.get(kind).has(ref)) errors.push(`missing finding ${kind}: ${ref}`);
    for (const ref of findingRefs.get(kind)) if (!computed[kind].has(ref)) errors.push(`finding ${kind} ${ref} does not hold`);
  }
  for (const g of computedDup) if (!duplicateGroups.has(g)) errors.push(`missing finding duplicate-process-id: ${g}`);
  for (const g of duplicateGroups) if (!computedDup.has(g)) errors.push(`finding duplicate-process-id ${g} does not hold`);

  // closed world: key-tier candidates listed, every message/signal endpoint accounted for
  if (landscape?.closed_world) {
    const listed = new Set(expected.relations.map((r) => `${r.type}|${r.from}|${r.to}`));
    const all = [];
    for (const [key, facts] of index) for (const f of facts.elements.values()) all.push({ ref: `${key}#${f.id}`, key, f });
    const hasFlow = (ref) => {
      const [key, id] = ref.split('#');
      return index.get(key).messageFlows.some((mf) => mf.from === id || mf.to === id);
    };
    for (const [type, throwKind, catchKind] of [
      ['message', 'msg_throw', 'msg_catch'],
      ['signal', 'sig_throw', 'sig_catch']
    ]) {
      const throws = all.filter((x) => x.f.kind === throwKind && x.f.endpoint);
      const catches = all.filter((x) => x.f.kind === catchKind && x.f.endpoint);
      for (const t of throws) {
        for (const c of catches) {
          if (!t.f.keyFromRef || !c.f.keyFromRef || t.f.key !== c.f.key) continue;
          if (t.key === c.key && t.f.processId === c.f.processId) continue;
          if (t.key === c.key && index.get(t.key).messageFlows.some((mf) => mf.from === t.f.id && mf.to === c.f.id)) continue;
          if (!listed.has(`${type}|${t.ref}|${c.ref}`)) {
            errors.push(`closed world: key-tier candidate ${type} ${t.ref} -> ${c.ref} (same name "${t.f.key}") is not listed`);
          }
        }
      }
      for (const t of throws) {
        const live = (linked.from.get(t.ref) ?? []).some((r) => r.expect !== 'must_not_link');
        if (!live && !hasFlow(t.ref) && !findingRefs.get('dangling-throw').has(t.ref)) {
          errors.push(`closed world: ${t.ref} (${type} throw "${t.f.key}") has no must_link/may_link and no dangling-throw finding`);
        }
      }
      for (const c of catches) {
        const live = (linked.to.get(c.ref) ?? []).some((r) => r.expect !== 'must_not_link');
        if (!live && !hasFlow(c.ref) && !findingRefs.get('unmatched-catch').has(c.ref)) {
          errors.push(`closed world: ${c.ref} (${type} catch "${c.f.key}") has no must_link/may_link and no unmatched-catch finding`);
        }
      }
    }
    for (const x of all) {
      if (x.f.kind !== 'call' || x.f.dynamic) continue;
      for (const pref of processIds.get(x.f.key) ?? []) {
        if (!listed.has(`call|${x.ref}|${pref}`)) {
          errors.push(`closed world: key-tier candidate call ${x.ref} -> ${pref} is not listed`);
        }
      }
    }
  }

  // data store groups
  const storeLabels = new Set();
  for (const facts of index.values()) {
    for (const f of facts.elements.values()) if (f.kind === 'data_store') storeLabels.add(f.label);
  }
  const groupedLabels = new Map();
  expected.data_store_groups.forEach((g, i) => {
    stats.groups++;
    (g.tags ?? []).forEach((t) => tags.add(t));
    for (const label of g.labels) {
      if (!storeLabels.has(label)) errors.push(`data_store_groups[${i}] ${g.name}: no data store is labelled "${label}"`);
      if (groupedLabels.has(label)) errors.push(`data_store_groups[${i}] ${g.name}: "${label}" is already in group ${groupedLabels.get(label)}`);
      groupedLabels.set(label, g.name);
    }
  });

  // trap coverage
  const na = landscape?.traps_not_applicable ?? {};
  for (const trap of TRAP_TAGS) {
    if (tags.has(trap) && na[trap]) errors.push(`trap ${trap} is tagged but also declared not applicable`);
    if (!tags.has(trap) && !na[trap]) errors.push(`trap ${trap} is neither tagged in expected.yaml nor declared in traps_not_applicable`);
  }
  return { errors, stats, tags };
}
