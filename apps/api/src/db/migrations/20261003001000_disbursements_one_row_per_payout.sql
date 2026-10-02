-- S655 review — one payout, one row.
--
-- disbursements.stripe_payout_id had no unique index. Two writers file the same
-- Stripe payout: the weekly payout run (jobs/autoPayouts.ts, right after it
-- fires the payout) and the Connect webhook / nightly sync
-- (services/connectPayoutSync.fileConnectPayout, which files any payout it
-- hears about as 'stripe_dashboard' when no row exists yet). Each looked first
-- and then inserted, so when the two interleaved one payout got two rows. The
-- second row linked no transfers, so its breakdown showed the whole amount as
-- "Not traced to a payment GAM moved" and raised an admin gap notice.
--
-- With this index both inserts use ON CONFLICT (stripe_payout_id): the payout
-- run claims a row the webhook filed first, and the webhook leaves a row the
-- payout run filed first alone (then updates its status and bank).
--
-- Partial: GAM-internal rows (OTP-era schedules, seeds) carry no payout id.
--
-- Production checked read-only on 10/2: 3 rows carry a stripe_payout_id, all
-- distinct — no duplicates to clean up first. If this ever fails to build, find
-- them with:
--   SELECT stripe_payout_id, count(*) FROM disbursements
--    WHERE stripe_payout_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
--
-- Additive (expand). Safe before the code deploy: the running build only ever
-- writes a second row for a payout id in exactly the race this stops. There,
-- its plain insert now fails with a duplicate-key error instead (both callers
-- catch and log it: the payout run counts that entity's run as failed though
-- the payout went, the webhook leaves it to the nightly sync) and the row the
-- other writer filed stands. No backfill.
CREATE UNIQUE INDEX IF NOT EXISTS uq_disbursements_stripe_payout_id
  ON disbursements (stripe_payout_id) WHERE stripe_payout_id IS NOT NULL;

COMMENT ON INDEX uq_disbursements_stripe_payout_id IS 'S655: one disbursements row per Stripe payout. autoPayouts and connectPayoutSync both insert with ON CONFLICT (stripe_payout_id).';
