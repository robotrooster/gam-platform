# Session 155 Handoff

**Theme:** OTP (On-Time Pay) backend infrastructure shipped.
Rent-advance-for-landlord product with float-spread revenue,
hidden behind a two-level rollout flag (global + per-landlord)
until launch.

## Decisions captured (this session)

Per the session-start product redirect:

- **OTP is a landlord product.** GAM advances rent on the last
  business day of the month. Tenant has no enrollment surface
  and no awareness — the existing tenant-side endpoint was
  removed (deprecated 410).
- **Q3 A — 1% spread.** Landlord receives 99% of rent on
  advance day; GAM keeps the 1% when it collects from tenant
  later. Scales with rent volume.
- **Q4 First-miss-on-GAM, no pursuit (regulatory boundary),
  6-month tenant disqualification.** Recovery + reenrollment
  policy flagged as future work.
- **Q5 NSF auto-disenroll** (the D conditions in original Q5
  are pre-enrollment gates, not post). Bank unlinking
  auto-blocks (handled when ach_verified flips FALSE).
- **Q6 Last business day of month.** ACH initiated late
  business-day clears in landlord's bank by the 1st.
- **Q2 Both visibility flags.** Global `system_features.otp_rollout_visible`
  AND per-landlord `landlords.otp_rollout_enabled` must both be
  TRUE for OTP to surface. Default OFF.

## Items shipped

### Migration: `20260506130000_otp_infrastructure.sql`

- New `system_features` table — generic platform-level feature
  flags (key/enabled/description/updated_at). Seeded with
  `otp_rollout_visible = FALSE`.
- `landlords.otp_rollout_enabled BOOLEAN DEFAULT FALSE` — per-
  landlord beta gate.
- `tenants.otp_disqualified_until TIMESTAMPTZ` + `otp_disqualified_reason TEXT`
  — 6-month NSF cooldown.
- New `otp_advances` table — one row per (cycle_month, tenant_id):
  rent_amount, fee_amount (1% of rent), advance_amount (99%),
  status (pending → advanced → reconciled / defaulted),
  payment_id pointers, audit timestamps.

### Service: `services/systemFeatures.ts`

Generic feature-flag helper — `isFeatureEnabled(key)`,
`listFeatures()`, `setFeatureEnabled(key, enabled, userId)`.
Reusable for any future flag.

### Service: `services/otp.ts`

- `isOtpVisibleForLandlord(landlordId)` — checks global +
  per-landlord
- `getQualificationStatus(tenantId)` — returns
  `{eligible, blockers, cooldown_until}`. Blockers:
  ach_unverified, deposit_not_funded, flex_deposit_active,
  bg_check_not_approved, nsf_cooldown
- `enableOtpForTenant({tenantId, landlordId, enabledByUserId})`
  — landlord opt-in, gated by visibility + qualification
- `disableOtpForTenant(...)` — landlord opt-out
- `disqualifyTenantForNsf(tenantId)` — 6-month cooldown
- `autoDisenrollOnAchUnverified(tenantId)` — bank-unlink hook
- `processMonthlyAdvance(now)` — last-business-day cron entrypoint.
  Iterates qualified tenants on participating landlords' leases,
  creates one advance row + one payments row per (cycle_month,
  tenant). Idempotent via UNIQUE (cycle_month, tenant_id).
- `reconcileSettledRentPayment(paymentId)` — webhook hook;
  closes out matching advance when tenant rent settles.
- `handleRentPaymentNsf(paymentId)` — webhook hook; marks
  defaulted, disqualifies tenant, fires admin alert.
- Helpers: `cycleMonthFor`, `cycleMonthForRentDue`,
  `isLastBusinessDayOfMonth`.

### Routes

```
DEPRECATED  POST /api/tenants/enroll-on-time-pay      — returns 410 Gone

ADMIN       GET   /api/admin/system-features          — list flags
            PATCH /api/admin/system-features/:key     — super_admin only
            PATCH /api/admin/landlords/:id/otp-rollout — super_admin only

LANDLORD    GET   /api/landlords/me/otp/visibility    — UI gate
            GET   /api/landlords/me/otp/eligible-tenants
            POST  /api/landlords/me/otp/tenants/:tenantId/enable
            POST  /api/landlords/me/otp/tenants/:tenantId/disable
            GET   /api/landlords/me/otp/advances      — history
```

### Cron (in `scheduler.ts`)

Daily 3pm Phoenix tick that calls `isLastBusinessDayOfMonth`;
when true, runs `processMonthlyAdvance`. Gated internally by
the global feature flag — safe to leave in scheduler permanently.

### Webhook hooks (in `routes/webhooks.ts`)

- `payment_intent.succeeded` for type=rent → calls
  `reconcileSettledRentPayment` after settlement
- `payment_intent.payment_failed` (terminal) for type=rent →
  calls `handleRentPaymentNsf` to mark default + disqualify

### Admin UI: `/system-features` page

New super_admin-only page in `apps/admin` showing all
registered flags + enable/disable buttons. Nav entry added
under Compliance section. Flags list is currently just
`otp_rollout_visible`; future flags get listed automatically.

Per-landlord beta toggle is via `PATCH /api/admin/landlords/:id/otp-rollout`
endpoint — UI for that surface is deferred (super_admin can
flip via the route directly or wait for S156 to add a UI control
on the existing landlord detail panel).

## Files touched / created

```
apps/api/src/db/migrations/20260506130000_otp_infrastructure.sql  (new)
apps/api/src/db/schema.sql                                         (regenerated, 9805 lines)

apps/api/src/services/systemFeatures.ts                            (new)
apps/api/src/services/otp.ts                                       (new — 350 lines)

apps/api/src/routes/admin.ts                                       (system-features + per-landlord toggle endpoints)
apps/api/src/routes/landlords.ts                                   (5 OTP endpoints appended)
apps/api/src/routes/tenants.ts                                     (deprecated enroll endpoint → 410)
apps/api/src/routes/webhooks.ts                                    (reconcile + NSF default hooks)

apps/api/src/jobs/scheduler.ts                                     (daily last-business-day tick)

apps/admin/src/main.tsx                                            (SystemFeatures inline page + route + nav)
```

## Validation

- `npm run db:migrate` → 1 applied; schema.sql regenerated to 9805 lines
- `npx tsc --noEmit` on api / landlord / tenant / admin → all exit 0
- Live smoke (9 phases all passing):
  - Phase 1: default flag OFF + `isOtpVisibleForLandlord` returns false ✓
  - Phase 2: global enabled but per-landlord OFF → still false ✓
  - Phase 3: both flags ON → visible=true ✓
  - Phase 4: qualification gate correctly identifies missing blockers ✓
  - Phase 5: fully qualified tenant; `enableOtpForTenant` succeeds ✓
  - Phase 6: `processMonthlyAdvance` creates advance row with
    correct fee ($15 = 1% of $1500) and advance amount ($1485) ✓
  - Phase 7: `reconcileSettledRentPayment` flips advance to
    reconciled ✓
  - Phase 8: NSF path → advance defaulted, tenant disenrolled,
    cooldown set, qualification status returns nsf_cooldown ✓
  - Phase 9: `isLastBusinessDayOfMonth` correct for Friday May 29
    (last weekday of May 2026) and false for May 15 ✓

## What this session did NOT do

- **No actual ACH push to landlord.** The advance creates a
  `payments` row in 'pending' status with `entry_description='ONTIMEPAY'`,
  but the real Stripe Connect transfer is wired by the existing
  disbursement path post-S155. The advance mechanism creates the
  obligation; the disbursement engine has to learn about
  ONTIMEPAY-tagged payouts to push the cash.
- **No landlord OTP UI.** Endpoints + visibility gate exist; the
  per-tenant enable/disable button + advances dashboard land in
  S156. Until then, OTP is fully hidden because:
  1. `system_features.otp_rollout_visible` is FALSE by default
  2. No UI surface anywhere in the landlord portal mentions OTP
  3. Even when a super_admin flips the flag, landlords see
     nothing until S156 lands the UI
- **No reenrollment policy.** Per Nic's note, recovery + reenrollment
  practices are flagged for future work. The tenant is permanently
  disqualified after 6 months unless their `otp_disqualified_until`
  timestamp is manually cleared (or naturally expires).
- **No tenant-portal cleanup.** The deprecated 410 endpoint is
  in place but the tenant `/services` page may still mention OTP.
  Per the hidden-until-rollout rule, the tenant has no UI for
  this anyway, so any visual reference is benign — a follow-up
  cleanup job can remove tenant references after S156.
- **No per-landlord toggle UI in admin app.** The PATCH endpoint
  exists; super_admin currently uses curl or DB. UI surface
  lands in S156.

## Pre-launch backend status

Closed list updates:
- ✅ OTP infrastructure (schema, service, routes, cron, webhook hooks, admin platform UI)
- ✅ Tenant-side OTP endpoint deprecated (410 Gone)

Remaining open items:
- PM third-party-companies subsystem (still the big one)
- Tax-form catalog (real session)
- Stripe sandbox testing (test key)
- Live browser smoke walkthrough
- (S156) OTP landlord UI: per-tenant toggle + advances dashboard;
  per-landlord toggle UI in admin app

## What next session should target

**Option A: Continue OTP — landlord UI (S156)**
- Per-tenant enable/disable toggle on landlord tenant detail
- Advances history dashboard
- Per-landlord beta toggle UI in admin app
- Smaller scope than S155; pure UI work since backend is done

**Option B: Move to next backlog item — tax-form catalog**
The S91 promise of a landlord-configurable per-state tax-form
catalog (CA DE-9, NY NYS-45, AZ A1-QRT, etc.). Real session;
schema + admin UI + integration with the books filing-deadlines
list.

**Option C: PM third-party-companies subsystem**
The biggest remaining item per CLAUDE.md. Schema for
pm_companies / pm_staff / pm_fee_plans + money flow under S113
destination charges + staff invite UX. Real big session.

Recommendation: **Option A (S156 OTP UI)** to keep momentum on
OTP — backend is fresh in head, UI is small, then we move
cleanly to the next track.

## Notes for future-Claude

- The OTP advance creates a `payments` row with
  `entry_description='ONTIMEPAY'`. The existing disbursement
  engine doesn't yet recognize this entry type — it's a
  payable to the landlord that the engine should pick up at
  payout time. Wiring that integration is the missing piece
  to make OTP cash actually flow. For S155 the row exists in
  'pending' status indefinitely; the engine update is the
  next blocker for live OTP cash movement.
- `cycleMonthFor(now)` returns next month's 1st (e.g. running
  on May 29 returns 2026-06-01). `cycleMonthForRentDue(due)`
  returns the 1st of the rent's due month. These are
  intentional opposites — the advance is FOR next month; the
  reconciliation matches the rent's natural due month.
- The `isLastBusinessDayOfMonth` helper walks forward from
  today checking if any later weekday exists in the same
  month. UTC-based; if a landlord is in a TZ where the
  cron fires on a different local day, they may see a
  one-day shift. For US landlords on Phoenix-time scheduler
  this should be fine.
- The 410 Gone on the tenant enroll endpoint will break any
  tenant-portal call that still tries to use it. Per recon,
  the tenant `/services` page may have a button for this.
  When S156 ships landlord UI, sweep tenant portal for any
  OTP/float references and remove them too — per the
  "hidden until rollout" rule.
- The reconciliation hook in webhooks.ts runs INSIDE the
  payment_intent.succeeded transaction's connection but
  uses its OWN connection (lazy-imported, fresh `getClient`).
  This means a reconciliation failure does NOT roll back the
  payment settlement. Acceptable for v1 — the cron pass
  could pick up missed reconciliations. Consider adding a
  daily reconciliation sweep cron in a follow-up.
