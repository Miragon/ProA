/**
 * Value chain test helpers (M4): synthetic chain documents and prepared
 * revisions. Synthetic data only.
 */
import { createHash } from 'node:crypto';

import { loadDocument, serializeDocument } from '@miragon/value-chain-schema-model';
import { sql } from 'drizzle-orm';

import { contentHash } from '../../src/domain/ingest.ts';
import { prepareRevision } from '../../src/domain/value-chain/document.ts';
import type { PreparedRevision } from '../../src/domain/value-chain/revisions.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A prepared revision, as the use cases store it: `prepareRevision` (M4 S2). */
export function prepare(input: unknown): PreparedRevision {
  return prepareRevision(input).prepared;
}

/**
 * A prepared revision that skips the ProA rules (canonical bytes from
 * schema-model, stand-in hashes), to reach the domain's own guards behind
 * `prepareRevision`, e.g. against ids starting with `@`.
 */
export function prepareUnchecked(input: unknown): PreparedRevision {
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

/** A step of {@link chain}. */
export interface StepSpec {
  id: string;
  name: string;
  parent?: string;
  color?: string;
  link?: string;
  x?: number;
  y?: number;
}

/**
 * A synthetic chain document from a compact spec: steps (with parents by
 * `hierarchy`), `sequence` edges and org units owning steps by `assignment`.
 * Positions default to a grid by index; every connection gets two waypoints.
 */
export function chain(spec: {
  name?: string;
  steps: readonly StepSpec[];
  sequence?: readonly (readonly [string, string])[];
  orgUnits?: readonly { id: string; name: string; owns: readonly string[] }[];
}) {
  const point = { x: 0, y: 0 };
  const waypoints = [point, { x: 10, y: 10 }];
  return {
    schemaVersion: 1,
    meta: { name: spec.name ?? 'Testkette' },
    elements: [
      ...spec.steps.map((s, i) => ({
        id: s.id,
        elementType: 'step',
        name: s.name,
        bounds: { x: s.x ?? i * 200, y: s.y ?? 0, width: 160, height: 60 },
        ...(s.color === undefined ? {} : { color: s.color }),
        ...(s.link === undefined ? {} : { link: s.link }),
      })),
      ...(spec.orgUnits ?? []).map((o, i) => ({
        id: o.id,
        elementType: 'orgUnit',
        name: o.name,
        bounds: { x: i * 200, y: -200, width: 130, height: 60 },
      })),
    ],
    connections: [
      ...spec.steps
        .filter((s) => s.parent !== undefined)
        .map((s) => ({
          id: `hier-${s.parent ?? ''}-${s.id}`,
          connectionType: 'hierarchy',
          source: s.parent,
          target: s.id,
          waypoints,
        })),
      ...(spec.sequence ?? []).map(([a, b]) => ({
        id: `seq-${a}-${b}`,
        connectionType: 'sequence',
        source: a,
        target: b,
        waypoints,
      })),
      ...(spec.orgUnits ?? []).flatMap((o) =>
        o.owns.map((step) => ({
          id: `assign-${o.id}-${step}`,
          connectionType: 'assignment',
          source: o.id,
          target: step,
          waypoints,
        })),
      ),
    ],
  };
}

/** The golden chain of the dev landscape (never the holdout's). */
export const NORDWIND_CHAIN = new URL(
  '../../../../eval/value-chains/nordwind-handel/value-chain.vc.json',
  import.meta.url,
);
/** The expected placements of the dev landscape (never the holdout's). */
export const NORDWIND_PLACEMENTS = new URL(
  '../../../../eval/value-chains/nordwind-handel/expected-placements.yaml',
  import.meta.url,
);

/** `/api/v1/projects/<project>/value-chains/main<rest>`. */
export function chainPath(project: string, rest = ''): string {
  return `/api/v1/projects/${project}/value-chains/main${rest}`;
}

/** A fingerprint of the relation side of a project; chain and placement writes must not move it. */
export async function relationSide(
  db: { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> },
  projectId: string,
): Promise<string> {
  const r = await db.execute(sql`
    select concat_ws('/',
      (select md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from relation x where x.project_id = ${projectId}),
      (select md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from relation_assertion x where x.project_id = ${projectId}),
      (select md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from no_link x where x.project_id = ${projectId}),
      (select md5(coalesce(string_agg(x::text, '|' order by x.no_link_id), '')) from no_link_withdrawal x where x.project_id = ${projectId}),
      (select md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from analysis_task x where x.project_id = ${projectId}),
      (select md5(coalesce(string_agg(x::text, '|' order by x.ord), '')) from finding x where x.project_id = ${projectId}),
      (select md5(coalesce(string_agg(x::text, '|' order by x.model_id), '')) from model_pipeline x where x.project_id = ${projectId}),
      (select md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from model x where x.project_id = ${projectId})
    ) as digest`);
  return (r.rows[0] as { digest?: string } | undefined)?.digest ?? '';
}
