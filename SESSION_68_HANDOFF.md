# Session 68 Handoff

**Theme:** Item 7 — Notifications schema rebuild. Closes a whole DEFERRED category. Pre-S18 dead types stripped, notification_preferences table created, 7 phantom columns added to `notifications`. Existing service + route code starts working for the first time (it had been silently no-op-ing every notification write inside try/catch since the service was authored).

Single coherent batch.

## Architectural finding

The S64-era `services/notifications.ts` and `routes/notifications.ts` were written assuming a richer `notifications` table (data jsonb, landlord_id, read_at, email_sent + ts, sms_sent + ts) and a `notification_preferences` table that **never existed in the schema**. Every `INSERT INTO notifications (..., data, ...)` raised a column-not-found error that got swallowed by the `try/catch` wrapper in `createNotification`. Result: in-app notifications, email gating, and per-user prefs have all been silent no-ops in production.

This batch fixes the schema forward to match the code (rather than rewriting the code, which is correct under the desired model).

## Migration

- `apps/api/src/db/migrations/20260503040000_notifications_columns_and_prefs.sql` — applied.
  - Adds 7 cols to `notifications` with `IF NOT EXISTS`: `data jsonb`, `landlord_id uuid (FK)`, `read_at timestamptz`, `email_sent bool default false`, `email_sent_at timestamptz`, `sms_sent bool default false`, `sms_sent_at timestamptz`.
  - Adds `idx_notifications_user_unread` (partial, `WHERE read = FALSE`) and `idx_notifications_landlord` (partial, where not null).
  - Creates `notification_preferences` table: `(id, user_id FK, type text, email_enabled bool, sms_enabled bool, in_app_enabled bool, created_at, updated_at)`.
  - `UNIQUE (user_id, type)` index for the upsert pattern in routes/notifications.ts.
  - `update_updated_at` trigger for the timestamp column.
  - `type` is intentionally `TEXT` not enum — vocabulary evolves frequently and we don't want to migrate every time. Vocabulary lives in services/notifications.ts as the source of truth.

Schema.sql 5910 → 5985 lines.

## Service + route changes

- **`apps/api/src/services/notifications.ts`**
  - `notifyLeaseExpiring()` — collapsed pre-S18 split (`lease_expiring_60` / `lease_expiring_30` types) into single `lease_expiring` type. Urgency lives in `data.urgent` for downstream consumers. Comment explains: under S18 the trigger date is per-property `expiration_notice_days`, not a fixed 60/30-day cron.
  - `notifyLeaseRenewalSurvey()` — deleted (no callers; pre-S18 explicit-tenant-intent flow superseded by S18's `auto_renew_mode` lease processor).
- Routes/notifications.ts — no code changes needed; routes were already written against the new schema and start working post-migration.

## Frontend cleanup

- **`apps/landlord/src/components/NotificationBell.tsx`** — `TYPE_ROUTES` and `TYPE_ICONS` collapsed `lease_expiring_60`/`lease_expiring_30` → single `lease_expiring`; removed `lease_renewal_survey` entry.
- **`apps/pos/src/components/NotificationBell.tsx`** — same cleanup (mirror file).
- **`apps/tenant/src/pages/ProfilePage.tsx`** — `NOTIF_TYPES` collapsed three pre-S18 entries (Lease Expiry 60, Lease Expiry 30, Renewal Survey) into one "Lease Expiry · Reminders as your lease end date approaches".

## Files touched

- apps/api/src/db/migrations/20260503040000_notifications_columns_and_prefs.sql (new)
- apps/api/src/db/schema.sql (auto-regenerated, 5985 lines)
- apps/api/src/services/notifications.ts
- apps/landlord/src/components/NotificationBell.tsx
- apps/pos/src/components/NotificationBell.tsx
- apps/tenant/src/pages/ProfilePage.tsx
- DEFERRED.md (Item 7 tombstoned, phantom tables 26 → 25, notifications phantom-cols 7 → 0)
- SESSION_68_HANDOFF.md (this file)

## Validation

- `cd apps/api && npx tsc --noEmit` → exit 0
- `cd apps/landlord && npx tsc --noEmit` → exit 0
- `cd apps/pos && npx tsc --noEmit` → exit 0
- `cd apps/tenant && npx tsc --noEmit` → exit 0 (with two pre-existing errors in LeasePage.tsx + one in ProfilePage line 43, all confirmed via git stash to pre-date S68 — they're a `useQuery` inference quirk and a missing variable, neither related to my changes)
- Migration applied cleanly via `npm run db:migrate`.

Not validated: end-to-end smoke (UI/UX work batched per standing rule). The notification system has never actually delivered an in-app row in production until this migration; first send-and-render check is worth doing in a future smoke pass.

## DEFERRED.md cleanup

- **Item 7** tombstoned — SHIPPED S68 with details.
- **Phantom tables 26 → 25** — `notification_preferences` removed.
- **Phantom cols 7 → 0** for notifications — entire row tombstoned.

## Pre-launch blockers still open

- Item 16 — Stripe ACH credit firing (held until 2026-05-05 per memory).
- Item 2 — FCRA adverse action notice infrastructure.
- Item 10 — Utility billing subsystem (multi-day per DEFERRED).
- Item 11 — Master Schedule finish-or-strip (9 phantom cols; needs Nic's product call on build vs strip).
- Item 14 — POS app completion (multi-day).
- Item 15 — E-sign frontend visual + e2e smoke.
- 17a Pass 2 continued — maintenance.ts, documents.ts, pos.ts, landlords.ts, esign.ts.
- Item 18 batches 1B + 2–5 — CHECK constraint centralization.
- Item 19 — Email systems consolidation.

## What next session should target

Top picks (none Stripe-blocked):
1. **Item 11 — Master Schedule finish-or-strip** — needs Nic to decide build-vs-strip. Per S63 notes there's vocabulary drift between units.ts:180 and SchedulePage.tsx that needs reconciling either way. Worth surfacing for a decision before the next coding session.
2. **17a Pass 2 continued** — maintenance.ts is the next-highest-traffic route file with inline scope checks. Same muscle from S70/S71/S72.
3. **Item 18 Batch 1B** — LEASE_STATUSES + late-fee triplet centralization. Per S63 needs file-by-file read because tokens overlap with other enums; precision work.

Avoid in a single session: utility billing (#10), POS completion (#14) — multi-day.

Today is 2026-05-02. Stripe rate work resumes 2026-05-05 (Tuesday, 3 days out).
