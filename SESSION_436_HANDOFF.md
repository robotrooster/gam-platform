# Session 436 — closed

## Theme

**Thirteenth services-audit session. Closes the
`stripeConnect.ts` arc — the webhook recorders.
20 tests pinning the Connect payout event flow
(connect_payouts upsert + S113-Phase4 disbursements
propagation + S175/S176 paid/failed notifications
with user vs pm_company routing) and the Connect
dispute event flow (connect_disputes upsert with
payment-intent + charge object/string handling).**

Suite at S435 close: **2311 / 133 files**.
Suite at S436 close: **2332 / 134 files** (+21 cases,
+1 file). 0 failures. Runtime **75.28s**.
Fortieth consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `services/stripeConnectWebhooks.test.ts` — 20 cases

Both webhook recorders covered end-to-end with real
DB upserts + mocked `./notifications` exports.

**`recordPayoutEvent` — entity resolution (3)**
- Unknown Connect account → silent noop, no insert
- User-owned account: row written with `user_id` set,
  `pm_company_id` NULL
- PM-company-owned account: row written with
  `pm_company_id` set, `user_id` NULL

**`recordPayoutEvent` — idempotency + status updates (3)**
- ON CONFLICT updates status + arrival_date + failure
  on re-fire (one row, latest status preserved)
- `failure_code` + `failure_message` persisted on failed
  status
- Null `arrival_date` supported (Stripe sometimes omits
  it on early events)

**`recordPayoutEvent` — S113-Phase4 disbursements (3)**
- paid → disbursements row flips to 'settled' +
  settled_at stamped
- failed → disbursements row flips to 'failed' +
  failure note appended to `notes` column with
  failure_code + failure_message inlined
- pending → disbursements flips to 'processing'
  (in_transit also maps here per the status map)

**`recordPayoutEvent` — S175/S176 notifications (6)**
- paid + user account → `notifyConnectPayoutPaid`
  fires with userId, email, phone, amount, payoutId
- failed + user account → `notifyConnectPayoutFailed`
  fires with reason + failureCode
- paid + pm_company → `notifyPmCompanyPayoutPaid` fires
- failed + pm_company → `notifyPmCompanyPayoutFailed`
  fires
- Non-terminal status (pending) → NO notification
- Notification throws → swallowed; webhook returns
  successfully; row still gets written

**`recordDisputeEvent` (5)**
- Happy: inserts row with payment_id + landlord_id
  resolved via stripe_payment_intent_id; amount,
  reason, status, evidence_due_by all populated
- `payment_intent` as expandable Stripe object →
  `.id` extracted and resolves to the same payment
- `charge` as expandable Stripe object → `.id`
  extracted into `stripe_charge_id`
- No payment_intent → payment_id + landlord_id both
  NULL (orphan dispute row)
- ON CONFLICT idempotency: status + evidence_due_by
  updated; one row, latest values

## Items shipped

```
apps/api/src/services/
  stripeConnectWebhooks.test.ts         (NEW — 20 cases)
```

No source code changes. Service preserved as-is.

## Decisions made during build

| Question | Decision |
|---|---|
| New file or append to S434/S435? | **New file.** Each S43N stripeConnect slice covers a coherent function family with its own mock shape. Per-file isolation keeps the mock surfaces tight. |
| Pre-clean `disbursements`? | **Yes — required.** disbursements isn't in `cleanupAllSchema` but FKs landlords with RESTRICT; the cleanup's `DELETE FROM landlords` trips the FK without a pre-clean. Same pattern as S424 added for flexpay_advances. |
| Pin the S113-Phase4 disbursements propagation? | **Yes — load-bearing.** The connect_payouts → disbursements status map is the audit chain that surfaces payout state to the landlord dashboard. A regression that drops the propagation would leave disbursements stuck in 'processing' forever. |
| Pin the failure-note append shape? | **Yes.** The note format (`[<timestamp>] stripe payout <code>: <message>`) is the operator's diagnostic surface. A regression that overwrites `notes` instead of appending would erase prior context. |
| Pin the S175/S176 notification fan-out to both user + pm_company paths? | **Yes — symmetric contract.** A PM company has no inherent contact; the staff list IS the addressable audience. A regression that only handled the user path would silently leave PM companies uninformed about payout state. |
| Pin the swallow-on-notification-throw behavior? | **Yes — webhook stability.** A bad notification call can't be allowed to fail the webhook, because Stripe would retry the whole event and overwrite the connect_payouts row repeatedly. The try/catch IS the operational guard. |
| Pin both expandable-object branches for dispute? | **Yes.** Stripe's PaymentIntent + Charge are sometimes returned as strings (id-only) and sometimes as full objects depending on which webhook event fires. A regression that only handled one form would lose the dispute → payment join half the time. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **2332 tests across 134
  files, 0 failures**, 75.28s. **Fortieth consecutive
  fully-green full-suite run.**
- 20 new test cases.
- 0 production regressions.
- 0 new findings — service matches contract.

## Services audit — progress

Post-S436:

### stripeConnect.ts ARC CLOSED — 12/12 functions covered

- S434 (account-management): ensureConnectAccount,
  createOnboardingSession, fetchAccountStatus,
  computeApplicationFee, recordAccountUpdated
- S435 (charges + transfers):
  createRentDestinationCharge,
  createRentPlatformCharge, createPmCompanyTransfer,
  firePmTransfersForReference
- S436 (webhook recorders): recordPayoutEvent,
  recordDisputeEvent
- Previously covered (pre-S434): fireManagerTransfersForReference

### Direct coverage (43 of 43 services ≈ 100% for dedicated files)

Every service file in apps/api/src/services now has
its own .test.ts (or a covered continuation slice).
What remains are **continuation halves** — the
Stripe state-machine paths in otp.ts / flexpay.ts /
flexCharge.ts that were deferred from S425 / S427 /
S431 — plus a handful of smaller helpers worth
sweeping for thoroughness.

### Still UNCOVERED (~13 files post-S436)

Highest-value continuation candidates:
1. **otp.ts Stripe state-machine half** (S427 continuation
   — disbursement firing, OTP success/failure path)
2. **flexpay.ts Stripe state-machine half** (S431
   continuation — advance firing, pull-day processing,
   NSF handling)
3. **flexCharge.ts billing/reconciliation half** (S425
   continuation — monthly statement generation, interest
   accrual, payment posting)
4. **pm.ts invitation lifecycle** (S428 continuation
   — send/accept/reject/revoke/expire)
5. **DB-backed credit-ledger wrappers** (S429
   continuation — record\*Event emitters with real
   subjects + dispute)
6. Plus ~8 smaller helpers (each less than ~150 lines)

## Items deferred — what S437 could target

### Continue services audit

**Recommend S437 = pm.ts invitation lifecycle slice.**
S428 deferred the 5-function send/accept/reject/revoke/
expire chain. It's the next major contract gap and
ships in one session.

**Alternatives:**
- otp.ts Stripe state-machine half (heavy — multiple
  branches; could span 2 sessions)
- flexpay.ts Stripe state-machine half (heavy similarly)
- flexCharge.ts billing half
- Roll through smaller helpers (faster cadence)

### Validation-hygiene backlog (16 items)

Unchanged from S427.

### Cumulative bug-sweep totals (post-S436)

- **47 production bug fixes** (S436 is direct coverage
  of well-built webhook recorders)
- 16 architectural / validation findings remaining
- 2332 tests across 134 files
- Suite baseline: **60-75s on a clean machine**

## What S437 should target

**Recommended: pm.ts invitation lifecycle slice.**
Closes the S428 deferred continuation; ships the
5-function send/accept/reject/revoke/expire chain
in one session.

**Alternatives:**
- otp.ts Stripe state-machine half
- flexpay.ts Stripe state-machine half
- flexCharge billing half

---

End of S436 handoff. **stripeConnect.ts arc CLOSED
at 12/12 functions covered across S434/S435/S436.
20 tests in this slice pin the payout-event upsert,
S113-Phase4 disbursements propagation, S175/S176
paid/failed notifications with user vs pm_company
routing, and the dispute-event upsert with both
expandable-object and string-id handling for
payment_intent and charge.**

2332 tests / 134 files / 0 failures. Fortieth
consecutive fully-green full-suite run.

**47 cumulative production bug fixes shipped across the
bug sweep.** Services audit: 43/43 services with
dedicated coverage files; what remains is
continuation halves on heavy state-machine services
(otp/flexpay/flexCharge) plus the pm.ts invitation
lifecycle.
