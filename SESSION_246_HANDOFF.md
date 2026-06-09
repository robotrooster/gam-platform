# Session 246 — closed

## Theme

FlexDeposit full build — second Flex Suite product. Tenant splits
the security deposit into 2–4 installments based on deposit amount ×
Checkr BG risk_level. GAM fronts the gap to landlord on move-in so
landlord sees deposit funded in full from day 1 — landlord never
knows the tenant is on installments. $3/month custody fee runs
continuously while the tenant has a deposit on the GAM platform.

## Product spec decisions (Nic-confirmed)

| Question | Decision |
|---|---|
| Who initiates enrollment? | **Tenant, before move-in.** Landlord never sees that the tenant is on FlexDeposit. The move-in invoice landlord receives is rent + non-deposit fees only — the deposit line is excluded because GAM fronts the gap. |
| Single payment at move-in? | Yes. Tenant pays installment 1 + rent + fees in one combined ACH PI; landlord receives their normal allocation; GAM keeps installment 1 + fires a Connect Transfer to landlord for the gap (N−1 installments worth) so landlord's deposit balance reads "funded in full." |
| Tier formula? | Risk-driven (Nic: "we can't go after non-payment for damages, so minimize float exposure"). $0–1000 → 4 max; $1001–2000 → 3 max; $2001+ → 2 max. BG risk_level modifies: low = max for band; medium = max − 1; high+ = 2 only. BG-missing or risk_level-null = ineligible (must wait for BG to complete). |
| Credit signal source? | **Checkr BG report's `risk_level`** (low/medium/high/very_high). Per Nic: new tenants have no GAM internal credit-ledger history, so internal score won't work for FlexDeposit. The internal multiplicative score belongs to a different product entirely. |
| $3/mo custody fee duration? | Continues as long as tenant is on the GAM platform — covers ongoing escrow custody costs, not just the financing service. Future-deferred: when tenant moves between GAM landlords, deposit re-points to new unit and fee continues uninterrupted. |
| Missed installment consequence? | **Placeholder shipped**: standard ACH retry → second failure flips installment to `defaulted` + plan status to `in_default` + admin alert + 60-day tenant suspension. Nic to spec the stricter legal remedy (eviction-eligible, deposit-due-in-full, etc.) in a follow-up. The remedy hook is `handleFlexDepositPaymentNsf` for easy extension. |
| Visibility flag default? | TRUE, per S245 product decision (assessment posture). Flips at launch. |

## Items shipped

### Schema migration — `20260511120000_flexdeposit_installments.sql`

- `security_deposits.flex_deposit_plan_status` text (active /
  completed / in_default), check-constrained
- `security_deposits.gam_advance_amount` numeric — dollars GAM
  fronted to landlord at move-in (= (N−1) × installment_amount)
- `tenants.flex_deposit_disqualified_until` + reason — 60-day
  cooldown after default
- New `flex_deposit_installments` table — one row per installment
  in the plan (PK id, FK security_deposit_id + tenant_id, number
  1..N, count 2..4 CHECK, amount, due_date, status enum
  pending/settled/failed/defaulted, payment_id FK, timestamps).
  Unique (security_deposit_id, installment_number). 3 indexes.
- New `flex_deposit_custody_charges` table — $3/mo charge log.
  Unique (cycle_month, tenant_id). 2 indexes.
- Seeds `flexdeposit_rollout_visible = TRUE` feature flag.

### Shared package — `packages/shared/src/index.ts`

- Replaced 5-tier 2-6 `FLEX_DEPOSIT_TIERS` with the new 3-band
  2-4 matrix (`$0-1000`/`$1001-2000`/`$2001+` → 4/3/2 installments).
- New `getFlexDepositMaxInstallments(depositAmount, riskLevel)` —
  the canonical tier resolver. Returns NULL when risk_level missing.
- `getFlexDepositTier(depositAmount)` kept as backwards-compat shim
  for any pre-S246 callers.
- New constants: `FLEX_DEPOSIT_CUSTODY_FEE = 3`, `FLEX_DEPOSIT_NSF_COOLDOWN_DAYS = 60`.

### Service — `apps/api/src/services/flexDeposit.ts` (~640 lines)

| Export | Purpose |
|---|---|
| `isFlexDepositVisible()` | Wraps `isFeatureEnabled('flexdeposit_rollout_visible')` |
| `getFlexDepositEligibility(tenantId)` | Returns `{eligible, blockers, max_installments, risk_level, deposit_amount, suspended_until}`. Blockers: ach_unverified, no_deposit_row, no_bg_result, bg_not_approved, risk_level_missing, tenant_suspended_nsf, already_funded, tenant_not_found. |
| `enrollFlexDeposit({tenantId, installmentCount})` | Pre-move-in enrollment. Inserts N installment rows (1 due move-in, 2..N monthly thereafter). Stamps deposit row with plan metadata. Idempotent — refuses re-enrollment. |
| `cancelFlexDeposit(tenantId)` | Pre-move-in cancel only. Wipes installments + clears flags. Refuses if any installment already paid. |
| `settleFlexDepositMoveIn({tenantId, securityDepositId, movInPaymentId, landlordConnectAccountId})` | Called from moveInBundle after the move-in tx commits. Flips installment 1 to settled, increments deposit counters. Fires Connect Transfer for the gap (N−1) × installment_amount to landlord — *only* when held_by='landlord' (escrow case doesn't need a Transfer because GAM holds anyway). Idempotency key `flexdeposit_gap_<deposit_id>`. |
| `processFlexDepositInstallmentDue(now?)` | Daily cron entry. Walks pending installments 2..N due today, fires ACH platform charge per installment, inserts payments row, links via flex_deposit_installments.payment_id. Resolves tenant default PM from `stripe.customers.retrieve → invoice_settings.default_payment_method`. |
| `processFlexDepositCustodyFee(now?)` | Monthly cron entry (1st of month). Walks every tenant with an active/completed FlexDeposit plan, inserts a $3 charge + fires ACH pull. Idempotent via UNIQUE (cycle_month, tenant_id). |
| `reconcileSettledFlexDepositPayment(paymentId)` | Webhook hook. Self-gates by `type/entry_description`. On installment settle: flips installment row, increments deposit counters, recomputes next_installment_date, flips plan to 'completed' when last installment lands. On custody-fee settle: flips fdcc row. |
| `handleFlexDepositPaymentNsf(paymentId)` | Webhook hook. First failure deferred to achRetry; second failure marks installment defaulted, plan → in_default, tenant suspended 60 days, admin alert fires (cites the legal-remedy TODO). |

### Move-in bundle — `apps/api/src/jobs/moveInBundle.ts`

When tenant has FlexDeposit enrolled before move-in:
- Look up the security_deposits row + installment 1 amount
- Set `depositAmountForInvoice = 0` (landlord's invoice shows rent +
  non-deposit fees only — no deposit line)
- Add `firstInstallmentAmount` to the invoice total (tenant pays
  it via the combined PI)
- Insert a separate payments row for installment 1 with
  `invoice_id = NULL` (audit-only, tenant-side ledger; doesn't appear
  on landlord's invoice view)
- Post-commit: call `settleFlexDepositMoveIn` which fires the
  Connect Transfer for the gap to landlord

### Routes — `apps/api/src/routes/tenants.ts`

| Route | Verb | Purpose |
|---|---|---|
| `/api/tenants/flexdeposit` | GET | Returns visibility + eligibility + active installment plan |
| `/api/tenants/flexdeposit/enroll` | POST | Body `{ installmentCount: 2..4 }`. Delegates to `enrollFlexDeposit`. |
| `/api/tenants/flexdeposit` | DELETE | Pre-move-in cancel; refuses if any installment already paid. |

### Scheduler — `apps/api/src/jobs/scheduler.ts`

Two new crons (Phoenix timezone):
- **0 6 * * *** — `processFlexDepositInstallmentDue`
- **0 7 1 * *** — `processFlexDepositCustodyFee` (1st of month)

### Webhook integration — `apps/api/src/routes/webhooks.ts`

Settled hook: calls `reconcileSettledFlexDepositPayment` after the
existing OTP + FlexPay reconcilers. Failed hook: calls
`handleFlexDepositPaymentNsf` after FlexPay/OTP NSF handlers. All
three NSF handlers are no-ops on non-matching payments — calling
them all in series is safe and idempotent.

### Tenant UI — `apps/tenant/src/main.tsx`

- New `FlexDepositModal` component (~110 lines). Shows deposit
  amount, max installments (from eligibility payload), installment-
  count picker (2..max), per-installment amount preview, $3/mo
  custody fee disclosure, NSF-second-failure-suspend disclosure.
  Ineligible state shows blocker-specific copy.
- New `useQuery('tenant-flexdeposit', ...)` hook pulling
  `/tenants/flexdeposit` for plan view + eligibility.
- Services-tile FlexDeposit action wired to `setFlexDepositModal(true)`.
  Description + price updated to match new spec.
- New "FlexDeposit installment plan" card on the services page —
  visible when enrolled, shows each installment with due date +
  status badge.

## Files touched (S246)

```
apps/api/src/db/migrations/
  20260511120000_flexdeposit_installments.sql        (new)
apps/api/src/db/schema.sql                           (regenerated)
packages/shared/src/index.ts                         (~ tier matrix
                                                      rewrite +
                                                      max-installments
                                                      helper; ~+25 / -5)
apps/api/src/services/flexDeposit.ts                 (new, ~640 lines)
apps/api/src/routes/tenants.ts                       (+ 3 routes;
                                                      ~+55 lines)
apps/api/src/jobs/moveInBundle.ts                    (~ FlexDeposit
                                                      branch;
                                                      +~75 / -10)
apps/api/src/jobs/scheduler.ts                       (+ 2 crons; +30)
apps/api/src/routes/webhooks.ts                      (+ 2 webhook
                                                      hooks; +25)
apps/tenant/src/main.tsx                             (+ FlexDeposit-
                                                      Modal + plan
                                                      view + tile
                                                      wiring + state
                                                      hook; ~+180)
DEFERRED.md                                          (~ FlexDeposit
                                                      tombstone +
                                                      portability
                                                      deferral note)
SESSION_246_HANDOFF.md                               (this file)
```

## Verification

- `cd apps/api && npx tsc --noEmit` → clean (0 errors)
- `cd apps/tenant && npx tsc --noEmit` → clean (0 errors)
- `npm run build` in packages/shared → clean
- Migration applied; `\d flex_deposit_installments` confirms 15
  columns, 3 indexes, UNIQUE (deposit_id, installment_number),
  status + count + number + amount CHECK constraints
- `flexdeposit_rollout_visible = TRUE` seeded

## Decisions made during build

| Question | Decision |
|---|---|
| One PI for rent+fees+installment_1 or split? | One combined PI. Avoids paying Stripe's ~$0.50 per-PI ACH fee twice and matches the FlexPay pattern. Installment 1 payments row carries no invoice_id (audit-only, tenant-side ledger). |
| Where does the deposit money actually flow? | Tenant pays installment 1 → GAM platform balance (rent + fees route normally to landlord via destination charges; installment 1 stays on platform). GAM fires Connect Transfer for the gap (N−1 × installment) to landlord → landlord's Connect balance shows full deposit. |
| What if landlord has no Connect account at move-in? | `settleFlexDepositMoveIn` skips the Transfer; the deposit row stays at "partial" status and an ops-side reconciliation can fire it later. (Same posture as OTP/FlexPay's "no Connect at advance time" path.) |
| What if `held_by='gam_escrow'`? | No Connect Transfer fires — GAM holds the funds anyway. The deposit row tracks the gap as `gam_advance_amount` for accounting; escrow funds grow as installments come in. |
| Rounding residue? | Stamped on installment 1 (largest payment). Banker's rounding to cents matches existing rent rounding. |
| Re-enrollment? | Refused. Tenants who cancel before move-in can re-enroll fresh; tenants who paid installment 1 can't cancel. |

## Carry-forward — S247+

### Flex Suite remaining

- **FlexCharge** — total rebuild. `flex_charge_accounts` /
  `flex_charge_transactions` tables don't exist; 4 tenant + 4
  landlord routes target nonexistent tables. Naming collision with
  POS card-surcharge "FlexCharge fee" needs separate rename pass.
- **FlexCredit** — needs product call (bureau vendor pick, qualifying
  events, billing). Backend is a single boolean column + flip
  endpoint today.

### FlexDeposit follow-ups

- **Deposit portability across leases on GAM platform.** Tenant
  moves from Landlord A's unit to Landlord B's unit; deposit
  re-points to new unit, custody fee continues uninterrupted.
  Touches: lease-end (don't trigger deposit-return engine when
  next-lease-on-GAM exists), security_deposits.unit_id repointing,
  Connect transfer A→B for landlord-held deposits, or escrow
  carry-over for gam_escrow ones. Multi-session.
- **Missed-installment legal remedy.** Nic to spec. Placeholder
  hook in `handleFlexDepositPaymentNsf`.

### Sublease — phase-2/3 build

- Money flow wiring (allocation engine + payments rows for
  sublessees)
- Document / e-sign integration
- Sublessee invite-via-email flow
- Liability disclosure copy
- Admin frontend surface

### Smaller items

- POS multi-terminal sync (still likely premature)
- POS end-to-end smoke (Nic-runs)
- /resolve smoke (Nic-runs)
- OTP cron-timing rework (flagged S244, non-blocking)

### External-vendor-blocked

- **Checkr Partner** — credentials still pending per Nic 2026-05-11

## Revised count

| Bucket | Pre-S246 | Post-S246 |
|---|---|---|
| Pickable now | ~3 (FlexCharge, FlexCredit, Sublease phase-2/3) | ~3 (same minus FlexDeposit) |
| Pre-launch flag-gated | 3 (FlexCharge, FlexDeposit, FlexCredit) | 2 (FlexCharge, FlexCredit; FlexDeposit shipped) |
| Multi-session epics | 1 (Sublease remaining) | 1 (Sublease + FlexDeposit portability) |

**Until v1 launch-ready:** ~3-4 sessions (FlexCharge, FlexCredit,
Sublease money-flow, FlexDeposit portability). Checkr unblocks on
partner credentials.

---

End of S246 handoff.
