import { describe, expect, it } from 'vitest';

import {
  ApiProblem,
  Candidate,
  CreateAgentTokenBody,
  CreateProjectBody,
  Fact,
  FactKind,
  FindingKind,
  ModelKey,
  OWNER_KEY_PATTERN,
  PROBLEMS,
  ProjectId,
  ProjectRef,
  Ref,
  RelationStatus,
  RelationType,
  Tier,
  apiRoutes,
  buildOpenApiDocument,
  createProblem,
  defaultOwnerKeyFile,
  formatRef,
  isElementId,
  isTypedId,
  newId,
  parseRef,
  problemType,
} from '../src/index.ts';

describe('refs', () => {
  it('formats and parses refs', () => {
    const ref = formatRef('finanzen/rechnungsstellung', 'Event_RechnungVersendet');
    expect(ref).toBe('finanzen/rechnungsstellung#Event_RechnungVersendet');
    expect(parseRef(ref)).toEqual({
      modelKey: 'finanzen/rechnungsstellung',
      elementId: 'Event_RechnungVersendet',
    });
  });

  it('accepts NCName element ids with dots and non-ASCII letters', () => {
    expect(Ref.safeParse('a/b#Activity_1.x').success).toBe(true);
    expect(Ref.safeParse('a#Prüfung_1').success).toBe(true);
  });

  it('rejects malformed refs and keys', () => {
    for (const bad of ['', 'a', 'A/b#x', 'a/b#', '#x', 'a/b#1x', 'a//b#x', 'a/b#x#y', 'a b#x']) {
      expect(Ref.safeParse(bad).success, bad).toBe(false);
    }
    expect(() => parseRef('nope')).toThrow(TypeError);
    expect(() => formatRef('Bad/Key', 'x')).toThrow(TypeError);
    expect(ModelKey.safeParse('vertrieb/auftragsabwicklung').success).toBe(true);
    expect(ModelKey.safeParse('vertrieb/').success).toBe(false);
  });
});

describe('ids', () => {
  it('creates sortable typed ULIDs', () => {
    const a = newId('project', 1_000);
    const b = newId('project', 2_000);
    expect(a).toMatch(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(isTypedId('prj', a)).toBe(true);
    expect(isTypedId('mdl', a)).toBe(false);
    expect(ProjectId.safeParse(a).success).toBe(true);
    expect(newId('model').startsWith('mdl_')).toBe(true);
  });

  it('rejects timestamps outside the ULID range', () => {
    expect(() => newId('model', -1)).toThrow(RangeError);
    expect(() => newId('model', 2 ** 48)).toThrow(RangeError);
  });
});

describe('enums', () => {
  it('match CONCEPT §2', () => {
    expect(FactKind.options).toEqual([
      'process',
      'call',
      'msg_throw',
      'msg_catch',
      'sig_throw',
      'sig_catch',
      'evt_start',
      'evt_end',
      'data_store',
      'message_flow',
      'lane',
      'task',
    ]);
    expect(RelationType.options).toEqual(['call', 'message', 'signal', 'trigger', 'manual']);
    expect(Tier.options).toEqual(['key', 'lexical', 'semantic', 'manual', 'rule']);
    expect(RelationStatus.options).toEqual([
      'proposed',
      'accepted',
      'rejected',
      'held',
      'obsolete',
    ]);
    expect(FindingKind.options).toEqual([
      'unresolved-call',
      'dynamic-call',
      'duplicate-process-id',
      'dangling-throw',
      'unmatched-catch',
    ]);
  });
});

describe('schemas', () => {
  it('parses a fact', () => {
    const fact = Fact.parse({
      modelKey: 'vertrieb/auftragsabwicklung',
      ref: 'vertrieb/auftragsabwicklung#Event_WareVersandbereit',
      kind: 'msg_throw',
      elementId: 'Event_WareVersandbereit',
      processId: 'Process_Auftragsabwicklung',
      scope: 'process',
      eventDef: 'message',
      label: 'Ware versandbereit',
      keyRaw: 'WareVersandbereit',
      keyNorm: 'wareversandbereit',
      fingerprint: '0123456789ab',
      attrs: { elementType: 'bpmn:IntermediateThrowEvent', custom: 1 },
    });
    expect(fact.attrs).toMatchObject({ custom: 1 });
  });

  it('rejects manual candidates and scores outside [0, 1]', () => {
    const base = { from: 'a#x', to: 'b#y', basis: 'lexical', signals: {} };
    expect(Candidate.safeParse({ ...base, type: 'message', score: 0.5 }).success).toBe(true);
    expect(Candidate.safeParse({ ...base, type: 'manual', score: 0.5 }).success).toBe(false);
    expect(Candidate.safeParse({ ...base, type: 'message', score: 1.5 }).success).toBe(false);
  });

  it('applies agent token defaults and never allows proa:review', () => {
    expect(CreateAgentTokenBody.parse({ name: 'claude' })).toEqual({
      name: 'claude',
      scopes: ['proa:read', 'proa:propose'],
      expiresInDays: 90,
    });
    expect(CreateAgentTokenBody.safeParse({ name: 'x', scopes: ['proa:review'] }).success).toBe(
      false,
    );
    expect(CreateAgentTokenBody.safeParse({ name: 'x', expiresInDays: 366 }).success).toBe(false);
  });
});

describe('problems', () => {
  it('builds RFC 9457 problems', () => {
    const p = createProblem('not-found', 'no such model', { status: 200, reviewUrl: 'x' });
    expect(p).toEqual({
      type: 'urn:proa:problem:not-found',
      title: 'Not found',
      status: 404,
      code: 'not-found',
      detail: 'no such model',
      reviewUrl: 'x',
    });
    expect(ApiProblem.safeParse(p).success).toBe(true);
    expect(problemType('lease-lost')).toBe('urn:proa:problem:lease-lost');
    expect(PROBLEMS['human-decision-required'].status).toBe(403);
  });
});

describe('openapi', () => {
  const doc = buildOpenApiDocument({ version: '1.2.3', serverUrl: 'http://127.0.0.1:7400' });

  it('is an OpenAPI 3.1 document with every route', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe('1.2.3');
    expect(doc.servers).toEqual([{ url: 'http://127.0.0.1:7400' }]);
    const operationIds = Object.values(doc.paths ?? {}).flatMap((item) =>
      ['get', 'put', 'post', 'delete', 'patch']
        .map((m) => (item as Record<string, { operationId?: string } | undefined>)[m]?.operationId)
        .filter((id): id is string => id !== undefined),
    );
    expect(operationIds.sort()).toEqual(Object.keys(apiRoutes).sort());
    expect(doc.paths?.['/api/v1/projects/{project}/models/by-key/{key}']?.put).toBeDefined();
  });

  it('names the shared schemas as components', () => {
    const schemas = Object.keys(doc.components?.schemas ?? {});
    for (const name of [
      'Project',
      'Model',
      'ModelStage',
      'Relation',
      'Fact',
      'Candidate',
      'ApiProblem',
      'Ref',
    ]) {
      expect(schemas, name).toContain(name);
    }
  });

  it('is deterministic', () => {
    expect(
      JSON.stringify(
        buildOpenApiDocument({ version: '1.2.3', serverUrl: 'http://127.0.0.1:7400' }),
      ),
    ).toBe(JSON.stringify(doc));
  });
});

describe('openapi problem responses', () => {
  const doc = buildOpenApiDocument();
  type Operation = {
    parameters?: unknown[];
    requestBody?: unknown;
    responses?: Record<string, unknown>;
  };
  const operations: Array<[string, Operation]> = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of ['get', 'put', 'post', 'delete', 'patch'] as const) {
      const op = (item as Partial<Record<string, Operation>>)[method];
      if (op) operations.push([`${method.toUpperCase()} ${path}`, op]);
    }
  }

  it('declares 422 on every route with params, query or a body (the server validates them)', () => {
    const missing = operations
      .filter(([, op]) => (op.parameters?.length ?? 0) > 0 || op.requestBody !== undefined)
      .filter(([, op]) => op.responses?.['422'] === undefined)
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('declares 415 where the server checks the media type of the body', () => {
    for (const name of ['putModelByKey', 'importModels', 'createSession'] as const) {
      expect(Object.keys(apiRoutes[name].responses), name).toContain('415');
    }
  });

  it('declares 403 insufficient-scope on listProjects (a token without proa:read)', () => {
    expect(Object.keys(apiRoutes.listProjects.responses)).toEqual(['200', '401', '403', '422']);
  });
});

describe('input validation', () => {
  it('takes a project id or key as project ref, nothing else', () => {
    for (const ok of ['nordwind-handel', 'a', 'prj_01J9Z3N4X5Q6R7S8T9V0W1X2Y3']) {
      expect(ProjectRef.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['', '\u0000', 'Nordwind', 'a b', 'a/b', '../x', 'prj_x', 'x'.repeat(65)]) {
      expect(ProjectRef.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects control characters in names people type', () => {
    expect(CreateProjectBody.safeParse({ key: 'a', name: 'Nord\u0000wind' }).success).toBe(false);
    expect(CreateProjectBody.safeParse({ key: 'a', name: 'Nordwind Handel' }).success).toBe(true);
    expect(CreateAgentTokenBody.safeParse({ name: 'claude\n' }).success).toBe(false);
  });

  it('checks element ids like formatRef', () => {
    expect(isElementId('Event_1')).toBe(true);
    expect(isElementId('Ereignis_Zahlung_ü')).toBe(true);
    expect(isElementId('1abc')).toBe(false);
    expect(isElementId('a\u0000b')).toBe(false);
    expect(isElementId('a'.repeat(256))).toBe(false);
  });
});

describe('openapi nullability', () => {
  const doc = buildOpenApiDocument();
  const schemas = (doc.components?.schemas ?? {}) as Record<
    string,
    { properties?: Record<string, unknown> }
  >;

  it('keeps null on nullable references (anyOf with type null)', () => {
    const nullRef = (schema: string, prop: string) => schemas[schema]?.properties?.[prop];
    for (const [schema, prop] of [
      ['Fact', 'processId'],
      ['Fact', 'eventDef'],
      ['AgentToken', 'revokedAt'],
      ['ModelPage', 'nextCursor'],
      ['ImportFileOutcome', 'problem'],
    ] as const) {
      expect(nullRef(schema, prop), `${schema}.${prop}`).toMatchObject({
        anyOf: expect.arrayContaining([{ type: 'null' }]) as unknown,
      });
    }
  });

  it('never emits allOf (the lossy form of .nullable() on named schemas)', () => {
    expect(JSON.stringify(doc)).not.toContain('"allOf"');
  });
});

describe('local owner key', () => {
  it('has a recognizable shape', () => {
    expect(OWNER_KEY_PATTERN.test(`proa_ok_${'A'.repeat(42)}-`)).toBe(true);
    expect(OWNER_KEY_PATTERN.test(`proa_ok_${'A'.repeat(42)}`)).toBe(false);
    expect(OWNER_KEY_PATTERN.test(`proa_at_${'A'.repeat(43)}`)).toBe(false);
  });

  it('defaults to the XDG state directory', () => {
    expect(defaultOwnerKeyFile({}, '/home/ada')).toBe('/home/ada/.local/state/proa/owner-key');
    expect(defaultOwnerKeyFile({ XDG_STATE_HOME: '/var/state/' }, '/home/ada')).toBe(
      '/var/state/proa/owner-key',
    );
    // Relative or empty XDG paths are invalid and ignored (XDG base directory spec).
    expect(defaultOwnerKeyFile({ XDG_STATE_HOME: 'state' }, '/home/ada/')).toBe(
      '/home/ada/.local/state/proa/owner-key',
    );
    expect(defaultOwnerKeyFile({ XDG_STATE_HOME: '' }, '/home/ada')).toBe(
      '/home/ada/.local/state/proa/owner-key',
    );
  });
});
