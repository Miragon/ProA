import type { CanvasOverlay } from '../chain-canvas-types';
import type { CanvasService, ElementRegistryService, OverlaysService, VcElement } from './services';

/** Overlay type of ProA's badges and labels on the chain canvas. */
const TYPE = 'proa-vc';
const MARKER = {
  finding: 'proa-vc-finding',
  invalid: 'proa-vc-invalid',
  selected: 'proa-vc-selected',
};

interface Services {
  get(name: 'canvas'): CanvasService;
  get(name: 'elementRegistry'): ElementRegistryService;
  get(name: 'overlays'): OverlaysService;
}

function label(text: string, tone: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'proa-vc-badge';
  el.dataset['tone'] = tone;
  // Text only: names and counts never become markup.
  el.textContent = text;
  return el;
}

/**
 * Badges ("3 Prozesse · 2 offen"), finding labels ("nichts angenommen", "Link
 * ungelöst") and markers (finding, invalid, selected) on the canvas (M4 §4).
 * A marker never comes alone: findings and invalid elements also get a text
 * label, the selected one is named in the side panel. Returns the cleanup.
 */
export function applyOverlays(
  diagram: Services,
  items: readonly CanvasOverlay[],
  invalidIds: readonly string[],
  selectedId: string | null,
): () => void {
  const canvas = diagram.get('canvas');
  const registry = diagram.get('elementRegistry');
  const overlays = diagram.get('overlays');
  const marked: [VcElement, string][] = [];
  const mark = (element: VcElement, marker: string) => {
    canvas.addMarker(element, marker);
    marked.push([element, marker]);
  };
  // One row of labels just above each element, so neighbouring rows never overlap.
  const add = (element: VcElement, labels: HTMLElement[]) => {
    if (labels.length === 0) return;
    const row = document.createElement('span');
    row.className = 'proa-vc-labels';
    row.append(...labels);
    overlays.add(element, TYPE, {
      position: { top: -26, left: 24 },
      html: row,
      show: { minZoom: 0.4 },
      scale: { min: 0.75 },
    });
  };
  const invalid = new Set(invalidIds);

  for (const item of items) {
    const element = registry.get(item.elementId);
    if (!element) continue;
    const labels: HTMLElement[] = [];
    if (item.badge) labels.push(label(item.badge.text, item.badge.tone));
    if (item.findings.length > 0) {
      mark(element, MARKER.finding);
      labels.push(label(item.findings.join(' · '), 'finding'));
    }
    if (invalid.has(item.elementId)) {
      mark(element, MARKER.invalid);
      labels.push(label('Fehler beim Speichern', 'invalid'));
      invalid.delete(item.elementId);
    }
    add(element, labels);
  }
  // Elements without badges or findings (new steps, connections) that a refused save named.
  for (const id of invalid) {
    const element = registry.get(id);
    if (!element) continue;
    mark(element, MARKER.invalid);
    if (!element.waypoints) add(element, [label('Fehler beim Speichern', 'invalid')]);
  }
  const selected = selectedId === null ? undefined : registry.get(selectedId);
  if (selected) mark(selected, MARKER.selected);

  return () => {
    overlays.remove({ type: TYPE });
    for (const [element, marker] of marked) canvas.removeMarker(element, marker);
  };
}
