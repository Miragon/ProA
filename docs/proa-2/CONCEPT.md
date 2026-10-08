# ProA 2.0 concept

Status: proposed (2026-10-05) · Owner: Dominik Horn · Decision record: ADR-0004

ProA 2.0 is a headless store for process landscapes. It holds BPMN models, the facts extracted from them, and the relations between processes together with their review state. Agents analyse the models and humans decide on the relations. Any MCP client can be the agent; the web UI is one client among several. 2.0 is rebuilt in place in `Miragon/ProA` (§9).

## 1. Principles

1. **Headless first.** Every capability is a domain use case, reachable through REST and, where agents need it, through MCP. The UI has no private endpoints.
2. **Code computes facts, agents judge, humans decide.**
3. **Postgres is the record; files are for exchange.** BPMN comes in, OKF goes out, and nothing flows both ways.
4. **One model is one BPMN file with a stable key.** Collaborations are never split.
5. **Append-only history, authorization in the domain.** Revisions, facts, assertions, submissions, no-links and events never change. Every use case checks access, and composite foreign keys back the checks up.
6. **The agent is the operator's choice.** ProA ships no runner and holds no LLM credentials; whoever runs the agent brings model, credentials and compute.
7. **Every part earns its place:** one deployable, one queue table, one event table, five packages. The eval corpus is the spec for procedures.

## 2. Domain model

**Entities:**

| Entity | Identity |
|---|---|
| Project | `prj_` |
| Principal | `prn_`: a user `(iss, sub)` or a service `(iss, client_id)`; an agent token (`agt_`, §6) is a service with `iss = urn:proa:agent-token` |
| Membership | role `viewer`, `editor` or `owner` |
| Model | `mdl_` with an immutable `key` such as `billing/dunning` |
| Revision | `rev_`, holding immutable bytes |
| Fact | `(revision, kind, element_id)` |
| Relation | `rel_`, plus the natural key `(type, from_ref, to_ref)` |
| Assertion, submission, no-link | append-only; submissions stored verbatim; a no-link (`nlk_`, an agent's judgement that a typed pair is unrelated) ends with a withdrawal row |
| Analysis task | `ana_` |
| Event | `(project, seq)`; both change feed and audit log |

**Refs** have the form `<model_key>#<element_id>`, or `<model_key>#<process_id>` for a process.

**Hashes.** `content_hash` makes identical uploads no-ops; `facts_hash` ignores layout. Each fact's `fingerprint = sha256(kind|event_def|ref_name_norm|label_norm|scope)[:12]` tells "same id, same meaning" apart from "same id, changed meaning".

**Facts** come from `@proa/bpmn-facts` and are versioned by `FACTS_VERSION`:

| kind | Source | `key_raw` |
|---|---|---|
| `process` | `bpmn:process` (+ participant name) | process id |
| `call` | callActivity | `calledElement` / `zeebe:calledElement@processId` |
| `msg_throw`, `msg_catch` | message events (incl. boundary, event-subprocess start), send/receive tasks | message name, else label |
| `sig_throw`, `sig_catch` | signal events | signal name |
| `evt_start`, `evt_end` | none/timer/conditional starts, none/terminate ends | label |
| `data_store`, `message_flow`, `lane`, `task` | inside one file | name |

Each fact also carries `element_id`, `process_id`, `scope` (`process`, `subprocess` or `event_subprocess`), `event_def`, `label` and `key_norm` (NFKC, lowercase, ä/ö/ü/ß → ae/oe/ue/ss, punctuation → space). Rules match only on real refs, never on labels.

**Relation types (v1):**

| type | from → to | Rule (no LLM) |
|---|---|---|
| `call` | `call` → `process` | `calledElement` = exactly one process id → **accepted** by `proa-rules/1.0.0` |
| `message` | `msg_throw` → `msg_catch` | same message name → proposed, tier `key`, confidence 1.0 |
| `signal` | `sig_throw` → `sig_catch` | same signal name → proposed, tier `key` |
| `trigger` | labelled none end → labelled none start | none; agents only |
| `manual` | any → any | humans only, rationale required |

Endpoints lie in different processes; start and end events inside embedded subprocesses, and end events inside event subprocesses, are never endpoints; the typed start of an event subprocess is. Timer, conditional, error and escalation events are out of v1. Message flows within one file are facts without a lifecycle; data stores are grouped by `key_norm`. A `calledElement` matching only a key's last segment (bpm-iq file stems) is proposed, not accepted.

**Unambiguous call (auto-accept).** A call is unambiguous when all three hold: (1) the target is a constant, i.e. C7 `calledElement="invoice-check"` or C8 `<zeebe:calledElement processId="invoice-check"/>`, not an expression such as C7 `${target}` or C8 `processId="=target"`; (2) exactly one process in the project's head revisions has that id; (3) that process is not the calling process. Version, binding and tenant attributes (C7 `calledElementBinding`, `calledElementVersion`, `calledElementTenantId`; C8 `bindingType`, `versionTag`) are kept as relation attributes and do not change the target. Everything else becomes a proposal or a finding: no match gives `unresolved-call`; two or more matches give proposals to every candidate plus `duplicate-process-id`; an expression gives `dynamic-call`, and agents may propose candidates; a match only by file stem or label is a proposal. Identical message or signal names are never auto-accepted, because names get reused and one throw may legitimately reach several catches; they arrive as `key`-tier proposals that a reviewer can accept in bulk per tier.

**Assertions** record kind and verdict; `source_kind` (`human`, `agent`, `rule`) with the authenticated principal and client; the declared procedure version and LLM model; the server-computed tier (`key`, `lexical`, `semantic`, `manual`); confidence, rationale and evidence; both endpoint fingerprints; for a pipeline proposal also its basis, the `facts_hash` of both endpoint models as the agent saw them (§3, judge each pair once). **No-links** record the typed pair, the reason, the same provenance and basis, and the analysed model as origin.

**Status.** `recomputeStatus` is a pure function. The latest decision wins, except that a newer proposal whose fingerprints differ from those stored with a rejection reopens the relation as `proposed`. Without a decision, a live proposal means `proposed`; otherwise the relation is `obsolete` and hidden. Human verdicts are `accept`, `reject` and `hold` ("vormerken": a note is required, a question and a label are optional). A held relation has status `held`: it is still open, leaves the review inbox for its own list, appears in agents' claim input, and a later accept or reject replaces the hold.

**Endpoint state** (`ok`, `changed`, `missing`) is recomputed on every ingest and delete; an accepted relation with an endpoint not `ok` is an open item (re-anchoring in R2). A task submission for model M withdraws the live agent judgements (pipeline proposals and no-links, any agent) touching M that were made on another version of M or under another procedure; current ones stay without repetition (§3), and ad-hoc proposals stay.

**PostgreSQL sketch** (Drizzle). Child rows carry `project_id`, with composite foreign keys `(project_id, x_id) → parent(project_id, id)`.

```sql
project(id, key unique, name, last_seq bigint default 0)
principal(id, kind, iss, subject, email, handle, unique(iss, kind, subject))
membership(project_id, principal_id, role)    invitation(id, project_id, email_norm, role, …)
agent_token(id, project_id, principal_id, name, prefix, secret_hash unique, scopes, expires_at,
         revoked_at, created_by, last_used_at)
model(id, project_id, key, name, head_revision_id, deleted_seq, unique(project_id, key))
model_revision(id, project_id, model_id, rev, xml, content_hash, facts_hash, facts_version, source jsonb, principal_id, seq)
fact(revision_id, project_id, kind, element_id, process_id, scope, event_def, label, key_raw, key_norm,
     fingerprint, attrs jsonb, pk(revision_id, kind, element_id))
relation(id, project_id, type, from_ref, to_ref, status, endpoint_state, tier, confidence, version,
         unique(project_id, type, from_ref, to_ref))
relation_assertion(id, project_id, relation_id, seq, kind, verdict, source_kind, principal_id, client_id,
         declared jsonb, submission_id, tier, confidence, rationale, evidence jsonb, from_fp, to_fp,
         from_hash, to_hash, check(not (kind = 'decision' and source_kind = 'agent')))
analysis_task(id, project_id, model_id, revision_id, kind, facts_hash,
         state in ('queued','claimed','done','failed','cancelled'),
         lease_token_hash, claimed_by, lease_until, attempts, last_error, created_at,
         claimed_seq, assignment jsonb, requeue_after)
  unique (model_id, kind) where state in ('queued','claimed')
analysis_submission(id, project_id, task_id unique, principal_id, declared jsonb, payload jsonb, result jsonb, seq)
no_link(id, project_id, type, from_ref, to_ref, from_model, to_model, from_hash, to_hash, reason, source_kind,
         principal_id, client_id, declared jsonb, submission_id, model_id, seq)
no_link_withdrawal(no_link_id pk, project_id, seq, principal_id, reason)
event(project_id, seq, type, principal_id, client_id, subject_ref, payload jsonb, at, pk(project_id, seq))
```

`seq` comes from `UPDATE project SET last_seq = last_seq + 1 RETURNING last_seq` in the writing transaction, which serializes writes per project and keeps `seq` dense for cursors. Triggers block UPDATE and DELETE on `event` and the other append-only tables. The policy limits rule decisions to `call` relations.

## 3. Analysis pipeline

**Ingest** is one transaction: reject DOCTYPE/ENTITY; parse the XML (422 on failure; limits 5 MB per file, 25 MB per import, 50k elements); extract the facts; run the rules; recompute `endpoint_state`; queue a task if needed; write the events.

A `relations` task is queued when the new head's `facts_hash` differs from the previous head's (a revert too, since partners may have judged against the other version meanwhile), and for a new or revived model. Candidates are computed in both directions, so a change to one model never re-queues the others: its re-analysis judges their shared pairs again.

```
 new head, facts_hash ≠ prev head ─┐          requeue (editor), lost judgement
                                   ▼               │
                   ┌──────────► queued ◄───────────┘
   release / lease │               │ claim (lease 15 min, attempts+1)
   expired, < 3    │               ▼
                   └────────── claimed ──── 3rd attempt lost ──► failed
                                   │ submit
                                   ▼
                                  done
 open task + new head with different facts_hash ──► cancelled (new task queued)

 Stage (view model_pipeline)          open_items = relations touching the model that are
   queued  → waiting_for_agent        proposed, held, or accepted with endpoint_state ≠ ok
   claimed → agent_working            (R1: + proposed descriptions; findings never block)
   failed  → agent_failed
   done    → waiting_for_review if any proposed item, waiting_for_clarification if only
             held items, else incorporated
```

The stage shows in `GET /projects/{p}/models?stage=` and MCP `list_processes`; humans can review at any stage.

**Review workflow** (UI first, REST for scripts):
1. **Rule tier:** unambiguous calls are accepted at ingest; a human can still reject them.
2. **Key tier:** identical message and signal names arrive as proposals with confidence 1.0; a reviewer checks them briefly and accepts them in bulk per tier.
3. **Agent proposals** (lexical, semantic, trigger) form the inbox, sorted by confidence and by how many open items a decision closes. Each card shows both endpoints in bpmn-js, the rationale, the evidence and the agent's optional question. Actions: **accept**; **reject** with a reason, which agents see in their next claim; **hold** with a note and an optional question or label (e.g. "mit Fachbereich Finanzen klären"); **correct**, i.e. accept a different endpoint as a `manual` relation linked to the proposal.
4. **Held items** have their own list. An answer is a note on the relation and reaches the next agent run; the decision is made when the answer is known.
5. **Learning loop (R1):** `GET /projects/{p}/eval-export` writes the project's models and decisions in the corpus format (§7), so real review work becomes eval cases.

**Claim and lease:**
- `claim_analysis({projectId?, modelKey?, max ≤ 5})` is one `UPDATE … WHERE id IN (SELECT … ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT n)` over queued tasks and expired leases with fewer than 3 attempts, in projects where the caller is at least `editor`; `modelKey` narrows it to one model. It sets a hashed lease token, `lease_until = now() + 15 min` and `attempts + 1`; expired tasks with 3 attempts become `failed` in the same transaction, so no cron job is needed.
- The claim returns `{taskId, leaseToken, leaseUntil, procedure: {id, version}, input}`. The `input` (≤ ~100 KB) holds the head facts, candidates in both directions (key tier, top 5 lexical matches per endpoint, up to 30 more compatible endpoints) and existing relations, including human rejections, held items, their notes and answered questions. M3 added optional fields within `proa-claim/1`, so older inputs still parse: the ends (`from`, `to`) of message flows inside the file, the documentation of partner endpoints and of their processes (`partnerProcesses`), both cut to 300 characters like the model's own, the project's visible findings with a ref in the model (`findings`), and, with judge each pair once (below), `judged` and `skip`; a pair in either list is left out of the candidates. The largest corpus input grew from 68.7 to 80.1 KB with M3 and is 82.0 KB with every task claimed at once (92.9 KB with LLM-sized judgements in `judged`). The input is rendered in the claim transaction under the project lock. XML only comes through `get_model_xml`.
- No renew; `release_analysis` requeues. A late submit passes if token and principal match and the task was not re-claimed or cancelled (else 409 `lease-lost` or `task-cancelled`). A different second submission gets 409 `already-submitted`; replaying a `submissionId` returns the stored result.

```jsonc
{ "taskId": "ana_…", "leaseToken": "…", "submissionId": "<uuid>",
  "procedure": {"id": "proa-relations", "version": "0.2.0"}, "llmModel": "claude-sonnet-5-5",
  "relations": [{"type": "message", "from": "order/handle#Evt_shipped", "to": "billing/invoice#Start_shipped",
                 "confidence": 0.82, "rationale": "…", "evidence": ["order/handle#Evt_shipped"], "question": null}],
  "noLinks": [{"type": "message", "from": "…", "to": "…", "reason": "no-evidence: …"}], "summary": "≤500 chars", "costUsd": 0.12 }
```

**Validation.** Every ref must exist in the head facts (no hallucinated elements); one endpoint lies in the task's model; types fit endpoint kinds; confidence is in [0, 1]; rationales ≤ 1,000 and questions ≤ 500 characters; ≤ 200 relations and ≤ 500 no-links. Each item comes back as `applied`, `duplicate`, `suppressed` (a human already decided and the fingerprints are unchanged), `reopened` or `invalid:<reason>`; each no-link (typed: without a `type` the server takes the one type the ends fit) as `stored`, `duplicate` or `invalid:<reason>`. Payloads are stored verbatim for the eval, and reviewers can bulk-reject a whole submission.

**Judge each pair once** (procedure `proa-relations@0.2.0`; the owner's requirement of 2026-10-08: no work may happen twice, also with several agents):
- An agent judgement is a live pipeline proposal or a live no-link. Its basis is the `facts_hash` of both endpoint models as the agent saw them at its claim, plus the declared procedure; it is current while both models and the procedure are unchanged.
- The claim assigns each `rule`, `key` and `lexical` candidate pair without a current judgement or a settling decision (accepted, or rejected with unchanged endpoints) to exactly one analysis: a partner's live claim that holds it, else the partner's queued task if its key sorts first and the pair is among its candidates, else this claim, which stores it as its assignment. The input lists the current judgements on the model's pairs (`judged`, any agent, the claimant's own included) and the pairs a partner judges (`skip`). `compatible` candidates are nobody's assignment, only the search space for missing partners.
- A submission withdraws the judgements made on another version of its model or under another procedure; current ones stay without repetition, and a duplicate needs the same basis. A new judgement of the same principal in an analysis of the same model replaces its earlier one on the pair; other judgements coexist, so disagreements stay visible: reviewers see current no-links on the relation (`Relation.noLinks`), in the review screen and as a flag in the bulk dialog. `uncovered` reports assigned pairs left without a verdict; nothing is queued for them.
- A judgement lost outside an analysis (a revoked token, `withdraw_proposal`) queues both endpoint models again, or makes a claimed task queue a follow-up when it is submitted.
- Double work that remains: a `compatible` pair that two concurrent partner searches both examine, re-claims after a lease expired, and candidate-cap drift between two claims (the pair then stays unjudged until one of its models changes).

**Requeue.** A new revision with a changed `facts_hash` cancels the open task and queues a new one. Same facts, or another model's change, only update `endpoint_state`; a lost judgement queues its models (above). A deleted model turns partner relations `missing` (open items). An extractor change runs `proa reindex`, and a procedure upgrade uses `POST …/analyses/requeue {modelKeys | all}`.

## 4. Where the truth lives: store vs Git/OKF

| Requirement | ProA DB | Git/OKF as store |
|---|---|---|
| Agent claims and leases | `SKIP LOCKED` | commits race; a rejected push is not a lease |
| "Which processes throw message X" | indexed `fact` | re-parse files, or build an index (a DB) |
| Per-project authorization via OIDC | domain policy | git-host permissions |
| Concurrent review clicks | a transaction each | a commit each, with conflicts |
| Users without Git | upload | the server commits for them with git credentials |
| Offline reading, diffs, PR review | via export | native |
| Build cost | low | high (clone, merge, credentials, webhooks) |

Git only wins in rows a read-only export covers too. **Decision: hybrid, but asymmetric.** Postgres is canonical for everything computed or decided; BPMN bytes are canonical at their origin (the revision for uploads; a linked repo, later, mirrored with `source={repo,commit,path}` and closed to UI upload).

**Import.** Every adapter yields `{path, bytes, sha256, source}` for `ingest(projectId, files, actor)`; the model key is the slugified path. Upload/`PUT` ships in v1, `proa import <dir>` in R1, a one-shot bpmiq.yml import (vendored MIT `content.ts`) in R2, linked sync and OKF restore later.

**OKF projection (R1, minimal).** Each project head exports as one OKF 0.2 bundle. Leases, memberships and agent tokens are never exported.

```
<project-key>/
  index.md                                     # okf_version: "0.2"
  models/<model-key>.bpmn                      # head bytes, verbatim
  processes/<process-id>.md                    # type: Process; sources → /models/<key>.bpmn#<process_id>
  relations/<type>--<from>--<to>--<hash8>.md   # type: Process Relation; from/to → #element_id, proa: {state, tier, …}
```

| ProA state | `status` | Trust fields |
|---|---|---|
| proposed | draft | `generated.by`: `proa-relations/0.1.0`, `proa-rules/1.0.0` or `human:<handle>` |
| accepted by a human | stable | `verified: [{by: human:<handle>, at}]` |
| accepted by a rule | stable | `verified: [{by: proa-rules/1.0.0, at}]` (machine-confirmed) |
| rejected | deprecated | `proa.decision`, no `verified` |

Rejected relations are exported on purpose, so offline agents do not propose them again. Freshness binds to fingerprints, not to `verified.at` versus `generated.at`. Handles are pseudonymous; no e-mail addresses or `sub` values. The export is deterministic (sorted keys, no timestamp; tested for byte-identical output and resolvable links). Compost compatibility is not a goal. One renderer feeds the zip, `GET …/okf/{path}` and MCP resources; ProA never reads its `.md` files back.

## 5. Interfaces

**HTTP (`/api/v1`):** typed ULIDs; RFC 9457 problem+json; cursor pagination; OpenAPI 3.1 from zod, checked by `oasdiff breaking`; idempotent via `content_hash` and `submissionId`; optional `If-Match` on decisions; landscape ETag `"s<seq>"`.

| Resource | Methods |
|---|---|
| `/me`, `/me/invitations`, `/invitations/{inv}/accept` | GET, GET, POST |
| `/projects[/{p}]`, `…/members` (users, and services as `(iss, client_id)`), `…/invitations` | CRUD (create: any user; other writes: owner) |
| `/projects/{p}/agent-tokens[/{t}]` | GET, POST (secret shown once), DELETE |
| `/projects/{p}/models?stage=`, `…/models/{m}[/revisions/{r}/(content\|facts)]` | GET, DELETE |
| `/projects/{p}/models/by-key/{key}` | PUT raw BPMN → 201 new model, 200 new revision, 200 `unchanged` |
| `/projects/{p}/imports` | POST ≤ 50 files, outcome per file |
| `/projects/{p}/landscape`, `…/relations[/{rel}]` | GET; POST to propose or add a manual relation |
| `…/relations/{rel}/decision` (`accept`, `reject`, `hold`), `…/decisions` | POST; bulk needs ids, versions and `expectedCount` |
| `/projects/{p}/eval-export` | GET (R1) |
| `/analyses/claim`, `/analyses/{a}/submission\|release`, `/analyses/pending?wait=30` | POST, POST, GET |
| `/projects/{p}/analyses[/requeue]`, `…/events?after=&wait=30` | GET/POST, GET long-poll |

Problem types: 422 `validation-failed`, `bpmn-invalid`; 404 `not-found` (also for ids from other projects); 403 `insufficient-scope`, `human-decision-required`; 409 `lease-lost`, `task-cancelled`, `already-submitted`.

**MCP** is stateless Streamable HTTP on `/mcp`. In v1 (local mode, §6) every client sends an agent token as bearer, and the `proa mcp` command bridges stdio-only clients such as Claude Desktop to it. Server mode (R1) adds OAuth discovery on `/mcp` and `/mcp/bearer` without it. With the 2.x SDK it speaks 2026-07-28 and negotiates 2025-11-25 and older; the 1.32 fallback tops out at 2025-11-25. The lease travels in tool arguments, so no session state is needed. Every tool except `list_projects`, `get_procedure` and the pipeline tools requires `projectId`. `claim_analysis` takes it optionally, and `submit_analysis` and `release_analysis` identify the task by `taskId` and `leaseToken`. Read tools carry `readOnlyHint`.

| Tool | Scope | Ships |
|---|---|---|
| `list_projects`, `list_processes` (with `stage`), `get_process`, `get_model_xml`, `get_relations`, `which_processes_use`, `find_unlinked_events`, `get_procedure` | read | MVP |
| `claim_analysis`, `submit_analysis`, `release_analysis` | propose | MVP |
| `get_landscape`, `propose_relation`, `withdraw_proposal` | read, propose | v1 |
| `put_model` (≤ 1 MB), `requeue_analysis`, `impact_of`, `trace_landscape_path`, `get_findings` | write, read | R1 |

There is no decide tool; an attempt returns `human-decision-required` with the review URL. Prompts and `instructions`: §7. Resources: `proa://projects/{p}/models/{key}.bpmn` and `…/landscape.json`.

**Events:** `model.revised|deleted`, `analysis.queued|claimed|done|failed`, `relation.proposed|decided|endpoint_changed`, `member.changed`, `agent_token.created|revoked`. Long-polls wait on Postgres `LISTEN`; webhooks will read the same table.

## 6. Auth and authorization

**Local mode (v1, `PROA_AUTH=local`).** ProA runs on the user's machine (`docker compose up`, Postgres included) and needs no IdP. The server binds to 127.0.0.1 only and rejects requests whose `Host` or `Origin` is not localhost (DNS rebinding, CSRF). The web UI and REST calls with the local session act as the single owner, a human on an interactive client. Every MCP client uses an agent token from the "connect an agent" page, which also prints ready-made configurations:
- **Claude Code, Cursor, VS Code, Codex:** HTTP `http://localhost:<port>/mcp` with `Authorization: Bearer proa_at_…`, e.g. `claude mcp add --transport http proa http://localhost:<port>/mcp --header "Authorization: Bearer ${PROA_TOKEN}"`.
- **Claude Desktop and other stdio-only clients:** an entry in `claude_desktop_config.json` that starts the bridge `proa mcp` (reads `PROA_URL` and `PROA_TOKEN`; from the repo checkout via `node`, or `docker exec -i` into the ProA container) and forwards stdio to `/mcp`. Remote custom connectors are not used in v1: they connect from the vendor's cloud and cannot reach localhost. An npm package and a Desktop Extension follow after the license decision.

The domain policy is the same in both modes; local mode simply has one human principal. Server mode (R1) adds users, memberships, invitations and OIDC:

**Resource server (server mode, R1).** ProA is never an authorization server or OAuth proxy; agent tokens are API keys for ProA itself. `PROA_PUBLIC_URL` defines the canonical resource `https://<host>/mcp`, the audience for REST and MCP alike; users enter exactly this URL. `/.well-known/oauth-protected-resource/mcp` (RFC 9728) returns it, exactly one authorization server (some clients may read only the first; spike) and `scopes_supported: proa:read proa:propose`. Unauthenticated calls to `/mcp` get 401 with `WWW-Authenticate: Bearer resource_metadata="…", scope="proa:read proa:propose"`; a missing scope gets 403 `insufficient_scope`. Every other `/.well-known/` path on ProA's origin answers 404 and never the web app's fallback page, including the root `oauth-protected-resource`, `oauth-authorization-server` and `openid-configuration`. `/mcp/bearer` answers 401 without `resource_metadata`, for clients that drop configured headers once discovery answers (Cursor, some VS Code setups).

**Token validation** reads the header only, on REST and MCP. `Bearer proa_at_…` is looked up in `agent_token`; anything else is a JWT checked by `jose` against the issuer's JWKS: `iss` exact, `aud` in `PROA_AUDIENCE` (default: the canonical resource), `exp`/`nbf` with 60 s skew, RS256, PS256 or ES256. Without an audience the server will not start, except with `PROA_AUTH=dev`. Identity is `(iss, sub)`, never the e-mail; the client is `azp`, `client_id` or `agt_…`. ProA never forwards a token.

**Clients in server mode.** Registration is IdP configuration, not ProA code.

| Client | Credential | Notes |
|---|---|---|
| Claude Code (subscription or API key) | user OAuth | `claude mcp add --transport http … --client-id proa-mcp --callback-port <port>` (whether a public client works without `--client-secret`: spike) |
| Claude Desktop, claude.ai, Claude Code Routines (via claude.ai connectors), ChatGPT developer mode | user OAuth | `proa-mcp` as custom client (for ChatGPT documented only by third parties; auth spike), or DCR; public URL |
| VS Code, Cursor, Gemini CLI, Codex | user OAuth or agent token | `proa-mcp` or DCR; header-only setups use `/mcp/bearer` |
| Claude Code `-p`, Agent SDKs (Claude, OpenAI), TS MCP SDK, CI | agent token or IdP client-credentials token | operator's secret store |
| Claude Managed Agents (vault `static_bearer`), OpenAI Responses API, Claude API MCP connector | agent token or bearer minted per request | public URL |

"Public URL": the vendor's cloud calls ProA (check the vendor's published egress ranges before allowlisting), so ProA and the IdP must be reachable from there; local Compose suffices for clients that connect from the developer's machine (Claude Code, VS Code, Cursor, Gemini CLI, Codex); Claude Desktop's custom connectors connect from Anthropic's cloud.

**IdP setup (server mode).** Keycloak 26.8, realm export in a Compose profile:
- `proa-web` (PKCE), `proa-cli` (PKCE, device flow) and `proa-mcp` (public, PKCE S256, refresh-token rotation, redirect URIs of the known clients).
- An Audience mapper in a realm default client scope gives every token, DCR clients included, the canonical `aud`. Experimental resource indicators and CIMD stay off.
- Optional anonymous DCR, limited by Trusted Hosts, Allowed Client Scopes and Max Clients, plus cleanup, since claude.ai registers per connection and Gemini CLI per login.
- `proa-mcp` and DCR clients can never obtain `proa:review`.

WorkOS: CIMD, DCR and a resource indicator for the canonical resource. Tokens requested without `resource`, such as M2M tokens, carry the environment client id as `aud`, which `PROA_AUDIENCE` may include only with the `org_id` gate.

**Agent tokens (MVP)** are the universal machine credential: every headless client accepts a static bearer, while Keycloak has no personal access tokens, Managed Agents cannot run client credentials, and project owners are often not IdP admins.
- `proa_at_<32 random bytes, base62><checksum>`, recognizable by secret scanners; stored as sha256 plus an 8-character prefix.
- One project; scopes from `proa:read`, `proa:propose`, `proa:write`, never review or owner actions; mandatory expiry (default 90 days, at most 365); revocation within 30 s; `last_used_at`.
- Created and revoked only by an owner on an interactive client; never advertised in the PRM.

**IdP client credentials** need no extra code: an owner registers `(iss, client_id)` as a service with a role of at most `editor`.

**Principals and provenance.** The system principal `proa-rules` may only accept `call` relations during ingest. Interactive clients are listed in `PROA_INTERACTIVE_CLIENTS` (default `proa-web,proa-cli`), never `proa-mcp`, DCR or CIMD ids. `source_kind` is derived, never sent: `human` is a user on an interactive client, `rule` the system principal, `agent` everything else, including a person chatting in claude.ai or ChatGPT.

**Permission = scope ∩ role ∩ principal rule:**

| Capability | Scope | Min role | Principal |
|---|---|---|---|
| Read | `proa:read` | viewer | any |
| Propose, claim, submit, release, withdraw own | `proa:propose` | editor | any |
| Ingest, delete models, requeue | `proa:write` | editor | any |
| Decide, create an accepted manual relation | `proa:review` | editor | user on an interactive client |
| Members, invitations, services, agent tokens, delete project | `proa:write` | owner | user on an interactive client |

Scopes nest (review ⊇ propose ⊇ read, write ⊇ read); higher scopes come through a 403 challenge. An agent token acts as `editor` (`viewer` if read-only). Any user may create a project and owns it.

**Tenancy:** one deployment per tenant; an optional gate `PROA_REQUIRED_CLAIM=org_id:<id>` fails closed. **Invitations** (14 days) need explicit acceptance with `email_verified`, a matching normalized e-mail and an interactive client. **Enforcement:** every use case starts with `policy.require(actor, perm, projectId)`, repositories only expose `findInProject`, foreign ids return 404, and a generated matrix tests use case × role × principal kind × credential type × foreign project.

| Agent threat | Mitigation |
|---|---|
| Prompt injection via labels, documentation, rationales | Agents cannot decide (policy and DB check); refs are validated; labels capped at 200 characters, documentation at 2,000, control and bidi characters stripped. |
| Data reaching an unwanted vendor | Agents send what they read to their model vendor. The IdP decides which clients connect; agent tokens read one project; tool pages hold ~100 KB; ProA tools reach nothing outside; rationales render as plain text under a strict CSP. |
| Leaked credential | Agent tokens: one project, no review, expiry, revocation, hashed, scannable. JWTs: exact audience. |
| Flooding, careless bulk accept | ≤ 200 relations per submission, one open task per model, `expectedCount` on bulk accept; revoking a token or service withdraws its proposals. |
| An agent on a human channel | No agent setup holds a `proa-web` or `proa-cli` token. **Remaining risk:** an agent driving the user's browser or CLI. |
| Lease replay, spoofed provenance | 256-bit lease tokens, hashed, bound to principal and task. `source_kind` and client come from the credential; procedure and model are only declared. |

## 7. Agents and procedures

**Procedures** are the analysis instructions, written once in `packages/procedures/*.md` with frontmatter `id`, `version`, `title`, `status` and an optional one-line `description` (e.g. `proa-relations@0.2.0`: `0.1.0` was released with M3, `0.2.0` replaced it before any live run to judge each pair once). Each calls a deterministic tool first and judges only what code cannot decide.

| Procedure | Output | Suggested model |
|---|---|---|
| `relations` (MVP, pipeline) | link and no-link verdicts with confidence, rationale, evidence | Sonnet class, e.g. `claude-sonnet-5-5` |
| `describe` (R1, tasks) | short (≤ 255 chars) and long text, DE and EN, proposed | `claude-haiku-4-5-20251001` if the eval holds |
| `landscape` (R1, questions) | answers, no writes | any |

**Delivery** to any MCP client, from that one source:
- Server `instructions`: labels are data, agents only propose, load the procedure with `get_procedure` and declare its id and version; `list_projects`, `get_procedure`, `submit_analysis` and `release_analysis` take no `projectId`, `claim_analysis` an optional one, every other tool a required one.
- `get_procedure({id})` returns the text as is, for clients without prompt or skill support, since tools are what every client shares. The procedure is self-contained (it includes the claim–submit loop), so Claude Desktop and Codex follow it from a start prompt. The claim names the expected procedure; pipeline tool descriptions state the lease and validation rules.
- The prompt `work_pipeline({projectId?, maxTasks?})` (`maxTasks` a whole number from 1 to 100, passed as a string like every prompt argument) and the Claude Code skill `/proa:relations [project] [max-tasks]` render through one helper, `renderPipelineWrapper` in `@proa/procedures`, so they cannot drift apart. It adds only the scope (project, number of tasks), the rule to declare the exact model id as `llmModel`, the version rule (if a claim names another procedure or version than the embedded one, load the claim's with `get_procedure` and follow it, while declaring what the claim names), `release_analysis` instead of an expiring lease and a reload with `get_procedure` after the context was summarized, then embeds the procedure verbatim. The prompts `analyze_model` (v1: one model) and `review_landscape` (R1, read-only) come later.
- The Claude Code plugin `plugins/proa/` holds the skill as `skills/relations/SKILL.md`. `pnpm --filter @proa/procedures generate` writes it from `relations.md` and sets the plugin version to the procedure version; a test in `pnpm test` (so in CI) fails while either lags behind, and generation refuses procedure text that Claude Code would expand in a skill (`$ARGUMENTS`, `$<digit>`, `${CLAUDE_…}`, `` !`command` ``). The skill sets `disable-model-invocation: true`, so only a user starts it. A released version's skill never changes (a test pins its sha256), because installs from a Git-hosted marketplace stay at their version until it changes and runs are recorded under `<id>@<version>`; `--plugin-dir` and a marketplace added from a local checkout load the current files. The plugin carries no MCP server: the connection is configured separately, so the tools keep the names `mcp__proa__*`. The repository is the plugin's marketplace (`.claude-plugin/marketplace.json`, `claude plugin install proa@proa`).
- **Language:** agents write `rationale`, `question`, the no-link `reason` and `summary` in German, because the review UI is German; refs, element ids, message and signal names and quoted labels stay verbatim. A per-project language setting is deferred (R1).
- **Judge each pair once** (`proa-relations@0.2.0`, §3): an agent judges its pairs (the `rule`, `key` and `lexical` candidates and relations in neither `judged` nor `skip`, except settled ones) and every other pair it examines, `compatible` candidates and partner-search hits included, each with a proposal or a typed no-link, so partner tasks skip them; it leaves `judged` and `skip` pairs alone and contradicts a `judged` verdict only with concrete evidence, by a judgement of its own. The `0.1.0` rule "repeat every pair you still support" is gone.

**Deterministic library (no LLM):** `@proa/bpmn-facts`; `@proa/relations` (normalization, compatibility matrix, rule tier, candidate scoring by token Jaccard plus a label-length-relative Levenshtein distance, German and English stopwords, a short synonym list); R1 lint rules such as `dangling-throw` and `unresolved-call`.

**Starting agents** is the operator's job: users invoke `/proa:relations` (the model cannot), `work_pipeline` or a start prompt; deployed agents run on a schedule, long-poll `GET /analyses/pending?wait=30` or, from R2, react to webhooks.

**Reference setups** (`examples/agents/`) are runnable documentation: not workspace packages, imported by nothing in `apps/` or `packages/`, not in the image, and never run against a model by CI. Each starts in a directory outside the checkout, all but Codex with ProA's MCP tools only, because `eval/` holds the ground truth:
- `claude-code/`: `mcp.json` (`${PROA_URL:-http://127.0.0.1:7400}/mcp`, `Bearer ${PROA_TOKEN}`, `alwaysLoad`) for an interactive session with `--strict-mcp-config --mcp-config --plugin-dir plugins/proa --tools "" --allowedTools "mcp__proa__*"`, and `run-headless.sh <project> <model> [batch-size] [max-batches]`, one fresh `claude -p "/proa:relations <project> <batch-size>"` with `--permission-mode dontAsk` per batch until `GET /api/v1/analyses/pending?projectId=` reports none, or a batch fails or makes no progress (exit 1). `claude -p` bills `ANTHROPIC_API_KEY` ahead of the subscription login, so the script refuses to start with it set unless given `--allow-api-billing`.
- `claude-desktop/`: entries for the `proa mcp` bridge (in the container via `docker exec`, or from the checkout) and a German start prompt (project, exact model id, batch size) that loads the procedure with `get_procedure`; one new chat per batch.
- `codex/`: a `config.toml` entry (`url`, `bearer_token_env_var = "PROA_TOKEN"`); Codex takes the same start prompt. It keeps its own shell and file tools, and its sandbox does not restrict reads, so a working directory does not keep it out of `eval/`: on the holdout it runs only in an environment without read access to the checkout (a container or VM without it, another OS user or machine).

For now, models are evaluated through MCP with these local agents only (owner decision 16, [HANDOFF.md](HANDOFF.md) §4): the Claude Agent SDK, Claude Managed Agents, the OpenAI Responses API and the OpenAI Agents SDK have no reference setup. That `claude -p` expands the plugin skill (as Anthropic's headless documentation says) and that ProA's tools stay available with `--tools ""` and `alwaysLoad` is unverified until the owner's first runs.

**Cost** is the operator's: with Sonnet 5.5 on an API key ($2/$10 per million input/output tokens), about $0.10–0.20 per revision, $30–60 for 300 models.

**Eval:**

```
eval/corpus/<landscape>/{landscape.yaml, models/*.bpmn, expected.yaml}   # lang, split dev|holdout, closed_world
eval/recordings/<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl
eval/tools/src/{candidates,replay,live,live-gate}.ts                    # eval:candidates, eval:replay, eval:live
```

Each entry has `type`, `from`, `to`, `expect` (`must_link`, `must_not_link` or `may_link`) and tags. In a `closed_world` landscape, any unlisted pair counts as a false positive. Live runs are agent-agnostic: `proa seed <landscape> --project <key> --issue-tokens --token-name <run>` loads a landscape into a fresh project and issues a read+propose agent token, any agent works the pipeline with it, and `eval:live` reads the project's stored submissions over REST into a recording (the agent is the token name; no claim input, which the server does not keep) and scores it with the `eval:replay` scorer.

| Gate | When | Criterion |
|---|---|---|
| `eval:candidates` | every PR, no LLM | ≥ 98 % of `must_link` pairs among the candidates; rule-tier precision 1.0; reported against `baseline-proa1` (Levenshtein ≤ 4) |
| `eval:replay` | every PR, no LLM | precision, recall and F1 per type and tag, from recordings; the committed report must match a fresh run; it shows the live gate but enforces nothing |
| live | by the owner before a procedure release, with Claude Desktop or Claude Code on the owner's subscription (owner decision 13, [HANDOFF.md](HANDOFF.md) §4); one fresh project and agent token per run, the token name is the recording's agent; 3 runs per landscape on a pinned model (the declared `llmModel`); `eval:live` exits 1 on fail | per procedure version, landscape and declared `llmModel`, over its live runs (any agent but `agent-sim`): **fail** if a run proposes a `must_not_link` pair at confidence ≥ 0.8, or the mean recall is more than 5 points below the baseline (the mean recall of the live runs of the highest earlier x.y.z version on that landscape with the same `llmModel`, else the `agent-sim` recordings of the same version, whatever their model); else **incomplete** with fewer than 3 runs or no baseline; else **pass** |

Recall here is the proposals' (`overall`, without the rule tier's acceptances), averaged over the runs that have one; exactly 5 points below the baseline passes. Fail is checked first, so a single run can fail a version on its model. Runs with another model form a gate of their own and never mix into a model's means; runs of different clients with the same `llmModel` do. A project is never reused across runs: its claims list an earlier run's current judgements in `judged` and leave those pairs out of the candidates (§3), so a second agent would judge almost nothing, and earlier proposals would bias the claim input.

**Seed cases:** one per 1.x weakness ("Order received" ≠ "Order rejected", "prüfen" = "pruefen", timer end ≠ message start, subprocess events stay inside, DE/EN pairs); rewritten XXE tests; 5 describe cases (R1); an anonymized holdout landscape. Decision memory is covered by Postgres integration tests.

## 8. Stack and repository

| Area | Choice |
|---|---|
| Base | Node 24 LTS, strict TypeScript, pnpm workspaces, zod 4 |
| Server | Hono with `@hono/zod-openapi`; `@modelcontextprotocol/server` 2.x (2026-07-28 and 2025-11-25), with v1 `@modelcontextprotocol/sdk` 1.32 as fallback if the spike finds gaps |
| Data | PostgreSQL 17, Drizzle, `pg`. No Redis. |
| BPMN | `bpmn-moddle` 10 with zeebe and camunda extensions (`@bpmiq/notations/extract.ts` drops event definitions and refs) |
| Auth | v1: local mode, agent tokens only, no IdP. Server mode (R1): `jose`, Keycloak 26.8 in a separate Compose profile, WorkOS for hosted instances. |
| Web | React 19, Vite, TanStack, Tailwind v4, shadcn, a hey-api client; bpmn-js for review; diagram-js + elkjs for the map (R1); follows `miragon-brand:modeler-tool-design` |
| Tests | vitest against real Postgres (lease races need it); MCP contract tests with the plain SDK client (`tools/list` and `prompts/list` snapshots, scope/cross-project matrix, both credential types); Playwright |
| Delivery | One image `ghcr.io/miragon/proa` (`edge` from develop, semver from `v2.*` tags) via `flyctl deploy --image` or Compose. No runner image. |

```
apps/server/src/{domain,db,http,mcp,auth}   # dependency-cruiser: domain imports none of the others
apps/web/  plugins/proa/  examples/agents/  eval/  docker/compose.yaml
packages/{contracts,client,bpmn-facts,relations,procedures}
```

## 9. Repository transition

Starting point (checked 2026-10-05): the remote has only `develop` and no tags or releases. `develop` already has the active ruleset `main`: pull requests, squash only, linear history, signed commits, no deletion or force push, no bypass actors, and no required status checks. 1.x is `1.3.0-snapshot` at develop HEAD `eb3539b`. `deploy.yml` would push `ghcr.io/miragon/proa:dev` (from develop) and `:prod` (from `main`, which does not exist), but it has never run, so no `proa` image exists in the Miragon registry.

**Step 1, freeze 1.x,** before any 2.0 commit reaches develop:
- Tag `v1.3.0` on `eb3539b`; its release marks 1.x as maintenance only.
- Branch `maintenance/1.x` from the tag for security fixes (`v1.3.x`). Its first commit sets `1.3.1-snapshot` and adds the branch to the pull-request triggers of `backend-tests.yml` and `frontend-checks.yml`. It also replaces `deploy.yml` and the Maven-release `release.yml` with one workflow that builds `ghcr.io/miragon/proa:<version>` when a `v1.3.*` tag is pushed. The old `release.yml` cannot be kept: its `scm` URL points at `envite-consulting/ProA`, and `workflow_dispatch` only runs workflows that exist on the default branch.
- Build `ghcr.io/miragon/proa:1.3.0` from the tag with the 1.x `Dockerfile` (no 1.x image has been published yet) and pin 1.x deployments to it. 2.0 never publishes `:dev` or `:prod`.
- Extend the existing `develop` ruleset to `maintenance/1.x` (pull requests, squash merges, no force pushes). Require status checks only from workflows without path filters. On `maintenance/1.x`, add them after its CI commit. On `develop`, require the `ci.yml` job once the cut-over PR has added it: the 1.x checks are path-filtered, the cut-over deletes them, and the ruleset has no bypass actors.

**Step 2, one cut-over PR to develop,** squash-merged; all 1.x commits stay in the history before it.

| Path | Action |
|---|---|
| `backend/`, `frontend/`, `pom.xml`, `mvnw*`, `.mvn/`, `Dockerfile`, `eclipse-formatter.xml`, `Makefile`, `scripts/`, `docker-compose.yml` | deleted; replaced by the monorepo and `docker/` |
| `.github/workflows/*`, `.githooks/` | deleted; replaced by `ci.yml` (lint, types, tests, eval gates, `oasdiff`, plugin drift) and `release.yml` |
| `docs/{ARCHITECTURE,IMPROVEMENTS,UI-MIGRATION}.md` | moved to `docs/1.x/`, frozen |
| `docs/adr/` | kept; ADR-0001 and ADR-0003 marked as 1.x decisions, ADR-0002 (never implemented) marked superseded by ADR-0004, links updated |
| `.github/dependabot.yml`, `.claude/` | kept; Maven removed, pnpm at `/`, fixed-versions rule rewritten for pnpm |
| `README.md`, `.gitignore` | rewritten: what 2.0 is, quickstart, connecting an agent, where 1.x lives |
| `LICENSE` | unchanged until the license decision |

**Step 3, build on develop** in small squash-merged PRs. `package.json` versions stay at `2.0.0-alpha.N` without git tags, so only `edge` images are published, until `v2.0.0` is tagged after the v1 UI step and the license decision.

**License prerequisite.** `LICENSE` is CC BY-NC-SA 4.0, not written for software, and much 1.x code has envite authors. 2.0 copies no 1.x source, tests or fixtures, so both options stay open: CC BY-NC-SA for everything, or a software license for 2.0 code with a NOTICE that pre-cut-over history stays CC BY-NC-SA. Legal decides before `v2.0.0`; until then packages stay `private: true`, and only `edge` images are published.

## 10. MVP slice and roadmap

**MVP (about 3 weeks, headless, no UI):**
1. **Week 1:** transition steps 1–2; scaffold, schema, `bpmn-facts`, ingest, rules, relation lifecycle; the test landscapes `nordwind-handel` (dev) and `stadtwerke-auental` (holdout) in `eval/corpus`, Camunda 7 and 8, deploy-checked against both engines; `eval:candidates` in CI.
2. **Week 2:** local mode (127.0.0.1 binding, Host/Origin checks, owner session), agent tokens and the `proa mcp` stdio bridge; policy matrix; pipeline, stages, review verdicts incl. `hold`, REST, events; MCP tools, `get_procedure`, `work_pipeline`; integration tests for decision memory and lease races.
3. **Week 3:** the `relations` procedure and plugin wrapper; the `claude-code`, `claude-desktop` and `codex` reference setups; live runs; `eval:replay`.

**Auth spike (R1, server mode, 1–2 days):** Keycloak loopback matching without fixed ports; Claude Code `--client-id` with a public client (no secret); claude.ai/Desktop connector registration (DCR vs. a user-supplied client id) and how it reads the PRM; ChatGPT with `proa-mcp` as user-defined OAuth client; Gemini CLI DCR re-registration; SDK negotiation with 2025-06-18 and 2025-11-25 clients; ChatGPT with a path-inserted-only PRM; Keycloak's DCR client limit and cleanup; `aud` after a Codex refresh; which clients use prompts.

**Done when:**
- uploading 3 models with curl shows the `call` links at once
- three local agents work the same pipeline over MCP: Claude Desktop through the `proa mcp` bridge, Claude Code on a subscription over HTTP, and a non-Claude client (Codex with `bearer_token_env_var`) that loads the procedure through `get_procedure`. Assertions show distinct principals, clients and declared models.
- an LLM-free contract test with the plain MCP SDK client runs claim, submit and release with both credential types
- decisions made in local mode (UI or REST with the owner session) survive a re-upload; held items stay held; deciding over MCP fails with `human-decision-required`
- the eval report shows precision and recall per agent against `baseline-proa1`
- no LLM credential exists in ProA's configuration, image or database

| Step | Scope | Effort |
|---|---|---|
| v1 UI (local) | projects and agent tokens; a "connect an agent" page with ready-made configurations for Claude Desktop, Claude Code, Cursor, VS Code and Codex; upload; inbox by stage; review screen (evidence, bpmn-js highlight, accept/reject/hold/correct, bulk per tier, held list); `analyze_model`, `propose_relation`; Playwright; one `docker compose up` | 1.5–2 weeks |
| R1 | server mode: OIDC (Keycloak), users, memberships, invitations, PRM and OAuth for MCP, a public URL for claude.ai, ChatGPT and Claude Code Routines, the auth spike; landscape map with saved views; lint; `describe` and `landscape` procedures; `impact_of`, `trace_landscape_path`; minimal OKF export and `eval-export`; npm package and Desktop Extension for the bridge; `put_model` | 3–4 weeks |
| R2 | bpmiq.yml import; rename and re-anchoring; an MCP App widget; webhooks; a WorkOS deployment incl. M2M audience check; a review assistant, if approved | 2–3 weeks |

## 11. Deferred on purpose

- **Versioning:** project versions, branches, named tags and a diff view (later one `landscape_tag(project_id, name, seq)` table), the landscape "as of seq".
- **Pipeline:** neighbour rechecks, priorities, lease renewal, a judgment cache beyond judging each pair once per change of its models (§3), `agent_run` bookkeeping, minimum procedure versions, a runner shipped with ProA.
- **Relations and content:** cross-project relations, external placeholders, error/escalation/link/compensation relations, DMN refs, fuzzy data-store matching, agent findings, comments, embeddings, runtime data.
- **Sync and export:** linked Git sync, OKF restore, foreign OKF, the Web Modeler, `messages/`, `findings/` and `log.md` in the export.
- **Platform and auth:** stdio MCP, MCP subscriptions, an authorization server or OAuth proxy in ProA, Keycloak CIMD while experimental, Enterprise-Managed Authorization (ID-JAG), token exchange, DPoP/mTLS, WorkOS API keys, personal user tokens (`proa-cli` uses device flow), row-level security, a shared multi-tenant instance.
- **Decisions:** auto-accept beyond `call`, and deciding via MCP.

## 12. Open questions for the owner

1. **Auto-accept.** Should only an unambiguous `calledElement` match be accepted without a click? Identical message and signal names would stay proposed, bulk-acceptable per tier.
2. **First users.** Will they upload through the UI, or work from bpmiq.yml/Git repositories? The answer decides whether folder and bpmiq.yml import move into v1.
3. **Held items.** Is a note plus an optional question enough for "vormerken" in v1, or do you need routing to people (assignee, due date, notification)?
4. **License** (prerequisite for `v2.0.0` and for publishing the bridge as npm package or Desktop Extension). Which license applies to 2.0 code? The test landscapes in `eval/corpus` are synthetic and written for 2.0.
5. **1.x.** How long does `maintenance/1.x` get fixes? Were 1.x versions snapshots or as-is/to-be variants? 2.0 treats variants as separate projects.
