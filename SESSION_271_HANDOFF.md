# Session 271 — closed (Webhook `payment_intent.payment_failed` branch)

## Theme

Extends the S270 webhook suite with the NACHA retry decisioning
path. Pins:
- Retryable codes (R01 insufficient funds) → `next_retry_at`
  scheduled 3 days out
- Non-retryable / zero-tolerance codes (R02 closed, R05
  unauthorized) → permanent failure
- Retry cap reached (`retry_count >= 2`) → permanent fallthrough
- Missing return code → permanent (conservative default)
- POS terminal failures → early-return, no DB write
- Terminal failures emit `payment_failed_nsf` credit event

No frontend, no walkthrough.

## Items shipped

### Extended — `apps/api/src/routes/webhooks.test.ts`

7 new cases. The S270 fixture (Stripe mock, email mock, supertest
harness, cleanupAll) carries over verbatim — only the event builder
and seed pattern changed.

New helper: `buildPaymentIntentFailed({ paymentIntentId,
returnCode?, metadata? })` returns the JSON event with a
`last_payment_error.payment_method_details.us_bank_account.return_details.code`
path matching what `services/achRetry.extractReturnCode` reads.
`returnCode: null` omits the entire `return_details` payload so
the helper reaches its "no code" branch.

Inline seed helper `seedPendingPayment({ paymentIntentId,
retryCount?, amount? })` builds the minimal lease/payment stack
(no allocation rule needed — that only matters on settle) and
optionally stamps `retry_count` to test the cap branch.

| # | Case | What it pins |
|---|---|---|
| 1 | R01 retryable | `next_retry_at` not null, no `payment_failed_nsf` emit |
| 2 | R02 non-retryable | permanent failure, `next_retry_at=NULL`, `payment_failed_nsf` emitted to tenant subject |
| 3 | R05 zero-tolerance | permanent failure, no retry scheduled |
| 4 | retry_count=2 (cap) | falls through to permanent UPDATE |
| 5 | Missing return code | conservative default → permanent |
| 6 | POS terminal failure | early-return, payment stays `pending` |
| 7 | Unknown PI id | 200, no side effects |

### Email mock refinement

The S270 mock overrode `sendEmail` (which doesn't exist as an
export). `services/notifications.ts` actually routes through
`sendNotificationEmail` from `services/email.ts` — the new mock
overrides that. Suppresses the Resend 403 stderr spam during the
rent-failed notification path.

## Decisions made during build

| Question | Decision |
|---|---|
| Add a new test file vs extend the existing webhooks.test.ts | **Extend.** Same Stripe mock, same email mock, same supertest harness, same cleanup. Splitting would force duplication or a shared-fixtures module — overkill for 7 cases. |
| Mock `services/achRetry` or seed real return codes? | **Real return codes, real helper.** `ACH_RETURN_CONFIG` in packages/shared is the source of truth for retry classification; mocking it would test only my mock. Build the event payload with the right `return_details.code` and let the real `extractReturnCode` + `decideRetry` run. |
| How to test retry-cap fallthrough | **Pre-stamp `retry_count=2` on the seeded payment.** The webhook's retry UPDATE has `AND retry_count < 2` in its WHERE clause, so the retry path no-ops and the permanent UPDATE catches the row. Test mirrors the production state where two prior retries failed. |
| Should the test seed `lease_id` on the payment? | **No, not necessary.** The failed-branch handler reads payment context (tenant_id, type, amount, due_date) but doesn't traverse the lease for retry decisioning. The notification ctx query joins lease tables but errors are swallowed; missing fields just skip the notify path. |
| Assert on credit event details (failure_code, failure_message) | **Partial — assert event_type emit + that tenant subject exists.** Deeper assertions on `event_data.failure_code` would couple the test to the credit-event payload shape; the existing allocation/deposit-return tests already pin that creditLedger writes work. Here we care that the right event type fires when retries exhaust. |

## Files touched (S271)

```
apps/api/src/routes/webhooks.test.ts    (~ +185 lines — 1 new helper,
                                          1 new describe block with
                                          7 cases, email-mock refinement)
DEFERRED.md                             (~ payment_failed tombstoned;
                                          dispute branches still open)
SESSION_271_HANDOFF.md                  (this file)
```

## Verification

- `cd apps/api && npm test` → 44/44 passing
  (16 allocation + 14 deposit-return + 14 webhook). 14.5s test
  time, 25s including setup.
- `cd apps/api && npx tsc -b` → clean.
- apps/pos unchanged from S268 (15/15 still passing).

### Expected stderr in test output

The S270 allocation-failure test's `webhook payment_intent.succeeded
handler failed: AppError` log persists — intentional. EMAIL ERROR
spam is now gone after the `sendNotificationEmail` mock refinement.

## Carry-forward — S272+

### Webhook follow-on (final slice)

- `charge.dispute.created/updated/closed` — `recordDisputeEvent`
  fires, dispute credit-event emitted, severity-tiered admin
  notification. Smaller than payment_failed but Stripe payload
  shape differs (charge object, not PI). ~30 min.
- Utility payment path (`row.type === 'utility'`) — reuses the
  allocation engine but flips `utility_bills.status='paid'` after.
  Trivial extension to the existing happy-path test. ~15 min.

### Launch list (DEFERRED order)

1. **Sentry on apps/api** — mechanical, ~1 session.
2. **Lease lifecycle integration** — fake clock + multi-service.
   ~2 sessions.
3. **Host pick + deploy config** — needs Nic's call.
4. **Production cron runner** — coupled to host.

### Vendor-blocked (unchanged)

- Checkr Partner credentials pending.
- FlexCredit (CredHub + Esusu) pending.

---

End of S271 handoff.
