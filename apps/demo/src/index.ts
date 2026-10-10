/**
 * `@proa/demo`: the public read-only demo (issue #3, docker/Dockerfile.demo).
 * {@link seedDemo} builds the database at image build time, {@link serveDemo}
 * supervises PostgreSQL and the server in the container, {@link checkDemo}
 * proves a running demo refuses every write.
 */
export { checkDemo, waitForDemo } from './check.ts';
export type { CheckOptions, CheckResult } from './check.ts';
export { DEMO_DB_ROLE_NAME } from './constants.ts';
export { baseSettings, databaseUrl } from './postgres.ts';
export { runDemo } from './program.ts';
export { childEnv, spawnProcess, stop, waitFor } from './processes.ts';
export type { Child, Exit, Spawn, Spawned, SpawnOptions } from './processes.ts';
export { APPS, DEMO_LANDSCAPES, SEED_TOKEN_NAME, seedDemo } from './seed.ts';
export type { ProjectSeed, SeedInfo } from './seed.ts';
export { DEMO_LINK_SETTINGS, publicOrigins, serveDemo, serverEnv } from './serve.ts';
