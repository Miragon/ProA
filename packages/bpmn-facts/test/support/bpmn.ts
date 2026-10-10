// Builders for hand-written BPMN test documents.
import { expect } from 'vitest';

import { Fact, MessageFlowInfo, ProcessInfo } from '@proa/contracts';
import type { FactKind } from '@proa/contracts';

import { extractFacts } from '../../src/index.ts';
import type { ExtractOptions, ExtractResult } from '../../src/index.ts';

export const BPMN_NS = 'http://www.omg.org/spec/BPMN/20100524/MODEL';

export type TestEngine = 'c7' | 'c8' | 'none';

const ENGINE_ATTRS: Record<TestEngine, string> = {
  c7:
    'xmlns:camunda="http://camunda.org/schema/1.0/bpmn" ' +
    'modeler:executionPlatform="Camunda Platform" modeler:executionPlatformVersion="7.24.0"',
  c8:
    'xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" ' +
    'modeler:executionPlatform="Camunda Cloud" modeler:executionPlatformVersion="8.9.0"',
  none: '',
};

/** A `bpmn:definitions` document with the namespaces and execution platform of `engine`. */
export function definitions(engine: TestEngine, content: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" xmlns:modeler="http://camunda.org/schema/modeler/1.0" ` +
      `xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" ` +
      `${ENGINE_ATTRS[engine]} id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">`,
    content,
    '</bpmn:definitions>',
    '',
  ].join('\n');
}

/** One executable `bpmn:process`. */
export function process(
  content: string,
  { id = 'Process_1', name = 'Process one', executable = true } = {},
): string {
  const nameAttr = name === '' ? '' : ` name="${name}"`;
  return `<bpmn:process id="${id}"${nameAttr} isExecutable="${String(executable)}">\n${content}\n</bpmn:process>`;
}

/** `definitions(engine, process(body) + roots)`. */
export function model(engine: TestEngine, body: string, roots = ''): string {
  return definitions(engine, `${process(body)}\n${roots}`);
}

export const MODEL_KEY = 'test/model';

/** Extracts and checks the result against the contracts schemas. */
export async function extract(
  xml: string | Uint8Array,
  opts: Partial<ExtractOptions> = {},
): Promise<ExtractResult> {
  const result = await extractFacts(xml, { modelKey: MODEL_KEY, ...opts });
  expectValid(result);
  return result;
}

/** Every fact, process and message flow conforms to `@proa/contracts`; facts are unique per `(kind, elementId)`. */
export function expectValid(result: ExtractResult): void {
  for (const f of result.facts) expect(() => Fact.parse(f), `${f.kind} ${f.ref}`).not.toThrow();
  for (const p of result.processes) expect(() => ProcessInfo.parse(p)).not.toThrow();
  for (const m of result.messageFlows) expect(() => MessageFlowInfo.parse(m)).not.toThrow();
  const identities = result.facts.map((f) => `${f.kind}#${f.elementId}`);
  expect(new Set(identities).size).toBe(identities.length);
}

/** The fact of `kind` for `elementId`; fails the test if there is none. */
export function factOf(result: ExtractResult, kind: FactKind, elementId: string): Fact {
  const fact = result.facts.find((f) => f.kind === kind && f.elementId === elementId);
  if (!fact) {
    const have = result.facts.filter((f) => f.elementId === elementId).map((f) => f.kind);
    throw new Error(`no ${kind} fact for ${elementId} (has: ${have.join(', ') || 'none'})`);
  }
  return fact;
}

/** All `[kind, elementId]` pairs, in result order. */
export function kinds(result: ExtractResult): Array<[FactKind, string]> {
  return result.facts.map((f) => [f.kind, f.elementId]);
}

/** Facts of one element, any kind. */
export function factsOf(result: ExtractResult, elementId: string): Fact[] {
  return result.facts.filter((f) => f.elementId === elementId);
}
