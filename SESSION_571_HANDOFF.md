# SESSION 571 HANDOFF

Continues S570's tenant-portal walkthrough redesign. Nic drove the two open
decisions early, then left for the night with "work on the tenant portal, stop
if you get hung up." I shipped 3 of the 5 remaining items — all typecheck-clean,
tested, API rebuilt + `launchctl kickstart`ed live — and deliberately stopped
before the two breakage-prone / largest items.

**Everything below is UNCOMMITTED** — Nic decides the push.
Key memory: [[gam-tenant-portal-redesign]] (updated with DONE vs REMAINING),
[[gam-agent-roster]], [[gam-owner-login-email-2fa]], [[gam-ach-microdeposits-not-instant]].

---

## Nic's two decisions this session (asked up front)
1. **Maintenance priority engine → LIVE tenant agent (LLM)**, not a deterministic
   classifier. (Built with a heuristic fallback so submit never blocks.)
2. **Entry-request fold → "entry ONLY through a maintenance call or a scheduled
   inspection."** This RESHAPES item 1: no more free-standing showing/other/
   emergency entry requests. (NOT built yet — see Remaining.)

---

## Shipped (all deployed live, tested)

### Item 2 — Maintenance redesign (DONE)
- **Tenant form**: free-text title → **category dropdown** (12-value
  `MAINTENANCE_CATEGORIES`, already in schema/shared; the "list TBD" note was
  stale — code had it. Added `MAINTENANCE_CATEGORY_LABEL` to packages/shared).
  Priority picker **removed**. Title is **derived server-side** from category.
- **Priority = live in-house LLM.** New `services/maintenancePriority.ts` calls
  `chatCompletion` (engine) with a tight JSON classifier prompt; on any failure
  (model down/timeout/unparseable) falls back to a keyword **heuristic**. Runs
  for every tenant-originated request (portal form + agent tool).
- **Migration `20260731000000`**: `maintenance_requests.recommended_priority` +
  `priority_source` ('agent'|'heuristic'|'landlord'). `createMaintenanceRequest`
  stores both; explicit (landlord) priority → source='landlord', no recommendation.
- **Route**: POST `/maintenance` — category optional (default 'general'), title
  + priority optional, **tenant-sent priority is stripped**. PATCH now accepts
  landlord **priority + category override**.
- **Landlord `MaintenancePage`**: shows category, "AI recommended: X (fallback?)",
  and a priority **override dropdown**.
- **Tenant `MaintenancePage`**: category heading + description snippet, priority
  shown read-only (labelled), **resolution time** on completed ("Resolved in N
  days"). Landlord-immutable confirmed — no DELETE route exists.
- **Agent tool `fileMaintenanceRequest`**: dropped model-set `priority`, added
  `category`; priority now comes from the recommender (one source of truth).
  ⚠️ **Run the 43-scenario agent eval when the LLM endpoint is up** (agent tool
  params changed) — see [[gam-agent-roster]].
- Tests: updated 2 stale assertions + added 2; maintenance suite 39 green,
  s439Triplet 23 green.

### Item 4 — Tenant email-2FA once ACH is set up (DONE)
- Infra already existed (`users.email_2fa_enabled`; login emails a code +
  returns `requiresEmailOtp`; `/auth/email-otp/verify` + `/resend`). Only the
  tenant side was missing.
- **Flip the flag** TRUE when a tenant sets up ACH: `stripe.ts /tenant/confirm-
  setup` (at bank-attach, even while microdeposits pending) + `webhooks.ts
  setup_intent.succeeded` backstop. Idempotent.
- **Tenant login**: ported the email-OTP step — `loginWithEmailOtp` /
  `resendEmailOtp` in AuthProvider + a Step-2 "check your email" code screen in
  `LoginPage` (mirrors the existing TOTP step). Without this the flag would lock
  tenants out (tenant UI only handled `requiresTotp`).
- Test: `stripe.test.ts` +1 (flag flips on confirm-setup while pending); suite 26 green.

### Item 5 — Feature-request storage (DONE)
- Was a **dead deep-link** to a nonexistent admin `/feature-requests` page.
- **Migration `20260731001000`**: `feature_requests` (soft-lifecycle via status
  new/reviewing/planned/declined/shipped). `routes/featureRequests.ts`: POST
  (any authed), GET `/mine`, GET (super-admin list), PATCH (super-admin triage).
  Registered at `/api/feature-requests`.
- **Tenant Services page**: external link → **in-app `FeatureRequestModal`** that
  POSTs. `cleanupAllSchema` extended for the new table. 4 tests green.
- No admin UI page yet (GET/PATCH backend exists) — small follow-up if wanted.

**Sweep**: 6 touched suites, **134 tests green**. API rebuilt + kickstarted;
`/api/feature-requests` + `/api/maintenance` return 401 unauth (live), no log errors.

---

## Remaining (start here next session)

### Item 1 — Entry-request fold (RESHAPED, NOT started)
Nic's rule: **entry ONLY through a maintenance call or a scheduled inspection.**
Plan:
- Migration: `unit_entry_requests` + `maintenance_request_id` + `inspection_id`
  nullable FKs, CHECK exactly-one-set.
- `routes/entryRequests.ts` POST: require one anchor; derive unit/tenant/lease/
  reason_category from the linked record; drop the free showing/other path.
- **Rework landlord `NewEntryRequestPage`**: pick a maintenance call or a
  scheduled inspection (fetch per-unit), not free-text reason.
- Tenant: **remove the Entry Requests nav tab** (`apps/tenant/src/main.tsx`
  ~L457 + its route) and surface entry requests **inline in the maintenance
  detail** (grant/deny there) + inspection detail.
- ⚠️ **Breakage-prone**: backend enforcement + landlord create UI must land in
  the SAME session (otherwise entry-create 400s). Grant/deny endpoints unchanged.
- Recon already done: `unit_entry_requests` schema, `entryRequests.ts` (POST
  ~L110-200), landlord `NewEntryRequestPage`/`EntryRequestsPage`, tenant
  `TenantInspectionsPage`/detail all located.

### Item 3 — Inspections overhaul (largest, untouched)
Checklist = landlord template + agent fills gaps (landlord defines required
shots per property/unit-type; agent guides + prompts for missing/low-quality).
Move-in/move-out photos tenant-owned, landlord view-only (immutable). Smoother
capture UX (video+photo already work).

---

## Files touched
- packages/shared/src/index.ts (MAINTENANCE_CATEGORY_LABEL)
- apps/api/src/db/migrations/20260731000000_maintenance_recommended_priority.sql (new)
- apps/api/src/db/migrations/20260731001000_feature_requests.sql (new)
- apps/api/src/services/maintenancePriority.ts (new)
- apps/api/src/services/maintenanceRequests.ts
- apps/api/src/routes/maintenance.ts (+ .test.ts)
- apps/api/src/services/agents/tools/fileMaintenanceRequest.ts
- apps/api/src/services/s439Triplet.test.ts
- apps/api/src/routes/featureRequests.ts + .test.ts (new)
- apps/api/src/routes/stripe.ts (+ .test.ts)
- apps/api/src/routes/webhooks.ts
- apps/api/src/index.ts (route registration)
- apps/api/src/test/dbHelpers.ts (cleanup order)
- apps/tenant/src/main.tsx (email-OTP login step + FeatureRequestModal)
- apps/tenant/src/pages/MaintenancePage.tsx
- apps/landlord/src/pages/MaintenancePage.tsx

## State
All UNCOMMITTED. Typecheck-clean (API + tenant + landlord). Migrations
`..000000` + `..001000` applied on dev + gam_test. API dist rebuilt + live.
Deferred: agent 43-scenario eval (LLM endpoint), items 1 + 3, optional admin
feature-requests UI page.
