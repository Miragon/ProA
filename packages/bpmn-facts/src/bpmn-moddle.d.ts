// bpmn-moddle ships types only for its element interfaces (`bpmn-moddle/types`),
// not for the BpmnModdle class. This declares the small part @proa/bpmn-facts
// uses; element properties are read through `get()` and narrowed at runtime.
declare module 'bpmn-moddle' {
  /** A parsed element. Unknown elements of foreign namespaces are generic elements with the same shape. */
  export interface ModdleElement {
    readonly $type: string;
    /** Attributes the registered packages do not know, by qualified name. */
    readonly $attrs?: Readonly<Record<string, string>>;
    readonly $parent?: ModdleElement;
    $instanceOf?(type: string): boolean;
    /** Property value, the descriptor's default if unset, `$attrs[name]` for unknown properties. */
    get?(name: string): unknown;
  }

  export interface ParseWarning {
    message: string;
    element?: unknown;
    property?: string;
    value?: unknown;
    error?: unknown;
  }

  export interface ParseResult {
    rootElement: ModdleElement | undefined;
    warnings: ParseWarning[];
    elementsById: Record<string, ModdleElement>;
    references: unknown[];
  }

  export class BpmnModdle {
    constructor(packages?: Record<string, object>, options?: Record<string, unknown>);
    fromXML(
      xml: string,
      typeName?: string,
      options?: Record<string, unknown>,
    ): Promise<ParseResult>;
  }
}
