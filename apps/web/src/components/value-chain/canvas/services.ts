/**
 * The diagram-js services the chain canvas uses, typed narrowly (the
 * renderer's `get<T>(name)` is untyped). Types only.
 */

export interface VcElement {
  id: string;
  type?: string;
  vcType?: 'step' | 'orgUnit' | 'sequence' | 'hierarchy' | 'assignment';
  vcLabel?: string;
  color?: string;
  link?: string;
  businessObject?: Record<string, unknown> & { link?: string; name?: string };
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  waypoints?: { x: number; y: number }[];
  source?: VcElement;
  target?: VcElement;
  incoming?: VcElement[];
  outgoing?: VcElement[];
  parent?: VcElement;
}

export interface Viewbox {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  outer: { width: number; height: number };
}

export interface CanvasService {
  zoom(): number;
  zoom(level: number | 'fit-viewport', center?: 'auto' | { x: number; y: number }): number;
  viewbox(): Viewbox;
  viewbox(box: Pick<Viewbox, 'x' | 'y' | 'width' | 'height'>): Viewbox;
  addMarker(element: VcElement, marker: string): void;
  removeMarker(element: VcElement, marker: string): void;
  scrollToElement(element: VcElement, padding?: number): void;
  getRootElement(): VcElement;
}

export interface ElementRegistryService {
  get(id: string): VcElement | undefined;
  getAll(): VcElement[];
}

export interface OverlaysService {
  add(
    element: VcElement,
    type: string,
    overlay: {
      position: { top?: number; left?: number; bottom?: number; right?: number };
      html: HTMLElement;
      show?: { minZoom?: number; maxZoom?: number };
      scale?: boolean | { min?: number; max?: number };
    },
  ): string;
  remove(filter: { type: string }): void;
}

export interface SelectionService {
  get(): VcElement[];
  select(element: VcElement | null): void;
}

export interface VcModelingService {
  updateProperties(element: VcElement, properties: Record<string, unknown>): void;
  updateLabel(element: VcElement, label: string): void;
  setColor(element: VcElement, color: string | undefined): void;
}
