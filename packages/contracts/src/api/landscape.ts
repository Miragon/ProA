import { z } from 'zod';

import { ProcessInfo } from '../facts.ts';
import { Finding } from '../findings.ts';
import { ModelId, ProjectId } from '../ids.ts';
import { ModelKey } from '../refs.ts';
import { ModelStage } from './models.ts';
import { Relation } from './relations.ts';

export const LandscapeModel = z
  .object({
    id: ModelId,
    key: ModelKey,
    name: z.string().nullable(),
    stage: ModelStage,
    processes: z.array(ProcessInfo),
  })
  .meta({ id: 'LandscapeModel', description: 'A model as part of the landscape.' });
export type LandscapeModel = z.infer<typeof LandscapeModel>;

/**
 * The project head: models, processes, non-obsolete relations and findings.
 * Served with `ETag: "s<seq>"`.
 */
export const Landscape = z
  .object({
    projectId: ProjectId,
    /** Event sequence number the landscape reflects. */
    seq: z.number().int().min(0),
    models: z.array(LandscapeModel),
    relations: z.array(Relation),
    findings: z.array(Finding),
  })
  .meta({ id: 'Landscape', description: 'The current process landscape of a project.' });
export type Landscape = z.infer<typeof Landscape>;
