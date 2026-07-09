-- Rent remainder rows for propane redistribution (S533).
--
-- ux_payments_rent_idempotent guarantees ONE rent row per (lease,
-- due_date) so invoice/cron generation can't double-bill. Propane
-- redistribution legitimately needs a SECOND rent row for the same
-- cycle: when settle-time priority redirects part of a rent payment to
-- accelerated propane, the uncovered rent comes back as a pending
-- "remainder" row. Mark those rows and exclude them from the
-- idempotency index — generation paths never set the flag, so their
-- one-row guarantee is unchanged.
--
-- No backfill needed: no remainder rows exist before this feature.

ALTER TABLE payments ADD COLUMN is_remainder boolean NOT NULL DEFAULT false;

DROP INDEX ux_payments_rent_idempotent;
CREATE UNIQUE INDEX ux_payments_rent_idempotent
    ON payments (lease_id, due_date)
    WHERE type = 'rent'
      AND status = ANY (ARRAY['pending'::text, 'processing'::text, 'settled'::text])
      AND NOT is_remainder;
