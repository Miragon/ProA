import { BpmnInputError } from './errors.ts';

/** The root element's start tag. */
export interface RootTag {
  /** Qualified name as written, e.g. `bpmn:definitions`. */
  name: string;
  /** Attributes by qualified name as written; values with character references decoded. */
  attributes: ReadonlyMap<string, string>;
}

export interface XmlScan {
  /** Number of elements (start tags). */
  elements: number;
  root: RootTag;
}

const LT = '<'.charCodeAt(0);
const GT = '>'.charCodeAt(0);
const SLASH = '/'.charCodeAt(0);
const QUESTION = '?'.charCodeAt(0);
const QUOTE = '"'.charCodeAt(0);
const APOS = "'".charCodeAt(0);

/** XML NameStartChar, approximated for non-ASCII (everything from U+00C0 up). */
function isNameStart(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) || // A-Z
    (c >= 0x61 && c <= 0x7a) || // a-z
    c === 0x5f || // _
    c === 0x3a || // :
    c >= 0xc0
  );
}

function skipPast(text: string, terminator: string, from: number, what: string): number {
  const end = text.indexOf(terminator, from);
  if (end < 0) throw new BpmnInputError('not-xml', `unterminated ${what} at offset ${from}`);
  return end + terminator.length;
}

/** Index of the `>` that closes the tag starting at `lt`; `>` inside quoted attribute values is skipped. */
function tagEnd(text: string, lt: number): number {
  let quote = 0;
  for (let i = lt + 1; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote) quote = 0;
    } else if (c === QUOTE || c === APOS) {
      quote = c;
    } else if (c === GT) {
      return i;
    } else if (c === LT) {
      break;
    }
  }
  throw new BpmnInputError('not-xml', `unterminated tag at offset ${lt}`);
}

const PREDEFINED: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

function decodeReferences(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return PREDEFINED[ref] ?? whole;
  });
}

function parseTag(content: string): RootTag {
  const name = /^[^\s/>]+/.exec(content)?.[0] ?? '';
  const attributes = new Map<string, string>();
  for (const m of content
    .slice(name.length)
    .matchAll(/([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const attr = m[1];
    if (attr !== undefined && !attributes.has(attr)) {
      attributes.set(attr, decodeReferences(m[2] ?? m[3] ?? ''));
    }
  }
  return { name, attributes };
}

/**
 * One linear pass over the markup before the parser runs: counts start tags
 * (comments, CDATA sections and processing instructions are skipped) and
 * reads the root tag. It is no parser, but it bounds the parser's work and
 * finds the root element for a precise `not-bpmn` error. Call it on text that
 * passed {@link assertSafeXml}, which has already rejected `<!DOCTYPE`.
 *
 * @throws {BpmnInputError} `too-many-elements`, or `not-xml` for markup that cannot be well-formed
 */
export function scanXml(text: string, maxElements: number): XmlScan {
  let elements = 0;
  let root: RootTag | null = null;
  let i = 0;
  for (;;) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      i = skipPast(text, '-->', lt + 4, 'comment');
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      i = skipPast(text, ']]>', lt + 9, 'CDATA section');
      continue;
    }
    const next = text.charCodeAt(lt + 1);
    if (next === QUESTION) {
      i = skipPast(text, '?>', lt + 2, 'processing instruction');
      continue;
    }
    if (next === SLASH) {
      i = lt + 2;
      continue;
    }
    if (!isNameStart(next)) throw new BpmnInputError('not-xml', `malformed markup at offset ${lt}`);
    elements++;
    if (elements > maxElements) {
      throw new BpmnInputError(
        'too-many-elements',
        `BPMN file has more than ${maxElements} XML elements`,
      );
    }
    if (root === null) {
      const end = tagEnd(text, lt);
      root = parseTag(text.slice(lt + 1, end));
      i = end + 1;
    } else {
      i = lt + 1;
    }
  }
  if (root === null) throw new BpmnInputError('not-xml', 'the document has no root element');
  return { elements, root };
}

/** Namespace URI of a qualified name, from the root tag's `xmlns` declarations. */
export function namespaceOf(root: RootTag, qualifiedName: string): string | undefined {
  const colon = qualifiedName.indexOf(':');
  return root.attributes.get(colon < 0 ? 'xmlns' : `xmlns:${qualifiedName.slice(0, colon)}`);
}

/** Local part of a qualified name. */
export function localName(qualifiedName: string): string {
  return qualifiedName.slice(qualifiedName.indexOf(':') + 1);
}

/** Namespace URIs declared on the root tag. */
export function declaredNamespaces(root: RootTag): Set<string> {
  const uris = new Set<string>();
  for (const [name, value] of root.attributes) {
    if (name === 'xmlns' || name.startsWith('xmlns:')) uris.add(value);
  }
  return uris;
}

/** Value of the root attribute `{namespace}local`, whatever prefix the document binds to the namespace. */
export function rootAttributeNS(
  root: RootTag,
  namespace: string,
  local: string,
): string | undefined {
  for (const [name, value] of root.attributes) {
    if (name.startsWith('xmlns:') && value === namespace) {
      const attr = root.attributes.get(`${name.slice('xmlns:'.length)}:${local}`);
      if (attr !== undefined) return attr;
    }
  }
  return undefined;
}
