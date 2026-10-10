import { describe, expect, it } from 'vitest';

import {
  ApiProblem,
  BulkDecisionBody,
  BulkPlacementDecisionBody,
  CreateValueChainBody,
  PLACEMENT_INVALID_REASONS,
  PlacementDecisionBody,
  PlacementItem,
  PlacementOutcome,
  PlacementTier,
  PostPlacementsBody,
  VALUE_CHAIN_FINDING_KINDS,
  VALUE_CHAIN_VIOLATIONS,
  ValueChainFinding,
  ValueChainFindingKind,
  ValueChainViolation,
  hasBidiCharacters,
  valueChainPath,
  Candidate,
  ClaimInput,
  DecisionBody,
  INVALID_REASONS,
  MAX_SUBMISSION_RELATIONS,
  MAX_UNCOVERED_PAIRS,
  NO_LINK_INVALID_REASONS,
  NoLinkId,
  NoLinkItem,
  PlacementAssertionId,
  PlacementId,
  ValueChainId,
  ValueChainRevisionId,
  NoLinkOutcome,
  NoteBody,
  Relation,
  SubmissionResult,
  ReleaseAnalysisBody,
  hasControlCharacters,
  ProposalOutcome,
  RequeueBody,
  SubmitAnalysisBody,
  reviewPath,
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
  RECORDING_FORMAT,
  RecordingLine,
  isPlacementLine,
  AnalysisKind,
  AnalysisSubmissionResult,
  ClaimAnalysisBody,
  ClaimedAnalysis,
  LEASE_TOKEN_PREFIX,
  MAX_CLAIM_PLACEMENT_PROCESSES,
  MAX_UNSURE_ITEMS,
  PIPELINE_PLACEMENT_INVALID_REASONS,
  PendingQuery,
  PlacementRecordingLine,
  UNSURE_INVALID_REASONS,
  UnsureOutcome,
  recordingPath,
  recordingSegment,
  DEMO_SAFE_METHODS,
  DEMO_WRITE_EXEMPT_OPERATIONS,
  Health,
  MAX_DEMO_LINK_LENGTH,
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
    expect(NoLinkId.safeParse(newId('noLink')).success).toBe(true);
  });

  it('types the value chain ids (M4)', () => {
    expect(ValueChainId.safeParse(newId('valueChain')).success).toBe(true);
    expect(ValueChainRevisionId.safeParse(newId('valueChainRevision')).success).toBe(true);
    expect(PlacementId.safeParse(newId('placement')).success).toBe(true);
    expect(PlacementAssertionId.safeParse(newId('placementAssertion')).success).toBe(true);
    // Placement assertions are not relation assertions (`asr_`).
    expect(PlacementAssertionId.safeParse(newId('assertion')).success).toBe(false);
    expect(PlacementId.safeParse(newId('valueChain')).success).toBe(false);
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

describe('read-only demo (issue #3)', () => {
  const routes = Object.values(apiRoutes);
  const descriptionOf403 = (route: (typeof routes)[number]): string | undefined =>
    (route.responses as Record<string, { description: string } | undefined>)['403']?.description;

  it('has the problem code demo-readonly (403)', () => {
    expect(PROBLEMS['demo-readonly']).toEqual({ status: 403, title: 'Read-only demo' });
    expect(createProblem('demo-readonly').type).toBe('urn:proa:problem:demo-readonly');
  });

  it('documents demo-readonly on every write route except the session routes', () => {
    const exempt: readonly string[] = DEMO_WRITE_EXEMPT_OPERATIONS;
    const safe: readonly string[] = DEMO_SAFE_METHODS;
    const writes = routes.filter((r) => !safe.includes(r.method));
    expect(writes.length).toBeGreaterThan(20);
    for (const route of writes) {
      const documented = descriptionOf403(route)?.includes('`demo-readonly`') === true;
      expect(documented, route.operationId).toBe(!exempt.includes(route.operationId));
    }
    expect(exempt.every((id) => routes.some((r) => r.operationId === id))).toBe(true);
  });

  it('documents it on no read route and keeps the other problems of a merged 403', () => {
    for (const route of routes.filter((r) => r.method === 'get')) {
      expect(descriptionOf403(route) ?? '', route.operationId).not.toContain('demo-readonly');
    }
    expect(descriptionOf403(apiRoutes.decideRelation)).toBe(
      'Problem: `insufficient-scope`, `human-decision-required`, `forbidden`, `demo-readonly`',
    );
    // The responses keep their status order.
    expect(Object.keys(apiRoutes.createProject.responses)).toEqual([
      '201',
      '401',
      '403',
      '409',
      '422',
    ]);
  });

  it('reports the demo in Health only when it is one', () => {
    const local = { status: 'ok', version: '1', db: 'ok' };
    expect(Health.parse(local)).toEqual(local);
    expect(Health.parse({ ...local, demo: 'readonly' }).demo).toBe('readonly');
    expect(Health.safeParse({ ...local, demo: 'writable' }).success).toBe(false);
  });

  it('carries the demo operator’s legal links as absolute https URLs only', () => {
    const demo = { status: 'ok', version: '1', db: 'ok', demo: 'readonly' } as const;
    const links = {
      imprintUrl: 'https://example.org/impressum',
      privacyUrl: 'https://example.org/datenschutz/',
    };
    expect(Health.parse({ ...demo, ...links })).toEqual({ ...demo, ...links });
    expect(Health.parse({ ...demo, imprintUrl: links.imprintUrl })).toEqual({
      ...demo,
      imprintUrl: links.imprintUrl,
    });
    for (const bad of [
      'http://example.org/impressum',
      'javascript:alert(1)',
      '/impressum',
      '',
      `https://example.org/${'x'.repeat(MAX_DEMO_LINK_LENGTH)}`,
    ]) {
      expect(Health.safeParse({ ...demo, imprintUrl: bad }).success, bad).toBe(false);
      expect(Health.safeParse({ ...demo, privacyUrl: bad }).success, bad).toBe(false);
    }
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

describe('pipeline and review contracts (M2)', () => {
  it('lists every invalid reason as a per-item outcome', () => {
    expect(ProposalOutcome.options).toEqual([
      'applied',
      'duplicate',
      'suppressed',
      'reopened',
      ...INVALID_REASONS.map((r) => `invalid:${r}`),
    ]);
  });

  it('checks a submission’s shape only; the limits are per item', () => {
    const base = {
      leaseToken: 'proa_lt_x',
      submissionId: '6f1e1a4e-4b7a-4c8e-9f5a-1d2c3b4a5f60',
      procedure: { id: 'proa-relations', version: '0.0.1' },
      relations: [
        { type: 'manual', from: 'x', to: 'y', confidence: 7, rationale: 'r'.repeat(5000) },
      ],
    };
    const parsed = SubmitAnalysisBody.parse(base);
    expect(parsed).toMatchObject({ llmModel: null, noLinks: [], summary: null, costUsd: null });
    expect(parsed.relations[0]).toMatchObject({ evidence: [], question: null });
    expect(SubmitAnalysisBody.safeParse({ ...base, submissionId: 'nope' }).success).toBe(false);
    const many = Array.from({ length: MAX_SUBMISSION_RELATIONS + 1 }, () => base.relations[0]);
    expect(SubmitAnalysisBody.safeParse({ ...base, relations: many }).success).toBe(false);
    expect(SubmitAnalysisBody.safeParse({ ...base, summary: 'x'.repeat(501) }).success).toBe(false);
  });

  it('validates decisions by verdict', () => {
    const ok = [
      { verdict: 'accept' },
      { verdict: 'reject', reason: 'falsch' },
      { verdict: 'hold', note: 'klären', question: 'wer?', label: 'Finanzen' },
      { verdict: 'correct', from: 'a/b#X', to: 'c/d#Y', note: 'anders' },
    ];
    for (const body of ok)
      expect(DecisionBody.safeParse(body).success, JSON.stringify(body)).toBe(true);
    const bad = [
      { verdict: 'reject' },
      { verdict: 'reject', reason: '  ' },
      { verdict: 'hold' },
      { verdict: 'correct', from: 'a/b#X', note: 'x' },
      { verdict: 'accept', version: 0 },
      { verdict: 'undecided' },
    ];
    for (const body of bad)
      expect(DecisionBody.safeParse(body).success, JSON.stringify(body)).toBe(false);
  });

  it('needs reasons and notes in bulk decisions, and ids with versions', () => {
    const items = [{ id: 'rel_01J9Z3N4X5Q6R7S8T9V0W1X2Y3', version: 2 }];
    expect(BulkDecisionBody.safeParse({ verdict: 'accept', items, expectedCount: 1 }).success).toBe(
      true,
    );
    expect(BulkDecisionBody.safeParse({ verdict: 'reject', items, expectedCount: 1 }).success).toBe(
      false,
    );
    expect(BulkDecisionBody.safeParse({ verdict: 'hold', items, expectedCount: 1 }).success).toBe(
      false,
    );
    expect(
      BulkDecisionBody.safeParse({ verdict: 'accept', question: 'q', items, expectedCount: 1 })
        .success,
    ).toBe(false);
    expect(
      BulkDecisionBody.safeParse({ verdict: 'accept', items: [], expectedCount: 1 }).success,
    ).toBe(false);
  });

  it('refuses control characters other than tab and line breaks in free text', () => {
    expect(hasControlCharacters('Zeile 1\nZeile 2\tTab\r\n')).toBe(false);
    for (const c of ['\u0000', '\u0007', '\u001b', '\u007f', '\u0085']) {
      expect(hasControlCharacters(`a${c}b`), JSON.stringify(c)).toBe(true);
    }
    const nul = 'a\u0000b';
    for (const body of [
      { verdict: 'reject', reason: nul },
      { verdict: 'hold', note: nul },
      { verdict: 'hold', note: 'ok', label: nul },
      { verdict: 'accept', note: nul },
    ]) {
      expect(DecisionBody.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
    expect(DecisionBody.safeParse({ verdict: 'reject', reason: 'a\nb' }).success).toBe(true);
    const submission = {
      leaseToken: 'proa_lt_x',
      submissionId: '6f1e1a4e-4b7a-4c8e-9f5a-1d2c3b4a5f60',
      procedure: { id: 'proa-relations', version: '0.0.1' },
      relations: [],
    };
    // Items are checked one by one on the server (invalid:control-characters) …
    expect(
      SubmitAnalysisBody.safeParse({
        ...submission,
        relations: [{ type: 'message', from: 'a', to: 'b', confidence: 1, rationale: nul }],
      }).success,
    ).toBe(true);
    // … the declared procedure and model are names.
    expect(SubmitAnalysisBody.safeParse({ ...submission, llmModel: nul }).success).toBe(false);
    expect(
      SubmitAnalysisBody.safeParse({ ...submission, procedure: { id: 'p\n', version: '1' } })
        .success,
    ).toBe(false);
    expect(ReleaseAnalysisBody.safeParse({ leaseToken: 'x', reason: nul }).success).toBe(false);
    expect(NoteBody.safeParse({ text: nul }).success).toBe(false);
  });

  it('requeues either named models or all', () => {
    expect(RequeueBody.safeParse({ all: true }).success).toBe(true);
    expect(RequeueBody.safeParse({ modelKeys: ['a/b'] }).success).toBe(true);
    expect(RequeueBody.safeParse({}).success).toBe(false);
    expect(RequeueBody.safeParse({ all: true, modelKeys: ['a/b'] }).success).toBe(false);
  });

  it('builds review paths', () => {
    expect(reviewPath('nordwind-handel')).toBe('/projects/nordwind-handel/review');
    expect(reviewPath('p', 'rel_1')).toBe('/projects/p/review/rel_1');
  });

  it('documents the pipeline and review routes with their problems', () => {
    const doc = buildOpenApiDocument();
    const submit = doc.paths?.['/api/v1/analyses/{analysis}/submission']?.post;
    expect(Object.keys(submit?.responses ?? {})).toEqual([
      '200',
      '401',
      '403',
      '404',
      '409',
      '413',
      '422',
    ]);
    expect(JSON.stringify(submit?.responses?.['409'])).toMatch(
      /lease-lost.*task-cancelled.*already-submitted/,
    );
    const decision = doc.paths?.['/api/v1/projects/{project}/relations/{relation}/decision']?.post;
    expect(JSON.stringify(decision?.responses?.['403'])).toMatch(/human-decision-required/);
    expect(Object.keys(decision?.responses ?? {})).toContain('412');
    const schemas = doc.components?.schemas ?? {};
    for (const name of [
      'ClaimInput',
      'ClaimCandidate',
      'ClaimJudged',
      'ClaimSkip',
      'NoLinkOutcome',
      'RelationNoLink',
      'SubmissionNoLinks',
      'UncoveredPairs',
      'ClaimPartnerProcess',
      'Finding',
      'Engine',
      'RelationProvenance',
      'RelationAssertion',
    ]) {
      expect(Object.keys(schemas), name).toContain(name);
    }
    expect(
      (schemas as Record<string, { properties?: Record<string, unknown> }>)['Model']?.properties?.[
        'engine'
      ],
    ).toMatchObject({
      anyOf: expect.arrayContaining([{ type: 'null' }]) as unknown,
    });
  });
});

describe('claim input (proa-claim/1)', () => {
  const base = {
    format: 'proa-claim/1',
    model: {
      key: 'a/m',
      name: null,
      revisionId: 'rev_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
      rev: 1,
      engine: null,
      processes: [{ processId: 'P', name: null, participantName: null }],
    },
    facts: [{ ref: 'a/m#E', kind: 'msg_throw', eventDef: 'message', label: 'E', process: 'P' }],
    candidates: [['message', 'a/m#E', 'b/n#C', 'compatible', 0.5]],
    partners: { 'b/n#C': { kind: 'msg_catch', label: 'C', process: 'b/n#Q' } },
    relations: [],
  };

  it('still parses an input without the later additions', () => {
    expect(ClaimInput.parse(base)).toEqual(base);
  });

  it('takes message-flow ends, partner and process documentation, and findings', () => {
    const input = {
      ...base,
      facts: [
        ...base.facts,
        { ref: 'a/m#F', kind: 'message_flow', label: '', from: 'a/m#E', to: 'a/m#Pool' },
      ],
      partners: { 'b/n#C': { ...base.partners['b/n#C'], doc: 'Wartet.' } },
      partnerProcesses: { 'b/n#Q': { name: 'Q', doc: 'Prozess Q.' }, 'c/o#R': {} },
      findings: [{ kind: 'dangling-throw', refs: ['a/m#E'], detail: 'nobody catches E' }],
    };
    expect(ClaimInput.parse(input)).toEqual(input);
    const bad = (extra: object) => ClaimInput.safeParse({ ...base, ...extra }).success;
    expect(bad({ facts: [{ ...base.facts[0], from: 'not a ref' }] })).toBe(false);
    expect(bad({ partnerProcesses: { 'b/n#Q': { name: 1 } } })).toBe(false);
    expect(bad({ findings: [{ kind: 'dangling-throw', refs: [], detail: '' }] })).toBe(false);
  });

  it('takes the current judgements and the skipped pairs (judge each pair once)', () => {
    const input = {
      ...base,
      judged: [
        { relation: 'rel_01J9Z3N4X5Q6R7S8T9V0W1X2Y3', origin: 'b/n', by: 'agent:x', mine: true },
        {
          type: 'message',
          from: 'a/m#E',
          to: 'b/n#C',
          origin: 'a/m',
          by: 'agent:y',
          reason: 'no-evidence: nein',
        },
      ],
      skip: [{ type: 'message', from: 'a/m#E', to: 'c/o#T', model: 'c/o', reason: 'claimed' }],
    };
    expect(ClaimInput.parse(input)).toEqual(input);
    const bad = (extra: object) => ClaimInput.safeParse({ ...base, ...extra }).success;
    expect(bad({ judged: [{ relation: 'rel_x', origin: 'b/n', by: 'agent:x' }] })).toBe(false);
    expect(bad({ judged: [{ ...input.judged[0], mine: false }] })).toBe(false);
    expect(bad({ skip: [{ ...input.skip[0], reason: 'later' }] })).toBe(false);
    expect(bad({ skip: [{ ...input.skip[0], type: 'manual' }] })).toBe(false);
  });
});

describe('no-links and submission results (judge each pair once)', () => {
  it('takes an optional type, checked per item', () => {
    expect(NoLinkItem.parse({ from: 'x', to: 'y' })).toEqual({ from: 'x', to: 'y', reason: '' });
    expect(NoLinkItem.parse({ type: 'manual', from: 'x', to: 'y', reason: 'r' })).toMatchObject({
      type: 'manual',
    });
    expect(NoLinkItem.safeParse({ type: 'x'.repeat(31), from: 'x', to: 'y' }).success).toBe(false);
  });

  it('lists every no-link outcome', () => {
    expect(NoLinkOutcome.options).toEqual([
      'stored',
      'duplicate',
      ...NO_LINK_INVALID_REASONS.map((r) => `invalid:${r}`),
    ]);
  });

  it('parses results stored before no-links were validated, and the new fields', () => {
    const old = {
      taskId: 'ana_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
      submissionId: '6f1e1a4e-4b7a-4c8e-9f5a-1d2c3b4a5f60',
      replayed: true,
      items: [],
      counts: { applied: 0, duplicate: 0, suppressed: 0, reopened: 0, invalid: 0 },
      withdrawn: 0,
    };
    expect(SubmissionResult.parse(old)).toEqual(old);
    const now = {
      ...old,
      noLinks: {
        items: [{ index: 0, result: 'invalid:type-required' }],
        counts: { stored: 0, duplicate: 0, invalid: 1 },
      },
      withdrawnNoLinks: 2,
      uncovered: { count: 1, pairs: [{ type: 'trigger', from: 'a/m#E', to: 'b/n#S' }] },
    };
    expect(SubmissionResult.parse(now)).toEqual(now);
    const pairs = Array.from({ length: MAX_UNCOVERED_PAIRS + 1 }, () => now.uncovered.pairs[0]);
    expect(SubmissionResult.safeParse({ ...now, uncovered: { count: 51, pairs } }).success).toBe(
      false,
    );
  });

  it('gives every relation its live, current no-links', () => {
    const relation = {
      id: 'rel_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
      type: 'message',
      from: 'a/m#E',
      to: 'b/n#C',
      status: 'proposed',
      endpointState: 'ok',
      tier: 'key',
      confidence: 1,
      version: 2,
      attrs: {},
      source: 'rule',
      provenance: null,
      noLinks: [
        {
          id: 'nlk_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
          handle: 'agent:x',
          origin: 'b/n',
          reason: 'near-miss: anderes Ereignis',
          at: '2026-10-08T08:00:00.000Z',
        },
      ],
      updatedAt: '2026-10-08T08:00:00.000Z',
    };
    expect(Relation.parse(relation)).toEqual(relation);
    const { noLinks: _noLinks, ...without } = relation;
    expect(Relation.safeParse(without).success).toBe(false);
  });
});

describe('agent recordings (eval/recordings, CONCEPT §7)', () => {
  const line = {
    format: RECORDING_FORMAT,
    landscape: 'nordwind-handel',
    modelKey: 'finanzen/mahnwesen',
    rev: 1,
    agent: 'agent-sim',
    procedure: { id: 'proa-relations', version: '0.0.1' },
    llmModel: 'sim-policy-1',
    input: {
      format: 'proa-claim/1',
      summary: true,
      facts: 3,
      candidates: 2,
      partners: 2,
      relations: 0,
      bytes: 900,
    },
    submission: {
      relations: [
        {
          type: 'message',
          from: 'finanzen/mahnwesen#Event_A',
          to: 'vertrieb/order#Start_A',
          confidence: 1,
        },
      ],
      noLinks: [],
      summary: null,
      costUsd: 0,
    },
    outcome: 'submitted',
    result: {
      replayed: false,
      counts: { applied: 1, duplicate: 0, suppressed: 0, reopened: 0, invalid: 0 },
      withdrawn: 0,
      items: [{ index: 0, result: 'applied', status: 'proposed' }],
    },
  };

  /** A relations line through the union schema (relations lines have no `kind`). */
  const relationLine = (value: unknown) => {
    const parsed = RecordingLine.parse(value);
    if (isPlacementLine(parsed)) throw new Error('parsed as a placement line');
    return parsed;
  };

  it('parses a recording line, without server ids and with a summarized input', () => {
    const parsed = relationLine(line);
    expect(parsed.task).toBeUndefined();
    expect(parsed.submission.relations[0]).toMatchObject({
      rationale: '',
      evidence: [],
      question: null,
    });
    expect(() => relationLine({ ...line, outcome: 'maybe' })).toThrow();
    expect(() => relationLine({ ...line, landscape: '_sample' })).toThrow();
    expect(() => relationLine({ ...line, input: { ...line.input, summary: false } })).toThrow();
  });

  it('keeps the no-link type and takes the server’s no-link answers', () => {
    const parsed = relationLine({
      ...line,
      submission: {
        ...line.submission,
        noLinks: [{ type: 'message', from: 'a/m#E', to: 'b/n#C', reason: 'x: y' }],
      },
      result: {
        ...line.result,
        noLinks: {
          items: [{ index: 0, result: 'stored' }],
          counts: { stored: 1, duplicate: 0, invalid: 0 },
        },
        withdrawnNoLinks: 0,
        uncovered: { count: 2 },
      },
    });
    expect(parsed.submission.noLinks[0]?.type).toBe('message');
    expect(parsed.result?.noLinks?.counts.stored).toBe(1);
    // A recording keeps the uncovered count, not the pairs.
    expect(parsed.result?.uncovered).toEqual({ count: 2 });
    // Older lines have none of them.
    expect(relationLine(line).result).not.toHaveProperty('noLinks');
  });

  it('parses a line built from a stored submission: no claim input', () => {
    const { input: _input, ...stored } = line;
    const parsed = relationLine(stored);
    expect(parsed.input).toBeUndefined();
    expect(parsed.submission.relations).toHaveLength(1);
    expect(recordingPath(parsed)).toBe(recordingPath(relationLine(line)));
    // Still the same format: an input, if present, must be one.
    expect(() => relationLine({ ...stored, input: null })).toThrow();
  });

  it('lays recordings out as <procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl', () => {
    expect(recordingPath(RecordingLine.parse(line))).toBe(
      'proa-relations@0.0.1/agent-sim/sim-policy-1/nordwind-handel.jsonl',
    );
    expect(recordingSegment('claude code / sonnet')).toBe('claude-code-sonnet');
    expect(recordingSegment('..')).toBe('none');
  });
});

describe('value chain and placement contracts (M4)', () => {
  it('maps the new problem codes to their statuses', () => {
    expect(PROBLEMS['value-chain-invalid'].status).toBe(422);
    expect(PROBLEMS['value-chain-unsupported-version'].status).toBe(422);
    expect(PROBLEMS['revision-conflict'].status).toBe(412);
    expect(PROBLEMS['precondition-required'].status).toBe(428);
    expect(createProblem('revision-conflict', 'stale', { headRev: 3 })).toMatchObject({
      type: 'urn:proa:problem:revision-conflict',
      status: 412,
      headRev: 3,
    });
  });

  it('finds bidirectional formatting characters', () => {
    for (const c of ['\u061C', '\u200E', '\u200F', '\u202A', '\u202E', '\u2066', '\u2069']) {
      expect(hasBidiCharacters(`a${c}b`), c.codePointAt(0)?.toString(16)).toBe(true);
    }
    expect(hasBidiCharacters('Qualitätsprüfung')).toBe(false);
  });

  it('lists every invalid placement reason as an outcome, in check order', () => {
    expect(PlacementOutcome.options).toEqual([
      'applied',
      'duplicate',
      'suppressed',
      'reopened',
      ...PLACEMENT_INVALID_REASONS.map((r) => `invalid:${r}`),
    ]);
    expect(PLACEMENT_INVALID_REASONS[0]).toBe('malformed-step');
    expect(PLACEMENT_INVALID_REASONS.at(-1)).toBe('too-many-steps');
    expect(VALUE_CHAIN_VIOLATIONS.slice(0, 3)).toEqual(['not-json', 'not-an-object', 'schema']);
    expect(
      ValueChainViolation.safeParse({
        reason: 'reserved-id',
        elementId: '@x',
        connectionId: null,
        path: 'elements.0.id',
        detail: 'reserved',
      }).success,
    ).toBe(true);
  });

  it('never gives a placement the rule tier', () => {
    expect(PlacementTier.options).toEqual(['key', 'lexical', 'semantic', 'manual']);
  });

  it('creates a chain from exactly one of name and content', () => {
    const doc = { schemaVersion: 1, meta: { name: 'K' }, elements: [], connections: [] };
    expect(CreateValueChainBody.safeParse({ key: 'main', name: 'Kette' }).success).toBe(true);
    expect(CreateValueChainBody.safeParse({ key: 'main', content: doc }).success).toBe(true);
    expect(CreateValueChainBody.safeParse({ key: 'main', name: 'K', content: doc }).success).toBe(
      false,
    );
    expect(CreateValueChainBody.safeParse({ key: 'main' }).success).toBe(false);
    expect(CreateValueChainBody.safeParse({ key: 'Main', name: 'K' }).success).toBe(false);
    expect(CreateValueChainBody.safeParse({ key: 'main', name: 'a\u0000' }).success).toBe(false);
  });

  it('checks a placement item’s shape only; the limits are per item', () => {
    const parsed = PlacementItem.parse({ step: 'x'.repeat(500), process: 'nope', confidence: 7 });
    expect(parsed).toEqual({
      step: 'x'.repeat(500),
      process: 'nope',
      confidence: 7,
      rationale: '',
      evidence: [],
      question: null,
    });
    expect(
      PlacementItem.safeParse({ step: 'x'.repeat(1001), process: 'a#b', confidence: 1 }).success,
    ).toBe(false);
    expect(PostPlacementsBody.safeParse({ kind: 'propose', placements: [] }).success).toBe(false);
    expect(
      PostPlacementsBody.safeParse({
        kind: 'propose',
        placements: Array.from({ length: 201 }, () => ({
          step: 's',
          process: 'a#b',
          confidence: 1,
        })),
      }).success,
    ).toBe(false);
    expect(
      PostPlacementsBody.safeParse({ kind: 'manual', step: 's', process: 'a/b#P', rationale: ' ' })
        .success,
    ).toBe(false);
    expect(
      PostPlacementsBody.parse({
        kind: 'propose',
        placements: [{ step: 's', process: 'a#b', confidence: 1 }],
      }),
    ).toMatchObject({ procedure: null, llmModel: null });
  });

  it('validates placement decisions by verdict, correct with a step', () => {
    expect(PlacementDecisionBody.safeParse({ verdict: 'accept' }).success).toBe(true);
    expect(PlacementDecisionBody.safeParse({ verdict: 'reject' }).success).toBe(false);
    expect(
      PlacementDecisionBody.safeParse({ verdict: 'hold', note: 'n', question: 'q?' }).success,
    ).toBe(true);
    expect(PlacementDecisionBody.safeParse({ verdict: 'correct', note: 'n' }).success).toBe(false);
    expect(
      PlacementDecisionBody.safeParse({ verdict: 'correct', step: 'step-a', note: 'n' }).success,
    ).toBe(true);
  });

  it('needs reasons and notes in bulk placement decisions, and ids with versions', () => {
    const item = { id: 'plc_01J9Z3N4X5Q6R7S8T9V0W1X2Y3', version: 1 };
    expect(
      BulkPlacementDecisionBody.safeParse({ verdict: 'accept', items: [item], expectedCount: 1 })
        .success,
    ).toBe(true);
    expect(
      BulkPlacementDecisionBody.safeParse({ verdict: 'reject', items: [item], expectedCount: 1 })
        .success,
    ).toBe(false);
    expect(
      BulkPlacementDecisionBody.safeParse({ verdict: 'hold', items: [item], expectedCount: 1 })
        .success,
    ).toBe(false);
    expect(
      BulkPlacementDecisionBody.safeParse({
        verdict: 'accept',
        question: 'q',
        items: [item],
        expectedCount: 1,
      }).success,
    ).toBe(false);
    expect(
      BulkPlacementDecisionBody.safeParse({
        verdict: 'accept',
        items: [{ id: 'rel_01J9Z3N4X5Q6R7S8T9V0W1X2Y3', version: 1 }],
        expectedCount: 1,
      }).success,
    ).toBe(false);
    expect(
      BulkPlacementDecisionBody.safeParse({
        verdict: 'accept',
        tier: 'rule',
        items: [item],
        expectedCount: 1,
      }).success,
    ).toBe(false);
  });

  it('builds value chain paths for reviewUrl', () => {
    expect(valueChainPath('nordwind-handel')).toBe('/projects/nordwind-handel/value-chain');
    expect(valueChainPath('p', { placementId: 'plc_1' })).toBe(
      '/projects/p/value-chain?placement=plc_1',
    );
    expect(valueChainPath('p', { elementId: 'step a' })).toBe(
      '/projects/p/value-chain/steps/step%20a',
    );
  });

  it('documents the value chain routes with their problems and names their components', () => {
    const doc = buildOpenApiDocument();
    const content = doc.paths?.['/api/v1/projects/{project}/value-chains/{key}/content'];
    expect(Object.keys(content?.put?.responses ?? {})).toEqual([
      '200',
      '201',
      '401',
      '403',
      '404',
      '412',
      '413',
      '415',
      '422',
      '428',
    ]);
    expect(JSON.stringify(content?.put?.responses?.['412'])).toMatch(/revision-conflict/);
    expect(JSON.stringify(content?.put?.responses?.['422'])).toMatch(
      /value-chain-invalid.*value-chain-unsupported-version/,
    );
    expect(Object.keys(content?.get?.responses ?? {})).toContain('304');
    const decision =
      doc.paths?.['/api/v1/projects/{project}/value-chains/{key}/placements/{placement}/decision']
        ?.post;
    expect(Object.keys(decision?.responses ?? {})).toEqual(
      expect.arrayContaining(['409', '412', '422']),
    );
    const operations = Object.values(apiRoutes).filter((r) =>
      (r.tags as readonly string[]).includes('value-chains'),
    );
    // 18 of S2's core plus `getValueChainFindings`.
    expect(operations).toHaveLength(19);
    const schemas = Object.keys(doc.components?.schemas ?? {});
    for (const name of [
      'ValueChain',
      'ValueChainDetail',
      'ValueChainStep',
      'ValueChainImpact',
      'SaveValueChainResult',
      'ValueChainViolation',
      'Placement',
      'PlacementItem',
      'PlacementOutcome',
      'PostPlacementsBody',
      'PostPlacementsResult',
      'BulkPlacementDecisionBody',
      'UnplacedProcess',
      'ValueChainStepDetail',
      'ValueChainFinding',
      'ValueChainFindingList',
    ]) {
      expect(schemas, name).toContain(name);
    }
  });

  it('keeps value chain findings apart from the relation findings', () => {
    expect(ValueChainFindingKind.options).toEqual([...VALUE_CHAIN_FINDING_KINDS]);
    for (const kind of VALUE_CHAIN_FINDING_KINDS) {
      expect(FindingKind.safeParse(kind).success, kind).toBe(false);
    }
    const finding = {
      kind: 'process-without-step',
      elementId: null,
      process: 'finanzen/mahnwesen#P_Mahn',
      link: null,
      state: 'proposed',
      calledFrom: [{ elementId: 'step-fakt', process: 'vertrieb/auftrag#P_Auftrag' }],
      detail: 'No accepted placement.',
    };
    expect(ValueChainFinding.parse(finding)).toEqual(finding);
    expect(ValueChainFinding.safeParse({ ...finding, state: 'accepted' }).success).toBe(false);
    expect(ValueChainFinding.safeParse({ ...finding, process: 'kein-ref' }).success).toBe(false);
  });
});

describe('the placement pipeline kind (M4b)', () => {
  const lease = `${LEASE_TOKEN_PREFIX}${'A'.repeat(43)}`;
  const hash = 'a'.repeat(64);

  it('claims relations tasks unless kinds says otherwise; kinds are distinct', () => {
    expect(ClaimAnalysisBody.parse({})).toEqual({ max: 1, kinds: ['relations'] });
    expect(ClaimAnalysisBody.parse({ kinds: ['placement', 'relations'] }).kinds).toEqual([
      'placement',
      'relations',
    ]);
    for (const kinds of [[], ['placement', 'placement'], ['relations', 'placement', 'x'], ['x']]) {
      expect(ClaimAnalysisBody.safeParse({ kinds }).success, JSON.stringify(kinds)).toBe(false);
    }
    // The pending query takes one kind or a list (repeated query parameter).
    expect(PendingQuery.parse({}).kinds).toBe('relations');
    expect(PendingQuery.parse({ kinds: 'placement' }).kinds).toBe('placement');
    expect(PendingQuery.parse({ kinds: ['relations', 'placement'] }).kinds).toEqual([
      'relations',
      'placement',
    ]);
    expect(PendingQuery.safeParse({ kinds: ['placement', 'placement'] }).success).toBe(false);
    expect(AnalysisKind.options).toEqual(['relations', 'placement']);
  });

  it('keeps placement fields off a relations submission (no defaults) and defaults relations', () => {
    const base = {
      leaseToken: lease,
      submissionId: '6f1e1a4e-4b7a-4c8e-9f5a-1d2c3b4a5f60',
      procedure: { id: 'proa-placements', version: '0.1.0' },
    };
    const parsed = SubmitAnalysisBody.parse(base);
    expect(parsed.relations).toEqual([]);
    expect(parsed).not.toHaveProperty('placements');
    expect(parsed).not.toHaveProperty('unsure');
    const placed = SubmitAnalysisBody.parse({
      ...base,
      placements: [{ step: 'step-a', process: 'a/b#P', confidence: 2 }],
      unsure: [{ process: 'a/b#Q' }],
    });
    expect(placed.placements?.[0]).toMatchObject({ rationale: '', evidence: [], question: null });
    expect(placed.unsure).toEqual([{ process: 'a/b#Q', reason: '' }]);
    const many = Array.from({ length: MAX_UNSURE_ITEMS + 1 }, () => ({ process: 'a/b#P' }));
    expect(SubmitAnalysisBody.safeParse({ ...base, unsure: many }).success).toBe(false);
  });

  it('lists the pipeline reasons: the ad-hoc ones plus outside-task-input after malformed-ref', () => {
    expect(PIPELINE_PLACEMENT_INVALID_REASONS.filter((r) => r !== 'outside-task-input')).toEqual(
      PLACEMENT_INVALID_REASONS,
    );
    expect(PIPELINE_PLACEMENT_INVALID_REASONS.indexOf('outside-task-input')).toBe(
      PIPELINE_PLACEMENT_INVALID_REASONS.indexOf('malformed-ref') + 1,
    );
    expect(UNSURE_INVALID_REASONS).toEqual([
      'malformed-ref',
      'outside-task-input',
      'unknown-process',
      'reason-required',
      'reason-too-long',
      'control-characters',
      'also-placed',
    ]);
    expect(UnsureOutcome.options).toContain('invalid:also-placed');
    expect(PROBLEMS['wrong-task-kind']).toEqual({ status: 422, title: 'Wrong task kind' });
  });

  it('requeues exactly one of models, all models or the value chain', () => {
    expect(RequeueBody.safeParse({ valueChain: true }).success).toBe(true);
    expect(RequeueBody.safeParse({ valueChain: true, all: true }).success).toBe(false);
    expect(RequeueBody.safeParse({ valueChain: false }).success).toBe(false);
  });

  const placementResult = {
    kind: 'placement' as const,
    taskId: newId('analysisTask'),
    submissionId: '6f1e1a4e-4b7a-4c8e-9f5a-1d2c3b4a5f60',
    replayed: false,
    placements: {
      items: [{ index: 0, result: 'invalid:outside-task-input', placementId: null, status: null }],
      counts: { applied: 0, duplicate: 0, suppressed: 0, reopened: 0, invalid: 1 },
    },
    unsure: {
      items: [{ index: 0, result: 'stored' }],
      counts: { stored: 1, duplicate: 0, invalid: 0 },
    },
    withdrawn: 0,
    skipped: { count: 1, processes: ['a/b#P'] },
    followUp: true,
  };

  it('tells the submission results apart by kind', () => {
    expect(AnalysisSubmissionResult.parse(placementResult)).toEqual(placementResult);
    const relations = {
      taskId: newId('analysisTask'),
      submissionId: 'x',
      replayed: false,
      items: [],
      counts: { applied: 0, duplicate: 0, suppressed: 0, reopened: 0, invalid: 0 },
      withdrawn: 0,
    };
    const parsed = AnalysisSubmissionResult.parse(relations);
    expect(parsed).toEqual(relations);
    expect(parsed).not.toHaveProperty('kind');
  });

  it('discriminates claimed tasks by kind', () => {
    const claimed = {
      kind: 'placement',
      taskId: newId('analysisTask'),
      projectId: newId('project'),
      projectKey: 'demo',
      valueChainId: newId('valueChain'),
      valueChainKey: 'main',
      revisionId: newId('valueChainRevision'),
      rev: 2,
      attempt: 1,
      leaseToken: lease,
      leaseUntil: '2026-10-09T10:15:00.000Z',
      procedure: { id: 'proa-placements', version: '0.1.0' },
      input: {
        format: 'proa-claim-placement/1',
        valueChain: {
          id: newId('valueChain'),
          key: 'main',
          name: 'Kette',
          revisionId: newId('valueChainRevision'),
          rev: 2,
          contentHash: hash,
          structureHash: hash,
        },
        steps: [
          {
            id: 'step-a',
            name: 'A',
            path: ['A'],
            kind: 'core',
            rank: 0,
            depth: 0,
            parentId: null,
            children: [],
          },
        ],
        processes: [],
        examples: [],
        truncated: false,
        remaining: 0,
      },
    };
    const parsed = ClaimedAnalysis.parse(claimed);
    expect(parsed.kind).toBe('placement');
    expect(ClaimedAnalysis.safeParse({ ...claimed, kind: 'relations' }).success).toBe(false);
    const tooMany = {
      ...claimed,
      input: {
        ...claimed.input,
        processes: Array.from({ length: MAX_CLAIM_PLACEMENT_PROCESSES + 1 }, () => ({})),
      },
    };
    expect(ClaimedAnalysis.safeParse(tooMany).success).toBe(false);
  });

  it('parses placement recording lines next to relations lines', () => {
    const line = {
      format: RECORDING_FORMAT,
      kind: 'placement',
      landscape: 'nordwind-handel',
      valueChain: { key: 'main', rev: 1, contentHash: hash },
      agent: 'agent-sim',
      procedure: { id: 'proa-placements', version: '0.1.0' },
      llmModel: 'sim-policy-1',
      input: {
        format: 'proa-claim-placement/1',
        summary: true,
        steps: 3,
        processes: 2,
        truncated: false,
        bytes: 1000,
      },
      submission: {
        placements: [{ step: 'step-a', process: 'a/b#P', confidence: 0.9 }],
        unsure: [{ process: 'a/b#Q', reason: 'unklar' }],
        summary: null,
        costUsd: null,
      },
      outcome: 'submitted',
      result: {
        replayed: false,
        counts: placementResult.placements.counts,
        withdrawn: 0,
        items: [{ index: 0, result: 'applied', status: 'proposed' }],
        unsure: placementResult.unsure,
        skipped: { count: 0 },
        followUp: false,
      },
    };
    const parsed = RecordingLine.parse(line);
    expect(isPlacementLine(parsed)).toBe(true);
    expect(PlacementRecordingLine.parse(line).submission.placements[0]).toMatchObject({
      rationale: '',
    });
    expect(recordingPath(parsed)).toBe(
      'proa-placements@0.1.0/agent-sim/sim-policy-1/nordwind-handel.jsonl',
    );
    expect(() => RecordingLine.parse({ ...line, valueChain: undefined })).toThrow();
  });

  it('describes the chain pipeline and the judged marker in the OpenAPI document', () => {
    const doc = buildOpenApiDocument();
    const schemas = doc.components?.schemas ?? {};
    for (const name of [
      'ClaimedPlacementAnalysis',
      'PlacementClaimInput',
      'PlacementSubmissionResult',
      'AnalysisSubmissionResult',
      'ValueChainPipeline',
      'ValueChainUnsure',
      'PlacementInputOutcome',
    ]) {
      expect(schemas, name).toHaveProperty(name);
    }
    expect(JSON.stringify(schemas['UnplacedProcess'])).toContain('judged');
  });
});
