# Session 330 — closed

## Theme

Shipped **FlexDeposit eligibility-check workflow** (S309
option C, deferred since S304). Closes the gap between
Consumer Privacy Policy § 2.1's promise of eligibility
"determined from your existing Platform account data
(e.g., your tenancy record, payment history on the
Platform, and active-lease status)" and the actual
behavior, which until now only checked ACH + BG + deposit
row + NSF cooldown.

Three new rule-based blockers added — all observable
Platform signals, no scoring or external bureau check
(preserves the SLA-not-loan structural defense as
service-tier qualification, not underwriting).

## Items shipped

### Backend (`apps/api/src/services/flexDeposit.ts`)

**Three new exported constants:**
- `FLEX_DEPOSIT_MIN_TENURE_DAYS = 30`
- `FLEX_DEPOSIT_MIN_RECENT_ON_TIME_PAYMENTS = 1`
- `FLEX_DEPOSIT_PAYMENT_LOOKBACK_DAYS = 90`

**`FlexDepositEligibility.blockers` union extended** with
three new variants:
- `insufficient_platform_tenure`
- `insufficient_on_time_payment_history`
- `prior_flexdeposit_default`

**`getFlexDepositEligibility()` extended** with three new
checks layered onto the existing ACH/BG/NSF gates:

1. **Platform tenure** — `tenants.created_at` compared to
   NOW(); blocks if < 30 days. Fraud defense against
   just-signed-up accounts.
2. **Prior FlexDeposit default** — any `security_deposits`
   row with `flex_deposit_plan_status = 'in_default'`
   permanently blocks. Distinct from `tenant_suspended_nsf`
   (temporary cooldown) — re-enrolling a defaulter would
   undermine the service-tier-consequences framing.
3. **On-time payment history** — counts
   `credit_events.event_type='payment_received_on_time'`
   in the trailing 90 days. First-lease-ever tenants
   (zero prior leases in `lease_tenants`) are exempt —
   they have no history; the BG-approved gate covers the
   cold-start risk. Tenants with any prior lease must have
   ≥ 1 on-time payment in the window.

### Frontend (`apps/tenant/src/main.tsx`)

FlexDepositModal eligibility-blocker label section
extended with human-readable copy for the three new
blocker types:
- `insufficient_platform_tenure` → "FlexDeposit requires
  at least 30 days on the GAM platform. Check back closer
  to your move-in date."
- `insufficient_on_time_payment_history` → "FlexDeposit
  requires at least one on-time rent payment on a prior
  lease in the last 90 days."
- `prior_flexdeposit_default` → "A prior FlexDeposit plan
  was marked in default. Re-enrollment is not available."

## Files touched (S330)

```
apps/api/src/services/flexDeposit.ts      (3 constants + 3
                                            blocker variants +
                                            ~50 lines of new
                                            eligibility logic)

apps/tenant/src/main.tsx                  (3 new blocker labels
                                            in FlexDepositModal)

SESSION_330_HANDOFF.md                    (this file)
```

No migrations. No schema changes (existing columns suffice).
No new service modules.

## Decisions made during build

| Question | Decision |
|---|---|
| Source of "on-time payment" signal — recompute from `payments` table or read `credit_events`? | **`credit_events`.** The credit-ledger emitter already writes `payment_received_on_time` events on every successful settled rent payment (S134–S142 ledger work). Reading the event log is cheaper + canonical. |
| First-lease-ever exempt from payment-history check? | **Yes.** New tenants making their first move-in have no payment history to check, and the BG-approved gate already covers the cold-start risk. Blocking first-lease tenants would defeat the FlexDeposit product premise (which is FOR new move-ins). |
| Permanent vs time-limited block for prior_flexdeposit_default? | **Permanent.** The SLA's service-tier consequences (Consumer ToS § 9.1.4(i)) treat default as a structural disqualification, not a cooldown. The existing `tenant_suspended_nsf` flag covers the temporary post-NSF window; this is the durable permanent flag for plan-level default. |
| Knobs as constants or DB-configurable? | **Constants for now.** Three knobs (`MIN_TENURE_DAYS`, `MIN_RECENT_ON_TIME_PAYMENTS`, `LOOKBACK_DAYS`) are exported so they're discoverable. Promoting to landlord-configurable or product-tier configuration is a future session — current values are sensible defaults. |
| External credit-bureau check? | **No.** Would break SLA-not-loan structural defense — credit-bureau pulls are an explicit hallmark of credit underwriting. The rule-based observable-Platform-data approach is what the Privacy Policy promises and what keeps the product on the right side of TILA / FCRA / state lending licensing. |

## Verification

- `npx tsc --noEmit` on `apps/api`: clean.
- `npx tsc --noEmit` on `apps/landlord`: clean.
- `npx tsc --noEmit` on `apps/tenant`: clean.
- `npx tsc --noEmit` on `apps/admin`: clean.
- `npx tsc --noEmit` on `apps/pm-company`: clean.
- Hand-ran the three new SQL queries against dev tenant
  (`alice@tenant.dev`):
  - `tenure_days = 5` (< 30 → blocks
    `insufficient_platform_tenure`)
  - `prior_default = false` (no block)
  - `prior_lease_count = 1` (not first-lease → checks
    on-time history)
  - `recent_ontime_count = 0` (< 1 → blocks
    `insufficient_on_time_payment_history`)

  Expected behavior for a recent-seed dev tenant with no
  payment history.

Not browser-walked. The eligibility blockers will manifest
in the FlexDepositModal as the new labels when a real
tenant hits the page; that needs walkthrough validation
once Nic exercises the FlexDeposit enrollment flow.

## Items deferred — what S331 could target

Real product / launch-readiness options remaining:

### A. Acceptance subsystem test coverage

Regression protection for the S314→S323 chain (~7
sessions of work, zero tests). Vitest cases for
`recordAcceptance`, `getPendingReAcceptances`,
`commitReAcceptance`, `fireFlexsuiteAcceptanceEmail`,
the dispute-resolve corrected-event path (S325 fixed a
real bug there).

### B. POS request-body migration

Offline-sync queue requires care; persisted IndexedDB
payloads on real terminals could conflict with mid-
migration wire-key renames.

### C. Unicode-capable font in flexsuitePdf

Small (~300KB bundle add); removes the 7-char ASCII
sanitizer from S322.

### D. FlexDeposit eligibility test coverage

New product code; could pair with A as a single
"acceptance + eligibility tests" session.

### E. Long-tail S312 reads on remaining tenant pages

Maintenance, Disbursements, Documents, Reports — pages
the S327 scan flagged but weren't migrated.

## Items deferred (cross-session docket)

- Consumer-side retention framing decision (S300).
- Campground Master import path (Nic-blocked on sample).
- 2FA fan-out (walkthrough-blocked).
- Yardi GL-export columns, Rentec template (S293).
- FlexCharge Business Account Agreement signature capture
  (S309 option B — not a launch feature).
- Standalone POS-operator auth (S309 option D).
- Deposit-return ↔ unpaid-installment offset architecture
  call (S310 carryover).
- SchedulePage booking-vs-lease shape audit.
- POS request-body migration.
- Embed Unicode-capable font in flexsuitePdf.
- Acceptance subsystem test coverage.
- FlexDeposit eligibility test coverage.
- Remaining long-tail S312-class reads on tenant pages.
- Nic-visual-review of the reconstructed
  PmInvitationsPage.tsx (S329 regression).

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Consumer-side retention framing decision (S300).
- FlexCredit Lender partner selection.
- SLA § 9.1.4(iii) deposit-return offset framing call.
- Visual review of reconstructed PmInvitationsPage
  (S329 regression).

## What S331 should target

Plenty of bounded code options remain — acceptance tests,
eligibility tests, POS migration, Unicode font, tenant
long-tail. None are walkthrough-blocked.

---

End of S330 handoff. Closed clean. FlexDeposit
eligibility-check workflow shipped per Privacy Policy
promise.
