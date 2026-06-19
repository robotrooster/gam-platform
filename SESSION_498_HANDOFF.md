# SESSION 498 HANDOFF

## Theme
Machine migration to the Mac Studio (M3 Ultra/96GB), chat-model swap to a local
**Hermes-4.3-36B 6-bit (MLX)**, a stack of CS-agent behavior fixes found via live
testing, and a new **per-property agent revenue-permissions** system with three
gated actions on top.

> Environment specifics (paths, model start commands, DB creds, the pgvector-from-
> source gotcha) live in Claude memory: `project_mac_studio_env`,
> `project_agent_engine`, `project_agent_revenue_permissions`. Read those first.

## Environment (new machine)
- Repo now at `/Users/nicholasrhoades/Downloads/gam`. Postgres 16 via Homebrew (NOT
  Docker), role `postgres`/`gam_dev_password`. pgvector 0.8.2 **built from source**
  against pg16 (brew formula targets pg17/18 — wrong ABI). Node 22 via brew.
- Models: chat = `~/models/Hermes-4.3-36B-6bit-mlx` on :8080 via MLX (uv venv
  `~/gam-mlx-env`; brew python@3.12 is broken on macOS 26). Embeddings = bge-large
  on :8081 via llama.cpp. **Relaunch after reboot: `~/gam-start.sh`.**
- The 36B was quantized locally from `NousResearch/Hermes-4.3-36B` (no public MLX
  6-bit exists). **EOS fix is load-bearing:** config eos was `2` (Seed-OSS) but the
  model emits `<|eot_id|>` (155127) — set in config.json + generation_config.json,
  else tokens leak. Re-apply on any re-convert.

## Shipped

### Agent CS-behavior fixes (all in shared code → tenant + landlord both)
- **Dangling "Let me look into that for you"** — `BASE_GUARDRAILS` literally told it
  to say that; removed. Added "ACTIONS REQUIRE TOOL CALLS — IN THE SAME REPLY" +
  a no-internal-reasoning rule (model was leaking `(Thinking: …)`).
- **Conversation loop after 6 turns** — `logInteraction.ts` set `turn_index =
  history.length`, which saturates at the 6-turn cap (=12); every later row tied,
  breaking `loadConversationHistory`'s `ORDER BY turn_index DESC`. Now a true
  `MAX(turn_index)+1`. (Gotcha: this repo's `query()` returns the rows array
  directly, not `{rows}`.)
- **Curated FAQ disabled** (`AGENT_CURATED_FAQ` flag, default off in
  `agentSession.ts`) — canned copy broke the human feel.
- **Escalation safety net** (`agentRunner.ts` `synthesizeHandoff`) — this model
  NARRATES escalations instead of calling the tool (the known control-tool gap,
  still present on the 36B; mlx_lm.server ignores `tool_choice`). When the agent's
  OWN reply promises a support handoff but no tool fired, we synthesize it. Keys off
  the agent's stated intent, not user keywords. Tightened to require a support-tier
  target so landlord-routing isn't mis-escalated.
- **Human tier = email-within-24h** (no live agents). `HUMAN_HANDOFF_REPLY` reworded.
  Routing LOCKED tier-driven: entry → senior only; senior → real-person only.
- **LLM timeout 60s → 180s** (`config.ts`) — long generations were erroring; widgets
  no longer surface "trouble reaching support" (tenant + landlord ChatWidget).
- **UI-hallucination fix** — agent was inventing portal sections. Added an anti-UI-
  invention guardrail + authored accurate `navigating-the-{tenant,landlord}-portal.md`
  KB articles from the REAL nav; ingested. Also `setting-up-ach-bank-to-pay-rent.md`.

### NEW: per-property agent revenue permissions (foundation + 3 actions)
- **Foundation:** `property_agent_permissions` table (migration `20260616120000`),
  shared enum `AGENT_REVENUE_CAPABILITIES` (`take_payment`, `lease_renewal`,
  `bill_fee`), gate `services/agentPermissions.ts → isAgentCapabilityEnabled`
  (default OFF). Landlord toggles IN CHAT via `set_agent_permission` /
  `get_agent_permissions` (`tools/agentPermissionTools.ts`).
- **Tenant lease renewal** — `tools/requestLeaseRenewal.ts` + `lease_renewal_requests`
  table (migration `20260616130000`, `LEASE_RENEWAL_REQUEST_STATUSES` enum). Records
  intent + notifies landlord; never changes the lease. Gated by `lease_renewal`.
- **Tenant payments REFRAMED → ACH-setup guidance** (Nic: GAM pushes ACH; agent does
  NOT charge or retry). Grounded KB article + existing `get_my_payment_methods`.
  NOT gated. `take_payment` capability currently unused (kept for the future).
- **Landlord bill_fee** — `tools/billFee.ts`, gated by `bill_fee`, bills via the new
  shared `services/leaseFees.ts → createLeaseFeePayment`. The existing
  `POST /api/leases/:id/bill-fee` route was refactored to call the SAME service (DRY).

## Decisions made (Nic)
- Agent NEVER accepts a notice-to-vacate or changes lease terms (no toggle exists).
- Revenue actions are per-property landlord opt-in, default OFF.
- No live human agents — escalation = "a senior agent will email you within 24h."
- Escalation routing locked: entry→senior→real-person; senior is the only tier that
  can reach a real person.
- Agent guides ACH setup; it does not execute charges or retries (banking function).

## Migrations applied
- `20260616120000_property_agent_permissions.sql`
- `20260616130000_lease_renewal_requests.sql`

## Key files touched
- `packages/shared/src/index.ts` (AGENT_REVENUE_CAPABILITIES, LEASE_RENEWAL_REQUEST_STATUSES)
- `apps/api/src/services/agents/profiles.ts` (guardrails + new tool allowlists)
- `apps/api/src/services/agents/{agentRunner,agentSession,logInteraction,config}.ts`
- `apps/api/src/services/{agentPermissions,leaseFees}.ts` (new)
- `apps/api/src/services/agents/tools/{agentPermissionTools,requestLeaseRenewal,billFee}.ts` (new)
- `apps/api/src/services/agents/tools/index.ts` (registrations)
- `apps/api/src/routes/leases.ts` (bill-fee route → shared service)
- `apps/api/src/services/agents/knowledge-content/{tenant,landlord}/navigating-*.md`,
  `tenant/setting-up-ach-bank-to-pay-rent.md` (new KB; re-ingest after edits)
- `apps/{tenant,landlord}/src/components/{AgentChatWidget,ChatWidget}.tsx` (error copy)

## Deferred / next session
1. **Landlord applicant approve/decline** — read-vs-act gap (has
   `get_pending_applications` + `get_background_check_status` reads, no decision
   action). Mirror the maintenance approve/reject pattern.
2. **Draft-with-approval tenant notices** (landlord) — agent drafts, landlord
   approves before send, never auto-sends. On the original roadmap.
3. **Property-settings UI toggle** for the agent permissions (frontend) — reuse
   `services/agentPermissions.ts`; only the in-chat toggle + a service exist now.
4. Minor: agent is slightly eager to act before explicit "yes" (e.g. files on
   "no haven't tried anything"); the dev DB had no properties/leases (seeded a
   minimal Maplewood/unit-101 lease for alice under James for testing).
5. Broader: the AI-seed KB (~40 articles) should get a product-accuracy review —
   the portal-walkthrough hallucination was one symptom.

## Notes
- Stack relaunch after a reboot: `~/gam-start.sh` (models) then `bash dev.sh` (apps),
  OR start API/tenant/landlord individually. dev.sh's fire-and-exit doesn't survive
  being launched from a Claude tool call — start long-lived servers individually here.
- Test creds: tenant `alice@tenant.dev`/`tenant1234`, landlord `james@demo.dev`/`landlord1234`.
- Maplewood currently has take_payment + lease_renewal + bill_fee all ENABLED (from testing).
