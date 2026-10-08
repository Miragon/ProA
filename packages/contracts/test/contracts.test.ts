import { describe, expect, it } from 'vitest';

import {
  ApiProblem,
  BulkDecisionBody,
  Candidate,
  ClaimInput,
  DecisionBody,
  INVALID_REASONS,
  MAX_SUBMISSION_RELATIONS,
  NoteBody,
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
  recordingPath,
  recordingSegment,
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

  it('parses a recording line, without server ids and with a summarized input', () => {
    const parsed = RecordingLine.parse(line);
    expect(parsed.task).toBeUndefined();
    expect(parsed.submission.relations[0]).toMatchObject({
      rationale: '',
      evidence: [],
      question: null,
    });
    expect(() => RecordingLine.parse({ ...line, outcome: 'maybe' })).toThrow();
    expect(() => RecordingLine.parse({ ...line, landscape: '_sample' })).toThrow();
    expect(() =>
      RecordingLine.parse({ ...line, input: { ...line.input, summary: false } }),
    ).toThrow();
  });

  it('parses a line built from a stored submission: no claim input', () => {
    const { input: _input, ...stored } = line;
    const parsed = RecordingLine.parse(stored);
    expect(parsed.input).toBeUndefined();
    expect(parsed.submission.relations).toHaveLength(1);
    expect(recordingPath(parsed)).toBe(recordingPath(RecordingLine.parse(line)));
    // Still the same format: an input, if present, must be one.
    expect(() => RecordingLine.parse({ ...stored, input: null })).toThrow();
  });

  it('lays recordings out as <procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl', () => {
    expect(recordingPath(RecordingLine.parse(line))).toBe(
      'proa-relations@0.0.1/agent-sim/sim-policy-1/nordwind-handel.jsonl',
    );
    expect(recordingSegment('claude code / sonnet')).toBe('claude-code-sonnet');
    expect(recordingSegment('..')).toBe('none');
  });
});
