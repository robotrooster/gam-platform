# Session 244 — closed

## Theme

OTP money-movement layer. Pre-S244, `processMonthlyAdvance` created
audit rows (`otp_advances` + a `payments` shadow) but no cash actually
moved — the cron stamped `status='advanced'` while the landlord's
Stripe Connect account stayed empty. S244 wires
`stripe.transfers.create` from the platform balance to the landlord's
Connect account, plus the recovery surface for failures.

## Recon-driven scope (DEFERRED was stale)

DEFERRED.md called for "advance-from-reserve disbursement (the `TODO:
disburse from reserve` at `scheduler.ts:901`)". On recon:

- That TODO comment was **deleted at S86**. The current
  `scheduler.ts:901` is historical commentary noting the stub
  cron was removed pending real wiring. No live TODO to replace.
- Landlord-side `OtpPage` (KPIs, tenant enroll/disable, advance
  history) already shipped — DEFERRED implied it didn't exist.
- "Reserve fund" framing is internal-bookkeeping terminology per
  Nic — there's no separate Stripe balance to advance from. The
  actual implementation uses Stripe Connect Transfers from GAM's
  platform balance. The "reserve pool" is the conceptual backing
  for the float-lending risk (when a tenant NSFs, the pool
  absorbs the loss); the cash itself just moves through Stripe.

So the real outstanding piece was just: fire the Transfer.

## Decisions made (Nic-confirmed before build)

| Question | Decision |
|---|---|
| Funding source for the advance? | GAM platform balance via `stripe.transfers.create` to landlord's Connect. GAM float-lends the advance; tenant ACH pull on the 5th is the recovery. NSF = GAM eats the loss. ODFI move is post-S244 future work. |
| Tenant-side OTP surface? | **Never.** OTP is landlord-product-only, matches the existing "landlord doesn't see tenant products" boundary. No tenant UI, no opt-in flow, no statement of the 1% spread to the tenant. |
| Qualification gate order (bg → deposit → ACH)? | Parallel show-all stays. Current code returns every blocker at once; gives the landlord a complete picture of what needs to clear. Strict-sequence enforcement is a worse UX for no benefit. |
| Reserve-fund terminology in DEFERRED? | Leave the language; it's internal bookkeeping for future default-rent / FlexDeposit-gap / OTP / Flexion-8 pool accounting. Doesn't shape the Transfer wiring. |

## Items shipped

### Schema migration — `20260511100000_otp_advances_transfer_tracking.sql`

Three nullable columns on `otp_advances`:

| Column | Purpose |
|---|---|
| `stripe_transfer_id` | Stripe id of the successful Transfer (`tr_…`). Partial UNIQUE index — admin retry de-dupes by this; future reconciliation tooling looks up the row by Stripe id. |
| `transfer_attempted_at` | Most recent fire attempt; populated on both success and failure. Ops-visibility lever. |
| `transfer_error` | Error message from the most recent failure. NULL after a successful retry — the row no longer carries a "needs attention" marker once funded. |

No backfill — pre-S244 `'advanced'` rows have no associated Transfer
(none fired pre-wiring). They keep their historical state; admin can
fire-and-write-off manually if needed.

### Service — `apps/api/src/services/otp.ts`

**`processMonthlyAdvance` restructure:**

- Candidate SELECT now pulls `users.stripe_connect_account_id` so the
  loop can skip-with-error landlords whose Connect vanished between
  enroll and advance day.
- Inside the per-tenant DB transaction: insert advance row + payments
  shadow as before, but **no status flip to `'advanced'`**. Both rows
  stay `'pending'` until the Stripe Transfer settles.
- **Outside the DB transaction:** fire `fireOtpAdvanceTransfer` per
  advance row. Network round-trip doesn't hold a tx open.
- Skip-and-record path for missing Connect account: advance row gets
  `transfer_error = "Landlord has no Stripe Connect account at
  advance time"`, admin alerted, loop continues.
- New return-shape fields: `advances_funded` (Transfer fired OK) +
  `advances_transfer_failed` (row created, Transfer errored).

**`fireOtpAdvanceTransfer(opts)` — new export:**

- `stripe.transfers.create({ amount, currency:'usd', destination:
  landlordConnect, description, metadata:{gam_purpose:'otp_advance',
  gam_advance_id, gam_tenant_id, gam_landlord_id, gam_cycle_month}})`
- **Idempotency key:** `otp_advance_<advanceId>`. Cron and admin
  retry use the same key — re-firing returns the original Transfer
  rather than double-paying. Defensive against the
  "network blip mid-response → row says failed, transfer actually
  succeeded" case.
- On success: CTE updates both rows atomically — advance →
  `status='advanced'`, `stripe_transfer_id`, `advanced_at`,
  `transfer_attempted_at`, `transfer_error=NULL`; linked payments
  row → `status='settled'`.
- On failure: update `transfer_attempted_at` + `transfer_error`,
  call `alertAdvanceTransferFailed` (admin notification with the
  retry endpoint URL in the body), re-throw for caller visibility.

**`enableOtpForTenant` precheck:**

- Refuse enrollment when landlord has no `stripe_connect_account_id`
  — clear message points to `/banking` for onboarding. Prevents the
  silent enroll-then-fail loop where the landlord enrolls 10 tenants,
  cron fires a month later, all 10 land in `transfer_error` because
  the Connect onboarding was never completed.

### Routes — `apps/api/src/routes/admin.ts` (1 new)

| Route | Verb | Permission | Purpose |
|---|---|---|---|
| `/api/admin/otp/advances/:id/retry-transfer` | POST | `requireAdmin` | Re-fire the Stripe Transfer for an advance stuck in `'pending'` with a `transfer_error`. 404 if not found, 409 if already funded (`stripe_transfer_id` set) or landlord has no Connect account. Calls `fireOtpAdvanceTransfer` — idempotent. |

Returned admin alert body explicitly cites this endpoint so the
operator has a one-click recovery path from the notification feed.

## Files touched (S244)

```
apps/api/src/db/migrations/
  20260511100000_otp_advances_transfer_tracking.sql   (new)
apps/api/src/db/schema.sql                            (regenerated)
apps/api/src/services/otp.ts                          (~ +180 lines:
                                                       enableOtpForTenant
                                                       Connect precheck;
                                                       processMonthlyAdvance
                                                       restructure +
                                                       transfer firing;
                                                       fireOtpAdvanceTransfer
                                                       + alertAdvanceTransferFailed
                                                       helpers)
apps/api/src/routes/admin.ts                          (~ +45 lines:
                                                       /otp/advances/:id/
                                                       retry-transfer)
DEFERRED.md                                           (~ OTP entry rewritten
                                                       — money-movement
                                                       shipped, cron-
                                                       timing flagged as
                                                       outstanding non-blocker)
SESSION_244_HANDOFF.md                                (this file)
```

No frontend changes — landlord OtpPage already complete pre-S244.
Tenant portal stays OTP-blind per Nic decision #2.

## Verification

- `cd apps/api && npx tsc --noEmit` → clean (0 errors)
- Migration applied: `psql gam -c "SELECT filename FROM
  schema_migrations ORDER BY filename DESC LIMIT 1"` →
  `20260511100000_otp_advances_transfer_tracking.sql`
- Schema.sql regenerated: contains `stripe_transfer_id`,
  `transfer_attempted_at`, `transfer_error` on `otp_advances` +
  the partial UNIQUE index `idx_otp_advances_stripe_transfer_id`

## Cron-timing question — flagged, not addressed

`OtpPage` subtitle promises: *"Get rent advanced to your bank on the
1st."* Current implementation fires the cron on the last business day
of the month at 3pm Phoenix. Stripe Transfer to Connect is instant
intra-Stripe, but the landlord's Connect → bank payout follows their
configured payout schedule (Stripe default = 2-day standard rolling).
So funds typically land in the landlord's bank ~3-4 business days
after the cron fires — Tue/Wed of the new month, not the 1st.

Three ways to close the gap, none blocking S244:

- **Move the cron earlier.** Fire ~5 business days before EOM so the
  T+2 payout puts cash in the landlord's bank by EOM. Simplest.
- **Stripe instant payouts.** Fire a `stripe.payouts.create` from the
  Connect balance immediately after the Transfer, requesting instant.
  Stripe charges 1.5% on instant payouts — would eat into the 1%
  spread and likely turn the product loss-leading.
- **Tighten copy.** Change the promise to "early in the month" or
  "by the first business week."

Recommend tabling until Nic surfaces it as a product call.

## Carry-forward — S245+

### Pickable now

- **Flex Suite tenant build** — full FlexPay / FlexCharge /
  FlexDeposit / FlexCredit, schema named (`flex_charge_accounts`,
  `flex_charge_transactions`, 6 flexpay cols on `tenants`). Multi-
  session epic, hidden behind launch flag.
- **Sublease subsystem** — greenfield. Multi-session, scope-shaping
  conversation needed up-front (tenant-initiated vs landlord-mediated,
  primary-tenant liability model, fee posture).
- **POS multi-terminal sync** — still likely premature.

### External-vendor-blocked

- **Checkr Partner** — Mon-trigger today (2026-05-11) but credentials
  not yet received per Nic. Stays parked until landed.

### Smaller items

- **OTP cron-timing rework** — see "Cron-timing question" above.
  Non-blocking. Product call.
- **POS end-to-end smoke** (Nic-runs).
- **/resolve smoke** (Nic-runs).

## Revised count

S244 closes the OTP money-movement gap. OTP is now functionally
end-to-end: landlord enrolls → tenant qualifies → cron creates row +
fires Connect Transfer → tenant rent ACH pulls reconcile the cycle
→ admin handles transfer failures via retry route.

| Bucket | Pre-S244 | Post-S244 |
|---|---|---|
| Pickable now | ~2 | ~2 (Flex Suite, Sublease) |
| Nic-blocked | 0 | 0 |
| External-vendor-blocked | 1 | 1 (Checkr Mon-trigger) |
| Multi-session epics | 3 (Flex, OTP, Sublease) | 2 (Flex, Sublease) |
| Pre-launch flag-gated | 2 | 1 (Flex; OTP now functionally complete) |

**Until v1 launch-ready:** ~2-3 sessions (Flex Suite tenant build +
Sublease subsystem as the two remaining multi-session epics; Checkr
ready when credentials arrive).

---

End of S244 handoff.
