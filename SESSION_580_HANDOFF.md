# SESSION 580 HANDOFF — Pre-onboarding sweep: Subsystem 2 (money-flow) complete + plan for 3→24

> Continues the S578 pre-onboarding sweep (24 subsystems, walked in order).
> This session finished the **Checkr/screening/onboarding-window build** (see
> SESSION_579_HANDOFF.md) AND swept **Subsystem 2 (Stripe money-flow)** end-to-end.
> **Nothing is committed** — the sweep rule is ONE deploy at the very end of the
> whole sweep. This doc maps the remaining subsystems into a plan of action.

---

## SWEEP RULES (Nic, non-negotiable — carry into every session)
1. **Go in ORDER, 2→24.** One subsystem at a time; report, then next.
2. **DO NOT COMMIT/deploy** until the ENTIRE sweep is done. One deploy at the end.
3. **Trust the CODE, not memory.** Trace real paths end-to-end. When intent is
   unclear, flag a design question — don't assume.
4. **Fix confirmed bugs the RIGHT / foundational way** (Nic, S580) — build for scale,
   no minimal bolt-ons. Update tests. Keep tree green (tsc + affected suites).
5. **TEST-DB GUARD:** always `cd apps/api && DB_NAME=gam_test npx vitest run src/…`.
   NEVER from repo root / without DB_NAME=gam_test (wipes the dev `gam` DB).
6. Report three buckets per subsystem: **(A)** confirmed bugs w/ repro, **(B)** design
   questions / minor notes, **(C)** verified-good (so Nic knows it was actually checked).

## Progress map (which subsystems are done)
| # | Subsystem | Status |
|---|-----------|--------|
| 1 | Auth (login/2FA/sessions) | ✅ S578 + universal mandatory 2FA (S579) |
| 2 | **Stripe money-flow** | ✅ **THIS SESSION — 1 bug fixed + rest verified** |
| 3 | **Rent invoicing + late fees** | ⬜ **DO NEXT** |
| 4 | Leases + e-sign | ⬜ |
| 5 | Onboarding | 🟨 largely covered by the S579 screening/onboarding build |
| 6 | Tenant portal | ⬜ |
| 7 | Landlord core | ⬜ |
| 8 | FlexSuite | 🟨 FlexPay done (S578); FlexDeposit/Charge/Credit/supersedence not swept |
| 9 | Maintenance | ⬜ |
| 10 | Inspections | ⬜ |
| 11 | Utilities/RUBS | ⬜ |
| 12 | Documents/storage | ⬜ |
| 13 | Screening/background | ✅ built S579 |
| 14 | POS | ⬜ |
| 15 | Business platform | 🟨 login/signup 2FA done (S578) |
| 16 | Storefront + public booking | ⬜ |
| 17 | Books/bookkeeping | ⬜ |
| 18 | Admin + admin-ops | 🟨 login 2FA done (S578) |
| 19 | PM companies | 🟨 login 2FA done (S578) |
| 20 | AI agents | ⬜ |
| 21 | Crons/scheduler (chain reactions) | ⬜ |
| 22 | Surveys/notifications/appointments | ⬜ |
| 23 | MH/RV (lot rent, propane, homes, vehicles) | ⬜ |
| 24 | Work-trade / snowbird / recurring | ⬜ |

---

## SUBSYSTEM 2 — Stripe money-flow — SWEPT (this session)

**Baseline:** 94 core money tests green before touching anything.

### (A) Confirmed bug — FIXED foundationally
**Platform→Connect passthrough double-pay** (`services/landlordPassthrough.ts`).
The Transfer fired INSIDE the DB txn with **no idempotency key**; on a
commit-after-transfer failure `platform_held` stayed true, so the auto-retry
(next `account.updated` webhook / weekly cron) re-summed the same owner-share and
fired a SECOND Transfer → landlord paid twice, GAM eats it.

Rebuilt as a durable **fire-after-commit intent state machine**:
- Migration `20260804130000_platform_transfer_intents.sql` (pending→transferred/failed).
- `stripeConnect.createPmCompanyTransfer` gained `idempotencyKey`.
- `landlordPassthrough.ts`: RESERVE (txn: claim owner-share, net reversals, write
  pending intent, flip platform_held, stamp `intent:<id>` sentinel) → EXECUTE (fire
  Transfer, key `platform_passthrough_<id>`) → CONFIRM (stamp real id) → RECOVER
  (`recoverPendingPlatformTransfers`, re-fires stuck intents; Stripe dedupes → never
  double-pays / never strands money).
- `jobs/autoPayouts.ts` runs recovery at the top of each weekly run.
- Tests: failure test rewritten + 3 new (reserved-not-stranded, no-double-pay,
  recovery-with-idempotency). `test/dbHelpers.ts` cleans the new table.
- **147 money-flow tests green; API typechecks clean.**

### (C) Verified-good (traced end-to-end)
- Webhook **signature verify** (dual platform+Connect secret) + **raw-event persist
  idempotency** (`stripe_event_id` UNIQUE, before processing).
- `payment_intent.succeeded` — **settle-once** (`status != 'settled'` guard); all
  allocations/post-commit transfers/credit-ledger keyed off settled rows → re-delivery no-op.
- `autoPayouts` Connect→bank payout — idempotency key `auto_friday_<acct>_<day>` + 6-day pre-skip.
- `paymentReversal` (chargeback/ACH-return reopen) — settled-guard + per-payment advisory
  lock + `ON CONFLICT (stripe_event_id)`; two-row reopen model.
- `reversalRecovery` — decision engine only (netting vs ACH-pull), idempotent; netting runs
  inside the passthrough reserve txn.
- `platformFee` — per-property $10 min, short-stay proration, future/pre-onboarding months excluded.
- `withdrawals` — instant-fee math (drift favors user); **margin-transfer REVERSED if payout
  fails** (already fire-after-commit-correct); live balance re-read each request.
- `disbursements` + `balances` — scoped read-only.

### (A2) Instant-withdrawal margin — REBUILT foundationally (Nic)
The old instant flow PRE-PULLED GAM's margin off the Connect balance, then
REVERSED it if the payout failed — a double-failure left the landlord charged-
for-nothing until an admin manually fixed it. Rebuilt so no manual recovery is
ever needed:
- Migration `20260804140000_instant_withdrawal_margin_and_circuit.sql`:
  `landlord_instant_margins` (owed→collected) + `connect_instant_circuit`.
- `services/instantWithdrawalMargin.ts`: circuit breaker (`recordInstantFailure`
  trips `disabled` at 3 consecutive fails; `recordInstantSuccess` resets) +
  margin receivable (`recordInstantMarginOwed`) + `collectOwedInstantMargins`
  (Connect→platform, idempotency key `instant_margin_<id>`; deferral on failure).
- `routes/withdrawals.ts`: instant path NEVER pre-pulls — pays the landlord their
  NET (`available − all-in fee`), records GAM's margin as `owed`. A failed payout
  moves NO money (nothing to reverse) + trips the circuit. When instant is
  disabled, the route auto-FALLS BACK to the free standard payout (landlord still
  paid, flaky path isolated). `instantFeeBreakdown` now returns exact `net`.
- `jobs/autoPayouts.ts`: `collectOwedInstantMargins` runs per candidate BEFORE the
  bank sweep — nets GAM's margin against the next disbursement.
- Tests: `instantWithdrawalMargin.test.ts` (circuit trip/reset, collect, deferral)
  + `withdrawals.test.ts` updated. **143 money-flow tests green; tsc clean.**

### (B) Notes / design-continuity (not bugs)
- **ACH-pull executor NOT built** (deferred to live keys). When built it moves real money
  OUT of a landlord's bank → **MUST reuse the S580 fire-after-commit + idempotency
  foundation**, else it reintroduces the double-pull class of bug.
- `payment_failed` re-delivery re-runs the retry UPDATE (nudges `next_retry_at` forward);
  `retry_count<2` guard doesn't dedupe the same event. Harmless timing drift.
- `withdrawals` payout idempotency window is 1s; a cross-second concurrent double-submit
  relies on Stripe's balance check. Consider a DB-level in-flight guard if it ever matters.
- `platformFee.ts` is a SECOND implementation of the fee math mirroring
  `jobs/platformFeeAccrual.ts` — drift risk; a shared source of truth would be cleaner.
- `disbursements` list is LIMIT 50 with no pagination.

---

## PLAN OF ACTION — Subsystem 3 onward (files + what to check per subsystem)

For each: enumerate surface → trace route→service→DB→webhook→cron end-to-end →
report A/B/C → fix confirmed bugs the foundational way → run affected suites + tsc.

**3. Rent invoicing + late fees (DO NEXT).** `jobs/invoiceGeneration.ts`,
`jobs/lateFees.ts`, `jobs/moveInBundle.ts`, `services/depositReturn.ts`, lease fee
schedule (`lease_fees.due_timing`). CHECK: monthly invoice cron idempotency (no double
invoices per unit/month — there's a partial UNIQUE on (unit_id,due_date)); late-fee
accrual (grace, retroactive back-to-due-date per `gam-retroactive-late-fee-design`);
FIFO pay-in-full (`gam-payment-application-fifo` — pay-in-full ONLY, no partials);
rent-obligation-per-lease (suspended/evicting units still counted). Tests: payments FIFO,
lateFees, invoiceGeneration suites.

**4. Leases + e-sign.** `routes/leases.ts`, `routes/esign.ts`, `routes/subleases.ts`,
`routes/subleaseInvitations.ts`, `services/leaseOnboarding.ts`, auto-field placement.
CHECK: e-sign signer state machine, auto-draft-on-accept (the double-draft trap I noted
in S579 — unit-bound intent + explicit e-sign), lease-is-law (charges only from signed
lease), renewal/non-renewal binding, deposit derivation.

**5. Onboarding.** Mostly covered by the S579 screening/onboarding-window build. Residual:
`routes/units.ts`, `routes/properties.ts` CRUD, CSV import pipeline
(`landlords-csv-*`), occupancy modes.

**6. Tenant portal.** `routes/tenants.ts` (big), `tenantCredits.ts`, `tenantWalkthroughs.ts`,
payment methods, communication dashboard.

**7. Landlord core.** `routes/landlords.ts` (~80 endpoints), reports (`routes/reports.ts` —
P&L auto-books), expenses, dashboard.

**8. FlexSuite.** `services/flexDeposit.ts` (custody model), `flexCharge.ts`, `flexCredit.ts`,
GAM-supersedence routing, `flexpay.ts` (already rehab'd S578). CHECK the not-credit posture
+ SSDI/SSI gates + supersedence FIFO.

**9. Maintenance.** `routes/maintenance.ts`, `maintenance-portal.ts`, `entryRequests.ts`,
approval threshold, contractor-marketplace fee (hidden).

**10. Inspections.** `routes/inspections.ts` (catalog, condition, photo gate, finalize→PDF).

**11. Utilities/RUBS.** `routes/utility.ts`, `serviceInterruptions.ts`, turnover reads,
RUBS submeter exclusion, flat-rate.

**12. Documents/storage.** `routes/documents.ts` + all authed file routes (nothing-public rule).

**14. POS.** `routes/pos.ts`, `businessPos.ts`, `posCustomerOnboarding.ts`, `posLock.ts`,
`terminal.ts` — dual-mode parity (landlord register vs standalone), cashier passcode/terminal lock.

**15. Business platform.** `businessInvoices`, `businessWorkOrders`, `businessQuotes`,
`businessPayouts` (Friday batch), $10/mo invoicing fee.

**16. Storefront + public booking.** `publicPropertyBooking.ts`, `bookings.ts`, subdomains,
storefront prod service.

**17. Books/bookkeeping.** `routes/books.ts`, `bankFeed.ts`, `bankReconciliation.ts` —
Stripe FC bank feed → landlord_expenses; P&L vs Books separation.

**18. Admin + admin-ops.** `routes/admin.ts` (~69 ep), scopes, nexus/tax, owner login.

**19. PM companies.** `routes/pm.ts`, `pmAgentActivity`, fee-plan routing, invitations.

**20. AI agents.** `routes/agent.ts`, roster eval (43 scenarios), runner backstops.

**21. Crons/scheduler.** `jobs/scheduler.ts` (~59 crons) — the backend chain reactions;
verify each cron's idempotency + self-gating (this is where money/state jobs live).

**22. Surveys/notifications/appointments.** `surveys.ts`, `announcements.ts`,
`notifications.ts`, `appointments.ts`.

**23. MH/RV.** `homeOwnership`, `homeSale`, `lotRent`, `propane`, `dumpLocations`,
`vehicles`, `depots`, `commonAreas` — reconciliation window, financed-home ownership flip.

**24. Work-trade / snowbird / recurring.** `workTrade.ts`, `recurringSchedules.ts` —
active-lease coupling, snowbird hibernating lease (design-locked, not built).

---

## KEY CONTEXT
- **Uncommitted work this session:** the entire S579 screening/onboarding build +
  the S580 money-flow fix (migration `20260804130000`, `landlordPassthrough.ts`,
  `stripeConnect.ts`, `autoPayouts.ts`, tests, `dbHelpers.ts`). `git status --short` for the full list.
- Migrations applied to dev + schema.sql regenerated (gam_test rebuilds from schema.sql).
- Prod API = launchd `com.gam.api` (compiled dist); FINAL deploy at sweep end:
  `cd apps/api && npm run build && launchctl kickstart -k gui/$(id -u)/com.gam.api`, verify :4000 + a login, THEN commit.
- Relevant memories: `gam-money-flow-platform-holds`, `gam-screening-grandfather-onboarding-window`,
  `gam-signup-2fa-and-auth-sweep`, `gam-test-db-guard`, `gam-prod-api-restart`.
