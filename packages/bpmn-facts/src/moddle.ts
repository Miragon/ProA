// bpmn-moddle access: one cached moddle per Camunda extension and narrow,
// runtime-checked readers for element properties.

// Workspace packages typecheck this source from their own tsconfig, which does
// not include our ambient declaration; the reference pulls it into every
// program that imports this module.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- see above
/// <reference path="./bpmn-moddle.d.ts" />
import { BpmnModdle } from 'bpmn-moddle';
import type { ModdleElement, ParseResult } from 'bpmn-moddle';
import camunda from 'camunda-bpmn-moddle/resources/camunda.json' with { type: 'json' };
import zeebe from 'zeebe-bpmn-moddle/resources/zeebe.json' with { type: 'json' };

export type { ModdleElement, ParseWarning } from 'bpmn-moddle';

/**
 * The extension a moddle knows. camunda (C7) and zeebe (C8) cannot be
 * registered together: both define `modelerTemplate` on the same types.
 */
export type ModdleExtension = 'camunda' | 'zeebe';

const moddles = new Map<ModdleExtension, BpmnModdle>();

/** Parses BPMN 2.0 XML (lax: unknown content becomes warnings, never an exception). */
export function parseBpmn(xml: string, extension: ModdleExtension): Promise<ParseResult> {
  let moddle = moddles.get(extension);
  if (!moddle) {
    moddle = new BpmnModdle(extension === 'camunda' ? { camunda } : { zeebe });
    moddles.set(extension, moddle);
  }
  return moddle.fromXML(xml);
}

export function isElement(value: unknown): value is ModdleElement {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { $type?: unknown }).$type === 'string'
  );
}

/** `el` is a `type` or a subtype of it (generic elements: exact type only). */
export function isA(el: ModdleElement, type: string): boolean {
  return el.$instanceOf ? el.$instanceOf(type) : el.$type === type;
}

/** Property value incl. descriptor defaults (`isInterrupting` → `true` when unset). */
export function prop(el: ModdleElement, name: string): unknown {
  return el.get ? el.get(name) : undefined;
}

/** Property value only if set in the document (no defaults). */
export function own(el: ModdleElement, name: string): unknown {
  return Object.hasOwn(el, name) ? (el as unknown as Record<string, unknown>)[name] : undefined;
}

export function str(el: ModdleElement, name: string): string | undefined {
  const value = prop(el, name);
  return typeof value === 'string' ? value : undefined;
}

export function ownStr(el: ModdleElement, name: string): string | undefined {
  const value = own(el, name);
  return typeof value === 'string' ? value : undefined;
}

export function child(el: ModdleElement, name: string): ModdleElement | undefined {
  const value = prop(el, name);
  return isElement(value) ? value : undefined;
}

export function children(el: ModdleElement | undefined, name: string): ModdleElement[] {
  if (!el) return [];
  const value = prop(el, name);
  return Array.isArray(value) ? value.filter(isElement) : [];
}

/** `extensionElements/values`. */
export function extensionValues(el: ModdleElement): ModdleElement[] {
  return children(child(el, 'extensionElements'), 'values');
}
