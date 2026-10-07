# ADR-0004: ProA 2.0 is a headless landscape store; any agent analyses over MCP, humans decide

- Status: **proposed** (2026-10-05)
- Deciders: Dominik Horn
- Related: `docs/proa-2/CONCEPT.md`; ADR-0001 (Keycloak), ADR-0002 (diagram stack, `@proa/relations`) and ADR-0003 (invitations) record 1.x decisions.

## Context

ProA 1.x (Quarkus, Vue) links processes by matching labels in uploaded BPMN. Its limits are structural:

- **Relation detection:** an absolute Levenshtein threshold, stripped umlauts, ignored event definitions and `calledElement`, subprocess events treated as process-level; no confidence or rationale; decisions lost on replace.
- **Identity and security:** a replaced model gets a new id, split collaborations corrupt the XML, and authorization in REST and repositories produced IDORs.
- **Ecosystem:** every AI-facing Miragon component is TypeScript, keeps the LLM in the host and exposes MCP tools.

The owner decided on a greenfield 2.0 in TypeScript with generic OIDC: headless first, intelligence in agents, a pipeline of models waiting for analysis. Two later decisions shape this record: 2.0 is rebuilt in the existing repository `Miragon/ProA`, and any agent the operator chooses must be able to drive ProA over MCP, from a local Claude subscription (Claude Code, Claude Desktop) to deployed agents (Claude Agent SDK, Claude Managed Agents, other vendors).

## Decision

1. **Headless store, one deployable.** One Hono server serves REST at `/api/v1` (OpenAPI 3.1 from zod), MCP at `/mcp` and the web app, all calling the same domain use cases.
2. **PostgreSQL is the system of record.** Files are for exchange only: BPMN in, an OKF 0.2 bundle out (R1), no sync back.
3. **One model = one BPMN file with an immutable key.** Re-uploads create revisions; collaborations are never split; no project versions.
4. **Code computes facts, agents judge, humans decide.** Ingest extracts facts and computes candidates. Agents propose with provenance. Only humans accept, reject or hold ("vormerken"), except that `proa-rules/1.0.0` accepts an *unambiguous* call: a static `calledElement` (C7) or `zeebe:calledElement processId` (C8) that equals the id of exactly one process in the project's head revisions, outside the calling process (CONCEPT §2).
5. **Relations remember decisions.** Each relation has an append-only assertion log, and its status is a pure function of assertions and head facts. A rejection reopens only when an endpoint's fingerprint changes. A held relation stays open with a note and an optional question, outside the main review inbox.
6. **The pipeline is one table, `analysis_task`,** claimed with `FOR UPDATE SKIP LOCKED` under a 15-minute lease, queued only when a model's `facts_hash` changed; inbox stages are derived.
7. **Agents are external and freely chosen.** ProA ships no runner and holds no LLM credentials; the agent's operator brings model, credentials and compute. One procedure text reaches any MCP client through server instructions, tool descriptions, MCP prompts (`work_pipeline`, `analyze_model`) and a `get_procedure` tool; the Claude Code plugin skill is generated from it. Reference agents (headless Claude Code, an Agent SDK worker) live in `examples/`, outside the product.
8. **Authorization lives in the domain.** Every use case starts with `policy.require(actor, permission, projectId)`; composite foreign keys keep rows within one project. Permission = scope ∩ project role ∩ principal rule. The review scope counts only for users on interactive clients (`proa-web`, `proa-cli`), so no agent can decide through its own MCP client or machine credential. An agent driving a user's browser or CLI remains a residual risk.
9. **v1 runs locally; server mode makes ProA an OAuth resource server.** v1 (`PROA_AUTH=local`) needs no IdP: the web UI on 127.0.0.1 is the local owner, and every MCP client uses a ProA-issued agent token. Claude Code, Cursor, VS Code and Codex connect over HTTP on localhost; Claude Desktop through the `proa mcp` stdio bridge. Server mode (R1) never makes ProA an authorization server or proxy: `jose` validates JWTs from one OIDC issuer (Keycloak, or WorkOS for Miragon-hosted instances; one deployment per tenant), with Protected Resource Metadata, 401/403 challenges and one exact audience, `https://<host>/mcp`. Interactive clients log users in through a pre-registered public client `proa-mcp`, optionally DCR, and CIMD where the IdP supports it stably. Deployed agents use **ProA-issued agent tokens**: one project, scopes at most read/propose/write, mandatory expiry, revocable, created only by an owner. IdP client credentials remain an alternative.
10. **An eval corpus is the spec.** Golden landscapes with `must_link`/`must_not_link` pairs gate PRs without an LLM. For a procedure release, an agent works a seeded project and its stored submissions are scored, so any agent can be measured.
11. **Same repository, rebuilt in place.** Tag `v1.3.0` on develop `eb3539b`, branch `maintenance/1.x` from it, pin 1.x deployments to an immutable image tag. One squash-merged PR to `develop` then replaces the Maven/Vue tree with a pnpm monorepo on the 2.0.0 version line. The license of 2.0 code needs a legal decision before the first 2.0 release.

## Consequences

Positive:
- UI, REST and MCP share one code path; agents query indexed facts, not XML.
- Any MCP client can do the work, interactive or headless; model cost sits with whoever runs the agent.
- Decisions survive re-uploads, and every proposal names its principal, client, declared procedure and model.

Costs and risks:
- **This is a rewrite.** A usable v1 with UI takes about 5 weeks. 1.x stays runnable from the maintenance branch; no data is migrated.
- **Most links need an agent,** started by the operator; without one, ProA shows identifier links only.
- **Provenance is partly self-declared.** ProA authenticates principal and client but cannot verify the model or procedure version.
- **Cloud clients wait for server mode:** claude.ai, ChatGPT and Claude Code Routines call from the vendor's cloud and need a public URL (R1). Client auth there is uneven (Cursor drops headers when discovery answers, DCR clients accumulate); a spike in R1 settles it.
- **Agent tokens are long-lived secrets** (hashed, scannable prefix, expiring).
- **Changed element ids lose decision memory** until re-anchoring (R2); Git users get an import, not a sync.
- **The license is unresolved.** 2.0 copies no 1.x code or fixtures, so every option stays open.

## Alternatives considered

- **Git/OKF bundle as the store, or bidirectional sync.** Offline reading and diffs come from a deterministic export too; Git is worse for leases, indexed queries, project authorization and concurrent review.
- **A mandatory runner or an LLM judge inside ProA.** Ties every deployment to one agent and one LLM key, and duplicates the host's agent loop.
- **IdP client credentials as the only machine credential.** Keycloak has no personal access tokens, Managed Agents vaults hold only a static bearer or a refresh token, and project owners are often not IdP admins.
- **ProA as authorization server or OAuth proxy.** Security-critical code that no researched client needs.
- **A new repository.** Clean history and license, but splits issues, links and the image name; rejected by the owner.
- **Landscape tools in bpm-iq, or a separate MCP server calling REST.** bpm-iq keeps Git as its record; a second deployable needs token exchange.
