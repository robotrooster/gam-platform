# Session 103 Handoff

**Theme:** Retention/prune cron for `email_send_log`. Tiny backend
hardener that follows up the S101+S102 logging build by keeping the
table from growing unboundedly. Daily 4am Phoenix prune; sent rows
decay at 90 days, failed rows survive 365 days for audit.

## Architecture decisions

**Two retention windows, not one.** Sent rows are operational
ephemera — once a delivery confirmation is a quarter old, nobody is
investigating it. Failed rows carry audit weight, especially the
adverse-action category (FCRA-adjacent). Splitting the windows lets
the table stay small without losing the rows that actually matter
for compliance review.

**90 / 365 days.** Sent at 90: well past any reasonable "did this
email actually go out last month?" investigation horizon, comfortably
short of the table-bloat regime. Failed at 365: covers annual review
windows; FCRA's strict 5-year retention requirement only attaches to
the actual adverse-action notice records (in `adverse_action_notices`,
not here), not the email-send log row.

**Defensive 10k-per-status-per-run cap.** PostgreSQL `DELETE` doesn't
support `LIMIT` directly, so the prune uses `DELETE WHERE id IN
(SELECT … LIMIT 10000)`. In steady state each daily run deletes the
rows that crossed the threshold yesterday — typically tens to low
hundreds. The cap exists for the historical-backlog case (long
outage that left the prune un-run for weeks) — subsequent daily
runs catch up automatically without ever pinning the table.

**4am Phoenix slot.** Sits between the 3:30am POS EOD and the 7am
invoice-gen runs. No overlap with other engines; light load.

## Shipped

### apps/api/src/jobs/scheduler.ts

- New top-level `pruneEmailSendLog()` function. Two `DELETE WHERE id
  IN (SELECT … LIMIT 10000)` statements, one per status, with the
  appropriate retention threshold. Catches its own errors so a prune
  failure can't take down the scheduler. Logs `[email-prune]
  sent=N failed=M` only when at least one row was deleted (silent
  on no-op runs, matching the EOD pattern).
- `cron.schedule('0 4 * * *', pruneEmailSendLog, { timezone:
  'America/Phoenix' })` registration.

## Files touched

- `apps/api/src/jobs/scheduler.ts` (one new function + one cron line)
- `SESSION_103_HANDOFF.md` (this file)

No migrations, no schema changes, no other file edits.

## Validation

- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- Smoke walk against dev DB: seeded 9 rows
  (3 old sent / 2 old failed / 2 fresh sent / 2 fresh failed), ran
  the same `DELETE … WHERE … LIMIT` SQL the production function uses,
  confirmed: pruned 3 sent + 2 failed; 4 rows remained (the 4 fresh).
  Cleanup left the table empty.

## What this session did NOT do

- **No production smoke** — the cron fires at 4am Phoenix daily; first
  fire after deploy will exercise it for real. Until the table holds
  rows past the retention window, every run is a no-op (silent).
- **No retention policy on `adverse_action_notices`** — that table
  has FCRA implications and a separate retention requirement
  (typically 5 years). Out of scope; flag for a separate compliance
  review session if Nic wants it formalized.
- **No retention work on other log-shaped tables** (`admin_action_log`,
  `platform_events`, `pos_inventory_log`, etc.). Each has its own
  growth curve and audit requirements; none are urgent. Could batch
  in a future "log retention pass" session.

## Pre-launch blockers still open

Same as S100/S101/S102:
- Item 16 batch 2 — bank ACH origination provider.
- Item 16 batch 3+ — OTP enablement (FlexPay SetupIntent).
- Item 10 (S90) payment integration — gated on Item 16 batch 2.

## What next session should target

1. **Item 16 batch 2 — bank ACH origination provider**, when the rail
   call is made.
2. **lease_fees.due_timing='move_out' / 'other' wire-up** — needs
   product decision on whether to build a move-out invoice generator
   or strip the unused enum values.
3. **Frontend pass for email failures** — wire the two endpoints
   into a dashboard card on landlord + a panel in admin ops. UI
   session.
4. **Log retention pass for sibling tables** (`admin_action_log`,
   `platform_events`, `pos_inventory_log`, etc.) — batch the same
   retention pattern across the audit-log family. Each table needs
   a per-table policy decision; quarter-day session.
