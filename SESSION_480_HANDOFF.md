# Session 480 — closed

> Landlord performance dashboard + agent-log report VIEW.
> The last unbuilt landlord-facing surface from the
> post-Phase-1a memory backlog.

## Theme

**Landlord-facing agent_interaction_logs dashboard. A
metadata-only SQL VIEW (`v_landlord_agent_interactions`)
defines the column allowlist — verbatim user_message,
agent_reply, tool_invocations, human_handoff, error_detail,
metadata, knowledge_chunk_ids, profile_id, actor_subject_id
all explicitly omitted. Two routes scope to the calling
landlord and surface 30-day KPIs + a recent-activity list.
Landlord portal gets a new `Agent Activity` page under the
Financials section, with KPI tiles, three breakdown cards
(by outcome / by agent / top tools), and a recent table
with audience + tool + latency + relative timestamp.**

Suite (api) at S479 close: 3058 / 161.
Suite (api) at S480 close: **3068 / 162 / 0 failures** (+10
new cases + 1 new test file).

apps/landlord tsc: clean. apps/landlord build: clean.

## What shipped

### `apps/api/src/db/migrations/20260614120000_v_landlord_agent_interactions.sql`

`CREATE OR REPLACE VIEW public.v_landlord_agent_interactions AS SELECT …`

Single definition of the landlord-safe column list. Routes
scoped to landlord_id SELECT from this VIEW, not the base
table. Admin/super_admin routes that need the full content
continue to SELECT from agent_interaction_logs directly.

**Explicitly OMITTED + why:**
- `user_message` / `agent_reply` — verbatim conversation
  content (admin-only per agent-engine design pass)
- `tool_invocations` — args JSON contains free-form text
  (skip-reason, message bodies, etc.)
- `human_handoff` — escalation transcript snippet
- `error_detail` — stack trace; ops-only
- `knowledge_chunk_ids` — RAG plumbing; not useful to landlord
- `metadata` — free-form jsonb; future-flexible
- `profile_id` — agent-engine internal slug
- `actor_subject_id` — duplicate of actor_user_id for
  non-prospect audiences

**Included:** id, conversation_id, turn_index, agent_type,
audience, agent_name, handled_by_tier, outcome, property_id,
landlord_id, actor_user_id, actor_role, escalation_count,
escalated_to_human, tool_invocation_count, tool_names,
latency_ms, prompt_tokens, completion_tokens, model,
grounded, created_at.

Migration applied; schema.sql regenerated.

### `apps/api/src/routes/landlordAgentActivity.ts` — NEW

Mounted at `/api/landlord/agent-activity`.

**`GET /` — 30-day summary KPIs:**
- Configurable `?days=N` (default 30, max 365).
- `totals`: total, tenant_count, landlord_count,
  escalated_count, grounded_count, avg_latency_ms.
- `by_outcome`: grouped count per outcome enum, desc.
- `by_agent`: grouped count per agent_name (Ava, Samantha,
  David, Sonny).
- `by_tool`: UNNEST(tool_names) then GROUP BY tool, LIMIT 10.

**`GET /recent` — last N rows:**
- Configurable `?limit=N` (default 50, max 200).
- Optional `?outcome=...` filter.
- Returns metadata columns only — id, conversation_id,
  turn_index, agent_name, audience, handled_by_tier,
  outcome, property_id, actor_role, escalation flags, tool
  names + count, latency_ms, grounded, created_at.

Both endpoints gate on `req.user.role === 'landlord'` and
scope every WHERE to `landlord_id = actor.profileId`.
Non-landlord roles get 403. PM-company staff access is a
future extension (entries 168, 192-ish in the perm
framework).

### `apps/api/src/routes/landlordAgentActivity.test.ts` — NEW

10 cases covering:
- Non-landlord role → 403
- Empty log → zeros + empty arrays
- Counts grouped by outcome / agent / tool — assertion
  uses `Object.fromEntries(rows.map(...))` for ordering-
  agnostic checks
- Cross-landlord rows excluded (scope guard)
- Days window respected (rows outside excluded)
- Configurable days (90) returns both rows
- **`/recent` returns metadata only — VIEW omits user_message
  + agent_reply** (the privacy assertion: seeded with
  verbatim sentinels, asserted on the JSON-stringified body)
- Limit + ordering: newest first
- Outcome filter
- Cross-landlord exclusion on /recent

### `apps/landlord/src/pages/AgentActivityPage.tsx` — NEW

- Header with description copy that explicitly calls out
  metadata-only posture ("Verbatim conversation text is
  admin-only").
- Time-window toggle: 7d / 30d / 90d buttons.
- **4 KPI tiles**: Conversations, From tenants, Escalated to
  human (amber when > 0), Avg latency (in seconds).
- **3 breakdown cards** (1×3 grid): By outcome (clickable
  rows filter the recent list), By agent, Top tools.
- **Recent activity table**: Agent (with SR badge for
  escalation tier), Audience, Outcome (with AlertTriangle
  when escalated), Tools (first 2 + "+N" overflow), Latency,
  Relative timestamp.
- Outcome filter pill appears above the table when set;
  click to clear.
- `OUTCOME_LABEL` map humanizes the snake_case enum values
  (`answered_entry` → "Answered (entry)", etc.).

### `apps/landlord/src/components/layout/Layout.tsx`

- Added `Bot` icon import from lucide.
- New nav item `Agent Activity` at `/agent-activity` under
  the Financials section (right after Reports). `roles:
  ['landlord']` — owner-only.

### `apps/landlord/src/main.tsx`

- Imports `AgentActivityPage`.
- Registers `<Route path="agent-activity" element={<AgentActivityPage />} />`
  inside the protected Layout block.

## Items shipped

```
apps/api/src/db/migrations/
  20260614120000_v_landlord_agent_interactions.sql       (NEW)
apps/api/src/db/
  schema.sql                                              (regenerated)
apps/api/src/routes/
  landlordAgentActivity.ts                                (NEW — ~140 lines)
  landlordAgentActivity.test.ts                           (NEW — ~220 lines, 10 cases)
apps/api/src/
  index.ts                                                (+ router mount)
apps/landlord/src/pages/
  AgentActivityPage.tsx                                   (NEW — ~290 lines)
apps/landlord/src/components/layout/
  Layout.tsx                                              (+ Bot icon + nav item)
apps/landlord/src/
  main.tsx                                                (+ import + route)
```

## Decisions made during build

| Question | Decision |
|---|---|
| VIEW or inline scoped SELECT in each route | **VIEW.** Single definition of which columns are landlord-safe; if a future agent-log surface is added, it SELECTs from the VIEW too — can't accidentally leak verbatim content. The agent memory explicitly called for this shape. |
| Include actor_user_id in the VIEW | **Yes.** Landlord already sees their own tenants on every tenant-facing surface; per-conversation identification is consistent with existing landlord visibility into their own tenant base. A stricter VIEW (without actor_user_id) is a future split if PM-company staff get access without tenant-id rights. |
| Role gate: landlord only or include PM | **Landlord only (403 for others).** PM-company staff dashboard access needs separate permission-framework work — flagged in route comments. Don't pre-extend permissions without the matrix call. |
| KPI tile selection | **Total / From tenants / Escalated / Avg latency.** Captures volume, tenant-mix, escalation rate (the operational signal the agent-engine memory called out), responsiveness. Grounded count was considered but it's a model-internal signal, not landlord-actionable. |
| Time-window UI | **7d / 30d / 90d buttons.** Three pre-set windows cover the common questions ("this week," "this month," "this quarter"). Custom date range is a future expansion. |
| Outcome filter wired to clickable breakdown rows | **Yes.** Click a breakdown row → recent table filters to that outcome. Closes the "I see 4 escalations — let me see them" loop in one click. |
| Table column choices | **Agent, Audience, Outcome, Tools, Latency, When.** Skipped conversation_id (not a UI signal), property_id (not always set; landlord can drill on the conversation_id elsewhere). |
| Relative timestamp formatting | **"5m ago" / "2h ago" / "3d ago" / date.** Standard recency display; "5m ago" beats `2026-06-14T19:23:14.811Z` for at-a-glance scanning. |
| Tool list display | **First 2 + "+N" overflow.** Many conversations call 3+ tools; full list is too wide for a table cell. Click-through to detail would be a future page. |
| Privacy assertion in tests | **Explicit sentinel + JSON.stringify check.** Seed the row with `TENANT_VERBATIM_PRIVATE` as the user_message, assert `JSON.stringify(body).not.toContain('TENANT_VERBATIM_PRIVATE')`. Catches both the VIEW omission AND any future route-side leakage in one check. |
| Cross-test agent_interaction_logs cleanup | **Local DELETE in beforeEach.** `cleanupAllSchema` doesn't touch the log; tests in this file wipe before each case to stay deterministic. |

## Verification

- `cd apps/api && npx tsc --noEmit`: clean.
- `cd apps/landlord && npx tsc --noEmit`: clean.
- Targeted: `vitest run src/routes/landlordAgentActivity.test.ts`
  — 10 passed.
- Full: `npm test` — **3068 / 162 / 0 failures** (+10 cases
  + 1 file).
- `cd apps/landlord && npm run build`: clean (pre-existing 500
  KB chunk warning unrelated).
- Migration applied; schema.sql regenerated.

### Bugs caught during build

None.

## Phase status

The landlord-facing agent reporting surface is now live. From
the agent memory's deferred list:

- ✅ **Landlord-facing report VIEW (metadata-only, omits verbatim
  cols)** — `v_landlord_agent_interactions` shipped.
- ✅ **Read-access gating** — `requireLandlordProfileId` +
  landlord_id WHERE on every SELECT.
- ⏳ **Retention/scrub job** for older logs — the existing
  agent retention job (S288) scrubs tenant content after 1
  year; landlord-side timeframe wasn't specified. Defer
  until landlord usage patterns inform a window.
- ⏳ **Monthly-partition agent_interaction_logs + retention** —
  P9 in the agent memory's "still deferred" cluster. Matters
  at 100M+ rows; not urgent pre-launch.

## What the next session should target

Remaining candidates:

- **Lease-fee PATCH state-law check** — currently only the
  parent `/leases/:id` PATCH runs `checkAgainstStatute`;
  per-fee edits at `/leases/:id/fees/:feeId` don't. Small
  backend wiring.
- **Property-default state-law check** — landlord changes a
  property's default `entry_notice_hours` or late-fee
  config; new leases inherit. Should surface the same
  hedged factual notice. Property-edit route recon needed.
- **Conversation-detail page** for the landlord — clicking a
  row in the new agent-activity table could open a metadata-
  only conversation view (turn list with tool names,
  outcomes, but still no verbatim content). Would extend
  the VIEW + add a third endpoint + a detail route.
- **PM-company staff access** to the agent-activity surface —
  the permission framework work to extend the role gate.

Strong recommend: **lease-fee PATCH + property-default
state-law check**. Closes the last two unsurfaced write
paths in the state-law arc and stays in the same operational
mode as the S476/S477/S478 work.

---

End of S480 handoff. **Landlord agent-activity dashboard
shipped. VIEW defines the column allowlist; routes scope by
landlord; portal page renders KPI tiles + breakdown cards +
recent table.**

3068 tests / 162 files / 0 failures.

**Landlord-facing surface from the agent-engine deferred list
now closed.**
