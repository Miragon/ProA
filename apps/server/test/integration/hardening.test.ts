/**
 * Hostile input and edge cases through the whole server, with the real
 * libraries and PostgreSQL: control characters in BPMN attributes, an event
 * with a message and a signal definition, rule-tier name matching in
 * which_processes_use, inert revision content, and malformed MCP/REST
 * input that must never surface a database error.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ModelPage, PutModelResult, Relation, RevisionFacts } from '@proa/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { libraryAnalysis } from '../../src/analysis.ts';
import { API_CSP } from '../../src/http/security-headers.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { listen } from '../support/http.ts';

let database: TestDatabase;
let t: TestApp;
let server: { url: string; close: () => Promise<void> };
let token: string;
const clients: Client[] = [];

const C7 =
  'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:camunda="http://camunda.org/schema/1.0/bpmn" ' +
  'xmlns:modeler="http://camunda.org/schema/modeler/1.0" modeler:executionPlatform="Camunda Platform"';

function definitions(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<bpmn:definitions ${C7} id="D" targetNamespace="x">\n${body}\n</bpmn:definitions>\n`;
}

/** A throw event with a message and a signal definition (eventDef `multiple`). */
function thrower(messageName: string, signalName: string): string {
  return definitions(`
  <bpmn:process id="Process_Thrower" name="Werfer" isExecutable="true">
    <bpmn:intermediateThrowEvent id="Throw_Both" name="Zahlung und Storno melden">
      <bpmn:messageEventDefinition messageRef="Message_1" />
      <bpmn:signalEventDefinition signalRef="Signal_1" />
    </bpmn:intermediateThrowEvent>
  </bpmn:process>
  <bpmn:message id="Message_1" name="${messageName}" />
  <bpmn:signal id="Signal_1" name="${signalName}" />`);
}

const catcher = definitions(`
  <bpmn:process id="Process_Catcher" name="Fänger" isExecutable="true">
    <bpmn:intermediateCatchEvent id="Catch_Message" name="Zahlung eingegangen">
      <bpmn:messageEventDefinition messageRef="Message_1" />
    </bpmn:intermediateCatchEvent>
    <bpmn:intermediateCatchEvent id="Catch_Signal" name="Storno">
      <bpmn:signalEventDefinition signalRef="Signal_1" />
    </bpmn:intermediateCatchEvent>
  </bpmn:process>
  <bpmn:message id="Message_1" name="Zahlung_Eingegangen" />
  <bpmn:signal id="Signal_1" name="Storno" />`);

/** NUL, a right-to-left override and SOH in every free-text call attribute. */
const JUNK = '&#0;&#x202E;&#1;';
const junkCaller = definitions(`
  <bpmn:process id="Process_Junk" name="Junk${JUNK}" isExecutable="true">
    <bpmn:callActivity id="Call_Junk" name="Aufruf${JUNK}" calledElement="Process_Catcher${JUNK}"
      camunda:calledElementBinding="version${JUNK}" camunda:calledElementVersion="1${JUNK}2"
      camunda:calledElementTenantId="t${JUNK}x" />
  </bpmn:process>`);

async function put(key: string, xml: string): Promise<PutModelResult> {
  const res = await t.putModel('hard', key, xml);
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return (await res.json()) as PutModelResult;
}

async function facts(result: PutModelResult): Promise<RevisionFacts> {
  const res = await t.asOwner(
    `/api/v1/projects/hard/models/${result.model.id}/revisions/${result.revision.id}/facts`,
  );
  return (await res.json()) as RevisionFacts;
}

async function relationRow(type: string, from: string, to: string) {
  const rows = await database.db.execute<{ id: string; from_fp: string; status: string }>(
    sql`SELECT id, from_fp, status FROM relation WHERE type = ${type} AND from_ref = ${from} AND to_ref = ${to}`,
  );
  const row = rows.rows[0];
  if (!row) throw new Error(`no ${type} relation ${from} → ${to}`);
  return row;
}

async function proposedEvents(relationId: string): Promise<number> {
  const rows = await database.db.execute<{ n: string }>(
    sql`SELECT count(*) AS n FROM event WHERE type = 'relation.proposed' AND subject_ref = ${relationId}`,
  );
  return Number(rows.rows[0]?.n);
}

async function connect(): Promise<Client> {
  const client = new Client({ name: 'proa-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
}

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database, { analysis: libraryAnalysis });
  await t.createProject('hard');
  token = (await t.createToken('hard', ['proa:read'])).secret;
  server = await listen(t.app.fetch);
});

afterAll(async () => {
  for (const c of clients) await c.close();
  await server.close();
  await database.drop();
});

describe('control characters in BPMN attributes', () => {
  it('stores the model with sanitized attrs instead of failing the whole ingest', async () => {
    const result = await put('hard/junk', junkCaller);
    expect(result.outcome).toBe('created');
    const call = (await facts(result)).facts.find((f) => f.kind === 'call');
    expect(call).toMatchObject({
      label: 'Aufruf',
      keyRaw: 'Process_Catcher',
      attrs: { binding: 'version', version: '12', tenantId: 'tx' },
    });
    expect(JSON.stringify(await facts(result))).not.toMatch(/\\u0000|\\u0001|‮/);
  });

  it('keeps the other files of an import when one of them carries control characters', async () => {
    const form = new FormData();
    form.append('files', new Blob([junkCaller.replaceAll('Junk', 'Junk2')]), 'hard/junk-two.bpmn');
    form.append('files', new Blob([catcher]), 'hard/catcher-copy.bpmn');
    const res = await t.asOwner('/api/v1/projects/hard/imports', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { modelKey: string; outcome: string }[] };
    expect(body.files.map((f) => [f.modelKey, f.outcome])).toEqual([
      ['hard/junk-two', 'created'],
      ['hard/catcher-copy', 'created'],
    ]);
    // Clean up: the copy would add a second catcher to the cases below.
    const models = (await (await t.asOwner('/api/v1/projects/hard/models')).json()) as ModelPage;
    for (const key of ['hard/junk-two', 'hard/catcher-copy']) {
      const id = models.items.find((m) => m.key === key)?.id;
      expect(
        (await t.asOwner(`/api/v1/projects/hard/models/${id}`, { method: 'DELETE' })).status,
      ).toBe(204);
    }
  });
});

describe('an event with a message and a signal definition', () => {
  let msgFp: string;
  let messageId: string;

  it('anchors the message relation to the msg_throw fact, the signal relation to the sig_throw fact', async () => {
    const created = await put('hard/thrower', thrower('ZahlungEingegangen', 'Storno'));
    await put('hard/catcher', catcher);
    const fs = (await facts(created)).facts.filter((f) => f.elementId === 'Throw_Both');
    expect(fs.map((f) => f.kind)).toEqual(['msg_throw', 'sig_throw']);
    const [msg, sig] = fs;
    msgFp = msg?.fingerprint ?? '';
    expect(msgFp).not.toBe(sig?.fingerprint);

    const message = await relationRow(
      'message',
      'hard/thrower#Throw_Both',
      'hard/catcher#Catch_Message',
    );
    const signal = await relationRow(
      'signal',
      'hard/thrower#Throw_Both',
      'hard/catcher#Catch_Signal',
    );
    expect(message.from_fp).toBe(msgFp);
    expect(signal.from_fp).toBe(sig?.fingerprint);
    messageId = message.id;
    expect(await proposedEvents(messageId)).toBe(1);
  });

  it('leaves the message relation alone when only the signal name changes', async () => {
    const revised = await put('hard/thrower', thrower('ZahlungEingegangen', 'Storno neu'));
    expect(revised.outcome).toBe('revised');
    const message = await relationRow(
      'message',
      'hard/thrower#Throw_Both',
      'hard/catcher#Catch_Message',
    );
    expect(message.from_fp).toBe(msgFp);
    expect(message.status).toBe('proposed');
    expect(await proposedEvents(messageId)).toBe(1);
    const signal = await relationRow(
      'signal',
      'hard/thrower#Throw_Both',
      'hard/catcher#Catch_Signal',
    );
    expect(signal.status).toBe('obsolete');
    const rel = (await (
      await t.asOwner(`/api/v1/projects/hard/relations/${messageId}`)
    ).json()) as Relation;
    expect(rel.endpointState).toBe('ok');
  });

  it('re-anchors the message relation when the message name changes', async () => {
    await put('hard/thrower', thrower('Zahlung-Eingegangen', 'Storno neu'));
    const message = await relationRow(
      'message',
      'hard/thrower#Throw_Both',
      'hard/catcher#Catch_Message',
    );
    expect(message.from_fp).not.toBe(msgFp);
    expect(await proposedEvents(messageId)).toBe(2);
  });
});

describe('MCP which_processes_use', () => {
  it('matches message names like the rule tier (separators ignored)', async () => {
    const client = await connect();
    for (const name of ['ZahlungEingegangen', 'Zahlung_Eingegangen', 'zahlung eingegangen']) {
      const result = await client.callTool({
        name: 'which_processes_use',
        arguments: { projectId: 'hard', kind: 'message', name },
      });
      const uses = (result.structuredContent as { uses: { role: string; ref: string }[] }).uses;
      expect(
        uses.map((u) => [u.role, u.ref]),
        name,
      ).toEqual([
        ['catches', 'hard/catcher#Catch_Message'],
        ['throws', 'hard/thrower#Throw_Both'],
      ]);
    }
    // The rule tier proposed exactly this pair.
    await relationRow('message', 'hard/thrower#Throw_Both', 'hard/catcher#Catch_Message');
  });

  it('matches nothing for a name without letters or digits, and survives NUL', async () => {
    const client = await connect();
    for (const [kind, name] of [
      ['message', '!!!'],
      ['call', 'a\u0000'],
      ['data_store', '\u0000'],
    ] as const) {
      const result = await client.callTool({
        name: 'which_processes_use',
        arguments: { projectId: 'hard', kind, name },
      });
      expect(result.isError, `${kind} ${JSON.stringify(name)}`).not.toBe(true);
      expect((result.structuredContent as { uses: unknown[] }).uses).toEqual([]);
    }
  });
});

describe('malformed input never surfaces a database error', () => {
  it('MCP rejects a project id with control characters before any query', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'list_processes',
      arguments: { projectId: '\u0000' },
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).not.toMatch(/Failed query|select|params/i);
  });

  it('MCP answers an unexpected error with an internal problem, logged, without its message', async () => {
    const failing = vi
      .spyOn(t.useCases, 'listProcesses')
      .mockRejectedValue(new Error('Failed query: select "id" from "project"\nparams: secret'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const client = await connect();
      const result = await client.callTool({
        name: 'list_processes',
        arguments: { projectId: 'hard' },
      });
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain('urn:proa:problem:internal');
      expect(text).not.toMatch(/Failed query|secret/);
      expect(errors).toHaveBeenCalled();
    } finally {
      failing.mockRestore();
      errors.mockRestore();
    }
  });

  it('REST answers 422 for a project ref or cursor with NUL, and for control characters in names', async () => {
    for (const path of [
      '/api/v1/projects/%00/models',
      `/api/v1/projects?cursor=${Buffer.from(JSON.stringify(['\u0000'])).toString('base64url')}`,
      `/api/v1/projects/hard/models?cursor=${Buffer.from(JSON.stringify(['\u0000'])).toString('base64url')}`,
    ]) {
      const res = await t.asOwner(path);
      expect(res.status, path).toBe(422);
      expect(await res.json()).toMatchObject({ code: 'validation-failed' });
    }
    const res = await t.asOwner('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'nul', name: 'a\u0000b' }),
    });
    expect(res.status).toBe(422);
  });
});

describe('revision content', () => {
  it('is a sandboxed download, never a page on the ProA origin', async () => {
    const result = await put(
      'hard/xss',
      definitions(`
  <bpmn:process id="Process_Xss" isExecutable="true">
    <bpmn:extensionElements><h:script xmlns:h="http://www.w3.org/1999/xhtml">fetch('/api/v1/session', { method: 'POST' })</h:script></bpmn:extensionElements>
  </bpmn:process>`),
    );
    const res = await t.asOwner(
      `/api/v1/projects/hard/models/${result.model.id}/revisions/${result.revision.id}/content`,
    );
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'application/xml',
      'content-disposition': `attachment; filename="hard-xss.${result.revision.id}.bpmn"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': API_CSP,
      'cross-origin-resource-policy': 'same-origin',
    });
    // Verbatim bytes: the script is stored, but inert.
    expect(await res.text()).toContain('<h:script');
  });
});
