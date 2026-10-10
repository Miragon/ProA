import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';

import { MaximizeIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  MARKERS,
  OVERLAY_TYPE,
  clickedId,
  focusViewbox,
  isInView,
  resolveElement,
  type CanvasHighlight,
  type DiagramElement,
  type Viewer,
} from '@/lib/bpmn-elements';

/**
 * Read-only BPMN canvas (bpmn-js NavigatedViewer) for the model view. It is
 * loaded lazily (bpmn-js is large) and highlights relation endpoints with a
 * marker class plus a text overlay, so colour is never the only signal.
 */

export interface BpmnCanvasProps {
  xml: string;
  highlights: readonly CanvasHighlight[];
  /** Element to scroll into view after highlighting. */
  focus?: string | null;
  onElementClick?: (elementId: string) => void;
  onImportError?: (message: string) => void;
}

export default function BpmnCanvas({
  xml,
  highlights,
  focus,
  onElementClick,
  onImportError,
}: BpmnCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  /** Bumped when the viewer exists, so the import effect runs. */
  const [ready, setReady] = useState(0);
  const clickHandler = useRef(onElementClick);
  const errorHandler = useRef(onImportError);
  useEffect(() => {
    clickHandler.current = onElementClick;
    errorHandler.current = onImportError;
  });

  // Create the viewer once.
  useEffect(() => {
    let disposed = false;
    let instance: Viewer | null = null;
    void import('bpmn-js/lib/NavigatedViewer').then(({ default: NavigatedViewer }) => {
      if (disposed || !container.current) return;
      const created: Viewer = new NavigatedViewer({ container: container.current });
      instance = created;
      created.get('eventBus').on('element.click', ({ element }) => {
        clickHandler.current?.(clickedId(element));
      });
      viewer.current = created;
      setImported(null);
      setReady((n) => n + 1);
    });
    return () => {
      disposed = true;
      instance?.destroy();
      viewer.current = null;
    };
  }, []);

  // Import the XML whenever it (or the viewer) changes.
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    let current = true;
    v.importXML(xml)
      .then(() => {
        if (!current) return;
        v.get('canvas').zoom('fit-viewport', 'auto');
        setImported(xml);
      })
      .catch((error: unknown) => {
        if (current) errorHandler.current?.(error instanceof Error ? error.message : String(error));
      });
    return () => {
      current = false;
    };
  }, [xml, ready]);

  // Markers and overlays for the highlights.
  useEffect(() => {
    const v = viewer.current;
    if (!v || imported !== xml) return;
    const canvas = v.get('canvas');
    const registry = v.get('elementRegistry');
    const overlays = v.get('overlays');
    const applied: { element: DiagramElement; marker: string }[] = [];
    for (const h of highlights) {
      const element = resolveElement(registry, h.elementId);
      if (!element) continue;
      const marker = MARKERS[h.tone ?? 'endpoint'];
      canvas.addMarker(element, marker);
      applied.push({ element, marker });
      if (h.label === '') continue;
      const badge = document.createElement('span');
      badge.className = 'proa-overlay';
      if (h.tone === 'finding') badge.dataset['tone'] = 'warning';
      if (h.tone === 'evidence') badge.dataset['tone'] = 'evidence';
      badge.textContent = h.label;
      overlays.add(element, OVERLAY_TYPE, { position: { top: -22, left: 0 }, html: badge });
    }
    return () => {
      for (const { element, marker } of applied) canvas.removeMarker(element, marker);
      overlays.remove({ type: OVERLAY_TYPE });
    };
  }, [highlights, imported, xml]);

  // Centre the focused element once per focus change (keeps the user's panning otherwise).
  useEffect(() => {
    const v = viewer.current;
    if (!v || !focus || imported !== xml) return;
    const canvas = v.get('canvas');
    const target = resolveElement(v.get('elementRegistry'), focus);
    if (!target) return;
    const current = canvas.viewbox();
    if (isInView(current, target)) return;
    const box = focusViewbox(current, target);
    if (box) canvas.viewbox(box);
    else canvas.scrollToElement(target, 120);
  }, [focus, imported, xml]);

  const zoomBy = (factor: number) => {
    const canvas = viewer.current?.get('canvas');
    if (canvas) canvas.zoom(canvas.zoom() * factor);
  };

  return (
    <div className="proa-canvas absolute inset-0">
      <div
        ref={container}
        className="absolute inset-0"
        data-testid="bpmn-canvas"
        data-imported={imported === xml ? 'true' : 'false'}
        role="img"
        aria-label="BPMN-Diagramm"
      />
      <div
        className="absolute right-4 bottom-16 z-30 flex flex-col gap-1 rounded-lg border bg-card p-1 shadow-sm"
        role="group"
        aria-label="Zoom"
      >
        <Button variant="ghost" size="icon-sm" aria-label="Vergrößern" onClick={() => zoomBy(1.2)}>
          <ZoomInIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Verkleinern"
          onClick={() => zoomBy(1 / 1.2)}
        >
          <ZoomOutIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Ganzes Diagramm zeigen"
          onClick={() => viewer.current?.get('canvas').zoom('fit-viewport', 'auto')}
        >
          <MaximizeIcon />
        </Button>
      </div>
    </div>
  );
}
