// zod must not probe `new Function` under the CSP (M4 §5); main.tsx imports it first too.
import '@/lib/zod-csp';

import { CURRENT_SCHEMA_VERSION, loadDocument } from '@miragon/value-chain-schema-model';

import type { DocumentCheck } from '../chain-canvas-types';

/**
 * Checks a parsed `.vc.json` before the page imports it (M4 §3.3 "Import"):
 * the format version first (a newer one would be refused by the migration
 * with an English message), then the schema-model's own validation
 * (`loadDocument`: the zod schema, unique ids, known endpoints, allowed
 * connection types). Loaded lazily with the canvas chunk's packages, so the
 * page never pulls schema-model or zod into its own bundle. ProA's own rules
 * (duplicate connections, cycles, depth, coordinates) are the save's, which
 * lists their violations.
 */
export function checkDocument(json: unknown): DocumentCheck {
  if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
    const version = (json as { schemaVersion?: unknown }).schemaVersion;
    if (
      typeof version === 'number' &&
      Number.isInteger(version) &&
      version > CURRENT_SCHEMA_VERSION
    ) {
      return { ok: false, kind: 'version', version, supported: CURRENT_SCHEMA_VERSION };
    }
  }
  try {
    const doc = loadDocument(json);
    return { ok: true, elements: doc.elements.length, connections: doc.connections.length };
  } catch (error) {
    const issues = (error as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
    const first = Array.isArray(issues) ? issues[0] : undefined;
    if (first) {
      const path = first.path.map(String).join('.');
      return { ok: false, kind: 'schema', path: path === '' ? null : path, detail: first.message };
    }
    return {
      ok: false,
      kind: 'schema',
      path: null,
      detail: error instanceof Error ? error.message.slice(0, 300) : String(error),
    };
  }
}
