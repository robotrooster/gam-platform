-- S160: users Connect-account readiness flags — landlord-side parity
-- with pm_companies (added in S159 migration 20260506160000).
--
-- Reasons identical to the PM-side migration:
--   - cache the Stripe Account.capability flags so gates that need
--     "is this account ready to receive a destination charge?"
--     don't have to live-fetch from Stripe on the hot path
--   - three separate flags so future surfaces can render granular
--     state (submitted vs verified vs payouts-enabled)
--
-- Same population mechanism: services/stripeConnect.ts →
-- recordAccountUpdated webhook handler will populate them on
-- account.updated events alongside the existing
-- stripe_connect_status_synced_at timestamp.
--
-- Default false. No backfill needed — existing landlord Connect
-- accounts will pick up the flags on the next webhook fire (Stripe
-- re-fires periodically; if it doesn't, an admin can trigger via
-- the existing /me/connect/account-status endpoint that will be
-- added in S160).
--
-- Why not consolidate this into a single shared "stripe_connect_status"
-- table? Because the entity-level FK is meaningful: when a user's
-- account is closed, the row should cascade-delete via the user FK.
-- A separate table would either need polymorphic FKs (yuck) or two
-- indirect lookups for every read.

ALTER TABLE users
  ADD COLUMN connect_charges_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN connect_payouts_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN connect_details_submitted  boolean NOT NULL DEFAULT false;

CREATE INDEX idx_users_connect_ready
  ON users(id)
  WHERE connect_payouts_enabled = true AND connect_details_submitted = true;
