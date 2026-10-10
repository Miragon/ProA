/**
 * `proa rules …` (owner decision 19): the project's auto-accept rules, as the
 * owner (owner key only; agents never see or change rules, so an agent token
 * is refused before any request).
 *
 * - **list**, **show** print the rules (with the read-only system rule of
 *   decision 9) and one rule's immutable revisions.
 * - **add** creates a rule, off unless `--enable`, and prints its preview.
 * - **edit** reads the head, merges the flags and saves the next revision
 *   with `If-Match: "r<rev>"`; **enable** and **disable** do the same for the
 *   switch (enable reports how many open proposals already match). Saving a
 *   rule whose author is no longer an owner takes it over, also without a
 *   change (`proa rules edit <id>` with no flags).
 * - **preview** shows what a rule (saved, edited by flags, or unsaved) would
 *   have accepted so far, would accept now, and the confidence curve.
 * - **apply** and **revoke** print a dry run first and change something only
 *   with `--yes`, passing the dry run's count as `expectedCount` (409 when
 *   the open proposals or acceptances changed in between).
 *
 * The agent of `--agent` is an agent token of the project, by id (`agt_…`),
 * name or principal (`prn_…`); rules store the token's `principalId`.
 */
import {
  applyAutoAcceptRule,
  createAutoAcceptRule,
  getAutoAcceptRule,
  listAgentTokens,
  listAutoAcceptRules,
  previewAutoAcceptRule,
  reviseAutoAcceptRule,
  revokeAutoAccepted,
  type AgentToken,
  type ApplyAutoAcceptResult,
  type AutoAcceptCriteria,
  type AutoAcceptItem,
  type AutoAcceptPreview,
  type AutoAcceptRevocationBody,
  type AutoAcceptRevocationResult,
  type AutoAcceptRule,
  type AutoAcceptRuleDetail,
  type AutoAcceptRuleDraft,
  type AutoAcceptRuleList,
  type AutoAcceptSystemRule,
} from '@proa/client';
import {
  AUTO_ACCEPT_TIERS,
  AutoAcceptKind,
  AutoAcceptRelationType,
  AutoAcceptTier,
  MAX_AUTO_ACCEPT_IDS,
  MIN_AUTO_ACCEPT_CONFIDENCE,
  type AutoAcceptRuleId,
  type PrincipalId,
} from '@proa/contracts';

import { call, createApi, type Api } from '../api.ts';
import { agentToken, ownerCredential, type CredentialOptions } from '../credentials.ts';
import { ApiError, CliError } from '../errors.ts';
import type { CliIo } from '../io.ts';

export interface RulesOptions extends CredentialOptions {
  url: string;
  project: string;
  json?: boolean;
}

/** The criteria flags of add, edit and preview (all optional; add checks the required ones). */
export interface CriteriaFlags {
  name?: string;
  kind?: string;
  tier?: string;
  /** `0.9`, `90%`. */
  min?: string;
  /** A relation type, or `any` to drop the narrowing. */
  type?: string;
  /** Token id, token name or principal id, or `any`. */
  agent?: string;
  /** A declared llmModel, or `any`. */
  model?: string;
  /** `--ad-hoc` / `--no-ad-hoc`. */
  adHoc?: boolean;
  /** A note; an empty string removes it. */
  note?: string;
}

export interface AddOptions extends RulesOptions, CriteriaFlags {
  enable?: boolean;
}

export interface ApplyOptions extends RulesOptions {
  dryRun?: boolean;
  yes?: boolean;
}

export interface RevokeOptions extends ApplyOptions {
  agent?: string;
  revision?: string;
  kind?: string;
  ids?: string[];
  reason?: string;
}

/** Drops a narrowing: `--type any`, `--agent any`, `--model any`. */
const ANY = 'any';

/**
 * Parses a minimum confidence: a fraction (`0.9`, `1`) or a percentage
 * (`90%`, `92.5 %`), inclusive, between 0.5 and 1. A percentage keeps two
 * decimals (`92.345%` → 0.9235), as the web UI does.
 *
 * @throws {CliError} for other forms or values outside 0.5–1
 */
export function parseConfidence(value: string): number {
  const m = /^\s*(\d+(?:[.,]\d+)?|[.,]\d+)\s*(%?)\s*$/.exec(value);
  const raw = m?.[1] ? Number(m[1].replace(',', '.')) : NaN;
  const percent = m?.[2] === '%';
  if (!Number.isFinite(raw) || (!percent && raw > 1)) {
    throw new CliError(
      `invalid minimum confidence ${JSON.stringify(value)}: use a fraction such as 0.9 or a percentage such as 90%`,
    );
  }
  const confidence = percent ? Math.round(raw * 100) / 10_000 : raw;
  if (confidence < MIN_AUTO_ACCEPT_CONFIDENCE || confidence > 1) {
    throw new CliError(
      `the minimum confidence must lie between ${MIN_AUTO_ACCEPT_CONFIDENCE * 100}% and 100%, not ${formatPercent(confidence)}`,
    );
  }
  return confidence;
}

/**
 * `0.9` → `90%`, `0.925` → `92.5%`, `0.9004` → `90.04%`: up to four decimals
 * of a percent, so a threshold never reads rounder (and looser) than it is.
 */
export function formatPercent(value: number): string {
  return `${Math.round(value * 1_000_000) / 10_000}%`;
}

function parseKind(value: string): AutoAcceptKind {
  const parsed = AutoAcceptKind.safeParse(value);
  if (!parsed.success) {
    throw new CliError(
      `unknown kind ${JSON.stringify(value)}: use ${AutoAcceptKind.options.join(' or ')}`,
    );
  }
  return parsed.data;
}

function parseTier(value: string, kind: AutoAcceptKind): AutoAcceptTier {
  const parsed = AutoAcceptTier.safeParse(value);
  const allowed: readonly string[] = AUTO_ACCEPT_TIERS[kind];
  if (!parsed.success || !allowed.includes(parsed.data)) {
    throw new CliError(
      `a ${kind} rule names one of the tiers ${allowed.join(', ')}, not ${JSON.stringify(value)}`,
    );
  }
  return parsed.data;
}

function parseType(value: string, kind: AutoAcceptKind): AutoAcceptRelationType | null {
  if (value === ANY) return null;
  if (kind === 'placement') throw new CliError('only a relation rule has a relation type');
  const parsed = AutoAcceptRelationType.safeParse(value);
  if (!parsed.success) {
    throw new CliError(
      `unknown relation type ${JSON.stringify(value)}: use ${AutoAcceptRelationType.options.join(', ')} or ${ANY}`,
    );
  }
  return parsed.data;
}

/**
 * The principal of `--agent`: a project agent token by id, by name (one
 * token of that name) or by its principal id.
 *
 * @throws {CliError} for an unknown or ambiguous agent
 */
export function resolveAgent(tokens: readonly AgentToken[], value: string): PrincipalId {
  const v = value.trim();
  const byId = tokens.find((t) => t.id === v || t.principalId === v);
  if (byId) return byId.principalId as PrincipalId;
  const named = tokens.filter((t) => t.name === v);
  const live = named.filter((t) => t.revokedAt === null);
  const pick = live.length === 1 ? live : named;
  if (pick.length === 1 && pick[0]) return pick[0].principalId as PrincipalId;
  if (pick.length > 1) {
    throw new CliError(
      `several agent tokens are named ${JSON.stringify(v)}; name the token by id (${pick.map((t) => t.id).join(', ')})`,
    );
  }
  throw new CliError(
    `no agent token ${JSON.stringify(v)} in this project (proa token list shows them; give an id agt_…, a name or a principal prn_…)`,
  );
}

function refuseAgentToken(io: CliIo, opts: CredentialOptions): void {
  if (agentToken(io, opts) !== undefined) {
    throw new CliError(
      'auto-accept rules are owner-only and agents never see them: proa rules uses the owner key (drop --token and unset PROA_TOKEN)',
    );
  }
}

async function ownerApi(io: CliIo, opts: RulesOptions): Promise<Api> {
  refuseAgentToken(io, opts);
  return createApi(io, opts.url, await ownerCredential(io, opts));
}

async function tokensOf(api: Api, project: string): Promise<AgentToken[]> {
  return (
    await call(
      api,
      `list agent tokens of ${project}`,
      listAgentTokens({ client: api.client, path: { project } }),
    )
  ).items;
}

const ruleId = (value: string) => value as AutoAcceptRuleId;

async function getRule(api: Api, project: string, id: string): Promise<AutoAcceptRuleDetail> {
  return call(
    api,
    `read auto-accept rule ${id}`,
    getAutoAcceptRule({ client: api.client, path: { project, rule: ruleId(id) } }),
  );
}

/** The draft of a rule's head revision (what an edit starts from). */
export function draftOf(rule: AutoAcceptRule): AutoAcceptRuleDraft {
  return {
    name: rule.name,
    enabled: rule.enabled,
    note: rule.note,
    kind: rule.kind,
    tier: rule.tier,
    minConfidence: rule.minConfidence,
    relationType: rule.relationType,
    agentPrincipalId: rule.agentPrincipalId,
    llmModel: rule.llmModel,
    includeAdHoc: rule.includeAdHoc,
  };
}

/**
 * Merges criteria flags into a draft; `kind` never changes (a new rule
 * instead). Resolves `--agent` through `tokens` (loaded only when needed).
 *
 * @throws {CliError} for invalid flags
 */
export async function mergeFlags(
  base: AutoAcceptRuleDraft,
  flags: CriteriaFlags,
  tokens: () => Promise<readonly AgentToken[]>,
): Promise<AutoAcceptRuleDraft> {
  if (flags.kind !== undefined && parseKind(flags.kind) !== base.kind) {
    throw new CliError('the kind of a rule never changes; add a new rule instead');
  }
  const kind = base.kind;
  const next: AutoAcceptRuleDraft = { ...base };
  if (flags.name !== undefined) next.name = flags.name;
  if (flags.tier !== undefined) next.tier = parseTier(flags.tier, kind);
  if (flags.min !== undefined) next.minConfidence = parseConfidence(flags.min);
  if (flags.type !== undefined) next.relationType = parseType(flags.type, kind);
  if (flags.agent !== undefined) {
    next.agentPrincipalId = flags.agent === ANY ? null : resolveAgent(await tokens(), flags.agent);
  }
  if (flags.model !== undefined) next.llmModel = flags.model === ANY ? null : flags.model.trim();
  if (flags.adHoc !== undefined) next.includeAdHoc = flags.adHoc;
  if (flags.note !== undefined) next.note = flags.note.trim() === '' ? null : flags.note;
  return next;
}

/** The draft of `add`: name, kind, tier and minimum are required. */
async function newDraft(
  flags: CriteriaFlags & { enable?: boolean },
  tokens: () => Promise<readonly AgentToken[]>,
): Promise<AutoAcceptRuleDraft> {
  const missing = (['name', 'kind', 'tier', 'min'] as const).filter((k) => flags[k] === undefined);
  if (missing.length > 0) {
    throw new CliError(`proa rules add needs ${missing.map((m) => `--${m}`).join(', ')}`);
  }
  const kind = parseKind(flags.kind ?? '');
  const base: AutoAcceptRuleDraft = {
    name: '',
    enabled: flags.enable === true,
    note: null,
    kind,
    tier: parseTier(flags.tier ?? '', kind),
    minConfidence: parseConfidence(flags.min ?? ''),
    relationType: null,
    agentPrincipalId: null,
    llmModel: null,
    includeAdHoc: false,
  };
  return mergeFlags(base, { ...flags, kind: undefined }, tokens);
}

function criteriaOf(d: AutoAcceptRuleDraft): AutoAcceptCriteria {
  return {
    kind: d.kind,
    tier: d.tier,
    minConfidence: d.minConfidence,
    relationType: d.relationType,
    agentPrincipalId: d.agentPrincipalId,
    llmModel: d.llmModel,
    includeAdHoc: d.includeAdHoc,
  };
}

// ------------------------------------------------------------------ output

const out = (io: CliIo, lines: string | string[]) =>
  io.stdout(`${(Array.isArray(lines) ? lines : [lines]).join('\n')}\n`);

const json = (io: CliIo, value: unknown) => io.stdout(`${JSON.stringify(value, null, 2)}\n`);

/** `relation key ≥ 90% [call] [agent agent:x] [model m] [ad hoc]`. */
export function criteriaText(
  r: Pick<AutoAcceptRule, 'kind' | 'tier' | 'minConfidence'> & {
    relationType?: AutoAcceptRule['relationType'] | undefined;
    agentPrincipalId?: string | null | undefined;
    llmModel?: string | null | undefined;
    includeAdHoc?: boolean | undefined;
    agent?: AutoAcceptRule['agent'] | undefined;
  },
): string {
  const parts = [`${r.kind} ${r.tier} ≥ ${formatPercent(r.minConfidence)}`];
  if (r.relationType) parts.push(`type ${r.relationType}`);
  if (r.agentPrincipalId) {
    const agent = r.agent;
    parts.push(
      `agent ${agent ? `${agent.handle}${agent.revoked ? ' (revoked)' : ''}` : r.agentPrincipalId}`,
    );
  }
  if (r.llmModel) parts.push(`model ${r.llmModel}`);
  if (r.includeAdHoc) parts.push('incl. ad hoc');
  return parts.join(', ');
}

/** One line per rule. */
export function ruleLine(r: AutoAcceptRule): string {
  const s = r.stats;
  const warn = r.authorIsOwner
    ? ''
    : ` (author is no longer an owner: matches nothing until an owner saves it again, e.g. proa rules edit ${r.id})`;
  return (
    `${r.id}  ${JSON.stringify(r.name)}  ${r.enabled ? 'on' : 'off'}  ${criteriaText(r)}  r${r.revision} by ${r.author.handle}` +
    `  in force ${s.inForce}, revoked ${s.revoked}, confirmed ${s.confirmed}, overruled ${s.overruled}${warn}`
  );
}

function systemLine(s: AutoAcceptSystemRule): string {
  return `system rule ${s.id} ${JSON.stringify(s.name)}: ${s.relationType} relations, always on, read-only; ${s.accepted} accepted`;
}

/** `relation call a#x → b#y` / `placement main a#P → step`. */
function subjectText(i: {
  kind: string;
  type: string | null;
  from: string | null;
  to: string | null;
  valueChainKey: string | null;
  step: string | null;
  process: string | null;
}): string {
  return i.kind === 'relation'
    ? `relation ${i.type ?? '?'} ${i.from ?? '?'} → ${i.to ?? '?'}`
    : `placement ${i.process ?? '?'} → ${i.step ?? '?'} (chain ${i.valueChainKey ?? '?'})`;
}

function itemLine(i: AutoAcceptItem): string {
  return `  ${subjectText(i)}  (${i.agent.handle}${i.llmModel ? `, ${i.llmModel}` : ''}, ${i.tier}, ${i.confidence.toFixed(2)})`;
}

function blockedLine(blocked: ApplyAutoAcceptResult['blocked']): string[] {
  return blocked.length === 0
    ? []
    : [`  blocked by a safeguard: ${blocked.map((b) => `${b.reason} ${b.count}`).join(', ')}`];
}

const ratio = (v: number | null): string => (v === null ? 'n/a' : `${Math.round(v * 1000) / 10}%`);

/** The preview as lines. */
export function formatPreview(p: AutoAcceptPreview): string[] {
  const h = p.history;
  const lines = [
    `history: of ${h.decided} agent-proposed items a human decided, the rule would have accepted ${h.wouldAccept}: ` +
      `${h.accepted} accepted, ${h.rejected} rejected, ${h.corrected} corrected, ${h.held} held (precision ${ratio(h.precision)})`,
    `  auto-accepted and not reviewed: ${h.autoUnreviewed}; still undecided: ${h.undecided}`,
    `open now: ${p.open.count} ${p.open.count === 1 ? 'proposal' : 'proposals'} would be accepted`,
    ...p.open.items.map(itemLine),
    ...(p.open.count > p.open.items.length
      ? [`  … ${p.open.count - p.open.items.length} more`]
      : []),
    ...blockedLine(p.open.blocked),
    'curve (other criteria unchanged):',
    '  min      would  accepted  rejected  corrected  held  precision  open',
    ...p.curve.map(
      (c) =>
        `  ${formatPercent(c.minConfidence).padEnd(7)}  ${String(c.wouldAccept).padStart(5)}  ${String(c.accepted).padStart(8)}  ` +
        `${String(c.rejected).padStart(8)}  ${String(c.corrected).padStart(9)}  ${String(c.held).padStart(4)}  ` +
        `${ratio(c.precision).padStart(9)}  ${String(c.open).padStart(4)}`,
    ),
  ];
  return lines;
}

function formatDetail(d: AutoAcceptRuleDetail): string[] {
  return [
    ruleLine(d),
    ...(d.note ? [`  note: ${d.note}`] : []),
    'revisions:',
    ...d.revisions.map(
      (r) =>
        `  r${r.revision}  ${r.at}  ${r.author.handle}${r.clientId ? ` (${r.clientId})` : ''}  ${r.enabled ? 'on' : 'off'}  ` +
        `${JSON.stringify(r.name)}  ${criteriaText(r)}`,
    ),
  ];
}

function formatApply(r: ApplyAutoAcceptResult, project: string): string[] {
  const n = r.count;
  return [
    r.dryRun
      ? `dry run: rule ${r.ruleId} r${r.revision}${r.enabled ? '' : ' (off)'} would accept ${n} open ${n === 1 ? 'proposal' : 'proposals'} in ${project}`
      : `rule ${r.ruleId} r${r.revision} accepted ${n} ${n === 1 ? 'proposal' : 'proposals'} in ${project}`,
    ...r.items.map(itemLine),
    ...(r.truncated ? ['  … more not listed'] : []),
    ...blockedLine(r.blocked),
  ];
}

function formatRevocation(r: AutoAcceptRevocationResult): string[] {
  const n = r.count;
  return [
    `${r.dryRun ? 'dry run: ' : ''}${n} ${n === 1 ? 'auto-acceptance' : 'auto-acceptances'} ${r.dryRun ? 'would be revoked' : 'revoked'}: ` +
      `${r.toProposed} back to review, ${r.toObsolete} obsolete (judged again)`,
    `  ${r.humanDecidedSince} decided by a human since stay unchanged; ${r.alreadyRevoked} revoked before`,
    ...r.items.map(
      (i) =>
        `  ${subjectText(i)}  rule ${JSON.stringify(i.ruleName)} r${i.revision} (${i.agent.handle}${i.confidence === null ? '' : `, ${i.confidence.toFixed(2)}`}) → ${i.outcome}`,
    ),
    ...(r.truncated ? ['  … more not listed'] : []),
  ];
}

/**
 * Turns rule save problems into messages: 412 (edited meanwhile), 422 with
 * the domain's reason (`unknown-agent`, `name-taken`, `kind-changed`) or with
 * the fields the schema refused.
 */
function explainSave(err: unknown, id: string | null): never {
  if (!(err instanceof ApiError)) throw err;
  const problem = (err.problem ?? {}) as Record<string, unknown>;
  if (err.status === 412 && problem['code'] === 'revision-conflict') {
    throw new CliError(
      `auto-accept rule ${id ?? ''} was changed meanwhile (now r${String(problem['headRev'])}); run the command again`,
    );
  }
  if (err.status === 422 && typeof problem['reason'] === 'string') {
    throw new CliError(
      `the server refused the rule (${problem['reason']}): ${err.problem?.detail ?? ''}`,
    );
  }
  const errors = problem['errors'];
  if (err.status === 422 && Array.isArray(errors) && errors.length > 0) {
    const text = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
    const fields = (errors as { path?: unknown; message?: unknown }[])
      .map((e) => `${text(e.path, '?').replace(/^json\./, '')}: ${text(e.message, '')}`)
      .join('; ');
    throw new CliError(`the server refused the rule: ${fields}`);
  }
  throw err;
}

/** What keeps a rule from accepting anything now (`null`: nothing), with what to do. */
function applyBlocker(
  r: Pick<ApplyAutoAcceptResult, 'ruleId' | 'enabled' | 'authorIsOwner'>,
  project: string,
): string | null {
  if (!r.enabled)
    return `the rule is off: enable it first with proa rules enable ${r.ruleId} -p ${project}`;
  if (!r.authorIsOwner) {
    return (
      'the rule’s author is no longer an owner, so it accepts nothing: take it over with ' +
      `proa rules edit ${r.ruleId} -p ${project} (saving it again makes you its author), then apply it`
    );
  }
  return null;
}

/**
 * 409 on apply or revoke: the selection changed since the dry run (run it
 * again), or, for apply, the rule was switched off or its author lost the
 * owner role meanwhile (running it again would not help).
 */
function explainConflict(err: unknown, again: string, project?: string, id?: string): never {
  if (err instanceof ApiError && err.status === 409) {
    const reason = err.problem?.['reason'];
    if ((reason === 'rule-disabled' || reason === 'author-not-owner') && id && project) {
      const blocker = applyBlocker(
        {
          ruleId: ruleId(id),
          enabled: reason !== 'rule-disabled',
          authorIsOwner: reason !== 'author-not-owner',
        },
        project,
      );
      throw new CliError(`nothing changed: ${blocker ?? ''}`);
    }
    throw new CliError(
      `${err.problem?.detail ?? 'the selection changed since the dry run'}; nothing changed. Run ${again} again`,
    );
  }
  throw err;
}

// ---------------------------------------------------------------- commands

/** `proa rules list -p <project> [--json]`. */
export async function rulesListCommand(io: CliIo, opts: RulesOptions): Promise<void> {
  const api = await ownerApi(io, opts);
  const list: AutoAcceptRuleList = await call(
    api,
    `list auto-accept rules of ${opts.project}`,
    listAutoAcceptRules({ client: api.client, path: { project: opts.project } }),
  );
  if (opts.json) return json(io, list);
  out(io, [
    systemLine(list.system),
    ...(list.items.length === 0
      ? [`no auto-accept rules in ${opts.project}: you decide every agent proposal yourself`]
      : list.items.map(ruleLine)),
  ]);
}

/** `proa rules show <id> -p <project> [--json]`. */
export async function rulesShowCommand(io: CliIo, id: string, opts: RulesOptions): Promise<void> {
  const api = await ownerApi(io, opts);
  const detail = await getRule(api, opts.project, id);
  if (opts.json) return json(io, detail);
  out(io, formatDetail(detail));
}

async function preview(api: Api, project: string, criteria: AutoAcceptCriteria) {
  return call(
    api,
    `preview an auto-accept rule in ${project}`,
    previewAutoAcceptRule({ client: api.client, path: { project }, body: criteria }),
  );
}

/** `proa rules add --name --kind --tier --min [narrowing] [--note] [--enable] -p <project>`. */
export async function rulesAddCommand(io: CliIo, opts: AddOptions): Promise<void> {
  refuseAgentToken(io, opts);
  let tokens: AgentToken[] | null = null;
  let api: Api | null = null;
  const lazyApi = async () => (api ??= await ownerApi(io, opts));
  const draft = await newDraft(
    opts,
    async () => (tokens ??= await tokensOf(await lazyApi(), opts.project)),
  );
  const client = await lazyApi();
  let saved;
  try {
    saved = await call(
      client,
      `create an auto-accept rule in ${opts.project}`,
      createAutoAcceptRule({ client: client.client, path: { project: opts.project }, body: draft }),
    );
  } catch (err) {
    explainSave(err, null);
  }
  const p = await preview(client, opts.project, criteriaOf(draft));
  if (opts.json) return json(io, { ...saved, preview: p });
  out(io, [
    `created ${ruleLine(saved.rule)}`,
    ...(saved.rule.enabled
      ? []
      : [`  off: enable it with proa rules enable ${saved.rule.id} -p ${opts.project}`]),
    ...formatPreview(p),
    ...(saved.rule.enabled && p.open.count > 0
      ? [
          `rules are never retroactive: accept the ${p.open.count} open ${p.open.count === 1 ? 'proposal' : 'proposals'} with proa rules apply ${saved.rule.id} -p ${opts.project}`,
        ]
      : []),
  ]);
}

async function revise(
  api: Api,
  opts: RulesOptions,
  id: string,
  change: (head: AutoAcceptRuleDetail) => Promise<AutoAcceptRuleDraft>,
) {
  const head = await getRule(api, opts.project, id);
  const draft = await change(head);
  try {
    return await call(
      api,
      `edit auto-accept rule ${id}`,
      reviseAutoAcceptRule({
        client: api.client,
        path: { project: opts.project, rule: ruleId(id) },
        headers: { 'if-match': `"r${head.revision}"` },
        body: draft,
      }),
    );
  } catch (err) {
    return explainSave(err, id);
  }
}

/** `proa rules edit <id> [flags] -p <project>`: the next revision. */
export async function rulesEditCommand(
  io: CliIo,
  id: string,
  opts: RulesOptions & CriteriaFlags,
): Promise<void> {
  const api = await ownerApi(io, opts);
  let tokens: AgentToken[] | null = null;
  let tookOver = false;
  const saved = await revise(api, opts, id, (head) => {
    tookOver = !head.authorIsOwner;
    return mergeFlags(
      draftOf(head),
      opts,
      async () => (tokens ??= await tokensOf(api, opts.project)),
    );
  });
  if (opts.json) return json(io, saved);
  out(io, [
    saved.outcome === 'unchanged'
      ? `unchanged: ${ruleLine(saved.rule)}`
      : `${saved.outcome === 'revised' && tookOver ? 'taken over' : saved.outcome} ${ruleLine(saved.rule)}`,
    ...(saved.outcome === 'revised'
      ? ['  earlier acceptances keep the revision that accepted them']
      : []),
  ]);
}

async function dryApply(api: Api, project: string, id: string): Promise<ApplyAutoAcceptResult> {
  return call(
    api,
    `apply auto-accept rule ${id} (dry run)`,
    applyAutoAcceptRule({
      client: api.client,
      path: { project, rule: ruleId(id) },
      query: { dryRun: 'true' },
      body: {},
    }),
  );
}

/** `proa rules enable|disable <id> -p <project>`. */
export async function rulesSwitchCommand(
  io: CliIo,
  id: string,
  enabled: boolean,
  opts: RulesOptions,
): Promise<void> {
  const api = await ownerApi(io, opts);
  const saved = await revise(api, opts, id, (head) =>
    Promise.resolve({ ...draftOf(head), enabled }),
  );
  const open = enabled && saved.rule.authorIsOwner ? await dryApply(api, opts.project, id) : null;
  if (opts.json) return json(io, { ...saved, ...(open ? { open: open.count } : {}) });
  out(io, [
    `${saved.outcome === 'unchanged' ? 'unchanged' : enabled ? 'enabled' : 'disabled'}: ${ruleLine(saved.rule)}`,
    ...(open && open.count > 0
      ? [
          `${open.count} open ${open.count === 1 ? 'proposal matches' : 'proposals match'} the rule already; rules are never retroactive: run proa rules apply ${id} -p ${opts.project}`,
        ]
      : []),
  ]);
}

/** `proa rules preview [<id>] [flags] -p <project>`: a saved rule, edited by flags, or an unsaved one. */
export async function rulesPreviewCommand(
  io: CliIo,
  id: string | undefined,
  opts: RulesOptions & CriteriaFlags,
): Promise<void> {
  const api = await ownerApi(io, opts);
  let tokens: AgentToken[] | null = null;
  const lazyTokens = async () => (tokens ??= await tokensOf(api, opts.project));
  const draft =
    id === undefined
      ? await newDraft({ ...opts, name: opts.name ?? 'preview' }, lazyTokens)
      : await mergeFlags(draftOf(await getRule(api, opts.project, id)), opts, lazyTokens);
  const p = await preview(api, opts.project, criteriaOf(draft));
  if (opts.json) return json(io, p);
  out(io, [`preview: ${criteriaText(draft)}`, ...formatPreview(p)]);
}

/**
 * `proa rules apply <id> [--dry-run] [--yes] -p <project>`. The dry run
 * shows what the head would accept even while the rule is off or its author
 * is no longer an owner; then it says what to do first instead of `--yes`.
 */
export async function rulesApplyCommand(io: CliIo, id: string, opts: ApplyOptions): Promise<void> {
  const api = await ownerApi(io, opts);
  const dry = await dryApply(api, opts.project, id);
  const blocker = applyBlocker(dry, opts.project);
  const go = opts.yes === true && opts.dryRun !== true && dry.count > 0 && blocker === null;
  if (!go) {
    if (opts.json) json(io, dry);
    else out(io, [...formatApply(dry, opts.project), ...(blocker ? [`  ${blocker}`] : [])]);
    if (opts.dryRun !== true && dry.count > 0) {
      throw new CliError(
        blocker
          ? `nothing accepted: ${blocker}`
          : `nothing accepted yet: run proa rules apply ${id} -p ${opts.project} --yes to accept the ${dry.count} ${dry.count === 1 ? 'proposal' : 'proposals'}`,
      );
    }
    return;
  }
  let done: ApplyAutoAcceptResult;
  try {
    done = await call(
      api,
      `apply auto-accept rule ${id}`,
      applyAutoAcceptRule({
        client: api.client,
        path: { project: opts.project, rule: ruleId(id) },
        body: { revision: dry.revision, expectedCount: dry.count },
      }),
    );
  } catch (err) {
    explainConflict(err, `proa rules apply ${id}`, opts.project, id);
  }
  if (opts.json) return json(io, done);
  out(io, formatApply(done, opts.project));
}

/** `proa rules revoke [<id>] [--revision] [--agent] [--kind] [--ids …] [--reason] [--dry-run] [--yes] -p <project>`. */
export async function rulesRevokeCommand(
  io: CliIo,
  id: string | undefined,
  opts: RevokeOptions,
): Promise<void> {
  const api = await ownerApi(io, opts);
  const ids = (opts.ids ?? [])
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  if (ids.length > MAX_AUTO_ACCEPT_IDS) {
    throw new CliError(`at most ${MAX_AUTO_ACCEPT_IDS} ids per revocation`);
  }
  if (id === undefined && opts.agent === undefined && ids.length === 0) {
    throw new CliError('name a rule id, --agent or --ids');
  }
  if (opts.revision !== undefined && id === undefined) {
    throw new CliError('--revision needs a rule id');
  }
  const body: AutoAcceptRevocationBody = {};
  if (id !== undefined) body.ruleId = ruleId(id);
  if (opts.revision !== undefined) {
    const m = /^\s*r?([1-9]\d{0,8})\s*$/i.exec(opts.revision);
    if (!m?.[1]) throw new CliError('--revision takes a revision number such as 2 or r2');
    body.revision = Number(m[1]);
  }
  if (opts.agent !== undefined) {
    body.agentPrincipalId = resolveAgent(await tokensOf(api, opts.project), opts.agent);
  }
  if (opts.kind !== undefined) body.kind = parseKind(opts.kind);
  if (ids.length > 0) body.ids = ids;
  if (opts.reason !== undefined && opts.reason.trim() !== '') body.reason = opts.reason;

  const dry = await call(
    api,
    'revoke auto-acceptances (dry run)',
    revokeAutoAccepted({
      client: api.client,
      path: { project: opts.project },
      query: { dryRun: 'true' },
      body,
    }),
  );
  const go = opts.yes === true && opts.dryRun !== true && dry.count > 0;
  if (!go) {
    if (opts.json) json(io, dry);
    else out(io, formatRevocation(dry));
    if (opts.dryRun !== true && dry.count > 0) {
      throw new CliError(
        `nothing revoked yet: run the command again with --yes to revoke the ${dry.count} ${dry.count === 1 ? 'auto-acceptance' : 'auto-acceptances'}`,
      );
    }
    return;
  }
  let done: AutoAcceptRevocationResult;
  try {
    done = await call(
      api,
      'revoke auto-acceptances',
      revokeAutoAccepted({
        client: api.client,
        path: { project: opts.project },
        body: { ...body, expectedCount: dry.count },
      }),
    );
  } catch (err) {
    explainConflict(err, 'proa rules revoke');
  }
  if (opts.json) return json(io, done);
  out(io, formatRevocation(done));
}
