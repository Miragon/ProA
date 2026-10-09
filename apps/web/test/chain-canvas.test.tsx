import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ChainCanvas from '../src/components/value-chain/canvas/chain-canvas';
import type {
  ChainCanvasHandle,
  ChainCanvasProps,
} from '../src/components/value-chain/chain-canvas-types';

/**
 * The chain chunk's own logic with a stand-in renderer (the real one needs a
 * browser, e2e/value-chain*.spec.ts): which change events reach the page,
 * the pending change the page can take at once, and which viewbox a new
 * instance starts with.
 */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const fake = vi.hoisted(() => ({
  instances: [] as {
    viewboxCalls: Box[];
    box: Box;
    destroyed: boolean;
    imported: boolean;
    fire: (event: string, payload: unknown) => void;
  }[],
}));

vi.mock('@miragon/value-chain-renderer/assets/value-chain.css', () => ({}));
vi.mock('diagram-js/lib/features/overlays', () => ({ default: {} }));
vi.mock('@miragon/value-chain-schema-model', () => ({
  createEmptyDocument: (name: string) => ({
    schemaVersion: 1,
    meta: { name },
    elements: [],
    connections: [],
  }),
  parseDocumentJSON: (text: string) => JSON.parse(text) as unknown,
  serializeDocument: (doc: unknown) => `${JSON.stringify(doc)}\n`,
}));
vi.mock('@miragon/value-chain-renderer', () => {
  type Listener = (payload: unknown) => void;
  const shapes = [{ id: 's1', vcType: 'step', x: 100, y: 100, width: 100, height: 60 }];
  class FakeDiagram {
    listeners = new Map<string, Listener[]>();
    viewboxCalls: Box[] = [];
    box: Box = { x: 0, y: 0, width: 800, height: 600 };
    destroyed = false;
    imported = false;
    doc: unknown = null;
    constructor() {
      fake.instances.push(this);
    }
    on(event: string, listener: Listener) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
    fire(event: string, payload: unknown) {
      for (const listener of this.listeners.get(event) ?? []) listener(payload);
    }
    importDocument(doc: unknown) {
      this.doc = doc;
      this.imported = true;
      // like the renderer: the import ends with commandStack.clear()
      this.fire('commandStack.changed', { trigger: 'clear' });
      return [];
    }
    exportDocument() {
      return this.doc;
    }
    get(name: string) {
      switch (name) {
        case 'canvas':
          return {
            viewbox: (box?: Box) => {
              if (box) {
                this.viewboxCalls.push(box);
                this.box = { ...box };
              }
              return { ...this.box, scale: 1, outer: { width: 800, height: 600 } };
            },
            zoom: () => 1,
            getRootElement: () => ({ businessObject: { name: 'Kette' } }),
            scrollToElement: () => undefined,
            addMarker: () => undefined,
            removeMarker: () => undefined,
          };
        case 'elementRegistry':
          return { getAll: () => shapes, get: (id: string) => shapes.find((s) => s.id === id) };
        case 'selection':
          return { get: () => [], select: () => undefined };
        case 'overlays':
          return { add: () => 'overlay', remove: () => undefined };
        default:
          throw new Error(`no service ${name}`);
      }
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return {
    Modeler: FakeDiagram,
    NavigatedViewer: FakeDiagram,
    VcDiagramElementFactory: class {},
    isStep: (e: { vcType?: string }) => e.vcType === 'step',
    isVcShape: (e: { vcType?: string }) => e.vcType === 'step' || e.vcType === 'orgUnit',
  };
});

afterEach(() => {
  fake.instances.length = 0;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function props(overrides: Partial<ChainCanvasProps> = {}): ChainCanvasProps {
  return {
    mode: 'edit',
    document: { key: 'edit:1', text: null, emptyName: 'Kette' },
    overlays: [],
    selectedId: null,
    invalidIds: [],
    dirty: false,
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onChange: vi.fn(),
    onImported: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

const imported = () =>
  waitFor(() => expect(screen.getByTestId('vc-canvas').dataset['imported']).toBe('true'));
const live = () => fake.instances.filter((i) => !i.destroyed);

/** Where the first fit puts the stand-in's one step (the free part of an 800 × 600 canvas). */
const FIT = { x: -226, y: -213, width: 800, height: 600 };

describe('chain canvas', () => {
  it('fits the chain on first load under StrictMode (the unmount before the import keeps no view)', async () => {
    const p = props({ mode: 'view', document: { key: 'view:r1', text: null, emptyName: 'K' } });
    render(
      <StrictMode>
        <ChainCanvas {...p} />
      </StrictMode>,
    );
    await imported();
    expect(fake.instances).toHaveLength(2);
    expect(fake.instances[0]!.destroyed).toBe(true);
    expect(fake.instances[0]!.imported).toBe(false);
    expect(live()[0]!.viewboxCalls).toEqual([FIT]);
  });

  it('keeps the view of a shown chain when switching from view to edit', async () => {
    const p = props({ mode: 'view', document: { key: 'view:r1', text: null, emptyName: 'K' } });
    const { rerender } = render(<ChainCanvas {...p} />);
    await imported();
    // the user panned
    const panned = { x: 40, y: 50, width: 900, height: 700 };
    live()[0]!.box = panned;
    rerender(<ChainCanvas {...p} mode="edit" />);
    await imported();
    expect(live()).toHaveLength(1);
    expect(live()[0]!.viewboxCalls).toEqual([panned]);
  });

  it('reports no change for an import (it only clears the stack), but one per edit', async () => {
    const p = props();
    render(<ChainCanvas {...p} />);
    await imported();
    await sleep(350);
    expect(p.onChange).not.toHaveBeenCalled();
    act(() => live()[0]!.fire('commandStack.changed', { trigger: 'execute' }));
    act(() => live()[0]!.fire('commandStack.changed', { trigger: 'execute' }));
    await waitFor(() => expect(p.onChange).toHaveBeenCalledTimes(1));
  });

  it('hands a pending change to the page at once, and then never reports it late', async () => {
    const p = props();
    const ref = createRef<ChainCanvasHandle>();
    render(<ChainCanvas ref={ref} {...p} />);
    await imported();
    expect(ref.current?.takePendingChange()).toBe(false);
    act(() => live()[0]!.fire('commandStack.changed', { trigger: 'undo' }));
    expect(ref.current?.takePendingChange()).toBe(true);
    expect(ref.current?.takePendingChange()).toBe(false);
    await sleep(350);
    expect(p.onChange).not.toHaveBeenCalled();
    expect(ref.current?.emptyText('Neu')).toBe(
      '{"schemaVersion":1,"meta":{"name":"Neu"},"elements":[],"connections":[]}\n',
    );
  });
});
