# Session 245 — closed

## Theme

FlexPay full build — first of the four Flex Suite products. The
recon at the start of the session revealed that DEFERRED.md was wrong
about both remaining epics: Flex Suite was *less* built than the UI
surface suggested (FlexPay routes hit nonexistent columns, would
crash on first call), and Sublease was *more* built than DEFERRED
claimed. Picked FlexPay for S245 because it crashed at runtime
(broken foundation per the fix-it-right rule), has the most-defined
product semantics in CLAUDE.md + tenant UI, and builds the engine
pattern (schema → enroll → grace-front cron → tenant-pull cron →
NSF retry) that FlexCharge / FlexDeposit / FlexCredit will clone.

## Product spec decisions (Nic-confirmed before build)

| Question | Decision |
|---|---|
| Pricing model? | $5 base + day-of-month. Pull on 1st = $6, pull on 11th = $16, pull on 28th = $33. Replaces the prior $3/$7/$12 tier system entirely. |
| Day cap? | 28. Covers all U.S. social security payout windows including SSDI/SS-retirement 4th-Wed-of-month (latest = 28th). Every month has a 28th, dodges the day-31-doesn't-exist problem. |
| FlexPay × OTP coexistence? | Both flags can be on for the same tenant. Money-side dedup: OTP fires EOM (earlier), wins the front; FlexPay's grace-period-end advance is suppressed (`grace_advance_suppressed = TRUE`) when OTP already covered. Tenant fee still bills regardless — the tenant signed up for scheduling certainty, not for OTP awareness. GAM collects both fee streams. |
| Tenant funds-flow? | GAM fronts rent to landlord from platform balance via Stripe Connect Transfer on `lease.rent_due_day + lease.late_fee_grace_days`. Tenant pays GAM on chosen day via combined ACH pull (rent + fee). Gross lands on platform balance — reimburses the advance + collects the fee revenue. |
| Funds-flow legal framing? | FlexPay is a PAYMENT-SCHEDULING SERVICE. Not a loan, not credit insurance, not a credit advance. Code identifiers (`tenant_fee_amount`, `fronted_at`, `processGracePeriodAdvance`) reflect the "fronting" framing internally; user-facing copy says "pay your rent on a day that matches your income". |
| Visibility default? | TRUE for UI/UX assessment per memory update. Per-product feature flag will flip at launch. |

## Items shipped

### Schema migrations

**`20260511110000_flexpay_schema.sql`** — tenant flag columns + the
`flexpay_advances` table.

- `tenants.flexpay_enrolled` (bool, default false)
- `tenants.flexpay_pull_day` (int 1..28 via CHECK)
- `tenants.flexpay_monthly_fee` (numeric(5,2))
- `tenants.flexpay_enrolled_at` (timestamptz)
- `tenants.flexpay_disqualified_until` (timestamptz)
- `tenants.flexpay_disqualified_reason` (text)
- `flexpay_advances` table:
  - identity: id, cycle_month, tenant_id, landlord_id, unit_id, lease_id
  - amounts: rent_amount, tenant_fee_amount, pull_day
  - landlord-front leg: grace_advance_suppressed (bool — TRUE
    when OTP covered), stripe_transfer_id (UNIQUE partial),
    transfer_attempted_at, transfer_error, fronted_at
  - tenant-pull leg: rent_payment_id, fee_payment_id, pulled_at,
    reconciled_at, defaulted_at, default_reason
  - status enum: pending / fronted / pulled / reconciled / nsf /
    defaulted
  - UNIQUE (cycle_month, tenant_id) — idempotency
  - Indexes on (landlord_id, cycle_month DESC), (tenant_id,
    cycle_month DESC), (status), (pull_day) WHERE
    status IN ('pending', 'fronted')

**`20260511110100_flexpay_feature_flag.sql`** — seeds
`flexpay_rollout_visible = TRUE` in `system_features`. Matches OTP's
flag-gating pattern; admins flip to FALSE per-product at launch.

### Service — `apps/api/src/services/flexpay.ts` (~510 lines)

| Export | Purpose |
|---|---|
| `calculateFlexPayFee(pullDay)` | `5 + pullDay`, throws on out-of-range |
| `isFlexPayVisible()` | Wraps `isFeatureEnabled('flexpay_rollout_visible')` |
| `getFlexPayEligibility(tenantId)` | Returns `{eligible, blockers, suspended_until}`. Blockers: ach_unverified, tenant_suspended_nsf, no_active_lease, tenant_not_found. **No deposit-funded gate** (FlexPay is independent of OTP). |
| `enrollFlexPay({tenantId, pullDay})` | Validates day 1..28, checks eligibility, writes the tenants row |
| `cancelFlexPay(tenantId)` | Clears the four enrollment columns |
| `processGracePeriodAdvance(now?)` | Daily cron entry. Walks every enrolled tenant whose lease grace-end day = today. Creates flexpay_advances row. Suppresses Transfer when matching OTP advance exists with stripe_transfer_id set. Otherwise fires `stripe.transfers.create` to landlord's Connect with idempotency key `flexpay_advance_<id>`. Returns counts. |
| `fireFlexPayAdvanceTransfer(opts)` | Lower-level Transfer firing; shared with future admin retry route. Same idempotency posture as OTP. |
| `processFlexPayPullDay(now?)` | Daily cron entry. Walks fronted rows whose pull_day = today. Resolves tenant's default payment method via `stripe.customers.retrieve → invoice_settings.default_payment_method`. Fires a single ACH PaymentIntent for rent + fee combined via existing `createRentPlatformCharge`. Inserts a `payments` row tagged `entry_description = 'FLEXPAY'`. |
| `reconcileSettledFlexPayPayment(paymentId)` | Webhook hook. On payment_intent.succeeded, flips matching advance row to 'reconciled'. Idempotent — no-op on non-FLEXPAY payments. |
| `handleFlexPayPaymentNsf(paymentId)` | Webhook hook for payment_failed. **First failure: no-op** — defers to the existing achRetry pipeline. **Second failure** (retry_count >= 1): marks advance defaulted, suspends tenant for 60 days, fires admin alert. |
| `autoDisenrollFlexPayOnAchUnverified(tenantId)` | Bank-unlink hook (parallel to OTP's version). No cooldown — tenant can re-enroll after re-verifying. |
| `cycleMonthForDate(d)` | First-of-month UTC for the cycle this date belongs to. |

### Routes — `apps/api/src/routes/tenants.ts`

Replaced the entire pre-S245 FlexPay block (lines 376-470) which
wrote to phantom columns:

| Route | Verb | Purpose |
|---|---|---|
| `/api/tenants/flexpay` | GET | Returns visibility + enrollment + eligibility + preview fee |
| `/api/tenants/flexpay/enroll` | POST | Body `{ pullDay }`, delegates to `enrollFlexPay` |
| `/api/tenants/flexpay` | DELETE | Cancels enrollment |

Removed the dead `getFlexPayTier` helper and the OTP-related
`otp_qualified_at` write (also a phantom column).

### Scheduler — `apps/api/src/jobs/scheduler.ts`

Two new daily crons (Phoenix timezone, parallel to existing OTP
cron at 3pm):

- **0 3 * * *** — `processGracePeriodAdvance`. Walks enrolled
  tenants whose lease grace-end day = today, fronts rent to
  landlord (or suppresses for OTP coverage).
- **0 5 * * *** — `processFlexPayPullDay`. Initiates tenant ACH
  pulls (rent + fee combined) on the chosen day.

Both gated by `isFlexPayVisible()` inside the service. Safe to leave
in scheduler permanently.

### Webhook integration — `apps/api/src/routes/webhooks.ts`

Two hooks added alongside the existing OTP hooks:

- `payment_intent.succeeded` (rent type): after OTP reconciliation,
  also calls `reconcileSettledFlexPayPayment`. Both reconcilers are
  no-ops on non-matching payments — calling both is safe and
  idempotent.
- `payment_intent.payment_failed` (rent type): after OTP NSF handler,
  also calls `handleFlexPayPaymentNsf` which checks retry_count and
  no-ops on first failure (deferring to achRetry).

### Tenant UI — `apps/tenant/src/main.tsx`

- `FlexPayModal` rewritten: single day-of-month slider (1..28),
  dynamic fee display computed as `5 + pullDay`, removed the
  3-tier card UI + variable-pattern toggle + SSI week-pattern
  selector. Removed dead `FLEXPAY_TIERS` + `WEEK_PATTERNS`
  constants.
- Services-page FlexPay tile: `$6–$33/month` price range,
  highlight shows `Day ${pullDay} · $${monthlyFee}/mo` when
  enrolled, locked only on `!achVerified` (no more deposit gate).
- Existing dashboard FlexDeposit row at line ~375 unchanged
  (FlexDeposit is the next product; this session only touched
  FlexPay).

## Decisions made during build

| Question | Decision |
|---|---|
| Two payments rows (rent + fee) or one combined? | One combined row with type='rent', amount = rent+fee, notes includes breakdown. Two PIs would double Stripe's per-ACH fee (~$0.50 each) and eat ~$1 of the FlexPay fee per cycle. The schema's `fee_payment_id` column stays NULL by convention — column kept for future flexibility if we ever split. |
| Charge model: destination charge or platform? | Platform (`createRentPlatformCharge`). The landlord already received funds via the grace-end Transfer (or via OTP); the tenant pull is GAM reimbursing itself + collecting the fee. No destination, no application_fee_amount. |
| Payment-method discovery? | `stripe.customers.retrieve → invoice_settings.default_payment_method` (then `default_source` legacy fallback). Mirrors the leaseTermination pattern. No DB-side `payment_methods` table to query against. |
| NSF retry boundary? | Standard achRetry pipeline handles the retry. FlexPay handler runs on every `payment_failed` event but no-ops when `retry_count < 1` (first failure). When `retry_count >= 1`, the second failure has landed — disqualify + 60-day suspend. Matches the existing UI copy ("one retry occurs 2 business days later; second failure suspends FlexPay for 60 days"). |
| FlexPay × OTP overlap dedup signal? | Presence of an `otp_advances` row with `stripe_transfer_id` set for the same (tenant, cycle_month). If OTP's Transfer fired, suppress FlexPay's. Both products' fees still bill regardless. |

## Files touched (S245)

```
apps/api/src/db/migrations/
  20260511110000_flexpay_schema.sql               (new)
  20260511110100_flexpay_feature_flag.sql         (new)
apps/api/src/db/schema.sql                        (regenerated)
apps/api/src/services/flexpay.ts                  (new, ~510 lines)
apps/api/src/routes/tenants.ts                    (~ rewrote flexpay
                                                   block; -100 / +50)
apps/api/src/jobs/scheduler.ts                    (+ 2 crons; ~32 lines)
apps/api/src/routes/webhooks.ts                   (+ 2 webhook hooks;
                                                   ~20 lines)
apps/tenant/src/main.tsx                          (~ rebuilt
                                                   FlexPayModal +
                                                   services tile;
                                                   -130 / +60)
DEFERRED.md                                       (~ Flex Suite entry
                                                   restructured per-
                                                   product)
SESSION_245_HANDOFF.md                            (this file)
```

## Verification

- `cd apps/api && npx tsc --noEmit` → clean (0 errors)
- `cd apps/tenant && npx tsc --noEmit` → clean (0 errors)
- Migrations applied: both rows in `schema_migrations`
- `\d flexpay_advances` confirms table shape; 22 columns, status
  CHECK enum, partial UNIQUE on stripe_transfer_id, 4 indexes
- `system_features` shows `flexpay_rollout_visible = TRUE` seeded

## Memory updates

- `project_flexsuite_otp_hidden.md` rewritten: Flex + OTP now
  visible-by-default for UI/UX assessment; per-product feature flag
  flips at launch. OTP remains landlord-only (no tenant surface ever).

## Carry-forward — S246+

### Flex Suite remaining

- **FlexCharge** — full rebuild required. Schema phantom
  (`flex_charge_accounts`, `flex_charge_transactions` don't exist);
  4 tenant routes + 4 landlord routes target nonexistent tables.
  Naming collision with POS card-surcharge "FlexCharge fee" needs
  a rename pass in POS UI strings.
- **FlexDeposit** — wire up enroll endpoint + move-in branch +
  installment-pull cron + $3/mo custody fee billing. Schema +
  tier math + OTP gating already correct.
- **FlexCredit** — needs product call (bureau vendor pick, qualifying
  events, billing). Backend is a single boolean column + flip
  endpoint today.

### Sublease — phase-2/3 build

- Money flow wiring (allocation engine + payments rows for sublessees)
- Document/e-sign integration
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

S245 closes 1 of 4 Flex Suite products. The engine pattern
(schema → cron pair → webhook hooks → tenant modal) is now in
place; FlexCharge / FlexDeposit / FlexCredit each clone the
pattern with their own product semantics.

| Bucket | Pre-S245 | Post-S245 |
|---|---|---|
| Pickable now | ~2 (Flex Suite epic + Sublease epic) | ~3 (FlexCharge, FlexDeposit, FlexCredit, Sublease phase-2/3) |
| Multi-session epics | 2 | 1 (Sublease remaining) |
| Pre-launch flag-gated | 1 (FlexSuite) | 3 (FlexCharge, FlexDeposit, FlexCredit still gate-pending) |

**Until v1 launch-ready:** ~4-5 sessions (3 Flex products +
Sublease money-flow + maybe Sublease docs/invite). Checkr unblocks
on partner credentials.

---

End of S245 handoff.
