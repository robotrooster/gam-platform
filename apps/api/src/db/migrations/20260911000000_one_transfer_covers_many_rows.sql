-- S640 — ONE PAYOUT COVERS MANY PAYMENTS, AND THE INDEX SAID IT COULD NOT.
--
-- Found firing Mountain View's first real disbursement by hand. Both companies
-- failed with:
--
--   duplicate key value violates unique constraint
--   "idx_user_balance_ledger_stripe_transfer_id"
--
-- That index is from S119, when a Stripe Transfer was fired PER LEDGER ROW for
-- a PM company's cut. One row, one transfer, and unique was right.
--
-- S561/S580 replaced that with the platform-held passthrough: the owed
-- owner-share for a landlord is summed across every settled payment and moved
-- in ONE transfer, whose id is then stamped on each reserved row. Three
-- payments, three rows, one transfer id — which the unique index rejects, and
-- the whole reservation rolls back.
--
-- It has never fired successfully with more than one payment in the batch. The
-- Sep 8 sweep of $589 worked because it happened to be a single payment; the
-- first ordinary month — three residents paying by card — could not have gone
-- out at all, for any landlord on the platform, and the failure surfaces only in
-- the job's error array.
--
-- A plain index keeps the lookups. Idempotency for the passthrough was never
-- this index: it is the `intent:<id>` sentinel plus platform_transfer_intents,
-- and the PM-cut path's "skip rows that already carry a transfer id" works the
-- same either way.
DROP INDEX IF EXISTS idx_user_balance_ledger_stripe_transfer_id;

CREATE INDEX IF NOT EXISTS idx_user_balance_ledger_stripe_transfer_id
  ON user_balance_ledger (stripe_transfer_id)
  WHERE stripe_transfer_id IS NOT NULL;

COMMENT ON COLUMN user_balance_ledger.stripe_transfer_id IS
  'S640: NOT unique. One platform-held passthrough transfer covers every owner-share row in the batch, so a transfer id legitimately repeats across rows.';
