import { z } from 'zod';

/**
 * Regex source of a model key: lowercase slug segments separated by `/`,
 * e.g. `finanzen/rechnungsstellung` (CONCEPT §2, eval/README.md). The key is
 * immutable and is the slugified file path below the import root.
 */
export const MODEL_KEY_PATTERN = '[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*';

/** XML `NameStartChar` without `:` (BMP only), as regex class content. */
const NCNAME_START =
  'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D' +
  '\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
/** XML `NameChar` without `:` (BMP only), as regex class content. */
const NCNAME_CHAR = `${NCNAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;

/**
 * Regex source of a BPMN element or process id: an XML NCName (BMP
 * characters). Written without the `u` flag so it carries over unchanged into
 * OpenAPI `pattern`s.
 */
export const ELEMENT_ID_PATTERN = `[${NCNAME_START}][${NCNAME_CHAR}]*`;

export const MODEL_KEY_MAX_LENGTH = 200;
export const ELEMENT_ID_MAX_LENGTH = 255;

const MODEL_KEY_RE = new RegExp(`^${MODEL_KEY_PATTERN}$`);
// XML NameChar includes combining marks (U+0300–U+036F) on purpose.
// eslint-disable-next-line no-misleading-character-class
const ELEMENT_ID_RE = new RegExp(`^${ELEMENT_ID_PATTERN}$`);
// eslint-disable-next-line no-misleading-character-class
const REF_RE = new RegExp(`^(${MODEL_KEY_PATTERN})#(${ELEMENT_ID_PATTERN})$`);

export const ModelKey = z
  .string()
  .max(MODEL_KEY_MAX_LENGTH)
  .regex(MODEL_KEY_RE, 'must be lowercase slug segments separated by /, e.g. billing/dunning')
  .meta({
    id: 'ModelKey',
    description: 'Immutable model key: lowercase slug segments separated by `/`.',
    example: 'finanzen/rechnungsstellung',
  });
export type ModelKey = z.infer<typeof ModelKey>;

export const ElementId = z
  .string()
  .max(ELEMENT_ID_MAX_LENGTH)
  .regex(ELEMENT_ID_RE, 'must be an XML NCName')
  .meta({
    id: 'ElementId',
    description: 'BPMN element or process id (XML NCName).',
    example: 'Event_WareVersandbereit',
  });
export type ElementId = z.infer<typeof ElementId>;

/** `<model_key>#<element_id>`, or `<model_key>#<process_id>` for a process (CONCEPT §2). */
export type Ref = `${string}#${string}`;

export const Ref = z
  .string()
  .max(MODEL_KEY_MAX_LENGTH + 1 + ELEMENT_ID_MAX_LENGTH)
  .regex(REF_RE, 'must be <model_key>#<element_id>')
  .meta({
    id: 'Ref',
    description:
      'Reference to a BPMN element: `<model_key>#<element_id>`, or `<model_key>#<process_id>` for a process.',
    example: 'vertrieb/auftragsabwicklung#Event_WareVersandbereit',
  }) as unknown as z.ZodType<Ref, Ref>;

/** True if `value` is a well-formed model key. */
export function isModelKey(value: string): boolean {
  return value.length <= MODEL_KEY_MAX_LENGTH && MODEL_KEY_RE.test(value);
}

/** True if `value` is a well-formed element or process id (XML NCName, at most 255 characters). */
export function isElementId(value: string): boolean {
  return value.length <= ELEMENT_ID_MAX_LENGTH && ELEMENT_ID_RE.test(value);
}

/** True if `value` is a well-formed ref. */
export function isRef(value: string): value is Ref {
  return value.length <= MODEL_KEY_MAX_LENGTH + 1 + ELEMENT_ID_MAX_LENGTH && REF_RE.test(value);
}

/**
 * Builds a ref from its parts.
 * @throws {TypeError} if the model key or element id is malformed
 */
export function formatRef(modelKey: string, elementId: string): Ref {
  if (!isModelKey(modelKey)) throw new TypeError(`invalid model key: ${JSON.stringify(modelKey)}`);
  if (!isElementId(elementId)) {
    throw new TypeError(`invalid element id: ${JSON.stringify(elementId)}`);
  }
  return `${modelKey}#${elementId}`;
}

/**
 * Splits a ref into model key and element id.
 * @throws {TypeError} if `ref` is malformed
 */
export function parseRef(ref: string): { modelKey: string; elementId: string } {
  const m =
    ref.length <= MODEL_KEY_MAX_LENGTH + 1 + ELEMENT_ID_MAX_LENGTH ? REF_RE.exec(ref) : null;
  if (!m?.[1] || !m[2]) throw new TypeError(`invalid ref: ${JSON.stringify(ref)}`);
  return { modelKey: m[1], elementId: m[2] };
}
