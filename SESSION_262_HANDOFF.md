# Session 262 — closed (Session C of FlexDeposit legal-remedy build)

## Theme

Closes out the 3-session FlexDeposit legal-remedy arc (S260
acceleration engine → S261 supersedence routing → S262 surfaces +
lease-end). Three UI/data surfaces shipped:

1. **Tenant LeasePage** — banner during accelerated (info) and
   in_default (with manual retry button) plan states.
2. **Landlord PaymentsPage** — partial-payment display when GAM
   supersedence diverted any portion of the gross; generic copy
   with no product disclosure; no "paid in full" framing.
3. **Lease-end deposit-return** — pool switched from `total_amount`
   to `collected_amount`; new post-commit Stripe Transfer at finalize
   moves landlord's share from gam_escrow → landlord Connect.

Memory-correcting fix landed mid-session: the supersedence routing
memory previously said "lease shows paid in full" — wrong from the
landlord's POV per Nic's clarification. Landlord sees ACTUAL bank
reality as a partial payment. Memory updated.

## Scope-shaping confirmed pre-build

| Q | Locked direction |
|---|---|
| Tenant banner — render in which states? | (Q1b) Accelerated (info) + in_default (with manual retry button). Lets tenant self-rescue after a failed acceleration pull rather than escalating to admin-only. |
| Landlord payment display — list vs detail? | (Q2 corrected) NOT just two equal-weight numbers — show the row as a PARTIAL payment when supersedence > 0. Primary display = net to bank; secondary = gross collected. No "paid in full" copy anywhere. Detail modal shows the full split (collected / retained for tenant balances / net to bank) with generic copy, no product names. |
| Lease-end — landlord disbursement semantics? | (Q3 corrected) NO GAM-eats-the-gap subsidy. Workflow already prevents the gap from materializing — missed FlexDeposit installments supersede rent payments throughout the lease, so by termination `collected_amount` ≈ `total_amount`. Pool = `collected_amount`. Simple. |

## Items shipped

### Tenant — FlexDeposit accelerated/in_default banner

**Backend:**

- `services/flexDeposit.ts → retryFlexDepositAcceleration({tenantId})` —
  new exported function. Reads the tenant's `in_default` plan, flips
  back to `accelerated`, re-stamps `balance_due_full_at`, fires a
  fresh ACH pull at `balance_due_total + supersedence_boost`
  (self-subtracts the just-flipped accelerated balance to avoid
  double-counting). Same metadata (`gam_purpose='flexdeposit_acceleration'`,
  `gam_retry='true'`) so the existing webhook routes settle/fail
  back through `settleFlexDepositAcceleration` /
  `failFlexDepositAcceleration` unchanged.
- `GET /api/tenants/flexdeposit` — extended response to include
  `deposit: { id, flex_deposit_plan_status, balance_due_full_at,
  balance_due_total, total_amount, collected_amount }` so the
  LeasePage can read banner state without a separate fetch.
- `POST /api/tenants/flexdeposit/retry-acceleration` — new tenant
  endpoint that calls `retryFlexDepositAcceleration` with the
  authenticated tenant's id.

**Frontend (`apps/tenant/src/pages/LeasePage.tsx`):**

- New `FlexDepositAcceleratedBanner` component rendered between the
  page header and `DepositPortabilitySection`. Auto-hides except
  during `accelerated` / `in_default` plan states.
- `accelerated` state: amber info banner — "Deposit balance due in
  full — $X. We're collecting via ACH. Typically completes in 1–3
  business days. Initiated N days ago."
- `in_default` state: red warning banner with the same balance line
  plus a "Pay full balance now" button. On click, posts the retry
  endpoint and shows "ACH pull initiated" feedback.

### Landlord — PaymentsPage partial-payment display

**Backend:** no changes — `GET /api/payments` already returns
`SELECT p.*` which includes `gam_supersedence_amount`; the global
camelCase middleware surfaces it as `gamSupersedenceAmount` on the
wire.

**Frontend (`apps/landlord/src/pages/PaymentsPage.tsx`):**

- Two helper functions at top of file: `netToBank(p)` and `isPartial(p)`.
- Row Amount column: when `isPartial`, primary number is `netToBank`
  with a small "of $X collected" line beneath; otherwise just the
  amount as before.
- Row Status column: when `isPartial`, an amber `partial` badge
  appears next to the existing status badge. Status itself
  (`settled` / `processing` / `failed`) is unchanged — it reflects
  ACH clearance, not distribution.
- Detail modal Payment section: when `isPartial`, replaces the
  single "Amount" line with three rows — "Collected from tenant"
  (gross), "Retained for tenant balances" (gam_supersedence_amount,
  amber), "Net to your bank" (net). Generic copy — no product
  names, no FlexDeposit/FlexCharge/FlexPay surface.
- Detail modal status header: when `isPartial`, shows
  `settled · partial` and the dollar line reads `$Y net to bank`
  instead of `$X`.

### Lease-end — collected_amount pool + Connect Transfer

**`services/depositReturn.ts`:**

- `calculateDepositReturn` — `totalDeposit` source switched from
  `sd.total_amount` to `sd.collected_amount`. Falls back to
  `total_amount` if `collected_amount` is null (legacy data) or to
  the lease_fee deposit if no `security_deposits` row exists. Under
  S260 + S261 supersedence workflow, by lease-end
  `collected_amount` ≈ `total_amount` in the normal case; the
  switch makes the engine reflect reality when supersedence didn't
  catch up.
- `finalizeDepositReturn` — new post-commit step:
  `fireLandlordDisbursementTransfer(row)`. Reads the deposit's
  `held_by`, `collected_amount`, `interest_accrued` + the landlord's
  Connect account. Skips when `held_by='landlord'` (legacy / non-
  FlexDeposit — landlord already has the funds). Otherwise computes
  `disbursement = collected_amount + interest_accrued - refund_amount`
  and fires `stripe.transfers.create` to the landlord's Connect with
  idempotency key `deposit_disb_<deposit_return_id>`. Admin-notifies
  on no-Connect (`deposit_disbursement_pending_no_connect`) or
  Stripe failure (`deposit_disbursement_transfer_failed`). Skipped
  when portability was authorized (deposit re-points to next lease
  instead of disbursing).

### Memory — supersedence routing entry corrected

`project_gam_supersedence_routing.md` description and body updated.
Old wording: "Landlord-facing accounting: payment.status = paid,
payment.amount = full rent amount. Lease books show paid in full.
Net-to-bank line on landlord dashboard shows the actual transfer."
Corrected: "Landlord row shows the ACTUAL received amount, labeled
as PARTIAL when supersedence > 0. There is NO 'paid in full' message
displayed to the landlord when the diversion happened." Reflects
Nic's S262 clarification.

`MEMORY.md` index hook line updated to match.

## Decisions made during build

| Question | Decision |
|---|---|
| Retry endpoint scope — tenant-callable only, or admin too? | **Tenant-callable** for v1 (per Q1b). An admin equivalent is trivial to add later if support tickets demand it; for now, the LeasePage button is the primary path. |
| Should retry pull boost via supersedence like other pulls? | **Yes.** Same self-subtract pattern as `accelerateFlexDepositPlan` — the FIFO query would include this deposit's `balance_due_total` after the flip back to 'accelerated', so subtract it to avoid double-counting. Cleanest treatment is "manual retry is just another acceleration pull." |
| Banner color cue — same red for both states, or distinct per state? | **Amber for accelerated (action-not-required info), red for in_default (action-required warning).** Matches the page's existing color discipline (amber = caution, red = problem). |
| Net-to-bank label wording for landlord | **"Net to your bank"** for clarity. Initial draft said "Net to bank" — second person reads better in a tenant-context aware landlord page. |
| Detail-modal retained-amount label | **"Retained for tenant balances"** — generic, doesn't disclose FlexDeposit/FlexCharge/FlexPay. Matches the locked rule: landlord has zero knowledge of which tenant-facing GAM product superseded. |
| Disbursement formula at finalize | **`collected_amount + interest_accrued - refund_amount`** — what's actually in escrow, minus what goes back to the tenant. Same number whether refund comes from principal or interest. Negative-guard via `Math.max(0, ...)`. |
| When to skip the Transfer | **`held_by='landlord'`** (legacy deposits — landlord already holds the funds; pre-S260 architecture) OR portability authorized (deposit re-points to next lease, no disbursement). The S260-era `held_by='gam_escrow'` is the only case that triggers the new Transfer. |
| Negative `disbursement` guard | Clamps to 0 (returns early). Refund + interest could in theory exceed collected if interest_accrued is high and collected is partial — that's an oversubscribed pool, not a Transfer-time concern. Refund logic upstream is unchanged. |

## Files touched (S262)

```
apps/api/src/services/flexDeposit.ts                  (~ new retryFlex
                                                       DepositAcceleration
                                                       function; ~+95)
apps/api/src/routes/tenants.ts                        (~ GET /flexdeposit
                                                       returns deposit
                                                       context;
                                                       new POST /flexdeposit/
                                                       retry-acceleration;
                                                       ~+45)
apps/api/src/services/depositReturn.ts                (~ pool = collected_amount;
                                                       new fireLandlord
                                                       Disbursement
                                                       Transfer + getStripe
                                                       import; ~+95)
apps/tenant/src/pages/LeasePage.tsx                   (~ FlexDepositAccelerated
                                                       Banner component +
                                                       JSX mount; ~+100)
apps/landlord/src/pages/PaymentsPage.tsx              (~ netToBank +
                                                       isPartial helpers;
                                                       row + status badge
                                                       + detail modal
                                                       partial-display
                                                       branches; ~+50)
DEFERRED.md                                           (~ FlexDeposit
                                                       Session C tombstoned;
                                                       3-session build
                                                       marked complete)
SESSION_262_HANDOFF.md                                (this file)
~/.claude/projects/-Users-gold-Downloads-gam/memory/
  project_gam_supersedence_routing.md                 (~ "paid in full"
                                                       framing replaced
                                                       with "partial
                                                       payment" semantic)
  MEMORY.md                                           (~ index hook
                                                       updated)
```

## Verification

- `apps/api` tsc → clean
- `apps/tenant` tsc → clean
- `apps/landlord` tsc → clean
- `packages/shared` tsc → clean
- No new migrations this session (data shape unchanged; only logic
  + presentation moved)

## Carry-forward — S263+

The FlexDeposit legal-remedy 3-session arc is complete. Open buckets
from the running DEFERRED.md (unchanged this session):

### Vendor-blocked

- Checkr Partner credentials pending
- FlexCredit (CredHub + Esusu) pending

### Other deferred

- POS multi-terminal session sync — Nic-approved scope, needs
  scope-shaping session before code lands

### Possible follow-ups discovered this session

- The current `finalizeDepositReturn` Transfer fires from GAM
  platform balance directly (no `source_transaction`). Funds are
  available because they were collected over the lease via
  installment pulls — they're sitting on GAM's balance, not on any
  specific charge. If platform balance ever runs thin under high
  finalization volume, switching to `source_transaction` from one
  of the installment-pull charges would tighten Stripe's funding
  routing. Low priority — pre-launch this won't bite.
- The tenant banner uses `tenant-flexdeposit` query key. If the
  retry mutation succeeds but the webhook hasn't yet settled, the
  query refetches and still sees `plan_status='accelerated'`. The
  UI shows the info banner — correct UX during the 1–3 day pull
  window. No follow-up needed.

## Revised count

| Bucket | Pre-S262 | Post-S262 |
|---|---|---|
| FlexDeposit remedy backend (schema + acceleration) | Session A shipped S260 | unchanged |
| FlexDeposit supersedence routing | Session B shipped S261 | unchanged |
| FlexDeposit UI + lease-end settlement | open | **Session C shipped** |
| POS multi-terminal sync | needs scope-shaping | unchanged |
| Vendor-blocked | 2 | 2 |

---

End of S262 handoff.
