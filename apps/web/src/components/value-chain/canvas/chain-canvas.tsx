// zod must not probe `new Function` under the CSP (M4 §5); main.tsx imports it first too.
import '@/lib/zod-csp';
import '@miragon/value-chain-renderer/assets/value-chain.css';

import { Modeler, NavigatedViewer, isStep, isVcShape } from '@miragon/value-chain-renderer';
import {
  createEmptyDocument,
  parseDocumentJSON,
  serializeDocument,
} from '@miragon/value-chain-schema-model';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

import type { CanvasElementInfo, ChainCanvasHandle, ChainCanvasProps } from '../chain-canvas-types';
import { applyOverlays } from './overlays';
import { PROA_MODULES } from './proa-modules';
import type {
  CanvasService,
  ElementRegistryService,
  OverlaysService,
  SelectionService,
  VcElement,
  VcModelingService,
  Viewbox,
} from './services';

/**
 * The value chain canvas (M4 §4), the only module that loads the renderer,
 * schema-model (with zod) and diagram-js: a lazy chunk like the bpmn-js
 * canvas. View mode is the renderer's NavigatedViewer, edit mode its Modeler;
 * switching destroys one and creates the other in the same place, keeping the
 * viewbox. A document is imported when the mode or `document.key` changes,
 * never because the page re-rendered, so refetched queries never replace an
 * edit in progress. Everything else is props in, callbacks out and the
 * imperative handle; panels, dialogs and the save logic stay outside this
 * chunk (the chain-only budget of the bundle guard, M4 §5).
 */

type Instance = NavigatedViewer;

interface Diagram {
  get(name: 'canvas'): CanvasService;
  get(name: 'elementRegistry'): ElementRegistryService;
  get(name: 'overlays'): OverlaysService;
  get(name: 'selection'): SelectionService;
  get(name: 'vcModeling'): VcModelingService;
}

const services = (instance: Instance) => instance as unknown as Diagram;

function inView(box: Viewbox, e: VcElement): boolean {
  const { x = 0, y = 0, width = 0, height = 0 } = e;
  return (
    x >= box.x && y >= box.y && x + width <= box.x + box.width && y + height <= box.y + box.height
  );
}

/** Room the floating header, legend and zoom controls take over the canvas (px). */
const INSET = { top: 150, right: 72, bottom: 64, left: 24 };

/**
 * Fits the drawing into the part of the canvas the floating chrome leaves
 * free (never above 100 %), so the top of the chain is not under the header.
 */
function fitFree(diagram: Diagram): void {
  const canvas = diagram.get('canvas');
  const shapes = diagram
    .get('elementRegistry')
    .getAll()
    .filter((e) => isVcShape(e) && e.width !== undefined);
  if (shapes.length === 0) return;
  const minX = Math.min(...shapes.map((e) => e.x ?? 0));
  const minY = Math.min(...shapes.map((e) => e.y ?? 0));
  const maxX = Math.max(...shapes.map((e) => (e.x ?? 0) + (e.width ?? 0)));
  const maxY = Math.max(...shapes.map((e) => (e.y ?? 0) + (e.height ?? 0)));
  const { outer } = canvas.viewbox();
  const freeW = Math.max(outer.width - INSET.left - INSET.right, 100);
  const freeH = Math.max(outer.height - INSET.top - INSET.bottom, 100);
  const scale = Math.min(freeW / (maxX - minX || 1), freeH / (maxY - minY || 1), 1);
  canvas.viewbox({
    x: minX - (INSET.left + (freeW - (maxX - minX) * scale) / 2) / scale,
    y: minY - (INSET.top + (freeH - (maxY - minY) * scale) / 2) / scale,
    width: outer.width / scale,
    height: outer.height / scale,
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error);
}

const ChainCanvas = forwardRef<ChainCanvasHandle, ChainCanvasProps>(
  function ChainCanvas(props, ref) {
    const { mode, document: doc, overlays, selectedId, invalidIds, dirty } = props;
    const host = useRef<HTMLDivElement>(null);
    const instance = useRef<Instance | null>(null);
    const viewbox = useRef<Pick<Viewbox, 'x' | 'y' | 'width' | 'height'> | null>(null);
    /** Takes the current instance's pending (debounced) change, if any. */
    const takePending = useRef<(() => boolean) | null>(null);
    const latest = useRef(props);
    useEffect(() => {
      latest.current = props;
    });
    /** The session (`mode:key`) of the last import, and a counter so effects re-run per instance. */
    const [imported, setImported] = useState<{ session: string; n: number } | null>(null);
    const [warnings, setWarnings] = useState(0);
    const session = `${mode}:${doc.key}`;
    const ready = imported?.session === session;

    // One renderer per mode and document key; the import runs right after mounting.
    useEffect(() => {
      const container = host.current;
      if (!container) return;
      let disposed = false;
      const element = document.createElement('div');
      element.style.position = 'absolute';
      element.style.inset = '0';
      container.append(element);
      const Renderer = mode === 'edit' ? Modeler : NavigatedViewer;
      const created: Instance = new Renderer({
        container: element,
        additionalModules: PROA_MODULES,
      });
      instance.current = created;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pending = false;
      // Import and destroy clear the selection; only the user's (and the page's) selections count.
      let settled = false;
      created.on<{ newSelection: VcElement[] }>('selection.changed', ({ newSelection }) => {
        if (settled && !disposed) latest.current.onSelect(newSelection.find(isVcShape)?.id ?? null);
      });
      created.on<{ element: VcElement }>('element.dblclick', ({ element: target }) => {
        if (mode === 'view' && isStep(target)) latest.current.onOpen(target.id);
      });
      created.on<{ trigger?: string | null }>('commandStack.changed', ({ trigger }) => {
        // An import clears the command stack (`trigger: 'clear'`): that is no edit, and it must
        // never decide about drafts (the draft dialog may still be asking).
        if (trigger === 'clear') return;
        clearTimeout(timer);
        pending = true;
        timer = setTimeout(() => {
          pending = false;
          latest.current.onChange();
        }, 300);
      });
      const take = () => {
        if (!pending) return false;
        clearTimeout(timer);
        pending = false;
        return true;
      };
      takePending.current = take;
      void Promise.resolve().then(() => {
        if (disposed) return;
        const { text, emptyName, key } = latest.current.document;
        try {
          const found = created.importDocument(
            text === null ? createEmptyDocument(emptyName) : parseDocumentJSON(text),
          );
          if (viewbox.current) services(created).get('canvas').viewbox(viewbox.current);
          else fitFree(services(created));
          settled = true;
          setWarnings(found.length);
          setImported((prev) => ({ session: `${mode}:${key}`, n: (prev?.n ?? 0) + 1 }));
          latest.current.onImported({ key, warnings: found.length });
        } catch (error) {
          latest.current.onError(message(error));
        }
      });
      return () => {
        disposed = true;
        clearTimeout(timer);
        if (takePending.current === take) takePending.current = null;
        // Keep the view only of a drawing that was shown: StrictMode (pnpm dev) unmounts before
        // the import microtask ran, and the empty canvas' viewbox would replace the first fit.
        if (settled) {
          const { x, y, width, height } = services(created).get('canvas').viewbox();
          viewbox.current = { x, y, width, height };
        }
        created.destroy();
        instance.current = null;
      };
    }, [mode, doc.key]);

    // Selection from the page (tree, J/K, ?step=): select and bring into view.
    useEffect(() => {
      const current = instance.current;
      if (!current || !ready) return;
      const diagram = services(current);
      const selection = diagram.get('selection');
      const target =
        selectedId === null ? undefined : diagram.get('elementRegistry').get(selectedId);
      const now = selection.get();
      if (!target) {
        if (now.length > 0) selection.select(null);
        return;
      }
      if (now.length !== 1 || now[0] !== target) selection.select(target);
      const canvas = diagram.get('canvas');
      if (!inView(canvas.viewbox(), target)) canvas.scrollToElement(target, 120);
    }, [selectedId, imported, ready]);

    useEffect(() => {
      const current = instance.current;
      if (!current || !ready) return;
      return applyOverlays(services(current), overlays, invalidIds, selectedId);
    }, [overlays, invalidIds, selectedId, imported, ready]);

    useImperativeHandle(ref, (): ChainCanvasHandle => {
      const get = () => {
        if (!instance.current) throw new Error('Die Zeichnung ist noch nicht geladen.');
        return instance.current;
      };
      const shape = (id: string) => {
        const found = services(get()).get('elementRegistry').get(id);
        return found && isVcShape(found) ? (found as VcElement) : null;
      };
      const modeling = () => services(get()).get('vcModeling');
      const stack = () => get() as unknown as Partial<Modeler>;
      return {
        exportCanonical: () => serializeDocument(get().exportDocument()),
        emptyText: (name) => serializeDocument(createEmptyDocument(name)),
        takePendingChange: () => takePending.current?.() ?? false,
        undo: () => stack().undo?.(),
        redo: () => stack().redo?.(),
        canUndo: () => stack().canUndo?.() ?? false,
        canRedo: () => stack().canRedo?.() ?? false,
        elementIds: () =>
          services(get())
            .get('elementRegistry')
            .getAll()
            .filter(isVcShape)
            .map((e) => e.id),
        elementInfo: (id): CanvasElementInfo | null => {
          const e = shape(id);
          if (!e) return null;
          const step = e.vcType === 'step';
          return {
            id: e.id,
            type: step ? 'step' : 'orgUnit',
            name: e.vcLabel ?? '',
            color: e.color ?? null,
            link: step ? (e.link ?? e.businessObject?.link ?? null) : null,
            parentId: e.incoming?.find((c) => c.vcType === 'hierarchy')?.source?.id ?? null,
          };
        },
        setLink: (id, link) => {
          const e = shape(id);
          if (!e || e.vcType !== 'step') return;
          // One command for both: the exporter falls back to businessObject.link (M4 §4).
          const value = link ?? undefined;
          modeling().updateProperties(e, {
            link: value,
            businessObject: e.businessObject ? { ...e.businessObject, link: value } : undefined,
          });
        },
        setName: (id, name) => {
          const e = shape(id);
          if (e) modeling().updateLabel(e, name);
        },
        setColor: (id, color) => {
          const e = shape(id);
          if (e) modeling().setColor(e, color);
        },
        chainName: () => services(get()).get('canvas').getRootElement().businessObject?.name ?? '',
        setChainName: (name) => {
          const root = services(get()).get('canvas').getRootElement();
          modeling().updateProperties(root, { businessObject: { ...root.businessObject, name } });
        },
        saveSVG: () => get().saveSVG().svg,
        zoom: (factor) => {
          const canvas = services(get()).get('canvas');
          canvas.zoom(canvas.zoom() * factor);
        },
        fit: () => fitFree(services(get())),
      };
    }, []);

    return (
      <div
        ref={host}
        className="proa-vc absolute inset-0"
        data-testid="vc-canvas"
        data-imported={ready ? 'true' : 'false'}
        data-mode={mode}
        data-dirty={dirty ? 'true' : 'false'}
        data-import-warnings={warnings}
        role="region"
        aria-label={mode === 'edit' ? 'Wertschöpfungskette bearbeiten' : 'Wertschöpfungskette'}
      />
    );
  },
);

export default ChainCanvas;
