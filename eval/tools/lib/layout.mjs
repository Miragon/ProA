// Deterministic left-to-right layered layout for BPMN DI.
//
// Per (sub)process container: break cycles by DFS, assign layers by longest
// path, insert dummy slots for long edges, assign rows per lane greedily (the
// first successor stays on the predecessor's row), then size columns and rows
// so every node is centred in its (column, row) cell. Edges are routed
// orthogonally through the gaps between columns; back edges loop below or
// above the rows, whichever crosses fewer shapes. Expanded subprocesses and
// event subprocesses are laid out recursively and sized by their content.
// Pools are stacked vertically, lanes tile the pool body, data stores sit in a
// band below the rows of the lane that first uses them.
import { GATEWAY_TYPES, SpecError } from './model.mjs';

export const L = {
  COL_GAP: 60,
  ROW_GAP: 50,
  MIN_ROW_H: 80,
  PAD_LEFT: 50,
  PAD_RIGHT: 50,
  PAD_TOP: 40,
  PAD_BOTTOM: 50,
  SUB_PAD_X: 30,
  SUB_PAD_TOP: 40,
  SUB_PAD_BOTTOM: 40,
  BAND_GAP: 50,
  ESP_GAP: 40,
  DS_GAP: 30,
  POOL_HEADER: 30,
  LANE_HEADER: 30,
  POOL_GAP: 60,
  BLACKBOX_H: 60,
  MIN_LANE_H: 120,
  MIN_POOL_W: 600,
  ORIGIN_X: 150,
  ORIGIN_Y: 80,
  LABEL_MAX_W: 90,
  LABEL_LINE_H: 14,
  CHAR_W: 6
};

const EVENT_SIZE = { w: 36, h: 36 };
const TASK_SIZE = { w: 100, h: 80 };
const GATEWAY_SIZE = { w: 50, h: 50 };
const DS_SIZE = { w: 50, h: 50 };

const even = (v) => Math.ceil(v / 2) * 2;

function sizeOf(node) {
  if (node.type.endsWith('Event')) return EVENT_SIZE;
  if (GATEWAY_TYPES.has(node.type)) return GATEWAY_SIZE;
  return TASK_SIZE;
}

/** Approximate label box for external labels (bpmn-js renders 11px Arial, ~14px lines). */
export function textBox(text, maxWidth = L.LABEL_MAX_W) {
  const words = text.trim().split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (line && candidate.length * L.CHAR_W > maxWidth) {
      lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  const width = Math.max(...lines.map((l) => l.length * L.CHAR_W));
  return { width: Math.ceil(width), height: lines.length * L.LABEL_LINE_H };
}

const box = (x, y, w, h) => ({
  x,
  y,
  w,
  h,
  get cx() {
    return this.x + this.w / 2;
  },
  get cy() {
    return this.y + this.h / 2;
  },
  get right() {
    return this.x + this.w;
  },
  get bottom() {
    return this.y + this.h;
  }
});

function simplify(points) {
  const pts = points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  const dedup = pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
  return dedup.filter((p, i) => {
    if (i === 0 || i === dedup.length - 1) return true;
    const a = dedup[i - 1];
    const b = dedup[i + 1];
    return !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
  });
}

function segmentHits(a, b, r) {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return maxX > r.x && minX < r.right && maxY > r.y && minY < r.bottom;
}

function countHits(points, boxes) {
  let hits = 0;
  for (let i = 0; i < points.length - 1; i++) {
    for (const r of boxes) if (segmentHits(points[i], points[i + 1], r)) hits++;
  }
  return hits;
}

// ------------------------------------------------------------------- grid

/**
 * Lays out one container (process or (event) subprocess) in relative
 * coordinates. Returns a grid that `emitGrid` translates to absolute DI.
 */
function computeGrid(container, opts) {
  const lanes = opts.lanes;
  const laneIds = lanes ? lanes.map((l) => l.id) : [null];
  const laneOf = (n) => (lanes ? n.laneId : null);
  const main = container.nodes.filter((n) => n.type !== 'eventSubProcess');
  const esps = container.nodes.filter((n) => n.type === 'eventSubProcess');

  // sizes, recursively for subprocesses
  const size = new Map();
  const childGrids = new Map();
  for (const n of container.nodes) {
    if (n.child) {
      const g = computeGrid(n.child, {
        lanes: null,
        padLeft: L.SUB_PAD_X,
        padRight: L.SUB_PAD_X,
        padTop: L.SUB_PAD_TOP,
        padBottom: L.SUB_PAD_BOTTOM,
        dataStores: []
      });
      childGrids.set(n, g);
      size.set(n, { w: g.width, h: g.height });
    } else {
      size.set(n, sizeOf(n));
    }
  }

  // graph: boundary flows count as edges of their host
  const edges = container.flows.map((flow) => ({
    flow,
    from: flow.source.attachedTo ?? flow.source,
    to: flow.target,
    viaBoundary: flow.source.type === 'boundaryEvent'
  }));
  const succ = new Map(main.map((n) => [n, []]));
  for (const e of edges) succ.get(e.from).push(e);

  // cycle breaking (iterative DFS, declaration order)
  const state = new Map();
  const back = new Set();
  const roots = [
    ...main.filter((n) => n.type === 'startEvent'),
    ...main.filter((n) => n.type !== 'startEvent' && n.incoming.length === 0),
    ...main
  ];
  for (const r of roots) {
    if (state.get(r)) continue;
    state.set(r, 1);
    const stack = [[r, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const out = succ.get(top[0]);
      if (top[1] < out.length) {
        const e = out[top[1]++];
        const s = state.get(e.to) ?? 0;
        if (s === 1) back.add(e);
        else if (s === 0) {
          state.set(e.to, 1);
          stack.push([e.to, 0]);
        }
      } else {
        state.set(top[0], 2);
        stack.pop();
      }
    }
  }
  const fwd = edges.filter((e) => !back.has(e));

  // longest-path layering
  const layer = new Map(main.map((n) => [n, 0]));
  const indeg = new Map(main.map((n) => [n, 0]));
  for (const e of fwd) indeg.set(e.to, indeg.get(e.to) + 1);
  const queue = main.filter((n) => indeg.get(n) === 0);
  while (queue.length) {
    const n = queue.shift();
    for (const e of succ.get(n)) {
      if (back.has(e)) continue;
      layer.set(e.to, Math.max(layer.get(e.to), layer.get(n) + 1));
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  const maxLayer = Math.max(0, ...main.map((n) => layer.get(n)));

  // chains with dummy slots for long edges
  const chains = fwd.map((edge) => {
    const items = [edge.from];
    for (let l = layer.get(edge.from) + 1; l < layer.get(edge.to); l++) {
      items.push({ dummy: true, layer: l, lane: laneOf(edge.from), key: edge.flow.index });
    }
    items.push(edge.to);
    return { edge, items };
  });
  const layerOf = (it) => (it.dummy ? it.layer : layer.get(it));
  const laneOfItem = (it) => (it.dummy ? it.lane : laneOf(it));
  const preds = new Map();
  const items = [...main];
  for (const c of chains) {
    c.items.forEach((it, k) => {
      if (it.dummy) items.push(it);
      if (k === 0) return;
      if (!preds.has(it)) preds.set(it, []);
      preds.get(it).push({ pred: c.items[k - 1], bump: k === 1 && c.edge.viaBoundary ? 1 : 0 });
    });
  }

  // rows per (layer, lane)
  const row = new Map();
  const cell = new Map();
  for (const it of items) {
    const k = `${layerOf(it)}|${laneOfItem(it)}`;
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(it);
  }
  for (let l = 0; l <= maxLayer; l++) {
    for (const lane of laneIds) {
      const list = cell.get(`${l}|${lane}`) ?? [];
      const desired = new Map();
      for (const it of list) {
        const ps = (preds.get(it) ?? []).filter((p) => laneOfItem(p.pred) === lane && row.has(p.pred));
        desired.set(it, ps.length ? Math.min(...ps.map((p) => row.get(p.pred) + p.bump)) : 0);
      }
      list.sort(
        (a, b) =>
          desired.get(a) - desired.get(b) ||
          (a.dummy ? 1 : 0) - (b.dummy ? 1 : 0) ||
          (a.dummy ? a.key : a.index) - (b.dummy ? b.key : b.index)
      );
      let last = -1;
      for (const it of list) {
        const r = Math.max(desired.get(it), last + 1);
        row.set(it, r);
        last = r;
      }
    }
  }

  // row heights per lane, column widths
  const rowH = new Map(laneIds.map((id) => [id, []]));
  for (const it of items) {
    const hs = rowH.get(laneOfItem(it));
    const r = row.get(it);
    while (hs.length <= r) hs.push(L.MIN_ROW_H);
    if (!it.dummy) hs[r] = Math.max(hs[r], size.get(it).h);
  }
  for (const id of laneIds) if (!rowH.get(id).length) rowH.get(id).push(L.MIN_ROW_H);

  const colW = Array.from({ length: maxLayer + 1 }, () => EVENT_SIZE.w);
  for (const n of main) colW[layer.get(n)] = Math.max(colW[layer.get(n)], size.get(n).w);
  const colX = [opts.padLeft];
  for (let l = 1; l <= maxLayer; l++) colX[l] = colX[l - 1] + colW[l - 1] + L.COL_GAP;
  const mainRight = colX[maxLayer] + colW[maxLayer];

  // vertical bands
  const dsByLane = new Map(laneIds.map((id) => [id, []]));
  for (const d of opts.dataStores) dsByLane.get(d.laneId).push(d);
  const espByLane = new Map(laneIds.map((id) => [id, []]));
  for (const n of esps) espByLane.get(laneOf(n)).push(n);

  const rowTop = new Map();
  const dsTop = new Map();
  const espTop = new Map();
  const bands = [];
  let y = 0;
  for (const lane of laneIds) {
    const top = y;
    let cy = top + opts.padTop;
    const tops = [];
    rowH.get(lane).forEach((h, r) => {
      tops[r] = cy;
      cy += h + (r < rowH.get(lane).length - 1 ? L.ROW_GAP : 0);
    });
    rowTop.set(lane, tops);
    if (dsByLane.get(lane).length) {
      cy += L.BAND_GAP;
      dsTop.set(lane, cy);
      cy += DS_SIZE.h;
    }
    if (espByLane.get(lane).length) {
      cy += L.BAND_GAP;
      espTop.set(lane, cy);
      cy += Math.max(...espByLane.get(lane).map((n) => size.get(n).h));
    }
    let h = cy - top + opts.padBottom;
    if (lanes) h = Math.max(h, L.MIN_LANE_H);
    bands.push({ laneId: lane, y: top, height: h });
    y += h;
  }
  const height = even(y);
  // lanes tile the pool body exactly
  bands[bands.length - 1].height += height - y;

  // positions
  const pos = new Map();
  const center = new Map();
  for (const it of items) {
    const l = layerOf(it);
    const lane = laneOfItem(it);
    const r = row.get(it);
    const rt = rowTop.get(lane)[r];
    const rh = rowH.get(lane)[r];
    if (it.dummy) {
      center.set(it, { x: colX[l] + colW[l] / 2, y: rt + rh / 2 });
    } else {
      const { w, h } = size.get(it);
      pos.set(it, box(Math.round(colX[l] + (colW[l] - w) / 2), Math.round(rt + (rh - h) / 2), w, h));
    }
  }
  let right = mainRight;
  for (const lane of laneIds) {
    let x = opts.padLeft;
    for (const n of espByLane.get(lane)) {
      const { w, h } = size.get(n);
      pos.set(n, box(x, espTop.get(lane), w, h));
      x += w + L.ESP_GAP;
      right = Math.max(right, x - L.ESP_GAP);
    }
  }

  // boundary events on the bottom edge of their host
  const bpos = new Map();
  for (const n of main) {
    const host = pos.get(n);
    const count = n.boundaries.length;
    if (!count) continue;
    if ((count - 1) * 44 > host.w - 50) {
      throw new SpecError([`${n.id}: too many boundary events (${count}) for its width (layout limit)`]);
    }
    n.boundaries.forEach((b, i) => {
      const cx = host.x + host.w - 30 - (count - 1 - i) * 44;
      bpos.set(b, box(cx - 18, host.y + host.h - 18, 36, 36));
    });
  }

  // data stores
  const dsPos = new Map();
  for (const lane of laneIds) {
    const list = dsByLane
      .get(lane)
      .map((d, i) => ({ d, i, want: d.anchor && pos.has(d.anchor) ? pos.get(d.anchor).cx : opts.padLeft + DS_SIZE.w / 2 }))
      .sort((a, b) => a.want - b.want || a.i - b.i);
    let prevRight = -Infinity;
    for (const { d, want } of list) {
      const x = Math.round(Math.max(want - DS_SIZE.w / 2, prevRight + L.DS_GAP, opts.padLeft));
      dsPos.set(d.ds, box(x, dsTop.get(lane), DS_SIZE.w, DS_SIZE.h));
      prevRight = x + DS_SIZE.w;
      right = Math.max(right, prevRight);
    }
  }
  const width = even(right + opts.padRight);

  // obstacles for route scoring
  const obstacles = [...pos.entries()].map(([n, b]) => ({ n, b }));
  for (const [b, bb] of bpos) obstacles.push({ n: b, b: bb });
  const columnClear = (l, y1, y2, exclude) => {
    const lo = Math.min(y1, y2);
    const hi = Math.max(y1, y2);
    return !obstacles.some(({ n, b }) => {
      if (n === exclude || n.attachedTo === exclude) return false;
      const host = n.attachedTo ?? n;
      if (host.type === 'eventSubProcess' || layer.get(host) !== l) return false;
      return b.bottom > lo && b.y < hi;
    });
  };
  const rowBand = (n) => {
    const lane = laneOf(n);
    const r = row.get(n);
    const t = rowTop.get(lane)[r];
    return { top: t, bottom: t + rowH.get(lane)[r] };
  };
  const gapBefore = (l) => colX[l] - L.COL_GAP / 2;
  const isGateway = (n) => GATEWAY_TYPES.has(n.type);

  // routes
  const routes = new Map();
  for (const c of chains) {
    const { edge, items: its } = c;
    const pts = [];
    const nextCy = (it) => (it.dummy ? center.get(it).y : pos.get(it).cy);
    const first = its[1];
    if (edge.viaBoundary) {
      const b = bpos.get(edge.flow.source);
      pts.push({ x: b.cx, y: b.bottom });
      if (nextCy(first) > b.bottom) pts.push({ x: b.cx, y: nextCy(first) });
      else pts.push({ x: b.cx, y: b.bottom + 20 });
    } else {
      const s = pos.get(edge.from);
      const ny = nextCy(first);
      if (isGateway(edge.from) && ny !== s.cy && columnClear(layer.get(edge.from), s.cy, ny, edge.from)) {
        pts.push({ x: s.cx, y: ny > s.cy ? s.bottom : s.y });
        pts.push({ x: s.cx, y: ny });
      } else {
        pts.push({ x: s.right, y: s.cy });
      }
    }
    for (let k = 1; k < its.length; k++) {
      const it = its[k];
      const cur = pts[pts.length - 1];
      const l = layerOf(it);
      if (k === its.length - 1) {
        const t = pos.get(it);
        if (isGateway(it) && cur.y !== t.cy && columnClear(l, cur.y, t.cy, it)) {
          pts.push({ x: t.cx, y: cur.y });
          pts.push({ x: t.cx, y: cur.y > t.cy ? t.bottom : t.y });
        } else {
          if (cur.y !== t.cy) {
            pts.push({ x: gapBefore(l), y: cur.y });
            pts.push({ x: gapBefore(l), y: t.cy });
          }
          pts.push({ x: t.x, y: t.cy });
        }
      } else {
        const d = center.get(it);
        if (cur.y !== d.y) {
          pts.push({ x: gapBefore(l), y: cur.y });
          pts.push({ x: gapBefore(l), y: d.y });
        }
      }
    }
    routes.set(edge.flow.id, simplify(pts));
  }
  // back edges loop below (or above) the rows; parallel loops get their own track
  const loopTracks = [];
  const track = (y, x1, x2, step) => {
    const lo = Math.min(x1, x2);
    const hi = Math.max(x1, x2);
    let yy = y;
    while (loopTracks.some((u) => Math.abs(u.y - yy) < 8 && u.hi > lo && u.lo < hi)) yy += step;
    return yy;
  };
  for (const edge of [...back].sort((a, b) => a.flow.index - b.flow.index)) {
    const src = edge.viaBoundary ? bpos.get(edge.flow.source) : pos.get(edge.from);
    const t = pos.get(edge.to);
    const sb = rowBand(edge.from);
    const tb = rowBand(edge.to);
    const exclude = new Set([edge.from, edge.to, edge.flow.source]);
    const obs = obstacles.filter(({ n }) => !exclude.has(n)).map(({ b }) => b);
    const yBelow = track(Math.max(sb.bottom, tb.bottom) + L.ROW_GAP / 2, src.cx, t.cx, 10);
    const below = [
      { x: src.cx, y: src.bottom },
      { x: src.cx, y: yBelow },
      { x: t.cx, y: yBelow },
      { x: t.cx, y: t.bottom }
    ];
    let best = below;
    if (!edge.viaBoundary) {
      const yAbove = track(Math.min(sb.top, tb.top) - L.ROW_GAP / 2, src.cx, t.cx, -10);
      const above = [
        { x: src.cx, y: src.y },
        { x: src.cx, y: yAbove },
        { x: t.cx, y: yAbove },
        { x: t.cx, y: t.y }
      ];
      if (countHits(above, obs) < countHits(below, obs)) best = above;
    }
    loopTracks.push({ y: best[1].y, lo: Math.min(src.cx, t.cx), hi: Math.max(src.cx, t.cx) });
    routes.set(edge.flow.id, simplify(best));
  }

  return {
    container,
    width,
    height,
    bands,
    pos,
    bpos,
    dsPos,
    routes,
    childGrids
  };
}

// ------------------------------------------------------------------- emit

function labelBelow(b, text) {
  const t = textBox(text);
  return { x: Math.round(b.cx - t.width / 2), y: Math.round(b.bottom + 7), width: t.width, height: t.height };
}

function labelAbove(b, text) {
  const t = textBox(text);
  return { x: Math.round(b.cx - t.width / 2), y: Math.round(b.y - 7 - t.height), width: t.width, height: t.height };
}

function labelBoundary(b, text, rightmost) {
  const t = textBox(text);
  const x = rightmost ? b.right + 2 : b.x - 2 - t.width;
  return { x: Math.round(x), y: Math.round(b.bottom - 2), width: t.width, height: t.height };
}

function flowLabel(points, text) {
  const t = textBox(text);
  const [p0, p1, p2] = points;
  if (p0.x === p1.x) {
    const down = p1.y > p0.y;
    return { x: p0.x + 5, y: down ? p0.y + 4 : p0.y - 4 - t.height, width: t.width, height: t.height };
  }
  if (p2 && p1.x === p2.x) {
    // horizontal then vertical: label beside the vertical leg, so sibling
    // flows leaving the same side do not stack their labels
    const down = p2.y > p1.y;
    return { x: p1.x + 5, y: down ? p1.y + 5 : p1.y - 5 - t.height, width: t.width, height: t.height };
  }
  return { x: p0.x + 5, y: p0.y - 4 - t.height, width: t.width, height: t.height };
}

function emitGrid(grid, ox, oy, out) {
  const abs = (b) => box(b.x + ox, b.y + oy, b.w, b.h);
  for (const n of grid.container.nodes) {
    const b = abs(grid.pos.get(n));
    const shape = { x: b.x, y: b.y, width: b.w, height: b.h };
    if (n.child) shape.isExpanded = true;
    if (n.name && (n.type.endsWith('Event') || GATEWAY_TYPES.has(n.type))) {
      shape.label = GATEWAY_TYPES.has(n.type) ? labelAbove(b, n.name) : labelBelow(b, n.name);
    }
    out.addShape(n.id, shape, b);
    for (const [i, bn] of n.boundaries.entries()) {
      const bb = abs(grid.bpos.get(bn));
      const s = { x: bb.x, y: bb.y, width: bb.w, height: bb.h };
      if (bn.name) s.label = labelBoundary(bb, bn.name, i === n.boundaries.length - 1);
      out.addShape(bn.id, s, bb);
    }
    if (n.child) emitGrid(grid.childGrids.get(n), b.x, b.y, out);
  }
  for (const [ds, b0] of grid.dsPos) {
    const b = abs(b0);
    out.addShape(ds.id, { x: b.x, y: b.y, width: b.w, height: b.h, label: labelBelow(b, ds.name) }, b);
  }
  for (const flow of grid.container.flows) {
    const waypoints = grid.routes.get(flow.id).map((p) => ({ x: p.x + ox, y: p.y + oy }));
    const edge = { waypoints };
    if (flow.name) edge.label = flowLabel(waypoints, flow.name);
    out.addEdge(flow.id, edge);
  }
}

function dataStorePlacement(process) {
  const topLevel = (n) => {
    let cur = n;
    while (cur.container.owner) cur = cur.container.owner;
    return cur;
  };
  return process.dataStores.map((ds) => {
    const users = [...ds.readers, ...ds.writers].sort((a, b) => a.index - b.index);
    const anchor = users.length ? topLevel(users[0]) : null;
    const laneId = process.lanes.length ? (anchor?.laneId ?? process.lanes[0].id) : null;
    return { ds, anchor, laneId };
  });
}

/**
 * Lays out a whole model.
 * @returns {{ shapes: Map<string, object>, edges: Map<string, object> }} absolute DI by element id
 */
export function layoutModel(model) {
  const shapes = new Map();
  const edges = new Map();
  const boxes = new Map();
  const out = {
    addShape(id, shape, b) {
      shapes.set(id, shape);
      boxes.set(id, b);
    },
    addEdge(id, edge) {
      edges.set(id, edge);
    }
  };

  const grids = new Map();
  for (const p of model.processes) {
    grids.set(
      p,
      computeGrid(p.root, {
        lanes: p.lanes.length ? p.lanes : null,
        padLeft: L.PAD_LEFT,
        padRight: L.PAD_RIGHT,
        padTop: L.PAD_TOP,
        padBottom: L.PAD_BOTTOM,
        dataStores: dataStorePlacement(p)
      })
    );
  }

  const collab = model.collaboration;
  const pools = new Map();
  if (!collab) {
    const p = model.processes[0];
    emitGrid(grids.get(p), L.ORIGIN_X, L.ORIGIN_Y, out);
  } else {
    const contentW = Math.max(
      0,
      ...collab.participants
        .filter((pt) => pt.process)
        .map((pt) => grids.get(pt.process).width + (pt.process.lanes.length ? L.LANE_HEADER : 0))
    );
    const poolW = even(Math.max(L.MIN_POOL_W, L.POOL_HEADER + contentW));
    let y = L.ORIGIN_Y;
    collab.participants.forEach((pt, index) => {
      const x = L.ORIGIN_X;
      let h = L.BLACKBOX_H;
      if (pt.process) {
        const g = grids.get(pt.process);
        h = g.height;
        const laneX = x + L.POOL_HEADER;
        let gx = laneX;
        if (pt.process.lanes.length) {
          gx += L.LANE_HEADER;
          for (const band of g.bands) {
            const lb = box(laneX, y + band.y, poolW - L.POOL_HEADER, band.height);
            out.addShape(band.laneId, { x: lb.x, y: lb.y, width: lb.w, height: lb.h, isHorizontal: true }, lb);
          }
        }
        emitGrid(g, gx, y, out);
      }
      const pb = box(x, y, poolW, h);
      pools.set(pt, { index, box: pb });
      out.addShape(pt.id, { x: pb.x, y: pb.y, width: pb.w, height: pb.h, isHorizontal: true }, pb);
      y += h + L.POOL_GAP;
    });

    // message flows: vertical, bending in the gap next to the source pool
    const gapUse = new Map();
    const plans = collab.messageFlows.map((mf) => {
      const sp = pools.get(mf.source.participant);
      const tp = pools.get(mf.target.participant);
      const down = sp.index < tp.index;
      const gapKey = down ? `${sp.index}+` : `${sp.index}-`;
      gapUse.set(gapKey, (gapUse.get(gapKey) ?? 0) + 1);
      return { mf, sp, tp, down, gapKey, slot: gapUse.get(gapKey) - 1 };
    });
    for (const plan of plans) {
      const { mf, sp, tp, down, gapKey, slot } = plan;
      const sBox = mf.source.node ? boxes.get(mf.source.node.id) : sp.box;
      const tBox = mf.target.node ? boxes.get(mf.target.node.id) : tp.box;
      const clampTo = (v, pool) => Math.min(Math.max(v, pool.x + L.POOL_HEADER + 20), pool.right - 20);
      let sx;
      let tx;
      if (mf.source.node && mf.target.node) {
        sx = sBox.cx;
        tx = tBox.cx;
      } else if (mf.source.node) {
        sx = sBox.cx;
        tx = clampTo(sx, tp.box);
      } else if (mf.target.node) {
        tx = tBox.cx;
        sx = clampTo(tx, sp.box);
      } else {
        sx = tx = Math.round(sp.box.x + sp.box.w / 2);
      }
      const sy = down ? sBox.bottom : sBox.y;
      const ty = down ? tBox.y : tBox.bottom;
      let pts;
      if (sx === tx) {
        pts = [
          { x: sx, y: sy },
          { x: tx, y: ty }
        ];
      } else {
        const n = gapUse.get(gapKey);
        const spread = Math.min(10, (L.POOL_GAP - 12) / Math.max(1, n - 1));
        const base = down ? sp.box.bottom + L.POOL_GAP / 2 : sp.box.y - L.POOL_GAP / 2;
        const gy = base + (slot - (n - 1) / 2) * spread;
        pts = [
          { x: sx, y: sy },
          { x: sx, y: gy },
          { x: tx, y: gy },
          { x: tx, y: ty }
        ];
      }
      pts = simplify(pts);
      const edge = { waypoints: pts };
      if (mf.name) {
        const t = textBox(mf.name);
        const mid = pts.length === 4 ? { x: (pts[1].x + pts[2].x) / 2, y: pts[1].y } : { x: pts[0].x, y: (pts[0].y + pts[1].y) / 2 };
        edge.label = { x: Math.round(mid.x + 5), y: Math.round(mid.y - t.height - 3), width: t.width, height: t.height };
      }
      edges.set(mf.id, edge);
    }
  }

  // data associations
  for (const p of model.processes) {
    for (const ds of p.dataStores) {
      const d = boxes.get(ds.id);
      for (const [list, read] of [
        [ds.readers, true],
        [ds.writers, false]
      ]) {
        for (const act of list) {
          const a = boxes.get(act.id);
          const ax = a.x + a.w * (read ? 0.45 : 0.55);
          let dp;
          let ap;
          if (d.y >= a.bottom) {
            dp = { x: d.cx, y: d.y };
            ap = { x: ax, y: a.bottom };
          } else if (d.bottom <= a.y) {
            dp = { x: d.cx, y: d.bottom };
            ap = { x: ax, y: a.y };
          } else if (d.x >= a.right) {
            dp = { x: d.x, y: d.cy };
            ap = { x: a.right, y: a.cy };
          } else {
            dp = { x: d.right, y: d.cy };
            ap = { x: a.x, y: a.cy };
          }
          const id = read ? `DataInputAssociation_${act.id}_${ds.id}` : `DataOutputAssociation_${act.id}_${ds.id}`;
          const pts = (read ? [dp, ap] : [ap, dp]).map((pt) => ({ x: Math.round(pt.x), y: Math.round(pt.y) }));
          edges.set(id, { waypoints: pts });
        }
      }
    }
  }

  return { shapes, edges };
}
