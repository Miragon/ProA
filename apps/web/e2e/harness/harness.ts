/**
 * The import check of the value chain renderer (M4 §5, §9; moved from S0 to
 * S3), run in a real browser by `e2e/value-chain-import.spec.ts`: the
 * renderer's entry does not load in Node and jsdom lacks the SVG geometry
 * diagram-js needs. Exposes `window.vcHarness`; results are counts and
 * indexes only, never names (a holdout chain may run through it).
 */
import '@/lib/zod-csp';
import '@miragon/value-chain-renderer/assets/value-chain.css';

import { PROA_MODULES } from '@/components/value-chain/canvas/proa-modules';
import { Modeler, isVcConnection } from '@miragon/value-chain-renderer';
import { parseDocumentJSON, serializeDocument } from '@miragon/value-chain-schema-model';

interface Point {
  x: number;
  y: number;
}
interface Element {
  id: string;
  vcType?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  waypoints?: Point[];
}
interface Diagram {
  get(name: 'elementRegistry'): { getAll(): Element[] };
  get(name: 'layouter'): { layoutConnection(connection: Element): Point[] };
  get(name: 'modeling'): {
    createShape(shape: Element, position: Point, parent: Element): Element;
    connect(source: Element, target: Element, attrs: Record<string, unknown>): Element;
    layoutConnection(connection: Element, hints: { waypoints: Point[] }): void;
    removeElements(elements: Element[]): void;
  };
  get(name: 'vcElementFactory'): {
    createNewStep(name?: string): Element;
    createNewOrgUnit(name?: string): Element;
  };
  get(name: 'vcAppend'): { append(source: Element, type: string): Element };
  get(name: 'copyPaste'): {
    copy(elements: Element[]): void;
    paste(context: { element: Element; point: Point }): Element[];
  };
  get(name: 'canvas'): { getRootElement(): Element };
}

const diagram = (m: Modeler) => m as unknown as Diagram & Modeler;

function mount(proa: boolean): Diagram & Modeler {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;inset:0;width:1600px;height:1000px';
  document.body.append(host);
  return diagram(new Modeler({ container: host, additionalModules: proa ? PROA_MODULES : [] }));
}

/** Rounded like `serializeDocument` (3 decimals). */
const round = (p: Point): Point => ({
  x: Math.round(p.x * 1000) / 1000,
  y: Math.round(p.y * 1000) / 1000,
});

/** Stored waypoints against `layouter.layoutConnection` (no hints), per connection. */
function compare(m: Diagram) {
  const layouter = m.get('layouter');
  const connections = m
    .get('elementRegistry')
    .getAll()
    .filter(isVcConnection)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const mismatches: { index: number; type: string }[] = [];
  connections.forEach((c, index) => {
    const expected = JSON.stringify(layouter.layoutConnection(c).map(round));
    const stored = JSON.stringify((c.waypoints ?? []).map(round));
    if (expected !== stored) mismatches.push({ index, type: c.vcType ?? '' });
  });
  return { connections: connections.length, mismatches };
}

function check(text: string) {
  const m = mount(true);
  try {
    const warnings = m.importDocument(parseDocumentJSON(text));
    return { warnings: warnings.length, ...compare(m) };
  } finally {
    m.destroy();
  }
}

/**
 * Synthetic chains drawn through the modeling API: a row of sub-steps
 * (vertical drops), a column (the ARIS rake), a single centred sub-step, a
 * sequence with a bendpoint and assignments; exported, serialized and
 * imported again, then checked like a stored chain.
 */
function roundTrip() {
  const m = mount(true);
  const modeling = m.get('modeling');
  const factory = m.get('vcElementFactory');
  const root = m.get('canvas').getRootElement();
  const step = (name: string, x: number, y: number) =>
    modeling.createShape(factory.createNewStep(name), { x, y }, root);
  const link = (a: Element, b: Element, vcType: string) => modeling.connect(a, b, { vcType });

  const a = step('Einkauf', 200, 100);
  const b = step('Lager', 500, 100);
  const c = step('Versand', 800, 100);
  link(a, b, 'sequence');
  const bend = link(b, c, 'sequence');
  modeling.layoutConnection(bend, {
    waypoints: [
      { x: 0, y: 0 },
      { x: 650, y: 40 },
      { x: 0, y: 0 },
    ],
  });
  // a row below "Einkauf"
  for (const [i, name] of ['Bedarf', 'Bestellung', 'Prüfung'].entries())
    link(a, step(name, 120 + i * 190, 300), 'hierarchy');
  // a column below "Lager" (the rake)
  for (const [i, name] of ['Eingang', 'Lagerung', 'Inventur'].entries())
    link(b, step(name, 560, 300 + i * 90), 'hierarchy');
  // one centred sub-step below "Versand"
  link(c, step('Paket', 800, 300), 'hierarchy');
  // assignments
  const unit = modeling.createShape(factory.createNewOrgUnit('Logistik'), { x: 500, y: -60 }, root);
  link(unit, b, 'assignment');
  link(unit, c, 'assignment');
  const built = compare(m);
  const text = serializeDocument(m.exportDocument());
  m.destroy();
  return { built, ...check(text), elements: parseDocumentJSON(text).elements.length };
}

const ID = /^(shape|connection)_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Collision-free ids (M4 §4): with ProA's factory, a step created, deleted and
 * created again, appended, pasted, and created in a second session on the
 * saved document never repeats an id; the stock factory hands out `shape_1`
 * again in a new session (upstream ask 4).
 */
function ids() {
  const first = mount(true);
  const modeling = first.get('modeling');
  const factory = first.get('vcElementFactory');
  const root = first.get('canvas').getRootElement();
  const created: string[] = [];
  const a = modeling.createShape(factory.createNewStep('A'), { x: 100, y: 100 }, root);
  created.push(a.id);
  modeling.removeElements([a]);
  const b = modeling.createShape(factory.createNewStep('B'), { x: 100, y: 100 }, root);
  created.push(b.id);
  const appended = first.get('vcAppend').append(b, 'sequence');
  created.push(appended.id);
  const copyPaste = first.get('copyPaste');
  copyPaste.copy([appended]);
  const pasted = copyPaste.paste({ element: root, point: { x: 400, y: 400 } }) ?? [];
  for (const p of pasted) created.push(p.id);
  for (const e of first.get('elementRegistry').getAll()) if (e.waypoints) created.push(e.id);
  const text = serializeDocument(first.exportDocument());
  first.destroy();

  const second = mount(true);
  second.importDocument(parseDocumentJSON(text));
  const c = second
    .get('modeling')
    .createShape(
      second.get('vcElementFactory').createNewStep('C'),
      { x: 100, y: 300 },
      second.get('canvas').getRootElement(),
    );
  created.push(c.id);
  second.destroy();

  const stock = (doc: string | null) => {
    const m = mount(false);
    if (doc) m.importDocument(parseDocumentJSON(doc));
    const s = m
      .get('modeling')
      .createShape(
        m.get('vcElementFactory').createNewStep('S'),
        { x: 100, y: 100 },
        m.get('canvas').getRootElement(),
      );
    const id = s.id;
    m.get('modeling').removeElements([s]);
    const out = serializeDocument(m.exportDocument());
    m.destroy();
    return { id, out };
  };
  const firstStock = stock(null);
  const secondStock = stock(firstStock.out);

  return {
    pasted: pasted.length,
    created: created.length,
    unique: new Set(created).size,
    wellFormed: created.filter((id) => ID.test(id)).length,
    stock: [firstStock.id, secondStock.id],
  };
}

declare global {
  interface Window {
    vcHarness: {
      check: typeof check;
      roundTrip: typeof roundTrip;
      ids: typeof ids;
      ready: boolean;
    };
  }
}

window.vcHarness = { check, roundTrip, ids, ready: true };
