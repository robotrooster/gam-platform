# Session 267 — closed (Deposit-return workflow tests)

## Theme

Third critical-path suite. Pins the `calculateDepositReturn`
math and the `finalizeDepositReturn` workflow without exercising
any real money paths. Stripe Transfer + gap-charge calls are
routed through their no-credentials-on-file fallback branches
(admin notification, `gap_charge_failed=TRUE`) — verifying that
the workflow lands correctly when Connect/customer-id aren't
present, which is also the pre-launch state.

No frontend, no walkthrough.

## Items shipped

### Extended — `apps/api/src/test/dbHelpers.ts`

Five new factory helpers:

- `seedLease({ unitId, landlordId, rentAmount?, leaseType?,
  status?, startDate? })` — defaults `fixed_term`, `active`,
  `2025-01-01`.
- `seedLeaseTenant({ leaseId, tenantId, role? })` — defaults to
  `primary`.
- `seedLeaseFee({ leaseId, feeType, amount, dueTiming,
  isRefundable? })` — feeType free-form (matches the wide CHECK
  list), dueTiming typed to the four allowed values.
- `seedSecurityDeposit({ unitId, leaseId, tenantId, totalAmount,
  collectedAmount?, interestAccrued?, heldBy?, status? })` —
  defaults `held_by='gam_escrow'`, `status='funded'`,
  `collectedAmount = totalAmount`.
- `seedDepositReturnDraft({ leaseId, tenantId, landlordId,
  securityDepositId?, totalDeposit, cleaningFeeAmount?,
  damageLines?, otherDeductions?, totalDeductions?, refundAmount?,
  gapAmount? })` — auto-computes totals if not provided; status
  always inserted as `draft`.

### New module — `apps/api/src/services/depositReturn.test.ts`

14 cases. All passing.

**calculate (7)**
| # | Case | What it pins |
|---|---|---|
| 1 | Full refund: no deductions | refund=full deposit, gap=0 |
| 2 | Partial refund: cleaning + damage | math sums + clamps refund |
| 3 | Gap: deductions exceed deposit | refund=0, gap=excess |
| 4 | S188 interest_accrued | added to tenant pool, increases refund |
| 5 | S180 unpaid-balance auto-sweep | unpaid_balance_lines + total |
| 6 | S262 deposit pool | uses `collected_amount`, not `total_amount` |
| 7 | Unknown lease | returns null |

**finalize (7)**
| # | Case | What it pins |
|---|---|---|
| 8 | Partial refund branch | status=sent_refund, negative-amount DEPOSIT payment row, admin notification for missing Connect (disbursement=collected-refund>0), credit event `deposit_returned_partial` |
| 9 | Full refund (disbursement=0) | no Connect notification (early-return when disbursement≤0), `deposit_returned_full` event |
| 10 | Gap branch | status=sent_gap, positive-amount DEPOSIT row, `gap_charge_failed=TRUE` (no Stripe customer), `deposit_returned_zero` + `tenancy_ended_with_balance` events |
| 11 | Zero branch | deposit==deductions, no refund or gap payment rows, `deposit_returned_zero` event |
| 12 | S180 sweep at finalize | unpaid payment flips to `paid_via_deposit`, refund_amount recomputed live |
| 13 | Re-finalize rejection | second call throws "already finalized" |
| 14 | held_by='landlord' (legacy) | landlord-disbursement notification skipped — landlord already holds the funds |

## Decisions made during build

| Question | Decision |
|---|---|
| How to skip real Stripe calls without mocking | **Route through no-credentials fallback branches.** `fireLandlordDisbursementTransfer` short-circuits to admin notification when `users.stripe_connect_account_id IS NULL`; `attemptGapAutoCharge` short-circuits to `gap_charge_failed` when `tenants.stripe_customer_id IS NULL`. Both checks happen BEFORE any Stripe SDK call, so leaving those columns null gives a Stripe-free test path that still exercises the surrounding workflow. Matches the pre-launch state (no Connect accounts yet) so the assertions reflect real-world day-1 behavior, not a contrived test fiction. |
| `withRollback` vs explicit cleanup for this suite | **Explicit cleanup.** `calculateDepositReturn` and `finalizeDepositReturn` use the singleton `db` pool internally for their queries; a separate-client transaction wouldn't be visible to them. Each test seeds via the singleton (commits immediately), then `beforeEach(cleanupAll)` wipes the 16 tables this suite touches. Allocation tests keep their withRollback pattern because `executeRentAllocation` takes a `client` parameter — different injection model, different test strategy. |
| Test order of cleanup tables | FK-dependency order, children before parents: credit_events → credit_subjects → admin_notifications → deposit_returns → security_deposits → payments → lease_fees → lease_tenants → leases → units → property_allocation_rules → properties → landlords → tenants → users. |
| Partial-refund test design | Used `depositTotal: 500, cleaningFeeAmount: 100` so that disbursement = collected (500) - refund (400) = 100 — non-zero. This pins that the Connect-missing notification fires only when there's actually something to disburse. Full-refund test pairs with it to verify the `disbursement ≤ 0 → no notification` short-circuit. |
| Re-fetch refund inside finalize | The "S180 sweep at finalize" test creates the draft with `refundAmount: 500` (matching deposit), THEN seeds an unpaid payment, then finalizes. Finalize's live re-pull recomputes refund=350 and unpaid_balance=150. Pins the S180 re-pull semantic — drafts can go stale, finalize is the source of truth. |

## Files touched (S267)

```
apps/api/src/test/dbHelpers.ts                 (~ +120 lines — 5 new
                                                 factories for the
                                                 lease + deposit stack)
apps/api/src/services/depositReturn.test.ts    (new — 365 lines, 14
                                                 cases)
DEFERRED.md                                    (~ deposit-return
                                                 tombstoned with
                                                 workflow-only caveat)
SESSION_267_HANDOFF.md                         (this file)
```

## Verification

- `cd apps/api && npm test` → 30/30 passing
  (16 allocation + 14 deposit-return). 5.9s test time for the new
  suite, 13.5s end-to-end including suite setup.
- `cd apps/api && npx tsc -b` → clean.

## Carry-forward — S268+

Per S265 list, in order of remaining critical-path coverage:

1. **Rent webhook handler.** `routes/webhooks.ts`, `payment_intent.succeeded`
   path. Bigger surface: signed-event construction needs a mock
   (either hand-rolled raw-body crafting + stubbing
   `stripe.webhooks.constructEvent`, or `vi.mock('stripe')`).
   Plus transitive dependencies on supersedence + stripeConnect
   services. ~1.5–2 sessions.
2. **POS sync queue.** `apps/pos/src/lib/syncQueue.ts`. Its own
   Vitest config in `apps/pos` with `jsdom` + `fake-indexeddb`. No
   server-side state.
3. **Lease lifecycle integration.** Sign → move-in invoice →
   monthly invoice cron → late-fee on grace expiry. Needs fake
   clock + timezone control + multiple service collaborators.

### Real-money-movement gap

The workflow-only deposit-return suite pins the fallback paths.
What it does NOT pin:
- `stripe.transfers.create` actually fires with the right
  amount/destination/metadata when the landlord has a Connect
  account.
- `stripe.paymentIntents.create` fires correctly when the tenant
  has a Stripe customer id.

That's by design at this stage. The complementary tests should
land alongside Stripe live-keys cutover (per launch order step 7
in DEFERRED), with `vi.mock('../lib/stripe')` and assertions on
the call args. Captured as a future-suite note here so it doesn't
fall off the radar.

### Vendor-blocked (unchanged)

- Checkr Partner credentials pending.
- FlexCredit (CredHub + Esusu) pending.

---

End of S267 handoff.
