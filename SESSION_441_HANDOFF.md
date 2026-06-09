# Session 441 — closed

## Theme

**Built the GAM AI agent system end-to-end, from nothing to a
near-launch product.** Self-hosted customer-service agents (tenant +
landlord) plus a brand-new public **sales lead-gen agent** — engine,
~28 tools, a 49-article code-grounded knowledge base, escalation,
logging, scale infrastructure, chat widgets on both portals, quality
features (proactive/empathy/memory/eval-harness), landlord onboarding
assist, and the sales agent backend.

> **The granular record lives in auto-memory: `project_agent_engine.md`**
> (loaded every session via MEMORY.md). Read it for exact files,
> schemas, env knobs, and decisions. This handoff is the high-level
> map + what's next.

Build handoff spec: `~/Downloads/gam-agent-engine-handoff.md`.

## State at close

- **Tests:** 144 across the agent surface (`src/services/agents/` +
  `src/routes/agent.test.ts`), 0 failures. tsc 0.
- **Code:** `apps/api/src/services/agents/` (engine, profiles, tools/,
  knowledge, scale, eval) + `routes/agent.ts` (auth chat + public
  `salesAgentRouter`) + chat widgets in `apps/tenant` & `apps/landlord`.
- **Migrations applied:** `..._agent_knowledge_store`,
  `..._agent_interaction_logs`, `20260609120000_sales_agent`.
- **KB:** 49 articles / 121 chunks (tenant/landlord/shared/sales).

## Self-hosted model topology (NOT in repo — needed every session)

- Chat: Hermes-4-14B-4bit via MLX on `localhost:8080/v1`
  (`LLM_ENDPOINT`/`LLM_MODEL`). Nic runs it.
- Embeddings: bge-large-en-v1.5 (1024-dim) via llama.cpp on
  `localhost:8081/v1` (`EMBEDDINGS_*`). Start: `./scripts/start-embeddings.sh`.
- pgvector 0.8.0 built from source vs pg16.

## ⚠ THE load-bearing fact for next session: the dev model is inadequate

The eval harness (`agentEval.ts`) measured the **14B dev model at 25%,
non-deterministically** (tool-calling is a coin-flip; escalation never
fires). This is a model-capability ceiling, NOT a code bug — confirmed
across the session. **The production model (Hermes-36B on the 96GB Mac
Studio) is required.** The swap is config-only (`LLM_ENDPOINT`/
`LLM_MODEL`) — no code change. The bigger model directly improves the
two weak spots: tool selection (from ~28 tools) and escalation firing.

**Nic's plan: test/QA happens AFTER swapping to the big computer.**
Until then: build functionality, don't chase dev-model tuning.

## What shipped this session (high level)

1. Engine (config-driven, plain fetch), 4 named CS agents (Ava/Samantha
   tenant, David/Sonny landlord) + grounded answering.
2. RAG knowledge layer (pgvector) + 49-article code-grounded KB.
3. ~28 actor-scoped tools (reads + actions) across tenant/landlord;
   adversarially security-reviewed clean (4 reviews).
4. Escalation chain (entry→senior→human) + context-carrying handoffs.
5. Interaction logging (`agent_interaction_logs`) + retention scrub
   (tenant 1yr / landlord indefinite).
6. Scale infra: endpoint pool (least-in-flight + failover), turn-gate
   (bounded concurrency + graceful shed), fire-and-forget logging,
   embedding + FAQ caches, per-user rate limit, server-side history,
   env-tunable DB pool.
7. Chat widgets (bubble + /support page) on tenant + landlord portals,
   profile cards, illustrated avatars, "working…" indicator, conv
   persistence. **NOT browser-walked.**
8. Human-presentation rule (never reveal it's automated — bot-disclosure
   nuance flagged), curated FAQ fast-path, proactive + empathy
   behaviors, cross-session memory, the **eval harness**.
9. Landlord onboarding assist (`get_setup_progress`).
10. **NEW: Sales lead-gen agent** — validates the `agentType` axis (no
    engine rebuild). Public/unauthed `POST /api/sales/chat`, "Jordan"
    persona, sales KB, `capture_lead`→`sales_leads`+team notification.
    Backend verified live. **Marketing-site widget NOT built.**

## ▶ WHAT NEXT SESSION SHOULD TARGET (in order)

1. **Marketing-site sales chat widget** (`apps/marketing`, public, calls
   `POST /api/sales/chat`). The sales agent's backend is done + verified;
   without this UI no prospect can reach Jordan. Mirror the portal
   widgets but unauthenticated. **Recon `apps/marketing` structure first.**
2. When on the big computer: run `agentEval.ts` against the 36B to
   quantify the real quality (expect a huge jump from 25%); browser-walk
   the chat widgets.
3. Deferred capability: `assign_maintenance_to_contractor` (tricky —
   `contractors` is a platform marketplace, `maintenance_requests.
   contractor_id` is a USER on the landlord's team via scopes), GAM Books
   summaries for landlords.

## Nic-owned (not code)

- Review the 49 AI-drafted KB articles + curated FAQ + sales copy
  (editable `.md` in `services/agents/knowledge-content/`).
- **FlexSuite + OTP/rent-reporting KB**: deliberately NOT authored — the
  SLA-not-loan framing is legally load-bearing; needs Nic/counsel.
- The bot-disclosure stance (agent deflects "are you a bot?" rather than
  flatly lying — adjustable).

## Notes

- Two files reverted externally mid-session (not by Claude):
  `routes/maintenance.ts` (back to inline; the `file_maintenance_request`
  TOOL still uses `services/maintenanceRequests.ts`, intact) and
  `.env.example` (lost the agent env-var docs — all knobs are in code
  comments + the memory file).
- No git topics raised (per standing rules). No smoke walk.
