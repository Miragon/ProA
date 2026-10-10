// Starts one PostgreSQL 17 for the integration project and hands its admin
// URL to the tests (`inject('adminDatabaseUrl')`). Each test file creates its
// own database from it (test/support/db.ts), so files run in parallel.
//
// PROA_TEST_DATABASE_URL=postgres://user:pass@host:port/db skips Testcontainers
// and uses that server instead (the user needs CREATEDB).
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

/** Same image as docker/compose.yaml. */
export const POSTGRES_IMAGE = 'postgres:17.11';

declare module 'vitest' {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const external = process.env['PROA_TEST_DATABASE_URL'];
  if (external) {
    project.provide('adminDatabaseUrl', external);
    return async () => {};
  }
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('proa')
    .withUsername('proa')
    .withPassword('proa')
    .start();
  project.provide('adminDatabaseUrl', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}
