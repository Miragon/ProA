// Types for lib/facts.mjs (the validator's minimal fact extraction), for the
// TypeScript part of eval/tools.

export interface ValidatorElement {
  id: string;
  /** bpmn-moddle type, e.g. `bpmn:StartEvent`. */
  type: string;
  kind: string;
  eventDef: string | null;
  label: string;
  key: string;
  keyFromRef: boolean;
  scope: 'process' | 'subprocess' | 'event_subprocess';
  processId: string;
  endpoint: boolean;
  dynamic: boolean;
}

export interface ValidatorProcess {
  id: string;
  kind: 'process';
  label: string;
  key: string;
  processId: string;
  scope: 'process';
  endpoint: boolean;
  isExecutable: boolean;
}

export interface ValidatorModelFacts {
  key: string;
  processes: Map<string, ValidatorProcess>;
  elements: Map<string, ValidatorElement>;
  messageFlows: Array<{ id: string; from: string | undefined; to: string | undefined }>;
}

export declare const OUTGOING_KINDS: ReadonlySet<string>;
export declare const INCOMING_KINDS: ReadonlySet<string>;
export declare function isDynamicCall(key: string): boolean;
/** `definitions` is the bpmn-moddle root element of a parsed model. */
export declare function extractFacts(modelKey: string, definitions: unknown): ValidatorModelFacts;
export declare function resolveRef(
  index: Map<string, ValidatorModelFacts>,
  ref: string,
): { error: string } | { fact: ValidatorElement | ValidatorProcess; modelKey: string; ref: string };
