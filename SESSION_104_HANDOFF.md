# Session 104 Handoff

**Theme:** Log-retention pass for sibling tables. Extends S103's
`pruneEmailSendLog` pattern to four operational log-shaped tables.
Folds both prune functions into a single 4am Phoenix cron callback so
the daily-prune block is self-contained.

## Architecture decisions

**Compliance-sensitive tables deliberately skipped.** Four candidate
tables were inventoried but excluded: `admin_action_log`, `audit_log`,
`bulletin_reveal_log`, `ach_monitoring_log`. Each has legal/compliance
retention implications (ACH NACHA records, admin override audit trail,
PII-unmask audit) where defaulting silently to a 1-year window would
be wrong. Surfaced for explicit Nic decision rather than buried in
this pass.

**Per-read-state windows on notifications.** `notifications` and
`tenant_notifications` both prune in two passes. Read rows decay at
180 days (UI clutter past 6 months — landlord/tenant has dismissed).
Unread rows survive 365 days (almost always abandoned by then, but
keeping them around longer avoids deleting "I'll get to it" backlog).
Mirrors S103's per-status approach for `email_send_log`.

**One cron, sequential prune calls.** Combined `pruneEmailSendLog` +
`pruneOperationalLogs` into one inline arrow at the existing 4am
Phoenix cron slot. Each function catches its own errors so a failure
in one doesn't block the other, and the visual block in scheduler.ts
shows "this is the daily-prune block" at a glance.

**Defensive 10k-per-status-per-run cap.** Same posture as S103. In
steady state each prune call deletes whatever crossed yesterday's
threshold (typically tens to low hundreds of rows). The cap exists
for the historical-backlog scenario where the prune was un-run for
weeks; subsequent days catch up automatically.

## Shipped

### apps/api/src/jobs/scheduler.ts

**New `pruneOperationalLogs()` function** with a small inner helper
`pruneByCondition(label, table, where, days)` that wraps the
`DELETE WHERE id IN (SELECT … LIMIT 10000)` idiom. Six prune calls,
one log line per non-zero deletion summed at the end:

| Table | Filter | Retention |
|---|---|---|
| `notifications` | `read = true` | 180 days |
| `notifications` | `read = false` | 365 days |
| `tenant_notifications` | `read = true` | 180 days |
| `tenant_notifications` | `read = false` | 365 days |
| `platform_events` | `true` | 365 days |
| `pos_inventory_log` | `true` | 365 days |

Output: `[ops-prune] notif_read=N notif_unread=N …` only when at
least one row was deleted; silent on no-op runs.

**Cron registration consolidated.** The S103 single-line cron
becomes a small arrow that calls both prune functions:

```
cron.schedule('0 4 * * *', async () => {
  await pruneEmailSendLog()
  await pruneOperationalLogs()
}, { timezone: 'America/Phoenix' })
```

## Files touched

- `apps/api/src/jobs/scheduler.ts` (one new function + one cron arrow)
- `SESSION_104_HANDOFF.md` (this file)

No migrations, no schema changes, no other file edits.

## Validation

- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- Smoke walk against dev DB seeded across all four tables
  (5 notifications + 5 tenant_notifications spanning the four
  age × read-state cells, 2 platform_events, 0 pos_inventory_log
  because dev has no pos_items). Inline-replayed the production
  prune SQL:
  - `notif_read`        deleted 1 (the old-read row)
  - `notif_unread`      deleted 1 (the >365d unread)
  - `tnotif_read`       deleted 1
  - `tnotif_unread`     deleted 1
  - `platform_events`   deleted 1 (>365d)
  - `pos_inventory_log` deleted 0 (no rows in dev)
  Confirmed survivors: `old unread` (200d, between thresholds),
  `fresh read`, `fresh unread`. Cleanup left zero pollution.

## What this session did NOT do

- **Did not touch the 4 compliance-sensitive log tables.** These need
  Nic's explicit retention policy:
  - `admin_action_log` — admin override audit. Suggested: 5+ years
    or never auto-prune.
  - `audit_log` — generic entity-change trail. Same.
  - `bulletin_reveal_log` — admin PII-unmask audit. Same.
  - `ach_monitoring_log` — NACHA recommends 2 years; many shops
    keep 7 years. Bundled under any future ACH compliance review.
- **No prod smoke** — cron fires at 4am Phoenix daily; first fire
  after deploy is the live exercise. Until each table holds rows past
  its retention window, every run is a no-op (silent).
- **No migration to add explicit retention columns** (e.g.
  `retention_until` per row). Not needed today; current windows are
  table-wide. Per-row retention is a future feature if ever needed.

## Pre-launch blockers still open

Same as S100/S101/S102/S103:
- Item 16 batch 2 — bank ACH origination provider.
- Item 16 batch 3+ — OTP enablement (FlexPay SetupIntent).
- Item 10 (S90) payment integration — gated on Item 16 batch 2.

## What next session should target

1. **Item 16 batch 2 — bank ACH origination provider**, when the
   rail call is made.
2. **Compliance-table retention policy** — short product session
   with Nic to lock retention windows for `admin_action_log`,
   `audit_log`, `bulletin_reveal_log`, `ach_monitoring_log`. Once
   the policy is named, extending `pruneOperationalLogs` to cover
   them is mechanical.
3. **lease_fees.due_timing='move_out' / 'other' wire-up** — needs
   product decision on whether to build a move-out invoice
   generator or strip the unused enum values.
4. **Frontend pass for email failures** — wire the S101+S102
   endpoints into a dashboard card on landlord + a panel in admin
   ops. UI session.
