# Session 125 Handoff

**Theme:** ACH retry notifications. Pairs with S124's NACHA retry
workflow — closes the UX gap where tenants and landlords got nothing
when an ACH payment failed and was either scheduled for retry or
permanently dead.

## Architecture decisions

**Two distinct notify helpers, two distinct messaging tones.**
`notifyAchRetryScheduled` is informational + actionable ("we'll try
again on $date, make sure you have funds"). `notifyAchRetriesExhausted`
is urgent + action-required ("manual intervention needed, contact
landlord or update payment method"). Different subject lines,
different copy, different SMS posture (both send SMS but the
exhausted variant uses GAM URGENT prefix).

**Both fire to tenant AND landlord.** The tenant gets the actionable
copy; the landlord gets info-only on retry (no action needed) or
urgent on exhaustion (manual review needed). Mirrors the existing
`notifyRentFailed` shape from S106 era.

**Notifications routed through `createNotification`** (S106) so they
land in:
- in-app `notifications` row for both users
- email via Resend (with `email_send_log` row written for the failure
  dashboard)
- SMS stub (still console.log per S106 — unblocks when Twilio is
  wired)

**Per-notification permission via existing `notification_preferences`.**
The `createNotification` function (S106) already consults
`notification_preferences` — tenants/landlords who've opted out of
specific notification types won't receive them. Two new types
introduced (`ach_retry_scheduled`, `ach_retries_exhausted` plus
`_info` and `_landlord` variants) — they default to opted-in for
all users (no preference row = `email_enabled=true`).

**Webhook handler does the lookup, helpers stay context-free.** The
`payment_intent.payment_failed` handler queries the joined payment
context (tenant email, landlord email, unit number, etc.) and passes
to the helpers. Keeps the helpers reusable from any failure-firing
path; webhook is the only caller today.

**Notification failure doesn't fail the webhook.** Wrapped in try/catch
that logs but doesn't propagate. Stripe shouldn't retry the whole
webhook just because we couldn't send an email — the payment status
update already succeeded.

## Shipped

### apps/api/src/services/notifications.ts

Two new exports:
- **`notifyAchRetryScheduled(opts)`** — fires when a payment is
  scheduled for retry. Tenant gets full action copy with retry date
  + bank-account-funds reminder; landlord gets short info copy.
  SMS to both.
- **`notifyAchRetriesExhausted(opts)`** — fires when retry cap is
  hit or the failure code is non-retryable. Tenant gets "update
  payment method or contact landlord" with explicit NACHA-2-retry
  explanation; landlord gets urgent "manual intervention required"
  alert. SMS to both with URGENT prefix.

Both go through `createNotification` (S106 → real Resend +
in-app + opt-in respect).

### apps/api/src/routes/webhooks.ts

`payment_intent.payment_failed` handler refactored to:
1. Update payment row + decide retry vs permanent (S124 logic)
2. Query joined payment context (tenant + landlord + unit + property)
3. Fire `notifyAchRetryScheduled` if `willRetry`, else
   `notifyAchRetriesExhausted`
4. Wrap in try/catch — notification failure logs but doesn't fail
   the webhook

Reason text is sourced from `ACH_RETURN_CONFIG[code].description`
when the code is known, or a generic fallback when it's not.

## Files touched

- `apps/api/src/services/notifications.ts` (2 new exports)
- `apps/api/src/routes/webhooks.ts` (notification fan-out from
  payment_failed handler)
- `SESSION_125_HANDOFF.md` (this file)

No migrations, no schema changes (notification_preferences supports
arbitrary type strings, so no enum extension needed).

## Validation

- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- 4-step smoke against dev DB:
  - **A.** `notifyAchRetryScheduled` inserts 2 notifications
    (`ach_retry_scheduled` + `ach_retry_scheduled_info`); writes 2
    `email_send_log` rows with correct categories ✓
  - **A2.** Real Resend send to verified email succeeds; unverified
    address fails with proper `status='failed'` log row (expected in
    dev) ✓
  - **B.** `notifyAchRetriesExhausted` inserts 2 notifications
    (`ach_retries_exhausted` + `ach_retries_exhausted_landlord`); 2
    log rows ✓
  - **B2.** Real Resend send for both notifications fires correctly ✓

Dev DB returned to zero rows post-test.

## What this session did NOT do

- **No admin notification surface.** S110+'s admin notification system
  remains a future build per the existing TODO. Today admin sees
  retry-cap-reached failures only via the existing
  `email_send_log` admin endpoint (S101).
- **No frontend.** Per UI/UX standing rule. The new notification
  types render via the existing in-app notifications endpoint
  the landlord/tenant portals already consume.
- **No SMS provider.** Still console.log stubs per S106. When
  Twilio/Telnyx is wired, these notifications will start firing
  real SMS automatically (the `sendSMS` function is already wired
  through createNotification).
- **No notification_preferences seeding for the new types.** New
  users default to opted-in (no preference row = email_enabled=true).
  If you want tenants/landlords to opt out of these specifically,
  a settings page that writes to `notification_preferences` is the
  surface (frontend pass).

## Pre-launch backend status

Add to closed list:
- ✅ Tenant ACH-failure retry-scheduled notification
- ✅ Retry-cap-exhausted alerting (tenant + landlord)

Open items:
- Sub-permission gating on routes (catalog defined S81)
- Compliance-table retention policy (needs your retention windows)
- lease_fees move_out / other due_timing wire-up (product call)
- OTP enablement (Item 16 batch 3+ — needs FlexPay tier UX)
- Admin notification surface (long-standing deferral)
- Frontend pass for everything backend-ready
- Stripe sandbox testing (waiting on test API key)

## What next session should target

Stripe sandbox testing remains highest-priority when ready. While
waiting:

1. **Sub-permission route gating** (~1 session) — mechanical pass;
   catalog defined S81, enforcement deferred.
2. **Compliance retention policy** — 30 min once you give windows
   for `admin_action_log`, `audit_log`, `bulletin_reveal_log`,
   `ach_monitoring_log`.
3. **Admin notification surface** — long-standing deferral. Building
   it would unlock several TODOs across the codebase that route
   admin alerts through console.error today.

Recommend **#1** as the next pure-backend session — most existing
backend has gates at the role level but not at the sub-permission
level. Closes the auth-surface gap before frontend pass + sandbox
testing.
