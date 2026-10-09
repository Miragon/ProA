/**
 * Value chain test helpers (M4 S1): synthetic chain documents and prepared
 * revisions as S2's `prepareRevision` will produce them. Synthetic data only.
 */
import { createHash } from 'node:crypto';

import { loadDocument, serializeDocument } from '@miragon/value-chain-schema-model';

import { contentHash } from '../../src/domain/ingest.ts';
import type { PreparedRevision } from '../../src/domain/value-chain/revisions.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * A prepared revision: canonical bytes from schema-model; the structure hash
 * and the step fingerprints are stand-ins over ids and names (S2 defines the
 * real ones, M4 §2).
 */
export function prepare(input: unknown): PreparedRevision {
  const document = loadDocument(input);
  const content = new TextEncoder().encode(serializeDocument(document));
  const steps = document.elements.filter((e) => e.elementType === 'step');
  return {
    content,
    contentHash: contentHash(content),
    structureHash: sha(JSON.stringify(steps.map((e) => [e.id, e.name]))),
    schemaVersion: document.schemaVersion,
    name: document.meta.name,
    stepFingerprints: new Map(
      steps.map((e) => [e.id, sha(`step|${e.name.toLowerCase()}|`).slice(0, 12)]),
    ),
  };
}

/**
 * A synthetic chain document: steps left to right, linked by `sequence`
 * connections, and one org unit (never a placement target).
 *
 * @param dx moves every shape (a layout-only change)
 */
export function chainDoc(name: string, steps: readonly [string, string][], dx = 0) {
  return {
    schemaVersion: 1,
    meta: { name },
    elements: [
      ...steps.map(([id, stepName], i) => ({
        id,
        elementType: 'step',
        name: stepName,
        bounds: { x: dx + i * 200, y: 0, width: 160, height: 60 },
      })),
      {
        id: 'org-unit',
        elementType: 'orgUnit',
        name: 'Organisationseinheit',
        bounds: { x: dx, y: 200, width: 130, height: 60 },
      },
    ],
    connections: steps.slice(1).map(([id], i) => ({
      id: `seq-${i}`,
      connectionType: 'sequence',
      source: steps[i]?.[0],
      target: id,
      waypoints: [
        { x: dx + i * 200 + 160, y: 30 },
        { x: dx + (i + 1) * 200, y: 30 },
      ],
    })),
  };
}
