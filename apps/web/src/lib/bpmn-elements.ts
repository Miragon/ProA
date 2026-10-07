/**
 * The parts of bpmn-js / diagram-js the model view uses, typed locally
 * (bpmn-js exports no service types), plus the pure element lookup.
 */

/** The parts of diagram-js services this component uses (bpmn-js ships no service types). */
export interface DiagramElement {
  id: string;
  type: string;
  /** Shapes have bounds; connections and the root do not. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  parent?: DiagramElement;
  businessObject?: { processRef?: { id?: string } };
}
export interface ElementRegistry {
  get(id: string): DiagramElement | undefined;
  filter(fn: (element: DiagramElement) => boolean): DiagramElement[];
}
export interface Canvas {
  zoom(): number;
  zoom(level: number | 'fit-viewport', center?: 'auto'): number;
  addMarker(element: DiagramElement | string, marker: string): void;
  removeMarker(element: DiagramElement | string, marker: string): void;
  scrollToElement(element: DiagramElement, padding?: number): void;
  getRootElement(): DiagramElement;
  viewbox(): Viewbox;
  viewbox(box: Pick<Viewbox, 'x' | 'y' | 'width' | 'height'>): Viewbox;
}
export interface Viewbox {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  outer: { width: number; height: number };
}
export interface Overlays {
  add(
    element: DiagramElement | string,
    type: string,
    overlay: { position: Record<string, number>; html: HTMLElement },
  ): string;
  remove(filter: { type: string }): void;
}
export interface EventBus {
  on(event: string, callback: (event: { element: DiagramElement }) => void): void;
}
export interface Viewer {
  importXML(xml: string): Promise<{ warnings: unknown[] }>;
  get(name: 'canvas'): Canvas;
  get(name: 'elementRegistry'): ElementRegistry;
  get(name: 'overlays'): Overlays;
  get(name: 'eventBus'): EventBus;
  destroy(): void;
}

export interface CanvasHighlight {
  /** Element id, or a process id (resolved to its pool in a collaboration). */
  elementId: string;
  /** Short text shown next to the element, e.g. "Von" or "Nach". */
  label: string;
  tone?: 'endpoint' | 'related' | 'finding';
}

export const MARKERS = {
  endpoint: 'proa-endpoint',
  related: 'proa-related',
  finding: 'proa-finding',
} as const;
export const OVERLAY_TYPE = 'proa-highlight';

/**
 * A shape for an element or process id: the element itself, else the pool
 * whose process has that id. `null` for the diagram root (a plain process).
 */
export function resolveElement(
  registry: Pick<ElementRegistry, 'get' | 'filter'>,
  id: string,
): DiagramElement | null {
  const direct = registry.get(id);
  if (direct && direct.parent) return direct;
  const pool = registry.filter(
    (e) => e.type === 'bpmn:Participant' && e.businessObject?.processRef?.id === id,
  )[0];
  return pool ?? null;
}

/** The id a click on `element` refers to: a pool stands for its process. */
export function clickedId(element: DiagramElement): string {
  if (element.type === 'bpmn:Participant')
    return element.businessObject?.processRef?.id ?? element.id;
  return element.id;
}

/** Smallest zoom at which labels stay readable when the view jumps to an element. */
export const FOCUS_SCALE = 1;
/** Below this zoom an element counts as unreadable even when it is in view. */
export const READABLE_SCALE = 0.75;

/** True if `element` lies fully inside the viewbox at a readable zoom: no need to move. */
export function isInView(
  current: Pick<Viewbox, 'x' | 'y' | 'width' | 'height' | 'scale'>,
  element: Pick<DiagramElement, 'x' | 'y' | 'width' | 'height'>,
): boolean {
  const { x, y, width, height } = element;
  if (x === undefined || y === undefined || width === undefined || height === undefined)
    return false;
  return (
    current.scale >= READABLE_SCALE &&
    x >= current.x &&
    y >= current.y &&
    x + width <= current.x + current.width &&
    y + height <= current.y + current.height
  );
}

/**
 * The viewbox that centres `element` at a readable scale (at least
 * {@link FOCUS_SCALE}, more if the user zoomed in further); `null` for
 * elements without bounds.
 */
export function focusViewbox(
  current: Pick<Viewbox, 'scale' | 'outer'>,
  element: Pick<DiagramElement, 'x' | 'y' | 'width' | 'height'>,
): Pick<Viewbox, 'x' | 'y' | 'width' | 'height'> | null {
  const { x, y, width, height } = element;
  if (x === undefined || y === undefined || width === undefined || height === undefined)
    return null;
  const scale = Math.max(current.scale, FOCUS_SCALE);
  const w = current.outer.width / scale;
  const h = current.outer.height / scale;
  return { x: x + width / 2 - w / 2, y: y + height / 2 - h / 2, width: w, height: h };
}
