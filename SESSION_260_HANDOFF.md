# Session 260 — closed (Session A of FlexDeposit legal-remedy build)

## Theme

FlexDeposit missed-installment legal remedy — backend foundation.
Schema migration + pull-schedule rework (primary at rent_due−5, retry
at rent_due−1) + 2-strike acceleration engine + landlord-Connect-
Transfer stripped at move-in + tenant ToS clauses with required
acknowledgment. Supersedence routing engine (the larger piece) and
all UI surfaces deferred to Sessions B + C per S259 plan.

## Items shipped

### Migration — `20260512110000_flexdeposit_acceleration.sql`

- `security_deposits.balance_due_full_at` (timestamptz, nullable) —
  set when 2-strike acceleration fires.
- `security_deposits.balance_due_total` (numeric(10,2), nullable) —
  full remaining balance at acceleration moment.
- `security_deposits` plan_status CHECK extended to include
  `'accelerated'` (between `active` and terminal `in_default` /
  `completed`).
- `flex_deposit_installments.primary_pull_date` (date, nullable) —
  primary ACH attempt (rent_due_day − 5).
- `flex_deposit_installments.retry_pull_date` (date, nullable) —
  retry ACH attempt (rent_due_day − 1).
- `flex_deposit_installments.attempt_count` (integer, NOT NULL
  default 0) — 0=untouched, 1=primary fired, 2=both fired.
- Backfill: `primary_pull_date = due_date` for existing rows
  (legacy single-attempt schedule); retry_pull_date stays NULL.
- 2 partial indexes for cron efficiency: `(primary_pull_date)`
  where pending + attempt_count=0; `(retry_pull_date)` where
  pending + attempt_count=1.
- Held_by NOT enforced via CHECK constraint — pre-S260 rows may have
  `held_by='landlord'` with already-fired Connect Transfers; can't
  retroactively flip. New FlexDeposit deposits forced to gam_escrow
  at app layer in `enrollFlexDeposit`.

### Backend engine — `apps/api/src/services/flexDeposit.ts`

**Enrollment (`enrollFlexDeposit`):**
- Pulls `leases.rent_due_day` alongside start_date.
- Per installment 2..N, computes `(primary_pull_date,
  retry_pull_date)` via new `computeInstallmentPullDates` helper.
  Installment 1 = no pull dates (paid at move-in).
- Helper clamps `rent_due_day` to month length (e.g., day=31 in
  February becomes 28/29).
- Forces `held_by='gam_escrow'` on the deposit row at enrollment.
- INSERT now writes primary_pull_date + retry_pull_date columns.

**Cron (`processFlexDepositInstallmentDue`):**
- Query rewritten to fire two cohorts:
  - `(primary_pull_date <= today AND attempt_count = 0)` → primary pull
  - `(retry_pull_date <= today AND attempt_count = 1)` → retry pull
- Additional filter: `sd.flex_deposit_plan_status = 'active'` —
  skips installments on plans already accelerated, in_default,
  or completed.
- Each pull increments `attempt_count` (0→1 on primary, 1→2 on retry).
- Notes string stamps pull kind: "FlexDeposit installment primary pull"
  vs "FlexDeposit installment retry pull".

**Move-in (`settleFlexDepositMoveIn`):**
- Connect Transfer to landlord **removed**. All FlexDeposit deposits
  live in gam_escrow throughout the lease (forced at enrollment).
- `landlordConnectAccountId` parameter removed from signature.
  Caller `apps/api/src/jobs/moveInBundle.ts` updated; the now-unused
  landlord-connect lookup query was deleted.
- Still flips installment 1 → settled, bumps deposit counters,
  marks status='funded' if total met. No money movement at move-in.

**NSF handler (`handleFlexDepositPaymentNsf`) — rewrite:**
- Reads `attempt_count` from the installment, not `payment.retry_count`.
- If `attempt_count = 1` (primary failed): no-op. Cron picks up retry
  on retry_pull_date.
- If `attempt_count = 2` (retry failed): mark installment defaulted.
  Then count consecutive defaulted installments at the tail of the
  sequence. On 2 consecutive defaults → fire acceleration.
- Single-strike state emits info-severity admin notification (not
  warn) so the count is visible without alert fatigue.
- Pre-S260 "defer to achRetry" pattern removed entirely — FlexDeposit
  installments bypass achRetry under the new scheduled-retry model.

**Acceleration (`accelerateFlexDepositPlan`):**
- Computes remaining balance from unpaid (pending + defaulted)
  installments.
- Stamps `balance_due_full_at = NOW()`, `balance_due_total = remaining`,
  flips plan_status to `'accelerated'`.
- Fires a single ACH pull at the full remaining balance with PI
  metadata `gam_purpose='flexdeposit_acceleration'`.
- Emits warn-severity admin notification.
- On PI creation failure: marks plan in_default immediately via
  `markPlanInDefault`.

**Acceleration settlement (`settleFlexDepositAcceleration`, internal):**
- On webhook success: flips plan to `'completed'`, mass-settles all
  remaining unpaid installments, marks deposit `status='funded'`,
  zeroes `installments_remaining`.

**Acceleration failure (`failFlexDepositAcceleration`, exported):**
- On webhook failure: plan flips to `'in_default'` terminal. Tenant
  enters NSF cooldown (`flex_deposit_disqualified_until` + reason
  `acceleration_pull_failed:<reason>`).
- Emits warn-severity admin notification.

**Reconciliation (`reconcileSettledFlexDepositPayment`):**
- Signature extended to accept optional PI metadata.
- Dispatches on `metadata.gam_purpose === 'flexdeposit_acceleration'`
  before falling through to the existing installment-reconcile path.

### Backend webhook routing — `apps/api/src/routes/webhooks.ts`

- `payment_intent.succeeded`: passes `pi.metadata` to
  `reconcileSettledFlexDepositPayment` for acceleration-pull
  dispatch.
- `payment_intent.payment_failed`: bypasses achRetry when
  `pi.metadata.gam_purpose` is `flexdeposit_installment` or
  `flexdeposit_acceleration` — sets `next_retry_at = NULL`
  unconditionally. Installment retries fire on retry_pull_date;
  acceleration failures are terminal.
- New dispatch branch: acceleration-pull failures call
  `failFlexDepositAcceleration(deposit_id, tenant_id, reason)`
  instead of the installment handler.

### Tenant UI — `apps/tenant/src/main.tsx`

- `FlexDepositModal` gained a "FlexDeposit Terms" disclosure block
  with the 3 S259-drafted clauses (ACH priority, catch-up +
  acceleration, separate parties).
- Required acknowledgment checkbox; enroll button disabled until
  checked. The 60-day suspension copy on the existing info line
  was removed (no longer accurate — suspension only fires at
  terminal in_default after acceleration failure).
- Tenant POST `/api/tenants/flexdeposit/enroll` now sends
  `acknowledgedTos: true` in the body.

### Backend route — `apps/api/src/routes/tenants.ts`

- `POST /api/tenants/flexdeposit/enroll` refuses without
  `acknowledgedTos: true` in the request body (400 with explicit
  "FlexDeposit Terms of Service acknowledgment required" error).

## Decisions made during build

| Question | Decision |
|---|---|
| `installment_count` validation already allows 2-4. Need to add a "consecutive defaulted" tracking column? | No — derived via SQL query over `flex_deposit_installments` filtered to `status IN ('settled','defaulted')` ordered DESC LIMIT 2. Two rows, both defaulted → acceleration. Avoids schema bloat. |
| Strike-counting semantics: per-pull or per-installment? | **Per-installment.** Each installment has primary + retry pulls built in (2 pull attempts). One installment that exhausts both pulls = 1 strike. Two consecutive strike-1 installments = acceleration. Maximum 4 ACH attempts before terminal state. |
| Tenant suspension on strike 1? | **No.** Suspension only fires at terminal in_default (after acceleration pull failure). Strike 1 generates info-severity admin notification only. |
| FlexDeposit ToS infrastructure — full e-sign or modal acknowledgment? | **Modal acknowledgment.** No flexDepositDocuments.ts exists; mirroring the sublease e-sign pattern would be a separate session. Required checkbox + backend gate covers explicit consent for the v1 launch. |
| Migration held_by CHECK constraint? | **Skipped.** Pre-S260 rows may have `held_by='landlord'` with fired Connect Transfers; retroactively flipping breaks audit. App-layer enforcement at enrollment time is enough; future migration to CHECK once dev DB verified clean. |
| `installment_amount`-residue handling unchanged? | Yes — installment 1's first_amount carries the rounding residue (pre-S260 behavior preserved). |

## Files touched (S260)

```
apps/api/src/db/migrations/
  20260512110000_flexdeposit_acceleration.sql        (new — ~95 lines)
apps/api/src/db/schema.sql                           (regenerated)
apps/api/src/services/flexDeposit.ts                 (~ enrollFlexDeposit
                                                      pulls rent_due_day +
                                                      forces gam_escrow;
                                                      cron query rewritten
                                                      for primary/retry
                                                      cohorts; handleFlex
                                                      DepositPaymentNsf
                                                      rewritten for
                                                      attempt_count +
                                                      2-strike check;
                                                      new accelerateFlex
                                                      DepositPlan +
                                                      settleFlexDeposit
                                                      Acceleration +
                                                      failFlexDeposit
                                                      Acceleration +
                                                      computeInstallment
                                                      PullDates helper +
                                                      markPlanInDefault
                                                      helper; settleFlex
                                                      DepositMoveIn
                                                      Connect-Transfer
                                                      stripped; reconcile
                                                      SettledFlexDeposit
                                                      Payment accepts PI
                                                      metadata for
                                                      acceleration
                                                      dispatch;
                                                      ~+220 net)
apps/api/src/routes/webhooks.ts                      (~ FlexDeposit
                                                      bypasses achRetry;
                                                      acceleration-pull
                                                      failure routes to
                                                      failFlexDeposit
                                                      Acceleration;
                                                      ~+15 net)
apps/api/src/routes/tenants.ts                       (~ /flexdeposit/enroll
                                                      requires
                                                      acknowledgedTos;
                                                      ~+10)
apps/api/src/jobs/moveInBundle.ts                    (~ removed unused
                                                      landlord-connect
                                                      lookup;
                                                      ~−10)
apps/tenant/src/main.tsx                             (~ FlexDepositModal
                                                      shows 3-clause ToS
                                                      block + required
                                                      acknowledgment
                                                      checkbox; ~+30)
DEFERRED.md                                          (~ FlexDeposit entry
                                                      Session A items
                                                      tombstoned;
                                                      Session B/C items
                                                      remain open)
SESSION_260_HANDOFF.md                               (this file)
```

## Verification

- `npm run db:migrate` → 1 applied; schema.sql regenerated to
  11418 lines
- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/tenant && npx tsc --noEmit` → clean

## Carry-forward — S261+

### Session B (next) — Supersedence routing engine

The load-bearing rule (`project_gam_supersedence_routing.md`
memory): every successful tenant ACH pull routes through GAM
platform first to satisfy outstanding GAM balances oldest-first;
surplus to landlord; landlord books show rent paid in full.

Build scope:
1. New service or extend `services/allocation.ts`:
   `computeTenantOutstandingGamBalance(tenantId)` returns the sum of
   unpaid FlexDeposit installments + accelerated balance +
   FlexCharge balance + FlexPay fees + custody fees, ordered FIFO.
2. Rent PaymentIntent creation path (`createRentPlatformCharge` and
   callers): boost `application_fee_amount` by
   `min(rent_amount, tenant_gam_outstanding)` on top of standard
   platform fee. `transfer_data.destination` still points at
   landlord's Connect account; Stripe routes net automatically.
3. Webhook `payment_intent.succeeded` for rent: distribute the
   boosted-fee portion internally — mark FlexDeposit installments
   paid, settle FlexCharge balances, etc. (oldest-first FIFO).
4. Same pattern on FlexDeposit installment + acceleration webhooks:
   if a pull succeeds AND the tenant has other unpaid GAM debts,
   the surplus satisfies them too.
5. FlexDeposit pull amounts already match exact installment
   balance, so supersedence is rarely surplus-generating from
   FlexDeposit pulls — primary case is rent pulls paying down
   FlexDeposit defaults.

### Session C — UI surfaces + lease-end settlement

1. Tenant LeasePage: "Balance due in full" surface when plan
   status = 'accelerated'. Shows balance_due_total + one-tap-pay
   button. Renders only while accelerated (acceleration pull
   pending).
2. Landlord dashboard payment view: two-number display where
   supersedence applied — "Rent paid: $X" (gross/lease status) +
   "Net to bank: $Y" (actual disbursement). No mention of WHICH
   GAM product superseded.
3. Lease-end deposit-return engine: read collected_amount vs
   total_amount; GAM eats the gap if any; landlord gets a
   single Transfer for the collected portion at termination.

### Vendor-blocked (unchanged)

- Checkr Partner credentials pending
- FlexCredit (CredHub + Esusu) pending

### Other deferred (unchanged from S259)

- POS multi-terminal session sync — Nic-approved scope, needs
  scope-shaping session (user story, sync transport, concurrency
  model, realtime threshold) before code lands

## Revised count

| Bucket | Pre-S260 | Post-S260 |
|---|---|---|
| FlexDeposit remedy backend (schema + acceleration engine + ToS) | open | **Session A shipped** |
| FlexDeposit supersedence routing | open | Session B remaining |
| FlexDeposit UI + lease-end settlement | open | Session C remaining |
| POS multi-terminal sync | needs scope-shaping | unchanged |
| Vendor-blocked | 2 | 2 |

---

End of S260 handoff.
