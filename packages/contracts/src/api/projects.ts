import { z } from 'zod';

import { ProjectId } from '../ids.ts';
import { plainName } from '../zod-utils.ts';
import { Role } from './auth.ts';
import { Timestamp, pageOf } from './common.ts';

/** Project key: one lowercase slug segment, e.g. `nordwind-handel`. */
export const ProjectKey = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase slug, e.g. nordwind-handel')
  .meta({
    id: 'ProjectKey',
    description: 'Unique project key (lowercase slug).',
    example: 'nordwind-handel',
  });
export type ProjectKey = z.infer<typeof ProjectKey>;

export const Project = z
  .object({
    id: ProjectId,
    key: ProjectKey,
    name: z.string().min(1).max(200),
    /** The caller's role in this project. */
    role: Role,
    /** Sequence number of the latest event; the landscape ETag is `"s<lastSeq>"`. */
    lastSeq: z.number().int().min(0),
    createdAt: Timestamp,
  })
  .meta({ id: 'Project', description: 'A project: one process landscape.' });
export type Project = z.infer<typeof Project>;

export const CreateProjectBody = z
  .object({ key: ProjectKey, name: plainName(200) })
  .meta({ id: 'CreateProjectBody', description: 'Request body to create a project.' });
export type CreateProjectBody = z.infer<typeof CreateProjectBody>;

export const ProjectPage = pageOf(Project, 'ProjectPage');
export type ProjectPage = z.infer<typeof ProjectPage>;
