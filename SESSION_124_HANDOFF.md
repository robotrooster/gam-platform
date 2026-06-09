# Session 124 Handoff

**Theme:** ACH retry workflow. NACHA Operating Rules permit up to 2
retries per failed ACH transaction; until S124 a failed
PaymentIntent just set `status='failed'` with no retry path. Closes
the compliance gap before launch.

## Architecture decisions

**Retry-eligibility classification at the return-code level.** NACHA
distinguishes retry-eligible codes (R01 insufficient funds, R09
uncollected funds) from non-retry-eligible (R02 account closed, R03
no account, R04 invalid account — these won't get better with a
retry) and zero-tolerance (R05/R07/R10/R29 — unauthorized debits,
must not retry under any circumstances). The shared
`ACH_RETURN_CONFIG` now carries `retryEligible: boolean` per code
plus the existing `zeroTolerance: boolean`.

**Conservative default for unknown codes.** Stripe may return
non-NACHA failure shapes (first-attempt timeouts, payment-method
issues unrelated to ACH return codes, etc.). `decideRetry` returns
`'permanent'` for unknown codes — better to under-retry than to
hammer Stripe with retries on issues that won't resolve.

**3-day cooldown via calendar days, not business days.** NACHA
recommends ≥1 business day before retry. Implementing
business-day arithmetic in the cron schema would require a holiday
calendar; 3 calendar days is a conservative weekend-safe proxy that
always satisfies the NACHA minimum. Future refinement could use
luxon's business-day skip if the slack matters.

**Optimistic claim before Stripe call.** The cron's atomic
`UPDATE … WHERE retry_count < 2 AND next_retry_at <= NOW()
RETURNING id` claims the row (increments retry_count + nulls
next_retry_at + stamps last_retry_at) BEFORE calling
`stripe.paymentIntents.confirm`. Two concurrent cron runs (rare —
shouldn't happen with one process; defensive) can't double-fire
because the loser's UPDATE matches zero rows.

**Status stays `'failed'` during the retry window.** No
intermediate `'retrying'` state. The webhook deciding "schedule a
retry" only sets `next_retry_at`; status remains `'failed'`. When
the retry actually fires and succeeds, the standard
`payment_intent.succeeded` webhook flips to `'settled'`. When it
fails again, the same `payment_intent.payment_failed` handler
re-classifies (could schedule another retry if retry_count < 2 and
the new code is retry-eligible, or terminate).

**Cron piggybacks on the 4am Phoenix prune block.** Same daily
cadence as email prune + ops log prune + PM transfer
reconciliation. Each handler is failure-isolated; a Stripe API
error in retries doesn't impact the prunes.

## Shipped

### Migration `20260504100000_payments_ach_retry.sql`

Adds two timestamp columns (`next_retry_at`, `last_retry_at`) and a
CHECK constraint capping the pre-existing `retry_count` at 2. New
partial index `idx_payments_ach_retry_due` for the cron scan
(`status='failed' AND next_retry_at IS NOT NULL`).

### packages/shared/src/index.ts

`ACH_RETURN_CONFIG` extended with `retryEligible: boolean` per code.
Added R09 (uncollected funds) classification. Existing
`zeroTolerance` flag preserved; the two flags are independent
(zero-tolerance implies non-retry but the converse isn't true).

### apps/api/src/services/achRetry.ts (new)

Three exports:
- `extractReturnCode(pi)` — pulls the NACHA return code from
  Stripe's `last_payment_error` chain. Defensive against missing
  fields; returns `null` if not resolvable. Uppercase-normalized.
- `decideRetry(returnCode)` — classifier. Returns `'retry'` or
  `'permanent'`. Conservative default on unknown codes.
- `processAchRetries()` — daily cron handler. Scans due rows,
  atomically claims each, calls `stripe.paymentIntents.confirm`,
  returns counts. Cap of 200 retries per run.

### apps/api/src/routes/webhooks.ts

`payment_intent.payment_failed` handler refactored. Reads return
code via `extractReturnCode`; classifies via `decideRetry`. On
`'retry'` AND `retry_count < 2`: schedules `next_retry_at = NOW() +
3 days`. On `'permanent'`: clears `next_retry_at`, status stays
`'failed'`. Both paths stamp `return_code` for audit.

### apps/api/src/jobs/scheduler.ts

The 4am Phoenix prune block now also runs `processAchRetries`
alongside email prune, ops log prune, and PM transfer recon. Same
failure-isolation pattern.

## Files touched

- `apps/api/src/db/migrations/20260504100000_payments_ach_retry.sql` (new)
- `apps/api/src/db/schema.sql` (regenerated)
- `packages/shared/src/index.ts` (ACH_RETURN_CONFIG extension + R09)
- `apps/api/src/services/achRetry.ts` (new — 3 exports)
- `apps/api/src/routes/webhooks.ts` (payment_failed retry decision)
- `apps/api/src/jobs/scheduler.ts` (cron handler addition)
- `SESSION_124_HANDOFF.md` (this file)

Plus a clean rebuild on `packages/shared` (recovered the dist; same
ESM/workspace package issue we've hit a few times mid-rebuild).

## Validation

- `npm run db:migrate` → 1 applied
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- `npm run build` in `packages/shared` → exit 0
- 11-step end-to-end smoke against dev DB:
  - **A.** `decideRetry` correct across all 8 cases (R01, R09 →
    retry; R02, R03, R05, R10, unknown, null → permanent) ✓
  - **B1/B2/B3.** `extractReturnCode` handles null error, nested
    R01 path, case normalization ✓
  - **C1.** Retry-queue scan picks up only the due row (skips capped
    + future-scheduled) ✓
  - **C2.** Atomic claim ✓
  - **C3.** Race-loser claim returns 0 rows (no double-fire risk) ✓
  - **C4.** CHECK rejects `retry_count=3` ✓

Live `stripe.paymentIntents.confirm` deferred to sandbox post-contract.

## What this session did NOT do

- **No live Stripe API exercise.** Schema + classifier + cron
  scheduling all verified in dev DB; the actual confirm call needs
  sandbox testing.
- **No business-day-aware cooldown.** 3 calendar days is the
  approximation. Implementing real business-day arithmetic would
  require a holiday calendar (federal + bank holidays) — separate
  session if that precision matters before launch.
- **No tenant notification on failure.** Today's `sendLatePaymentNotice`
  cron in scheduler.ts emails the LANDLORD when a tenant goes 5+
  days late; equivalent tenant-facing email saying "your ACH
  failed; we'll retry on $date" doesn't exist. Half-session add.
- **No alerting on retry-cap-reached.** When `retry_count` hits 2
  and the second retry also fails, status stays `'failed'`
  permanently. No notification fires to admin/landlord saying "this
  payment is dead, manual intervention needed." Half-session add.
- **No frontend.** Per UI/UX standing rule.

## Pre-launch backend status

Add to closed list:
- ✅ ACH retry workflow (NACHA-compliant, up to 2 retries)

Open items still NOT yet built:
- Sub-permission gating on routes (catalog defined S81)
- Compliance-table retention policy (needs your retention windows)
- lease_fees move_out / other due_timing wire-up (product call)
- OTP enablement (Item 16 batch 3+ — needs FlexPay tier UX)
- Tenant ACH-failure notification (half-session)
- Retry-cap-reached alerting (half-session)
- Frontend pass for everything backend-ready
- Stripe sandbox testing (waiting on test API key)

## What next session should target

Stripe sandbox testing remains highest-priority when ready. While
waiting:

1. **Sub-permission route gating** — mechanical pass; catalog defined
   S81. Touches most route files but each touch is small. ~1 session.
2. **Compliance-table retention policy** — 30 min when you give
   retention windows for `admin_action_log`, `audit_log`,
   `bulletin_reveal_log`, `ach_monitoring_log`.
3. **Tenant ACH-failure notification + retry-cap alerting** — pairs
   with S124, adds the "your retry is scheduled / this payment is
   dead" emails. Half-session.

Recommend **#3** as the natural follow-up to S124 — completes the
NACHA-compliance UX so tenants know what's happening on retry.
