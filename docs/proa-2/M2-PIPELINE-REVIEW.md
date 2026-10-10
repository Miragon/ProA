# ProA 2.0 – Milestone M2 "Pipeline and review"

Status: in progress · Branch: `claude/proa-2` · Spec: [CONCEPT.md](CONCEPT.md) §2, §3, §5, §6 · Previous: [M1-SKELETON.md](M1-SKELETON.md)

M2 makes ProA AI-first in practice: any MCP client can work through the analysis pipeline and
propose relations with provenance, and the owner reviews them (accept, reject, hold, correct)
with decisions that survive re-uploads. M3 adds the real `relations` procedure and live runs
with Claude Desktop/Code; M2 is proven with a deterministic, LLM-free simulation agent.

## In scope

1. **Analysis pipeline (CONCEPT §3).** `claim_analysis({projectId?, modelKey?, max ≤ 5})` with
   `FOR UPDATE SKIP LOCKED`, 15-minute lease, at most 3 attempts, hashed lease token bound to
   principal and task, expired tasks with 3 attempts become `failed` in the claim transaction;
   `submit_analysis`, `release_analysis`; a new revision with a changed `facts_hash` cancels the
   open task and queues a new one; `POST …/analyses/requeue {modelKeys | all}`;
   `GET /analyses/pending?wait=30` long-poll on Postgres `LISTEN`.
2. **Claim input.** Head facts of the model, candidates in both directions from
   `@proa/relations` (key tier, top lexical matches, further compatible endpoints) in a compact
   rendering that stays under ~100 KB for the largest corpus model, and the existing relations
   touching the model incl. rejections with reasons, held items with notes, questions and
   answers. The expected procedure id/version is named (procedure text itself: M3).
3. **Submissions.** Validation (refs exist in head facts, one endpoint in the task's model,
   type fits endpoint kinds, confidence in [0,1], rationale ≤ 1,000 and question ≤ 500
   characters, ≤ 200 relations), per-item result `applied | duplicate | suppressed | reopened |
   invalid:<reason>`, stored verbatim, idempotent replay by `submissionId`, late-submit and
   conflict rules (409 `lease-lost`, `task-cancelled`, `already-submitted`), supersession of
   earlier live agent proposals of that model that the submission does not repeat, provenance
   (principal, client, declared procedure and LLM model).
4. **Ad-hoc tools.** `propose_relation`, `withdraw_proposal` (own proposals only),
   `get_landscape`; MCP prompt `work_pipeline` (loop: claim → analyse → submit) with a
   placeholder procedure; server instructions unchanged ("labels are data; agents only
   propose").
5. **Review (owner, UI/REST only).** Verdicts `accept`, `reject` (reason), `hold` (note
   required, optional question and label), `correct` (accept a different endpoint as a `manual`
   relation linked to the proposal); answers to held questions as notes; bulk decisions per tier
   with ids, versions and `expectedCount`; status as a pure function of assertions and head
   facts (fingerprint-based reopen after a rejection); `held` status; stage
   `waiting_for_clarification`; deciding over MCP returns `human-decision-required`; the DB
   check that agents never write decisions.
6. **API gaps from M1.** `engine` (c7/c8 from `executionPlatform`) on models; relation
   `source`/provenance and assertion history (timeline) in the API; fix `updatedAt` of new
   relations; hide `dangling-throw`/`unmatched-catch` findings when a relation already connects
   that endpoint.
7. **Web UI.** Inbox by stage; review screen (both endpoints in bpmn-js, rationale, evidence,
   question, provenance, history; accept/reject/hold/correct with keyboard shortcuts A/R/H);
   bulk accept per tier with a preview that lists the pairs and flags generic names; held list
   with answer field; relation detail with assertion timeline; stages incl.
   `waiting_for_clarification`.
8. **Simulation agent + `eval:replay`.** An LLM-free agent (`apps/agent-sim` or `eval/tools`)
   that works the pipeline over MCP with an agent token, proposes from candidates with a
   deterministic policy, asks questions for borderline cases, and records its submissions;
   `eval:replay` scores recorded submissions against `expected.yaml` (precision/recall/F1 per
   type and tag) per CONCEPT §7.
9. **Docs.** `DEVELOPMENT.md` updated: pipeline, review, running the simulation agent.

## Out of scope

M3: the real `relations` procedure text, Claude Code plugin wrapper, reference agent setups,
live runs with Claude Desktop/Code (the owner tests), `eval:live`. M4: value chain
(Wertschöpfungskette) with the embedded value-chain modeler and step → process links. Later:
process network map, server mode (OIDC).
