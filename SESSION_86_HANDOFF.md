# Session 86 Handoff

**Theme:** Backend landmine removal. Three runtime footguns identified
in the S85 audit, all defused: pm_companies/pm_fee_plans references in
reports.ts, the otpScheduler cron crashing on first fire, and seven
stub crons in scheduler.ts that either did pure log statements or
faked credit without payment.

## Architecture decision recorded

**PM subsystem is fully retired.** Item 13 already declared it
superseded by 16a, but reports.ts kept three orphan SQL sites. They're
all gone now — `pmInfo`/`pmPlan`/`pmFee` keys remain in response shapes
as `null`/`0` constants so the frontend doesn't need a shape change.
The dead `/api/reports/pm-client` endpoint (no callers) was deleted
outright.

**OTP scheduler stays disabled.** Two compounding schema breaks made
it a runtime crash on first fire:
- `JOIN units u ON u.tenant_id = t.id` — column dropped when
  lease_tenants/v_unit_occupancy landed.
- `INSERT INTO disbursements (landlord_id, scheduled_date, unit_count,
  type, notes)` — pre-S64 shape; current 16a-era table has user_id +
  bank_account_id + trigger_type instead.

The export remains so any future re-enable site can find it. The call
in `index.ts:144` is removed. Re-enable when Item 16 batch 3+ wires
real OTP infra (SetupIntent enrollment + disbursement firing rail).

**Scheduler.ts cron-pruning policy.** Crons that were pure
`console.log` bodies got deleted with a comment block explaining why
and pointing at the rebuild owner. Crons that actually moved data
without ever calling Stripe (FlexDeposit, FlexPay) were also deleted —
they granted credit without payment, which is worse than no cron at
all. Crons against phantom tables (FlexCharge → flex_charge_accounts)
were deleted to prevent "relation does not exist" errors at first fire.

## Shipped

### apps/api/src/routes/reports.ts
- Two sites that built `pmInfo`/`pmPlan` from queryOne against
  pm_companies/pm_fee_plans → constants `null`. Response shape
  preserved.
- `pmFee` calculation block in tax-summary deleted (pmPlan was always
  null, so the if-block was dead). `pmFee = 0` constant.
- Entire `GET /api/reports/pm-client` endpoint deleted (52 lines). No
  callers anywhere in the codebase; the LEFT JOIN against missing
  pm_companies/pm_fee_plans tables would throw before the
  `if (!landlord?.pm_company_id)` check could catch it.

### apps/api/src/index.ts
- `scheduleOtpCron` import + call removed. Replaced with a comment
  pointing at services/otpScheduler.ts header for re-enable
  instructions.

### apps/api/src/services/otpScheduler.ts
- Header comment rewritten to explicitly document DISABLED status,
  the two schema breaks, and the rebuild path. Code body unchanged.

### apps/api/src/jobs/scheduler.ts
- Deleted 7 stub crons (~100 lines): 28th rent collection, OTP SLA,
  reserve fund contribution, FlexDeposit installment pulls, utility
  billing, FlexPay daily pull, FlexCharge daily pull. Each deletion
  block carries a comment explaining why and which DEFERRED item
  rebuilds it.
- Late-detection email TODOs (sendOnTimePayInvitation,
  sendLatePaymentNotice) re-tagged with explicit S86 follow-up
  pointers — the templates were ported in S85 but consumers weren't
  wired. Bounded follow-up.
- Boot summary console.log block trimmed to match what's actually
  scheduled (8 crons remaining vs the previous 15-line list claiming
  things that no longer ran).

## Files touched

- apps/api/src/routes/reports.ts (3 PM-removal edits + endpoint delete)
- apps/api/src/index.ts (scheduleOtpCron import + call removed)
- apps/api/src/services/otpScheduler.ts (header comment rewrite)
- apps/api/src/jobs/scheduler.ts (7 cron deletions + summary trim +
  email TODO re-tag)
- SESSION_86_HANDOFF.md (this file)

## Validation

- `cd apps/api && npx tsc --noEmit` → exit 0
- `psql gam -c "SELECT 1 FROM pm_companies"` still errors (expected —
  the table never existed; the route refs that hit it are gone)
- scheduler.ts went from 681 → 513 lines (24% reduction); the 8 cron
  list now matches actual schedule.

## What this session did NOT do

- **No re-enabled OTP infra.** Disabled, not fixed. Belongs in Item 16
  batch 3+.
- **No email wiring for late detection.** Two TODOs re-tagged as S86
  follow-ups; doable in a small bounded session. Templates are ready.
- **No phantom-table rebuilds.** POS (11 tables), Maintenance (5),
  FlexCharge (2), Work-trade (3), utility_bills, books_access — all
  still missing. The S81 perm gates I shipped on those routes still
  work, but the underlying tables aren't there.
- **No FCRA adverse action work.** Item 2 still zero infra.

## Pre-launch blockers still open

- Item 2 — FCRA adverse action notice infrastructure.
- Item 3 — Books rebuild (books_access + AZ-genericize + 5 broken
  endpoints).
- Item 5 — Maintenance subsystem (5 phantom tables).
- Item 6 — Work-trade subsystem (3 phantom tables).
- Item 10 — Utility billing subsystem.
- Item 11 — Master Schedule finish-or-strip.
- Item 14 — POS app completion (11 phantom tables).
- Item 16 batch 2 — bank ACH origination provider selection (your call).
- Item 16 batch 3+ — OTP enablement (FlexPay SetupIntent), pi_* audit.

## What next session should target

Top picks for S87:

1. **Item 2 — FCRA adverse action notice infrastructure (recommended).**
   Bounded pre-launch task, no external dependencies. Schema migration
   for `adverse_action_notices` table (CRA name/address/phone, date,
   notice_text). Insertion at PATCH `/background/:id/decision` when
   status='denied'. Email template + delivery via the Resend sender.
   Half-day session.
2. **Wire the late-detection email TODOs.** Connect
   sendLatePaymentNotice + sendOnTimePayInvitation in scheduler.ts to
   the data the SELECT already fetches. Quarter-day cleanup.
3. **Item 5 — Maintenance subsystem.** 5 phantom tables, routes already
   gated in S81, multi-day build.

Recommend **#1**. FCRA is a hard launch blocker (compliance) and the
session is well-scoped — no product decisions beyond approving the
notice template wording.
