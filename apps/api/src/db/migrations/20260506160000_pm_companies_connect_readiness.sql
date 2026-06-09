-- S159: pm_companies Connect-account readiness flags.
--
-- recordAccountUpdated (services/stripeConnect.ts) currently only stamps
-- stripe_connect_status_synced_at. To gate acceptPropertyInvitation
-- (services/pm.ts) on bank readiness without a live Stripe round-trip
-- on every accept, we cache the relevant capability flags on the
-- pm_companies row.
--
-- Three separate flags so future surfaces can render granular state
-- ("submitted but not yet verified", "verified but payouts disabled",
-- etc.). Acceptance of an owner_to_pm invitation requires
-- payouts_enabled=true AND details_submitted=true (charges_enabled is
-- nice-to-have but not strictly required — destination charges work
-- as long as the destination can receive transfers).
--
-- Default false. Webhook backfills as accounts onboard. No backfill
-- needed for existing rows since none have shipped yet.
--
-- Same booleans should arguably exist on users for landlord Connect
-- accounts; deferred to a later session — not in S159 scope.

ALTER TABLE pm_companies
  ADD COLUMN connect_charges_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN connect_payouts_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN connect_details_submitted  boolean NOT NULL DEFAULT false;

-- Partial index so the accept-time guard query (joining pm_companies
-- on accepted invitations) can hit a hot index instead of a seq scan
-- when the platform has many PM companies.
CREATE INDEX idx_pm_companies_connect_ready
  ON pm_companies(id)
  WHERE connect_payouts_enabled = true AND connect_details_submitted = true;
