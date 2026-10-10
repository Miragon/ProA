/**
 * Migrations 0009/0010 (owner decision 19) on a database that already holds
 * data from before them, as the owner's stack and the run projects do: the
 * new unique constraints, foreign keys and checks apply to existing rows,
 * which keep their content, and a marked acceptance can follow.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';

import { createDatabase, type Database } from '../../src/db/client.ts';
import { MIGRATIONS_DIR, runMigrations } from '../../src/db/migrate.ts';

const P = 'prj_01J9Z3N4X5Q6R7S8T9V0W1X2M1';
const OWNER = 'prn_01J9Z3N4X5Q6R7S8T9V0W1X2M1';
const AGENT = 'prn_01J9Z3N4X5Q6R7S8T9V0W1X2M2';

let name: string;
let database: Database;
let before: string;

async function admin(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: inject('adminDatabaseUrl') });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  name = `proa_mig_${randomBytes(6).toString('hex')}`;
  await admin(`CREATE DATABASE "${name}"`);
  const url = new URL(inject('adminDatabaseUrl'));
  url.pathname = `/${name}`;
  database = createDatabase(url.toString(), { max: 2 });

  // The migrations up to 0008, as a database from before owner decision 19 has them.
  before = await mkdtemp(join(tmpdir(), 'proa-mig-'));
  await cp(MIGRATIONS_DIR, before, { recursive: true });
  const journalPath = join(before, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter(
    (e) => !e.tag.startsWith('0009') && !e.tag.startsWith('0010'),
  );
  await writeFile(journalPath, JSON.stringify(journal));
  await migrate(database.db, { migrationsFolder: before });

  await database.db.execute(
    sql.raw(`
      INSERT INTO project (id, key, name) VALUES ('${P}', 'mig', 'Migration');
      INSERT INTO principal (id, kind, iss, subject, handle) VALUES
        ('${OWNER}', 'user', 'urn:proa:local', 'owner', 'owner'),
        ('${AGENT}', 'service', 'urn:proa:agent-token', 'agt_x', 'agent:x');
      INSERT INTO membership (project_id, principal_id, role) VALUES ('${P}', '${OWNER}', 'owner');
      INSERT INTO relation (id, project_id, type, from_ref, to_ref, status, endpoint_state, tier, attrs)
        VALUES ('rel_m1', '${P}', 'message', 'a/x#E', 'b/y#S', 'accepted', 'ok', 'key', '{}');
      INSERT INTO relation_assertion (id, project_id, relation_id, seq, kind, verdict, source_kind, principal_id, tier, confidence)
        VALUES ('asr_m1', '${P}', 'rel_m1', 1, 'proposal', NULL, 'agent', '${AGENT}', 'key', 0.95),
               ('asr_m2', '${P}', 'rel_m1', 2, 'decision', 'accept', 'human', '${OWNER}', NULL, NULL);
      INSERT INTO value_chain (id, project_id, key, name) VALUES ('vch_m1', '${P}', 'main', 'Kette');
      INSERT INTO value_chain_revision (id, project_id, value_chain_id, rev, content, content_hash, structure_hash, schema_version, principal_id, source_kind, seq)
        VALUES ('vcr_m1', '${P}', 'vch_m1', 1, '\\x7b7d', 'h', 's', 1, '${OWNER}', 'human', 3);
      INSERT INTO value_chain_step (project_id, value_chain_id, element_id, generation, created_rev)
        VALUES ('${P}', 'vch_m1', 'step-a', 1, 1);
      INSERT INTO placement (id, project_id, value_chain_id, element_id, generation, process_ref, status, endpoint_state, tier)
        VALUES ('plc_m1', '${P}', 'vch_m1', 'step-a', 1, 'a/x#P', 'proposed', 'ok', 'lexical');
      INSERT INTO placement_assertion (id, project_id, placement_id, seq, kind, source_kind, principal_id, tier, confidence)
        VALUES ('pas_m1', '${P}', 'plc_m1', 4, 'proposal', 'agent', '${AGENT}', 'lexical', 0.95);
    `),
  );
});

afterAll(async () => {
  await database.close();
  await admin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await rm(before, { recursive: true, force: true });
});

describe('migrations 0009 and 0010 on existing data', () => {
  it('apply, and leave the rows as they were', async () => {
    const rows = async () =>
      (
        await database.db.execute(
          sql.raw(
            `SELECT (SELECT count(*) FROM relation_assertion) AS r, (SELECT count(*) FROM placement_assertion) AS p`,
          ),
        )
      ).rows[0];
    const counted = await rows();
    await runMigrations(database.db);
    expect(await rows()).toEqual(counted);
    const marked = await database.db.execute(
      sql.raw(
        `SELECT count(*) AS n FROM relation_assertion WHERE auto_accept_rule_id IS NOT NULL OR auto_accept_trigger_id IS NOT NULL`,
      ),
    );
    expect(Number(marked.rows[0]?.['n'])).toBe(0);
  });

  it('takes a rule and a marked acceptance on an existing relation and placement', async () => {
    await database.db.execute(
      sql.raw(`
        INSERT INTO auto_accept_rule (id, project_id, kind, created_by, seq)
          VALUES ('aar_m1', '${P}', 'relation', '${OWNER}', 5), ('aar_m2', '${P}', 'placement', '${OWNER}', 6);
        INSERT INTO auto_accept_rule_revision (project_id, rule_id, kind, revision, name, enabled, tier, min_confidence, principal_id, source_kind, seq)
          VALUES ('${P}', 'aar_m1', 'relation', 1, 'R', true, 'key', 0.9, '${OWNER}', 'human', 5),
                 ('${P}', 'aar_m2', 'placement', 1, 'P', true, 'lexical', 0.9, '${OWNER}', 'human', 6);
        INSERT INTO relation_assertion (id, project_id, relation_id, seq, kind, verdict, source_kind, principal_id,
                                        auto_accept_rule_id, auto_accept_rule_revision, auto_accept_trigger_id)
          VALUES ('asr_m3', '${P}', 'rel_m1', 7, 'decision', 'accept', 'human', '${OWNER}', 'aar_m1', 1, 'asr_m1');
        INSERT INTO placement_assertion (id, project_id, placement_id, seq, kind, verdict, source_kind, principal_id,
                                         auto_accept_rule_id, auto_accept_rule_revision, auto_accept_trigger_id)
          VALUES ('pas_m2', '${P}', 'plc_m1', 8, 'decision', 'accept', 'human', '${OWNER}', 'aar_m2', 1, 'pas_m1');
      `),
    );
    await expect(
      database.db.execute(sql.raw(`UPDATE auto_accept_rule_revision SET enabled = false`)),
    ).rejects.toThrow();
  });
});
