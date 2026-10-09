import { VcDiagramElementFactory, type VcViewerOptions } from '@miragon/value-chain-renderer';
import OverlaysModule from 'diagram-js/lib/features/overlays';
import type { Connection, Label, Root, Shape } from 'diagram-js/lib/model/Types';

import { ulid } from '@/lib/ulid';

/**
 * ProA's additions to the value chain renderer (M4 §4), passed as
 * `additionalModules` to both the NavigatedViewer and the Modeler: diagram-js
 * overlays (the NavigatedViewer has none) for badges and finding labels, and
 * an element factory with collision-free ids.
 */

type ModuleDeclaration = NonNullable<VcViewerOptions['additionalModules']>[number];
type ElementType = 'root' | 'shape' | 'connection' | 'label';

interface Registry {
  get(id: string): unknown;
}

/**
 * The renderer's factory hands out `shape_1`, `shape_2`, … from a counter that
 * restarts in every editing session and only probes the current registry, so
 * a step added later can get the id of a step deleted earlier, and ProA would
 * read it as that step (M4 §2). This one gives every element created without
 * an id `<type>_<ULID>` (`shape_01J…`, `connection_01J…`): palette, append,
 * auto-place and paste all go through `create` (copy-paste drops the ids).
 * Ids that come in with a document are never changed.
 */
export class ProaElementFactory extends VcDiagramElementFactory {
  static override $inject = ['elementRegistry'];
  private readonly registry: Registry;

  constructor(elementRegistry: ConstructorParameters<typeof VcDiagramElementFactory>[0]) {
    super(elementRegistry);
    this.registry = elementRegistry;
  }

  /** A new id that no element of this diagram has. */
  newId(type: ElementType): string {
    let id: string;
    do id = `${type}_${ulid()}`;
    while (this.registry.get(id));
    return id;
  }

  override create(type: 'root', attrs?: Partial<Root>): Root;
  override create(type: 'shape', attrs?: Partial<Shape>): Shape;
  override create(type: 'connection', attrs?: Partial<Connection>): Connection;
  override create(type: 'label', attrs?: Partial<Label>): Label;
  override create(type: ElementType, attrs?: { id?: string }): Root | Shape | Connection | Label {
    const withId = attrs?.id ? attrs : { ...attrs, id: this.newId(type) };
    return super.create(type as 'shape', withId as Partial<Shape>);
  }
}

const proaIdModule = { elementFactory: ['type', ProaElementFactory] } as ModuleDeclaration;

/** The modules ProA adds to every renderer instance. */
export const PROA_MODULES: ModuleDeclaration[] = [OverlaysModule, proaIdModule];
