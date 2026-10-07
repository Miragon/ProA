/** Why an input was rejected; the server answers 422 `bpmn-invalid` (413 for `too-large`). */
export type BpmnInputErrorCode =
  /** The document contains a DOCTYPE declaration (XXE, entity expansion). */
  | 'doctype-forbidden'
  /** The document declares or references an external/internal ENTITY. */
  | 'entity-forbidden'
  | 'too-large'
  | 'too-many-elements'
  /** Not well-formed XML, or not UTF-8. */
  | 'not-xml'
  /** Well-formed XML but not a BPMN 2.0 `definitions` document. */
  | 'not-bpmn'
  | 'invalid-model-key';

/** Rejection of hostile, oversized or malformed input. Nothing was extracted. */
export class BpmnInputError extends Error {
  override readonly name = 'BpmnInputError';
  readonly code: BpmnInputErrorCode;

  constructor(code: BpmnInputErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
