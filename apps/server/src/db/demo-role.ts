import type pg from 'pg';

/** Name of the read-only role the demo server connects as (issue #3). */
export const DEMO_DB_ROLE = 'proa_demo';

/** Longest statement the demo role may run: a public server must not be kept busy. */
export const DEMO_STATEMENT_TIMEOUT = '30s';

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface ReadOnlyRoleOptions {
  /** Role name; default {@link DEMO_DB_ROLE}. */
  name?: string;
  /** Login password; default none (the demo's PostgreSQL trusts loopback inside its container). */
  password?: string;
}

/**
 * The read-only demo's third write barrier: a login role that may read every
 * table and view of `public` and whose transactions are read-only by default
 * (`default_transaction_read_only = on`), with a statement timeout. The demo
 * server connects as this role; reads run as `read only` transactions anyway,
 * so any write that slipped past the HTTP guard and the policy fails in
 * PostgreSQL (SQLSTATE 25006). Idempotent; run by `demo-bootstrap.ts` as a
 * role that may create roles, after the migrations.
 *
 * @throws if `name` is not a plain lower-case identifier
 */
export async function createReadOnlyRole(
  client: pg.ClientBase,
  options: ReadOnlyRoleOptions = {},
): Promise<string> {
  const name = options.name ?? DEMO_DB_ROLE;
  if (!ROLE_NAME.test(name)) throw new Error(`invalid role name ${JSON.stringify(name)}`);
  const role = client.escapeIdentifier(name);
  const { rows } = await client.query<{ exists: boolean; db: string }>(
    'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists, current_database() AS db',
    [name],
  );
  const found = rows[0];
  if (!found) throw new Error('no answer from PostgreSQL');
  const password =
    options.password === undefined ? '' : ` PASSWORD ${client.escapeLiteral(options.password)}`;
  await client.query(
    found.exists
      ? `ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE${password}`
      : `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE${password}`,
  );
  await client.query(`GRANT CONNECT ON DATABASE ${client.escapeIdentifier(found.db)} TO ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
  await client.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
  await client.query(`ALTER ROLE ${role} SET statement_timeout = '${DEMO_STATEMENT_TIMEOUT}'`);
  return name;
}
