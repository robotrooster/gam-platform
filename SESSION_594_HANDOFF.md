# SESSION 594 HANDOFF — Sweep COMPLETE (23+24); home-sale reframe (L→T flat + T→T resident); money-path + wire-contract hardening; landlord + tenant heartbeat monitors

> Long session. Finished the S578→ pre-onboarding sweep (**all 24 subsystems now
> combed**), then a run of Nic-directed fixes + two new product features. **Nothing
> committed** — the entire S578→S594 sweep + this session's work is still ONE
> uncommitted deploy. Everything green; tsc clean across touched apps.

> ⚠️ **Comment session numbers:** some later comments/migration headers say `S595`
> (the two heartbeat monitors). This IS session 594 — cosmetic off-by-one, ignore.

---

## SWEEP STATUS — COMPLETE

24-subsystem by-hand sweep (S578→S594) is **done**. This session closed the last two:
- **23 MH/RV** — homeOwnership, homeSale, lotRent, propane, dumpLocations, vehicles, depots, commonAreas.
- **24 Work-trade / snowbird / recurring** — workTrade, lease hibernation, recurring-schedule materializer, scheduledLeaseChanges.

Method held: BY HAND, in order, both lenses (security/correctness + design-flow). The
ONLY fan-out used was a workflow for the non-launch wire-contract cleanup (business +
fitness) — explicitly NOT the subsystem sweep.

---

## WHAT SHIPPED (code complete, NOT committed, all green)

### A. Subsystem 23 comb — bugs fixed
- **homeSale** — 2 bugs: (1) IDOR — `GET /home-sales/unit/:id` non-active-contract branch returned the contract to ANY tenant (no `tenant_id === profileId` check); fixed. (2) write-scope — `POST /` trusted body `tenantId`; now validated against `v_lease_active_tenants`.
- **commonAreas** — 1 bug: `/reservations/:rid/decide` flipped status without an `AND status='pending'` guard → concurrent double-approve could double-bill the amenity fee; made the transition atomic. ALSO recovered a **pre-existing red suite** (10/16): tests exercised `/request` without `reservable:true`, but the create default is `reservable=false` ("announce-only", confirmed by the AmenitiesPage toggle copy) — tests were stale, not the code. Defaulted the `makeArea` helper to `reservable:true` + added a test documenting the intended default. 17/17.
- homeOwnership, lotRent, dumpLocations, vehicles, depots — CLEAN (evidence-based).

### B. Home sales reframed (Nic's "absolute distinction")
- **Landlord→Tenant (GAM bills the money)** — now supports BOTH plan shapes: flat ($X × N, auto-ends) OR amortized (price+interest+term). Flat is stored as 0%-amortization so billing/payoff is reused. Migration `20260806160000` (`home_sale_contracts.plan_type`), shared `HOME_SALE_PLAN_TYPES`, service+route derive the plan, `UnitDetailPage` FinancedSaleSection got the toggle.
- **Tenant→Tenant (GAM processes NO money)** — NEW record-only flow. A resident sells their OWN home to another resident on payments; GAM keeps the schedule + a copy of the contract, flips `home_ownerships` to the buyer on payoff. **Separate tables** `resident_home_sales` + `resident_home_sale_installments` (migration `20260806170000`) so the billing cron can NEVER touch it. New `services/residentHomeSale.ts`, `routes/residentHomeSale.ts` (create / get / mark-paid / cancel / contract upload + authed serve), registered in index.ts, `ResidentSaleSection` in UnitDetailPage, `cleanupAllSchema` updated. 4 tests. Memory `gam-home-sale-money-distinction` saved.

### C. Money-path hardening
- **Propane double-charge** (Nic escalated from "minor") — migration `20260806150000` adds `propane_fills.client_key` + partial-unique index; `POST /propane/fills` takes a per-unit advisory lock + short-circuits on repeat key (ON CONFLICT); frontend sends a stable key per fill-modal mount. Test proves 2 submits → 1 fill/charge.
- **L→T home-sale billing idempotency backstop** — migration `20260806180000` adds `payments.home_sale_installment_id` + partial-unique index `ux_payments_home_sale_installment` + FK; `billDueHomeSaleInstallments` now bills each installment in its own txn with `ON CONFLICT (home_sale_installment_id) WHERE … DO NOTHING`. It was the ONE money type missing a `ux_payments_*` backstop.

### D. Four structural fixes ("fix them all")
- **#1 Hibernation marker** — migration `20260806190000` `work_trade_agreements.paused_by_hibernation`; `/leases/:id/hibernate` sets it, `/resume` reactivates ONLY those (a hand-paused agreement now survives a hibernate/resume cycle). 2 regression tests (69/69 leases).
- **#2 Shared authed file-serve** — `lib/fileServe.ts` (traversal-safe resolve + stream); `documents.ts` and `residentHomeSale.ts` refactored onto it. 6 unit tests (rejects `/uploads/../../etc/passwd`, non-uploads paths, null, missing).
- **#3 Money-idempotency completeness guard** — `apps/api/src/moneyIdempotency.test.ts` parses `payments.type` and FAILS if a new type isn't declared as index-backed or idempotent-by-documented-other-means. (Chosen over refactoring money inserts — safer, prevents the actual "forgot the backstop" failure.)
- **#4 wire-contract → 0 everywhere** — workflow swept business (29→0; real bug: GlobalSearch `work_orders` group never rendered) + fitness (23→0; all request-body/local-state reads, annotated `// wire-ok`). Verified ground truth (scan 0, tsc clean) then ratcheted baselines.

### E. Wire-contract launch portals → 0 (item #5 from the platform eval)
Landlord 12→0 (real bug: NotificationsPage read `data.maintenance_request_id` off a **camelized jsonb blob** — `camelCaseKeys` deep-recurses into jsonb, so it was undefined; fixed to `maintenanceRequestId`. Dead `camelCase ?? snake` fallbacks removed. ConfirmIntentModal const-map annotated). Admin 8→0 (arc-closer "onboarding speed" report read 8 snake fields off a camelized response → whole table rendered blank; fixed). Storefront 10→0 (baseline was stale; already 0). Business SchedulesPage fixed earlier in-session (42→29→…→0). **Every portal is now baseline 0** — the wireContract guard is fully preventive. Memory `gam-camelize-wire-contract-test-gap` updated with the jsonb-recursion gotcha.

### F. Two heartbeat monitors (new product features)
- **Landlord dashboard — "Property Health — last 6 months"** (`apps/landlord/.../DashboardPage.tsx`): replaced the Rent-Collected area chart with an animated ECG (6 PQRST beats = 6-month revenue, sweeping scan + glow, `prefers-reduced-motion` fallback, hover tooltip + marker). Health COLOR = lease-rent collection rate (`collectedMtd / monthlyRentVolume`): `<85%` red, `≥85%` green, `=100%` **gold**. **No amber** (Nic: reads as the gold at a glance). Dropped `recharts` from the page.
- **Tenant home — "Payment Health — last 6 months"** (`apps/tenant/src/main.tsx`): mirror ECG, but health = **ON-TIME payment %** (NOT total paid). Enhanced `GET /tenants/me/payment-health` with a real on-time series: a billed obligation (rent/utility/fee/home_payment) is on-time iff it settled by `due_date + lease grace`; excludes late_fees + deposits; window = 6 months. Beats = each month's on-time rate; color 100 gold / ≥80 green / <80 red. 19/19 tests. (Demo: alice reads 60% red — Apr–Jun on time, Jul–Aug late.)

---

## DECISIONS LOCKED (Nic)
- Home-sale money boundary is **absolute**: L→T billed via platform (like rent); T→T record-only, separate tables, never wire money to it.
- Heartbeat health scales **red→green→gold, NO amber**.
- Landlord monitor = collection vs expected **lease rent** (not short-term/booking income). Tenant monitor = **on-time** %, not total-paid ("total paid is the landlord's collective view").
- Thresholds (mine, tunable): landlord green ≥85 / gold =100; tenant green ≥80 / gold =100.

## MIGRATIONS (all applied to `gam`, schema regenerated)
`20260806150000` propane client_key · `160000` home_sale plan_type · `170000` resident_home_sales · `180000` payments home_sale_installment idempotency · `190000` work_trade paused_by_hibernation.

## VERIFY STATE
- tsc clean: api, landlord, tenant, business, fitness, admin, shared.
- Green suites (touched): homeSale 12, residentHomeSale 4, commonAreas 17, propane 10, lotRent 3, homeOwnership 4, workTrade 26, leases 69, fileServe 6, moneyIdempotency 2, wireContract 15 (all portals 0), tenants-profile-dashboard 19, payments 48, moneyTriplet 31.
- **Nothing committed.** Whole S578→S594 sweep + this session = one uncommitted deploy.

## OPS NOTES (completed as scripts this session — S594)
These are now real, tested tooling in `scripts/` (not just prose):
- **Backend/API change → `bash scripts/restart-api.sh`.** :4000 is the launchd
  `com.gam.api` dist (`apps/api/dist/index.js`), NOT ts-node-dev (that process is
  a non-bound leftover) — a source change is NOT live until rebuilt + kickstarted.
  The script does `tsc -b` build → `launchctl kickstart -k gui/$(id -u)/com.gam.api`
  → verifies `/health`. (Ran it manually this session for the tenant endpoint; /health 200.)
- **Frontend (.tsx) change** HMRs via the vite dev servers — no restart needed.
- **Dev login 2FA code → `bash scripts/dev-2fa-code.sh <email>`.** Email-2FA is
  mandatory on every portal (S578), but dev SUPPRESSES real sends to seed domains
  (`@tenant.dev/@demo.dev/…`); the 6-digit code is stored in `email_send_log.subject`.
  Submit the password in the UI FIRST (that generates the code), then run the script.
  Works for ANY dev login. (Nic walks the tenant portal as `alice@tenant.dev` / `tenant1234`.)

## OPEN / DEFERRED (all optional — nothing blocking)
- Commit the S578→S594 sweep (Nic's call — do NOT initiate).
- Heartbeat thresholds tunable; tenant on-time could score all-time vs trailing-6-mo if Nic prefers.
- Landlord monitor beats still come from `stats.trend` (may include non-lease revenue); the COLOR is lease-only. Restricting beats to lease-rent is a small backend `stats.trend` change if wanted.
- Non-launch wire-contract debt is now 0 too (business/fitness swept), so the guard is airtight platform-wide.

## NEXT SESSION
1. Sweep is DONE — no more subsystems. Continue with Nic's product direction / walkthroughs.
2. If committing: it's one large uncommitted tree (S578→S594) — Nic decides when.
3. Remember the OPS notes (API rebuild+kickstart; dev 2FA code lookup).

## RELEVANT MEMORIES
[[gam-home-sale-money-distinction]], [[gam-camelize-wire-contract-test-gap]], [[gam-sweep-byhand-no-fanout]], [[gam-comb-dual-lens]], [[gam-prod-api-restart]], [[gam-owner-login-email-2fa]], [[gam-no-raw-enums-in-ui]], [[gam-button-color-rule]], [[gam-foreign-ref-write-scope]], [[gam-file-serve-perrow-auth]].
