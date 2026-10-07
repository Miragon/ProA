/** Target engine of a BPMN file: Camunda 7 (`c7`), Camunda 8 (`c8`) or unknown. */
export type Engine = 'c7' | 'c8';

const DEFINITIONS_TAG = /<(?:[A-Za-z_][\w.-]*:)?definitions\b[^>]*>/;
const EXECUTION_PLATFORM = /\bmodeler:executionPlatform\s*=\s*(["'])(.*?)\1/;
const ZEEBE_NS = 'http://camunda.org/schema/zeebe/1.0';
const CAMUNDA_NS = 'http://camunda.org/schema/1.0/bpmn';

/**
 * Reads the engine like `@proa/bpmn-facts` does: `modeler:executionPlatform`
 * on `bpmn:definitions` ("Camunda Cloud" → C8, "Camunda Platform" → C7),
 * else the declared zeebe or camunda namespace. The API does not carry the
 * engine yet, so the UI derives it from the head revision's bytes.
 */
export function detectEngine(xml: string): Engine | null {
  const definitions = DEFINITIONS_TAG.exec(xml)?.[0];
  if (!definitions) return null;
  const platform = EXECUTION_PLATFORM.exec(definitions)?.[2]?.toLowerCase() ?? '';
  if (platform.includes('cloud') || platform.includes('camunda 8')) return 'c8';
  if (platform.includes('platform') || platform.includes('camunda 7')) return 'c7';
  if (definitions.includes(ZEEBE_NS)) return 'c8';
  if (definitions.includes(CAMUNDA_NS)) return 'c7';
  return null;
}

export const ENGINE_LABELS: Record<Engine, string> = { c7: 'Camunda 7', c8: 'Camunda 8' };
