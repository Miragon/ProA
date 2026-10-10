// Deliberate violation of `domain-is-pure`, used by test/unit/architecture.test.ts.
import { repo } from '../db/repo.ts';

export const bad = repo;
