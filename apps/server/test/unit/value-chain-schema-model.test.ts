// M4 S0: @miragon/value-chain-schema-model from npm in Node, as the server will use it. A
// revision stores serializeDocument(loadDocument(input)) (M4 §2), so every golden chain in
// eval/value-chains must parse with the package's validation and serialize back to exactly
// its committed bytes. One of the chains belongs to the holdout landscape, whose content
// stays out of test output: a serialization mismatch names the first differing line only,
// and an error while parsing names the function and the error class, never its message
// (JSON.parse quotes the text, the cross-field rules quote element ids).
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';

import {
  CURRENT_SCHEMA_VERSION,
  loadDocument,
  parseDocumentJSON,
  serializeDocument,
  validateDocument,
} from '@miragon/value-chain-schema-model';
import { describe, expect, it } from 'vitest';

const valueChains = new URL('../../../../eval/value-chains/', import.meta.url);
const chainFile = (landscape: string) => new URL(`${landscape}/value-chain.vc.json`, valueChains);
const landscapes = readdirSync(valueChains)
  .filter((entry) => existsSync(chainFile(entry)))
  .sort();

/** 1-based number of the first line where the texts differ, or 0 when they are equal. */
function firstDifferentLine(actual: string, expected: string): number {
  if (actual === expected) return 0;
  const a = actual.split('\n');
  const b = expected.split('\n');
  const index = a.findIndex((line, i) => line !== b[i]);
  return (index === -1 ? a.length : index) + 1;
}

/**
 * Runs fn; an error becomes one that names the call and the error class only. Deliberately
 * without `cause`: vitest prints the cause's message.
 */
function redacted<T>(landscape: string, call: string, fn: () => T): T {
  let kind: string;
  try {
    return fn();
  } catch (error) {
    kind = error instanceof Error ? error.constructor.name : typeof error;
  }
  throw new Error(
    `${landscape}: ${call} threw ${kind} (message withheld; run ` +
      `node eval/value-chains/validate-value-chains.mjs ${landscape} for details)`,
  );
}

/** Real path of the package.json that `specifier` resolves to from `base` (a file URL). */
function packageJsonOf(specifier: string, base: string): string {
  const path = findPackageJSON(specifier, base);
  if (!path) throw new Error(`no package.json for ${specifier} from ${base}`);
  return realpathSync(path);
}

describe('value-chain schema-model (npm) in Node', () => {
  it('finds the golden chains of both scored landscapes', () => {
    expect(landscapes).toEqual(['nordwind-handel', 'stadtwerke-auental']);
  });

  it.each(landscapes)('%s: parse and serialize reproduce the committed file', (landscape) => {
    const text = readFileSync(chainFile(landscape), 'utf8');
    const run = <T>(call: string, fn: () => T) => redacted(landscape, call, fn);
    const loaded = run('loadDocument', () => loadDocument(JSON.parse(text)));
    expect(loaded.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const results = {
      loadDocument: run('serializeDocument', () => serializeDocument(loaded)),
      parseDocumentJSON: run('parseDocumentJSON', () => serializeDocument(parseDocumentJSON(text))),
      validateDocument: run('validateDocument', () =>
        serializeDocument(validateDocument(JSON.parse(text))),
      ),
    };
    const differences = Object.entries(results).map(([fn, out]) => [
      fn,
      firstDifferentLine(out, text),
    ]);
    expect(Object.fromEntries(differences)).toEqual({
      loadDocument: 0,
      parseDocumentJSON: 0,
      validateDocument: 0,
    });
  });

  it('rejects what ProA relies on it to reject', () => {
    const step = (id: string) => ({
      id,
      elementType: 'step',
      name: id,
      bounds: { x: 0, y: 0, width: 160, height: 60 },
    });
    const doc = (overrides: object) => ({
      schemaVersion: 1,
      meta: { name: 'x' },
      elements: [step('a'), step('b')],
      connections: [],
      ...overrides,
    });
    expect(() => loadDocument(doc({}))).not.toThrow();
    // A newer schemaVersion than the package knows (M4 §2: 422 value-chain-unsupported-version).
    expect(() => loadDocument(doc({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }))).toThrow(
      /schemaVersion/,
    );
    expect(() => loadDocument(doc({ elements: [step('a'), step('a')] }))).toThrow(/Duplicate id/);
    const line = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
    const sequence = (target: string, waypoints = line) => ({
      id: 'c',
      connectionType: 'sequence',
      source: 'a',
      target,
      waypoints,
    });
    expect(() => loadDocument(doc({ connections: [sequence('b')] }))).not.toThrow();
    expect(() => loadDocument(doc({ connections: [sequence('x')] }))).toThrow(/unknown element/);
    expect(() => loadDocument(doc({ connections: [sequence('b', line.slice(1))] }))).toThrow();
  });

  it('loads the same zod package as the server (one zod v4 copy in Node)', () => {
    // Not instanceof: zod v4's Symbol.hasInstance checks trait names, so a schema of any
    // zod v4 copy passes it. Node loads the package from its real path (pnpm links it from
    // the store) and resolves its zod from there; resolving from the link would find the
    // server's zod whatever the package pins.
    const schemaModel = packageJsonOf('@miragon/value-chain-schema-model', import.meta.url);
    const zodOfSchemaModel = packageJsonOf('zod', pathToFileURL(schemaModel).href);
    expect(zodOfSchemaModel).toBe(packageJsonOf('zod', import.meta.url));
  });
});
