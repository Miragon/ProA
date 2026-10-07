// Types for lib/moddle.mjs, for the TypeScript part of eval/tools.

export interface ModdleParseResult {
  /** The bpmn:Definitions element. */
  rootElement: unknown;
  warnings: Array<{ message: string }>;
}

export interface EvalModdle {
  fromXML(xml: string): Promise<ModdleParseResult>;
}

/** c7 -> bpmn + camunda + modeler; c8 -> bpmn + zeebe + modeler. */
export declare function createModdle(engine: 'c7' | 'c8'): EvalModdle;
