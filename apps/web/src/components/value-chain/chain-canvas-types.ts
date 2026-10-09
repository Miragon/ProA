/**
 * The contract between the value chain page and the lazy chain chunk
 * (`canvas/chain-canvas.tsx`, M4 §4/§5): props in, events out, and an
 * imperative handle for the editor. Types only, so the page never pulls the
 * renderer, schema-model or zod out of that chunk.
 */

export type ChainCanvasMode = 'view' | 'edit';

/** What the canvas shows: canonical `.vc.json` text, or a new empty chain. */
export interface ChainCanvasDocument {
  /**
   * Identity of this import: a new key (re)imports `text`. The page keeps it
   * stable while the user edits, so query refetches never replace the edits.
   */
  key: string;
  /** Canonical text; `null` creates an empty document named `emptyName`. */
  text: string | null;
  emptyName: string;
}

/** Badges, finding labels and markers per element (M4 §4 "Overlays"). */
export interface CanvasOverlay {
  elementId: string;
  /** "3 Prozesse · 2 offen", "1 offen". */
  badge: { text: string; tone: 'warning' | 'neutral' } | null;
  /** Finding labels ("nichts angenommen", "Link ungelöst"); a marker goes with them. */
  findings: string[];
}

export interface CanvasElementInfo {
  id: string;
  type: 'step' | 'orgUnit';
  name: string;
  color: string | null;
  /** Steps only. */
  link: string | null;
  /** The source of the incoming `hierarchy` connection (the parent step), if any. */
  parentId: string | null;
}

export interface ChainCanvasProps {
  mode: ChainCanvasMode;
  document: ChainCanvasDocument;
  overlays: readonly CanvasOverlay[];
  /** Element to select (and scroll to when out of view). */
  selectedId: string | null;
  /** Elements a refused save named (422 `value-chain-invalid`). */
  invalidIds: readonly string[];
  /** Unsaved changes (shown as `data-dirty`). */
  dirty: boolean;
  onSelect: (elementId: string | null) => void;
  /** Double-click on a step in view mode (drill-down). */
  onOpen: (elementId: string) => void;
  /**
   * The document changed (edit mode): debounced by 300 ms after an executed,
   * undone or redone command; never for an import, which only clears the
   * command stack. `takePendingChange` asks for a pending one at once.
   */
  onChange: () => void;
  onImported: (info: { key: string; warnings: number }) => void;
  onError: (message: string) => void;
}

export interface ChainCanvasHandle {
  /**
   * `serializeDocument(exportDocument())`: the canonical text the server
   * stores. Throws when the drawing is not a valid document.
   */
  exportCanonical(): string;
  /** The canonical text of a new, empty chain named `name` (the clean state of a new chain). */
  emptyText(name: string): string;
  /**
   * Cancels a change notification that is still waiting for its debounce and
   * returns whether there was one; the caller then handles the change itself.
   * The page asks before it decides on unsaved changes ("Fertig", leaving).
   */
  takePendingChange(): boolean;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Ids of every step and org unit on the canvas. */
  elementIds(): string[];
  elementInfo(elementId: string): CanvasElementInfo | null;
  /** One undoable command each. `null` clears the link. */
  setLink(elementId: string, link: string | null): void;
  setName(elementId: string, name: string): void;
  setColor(elementId: string, color: string | undefined): void;
  chainName(): string;
  setChainName(name: string): void;
  /** A standalone SVG of the drawing. */
  saveSVG(): string;
  zoom(factor: number): void;
  fit(): void;
}
