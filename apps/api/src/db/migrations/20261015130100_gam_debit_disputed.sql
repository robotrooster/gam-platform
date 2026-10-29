-- 10/13 — A GAM FEE PULL THE LANDLORD'S BANK DISPUTES: THE FEES ARE OWED AGAIN
--
-- Nic, 10/13: "GAM fee pull disputed by landlord's bank: AUTOMATIC — the
-- disputed fees reopen as owed by the landlord, collected on the next pull,
-- admin told."
--
-- A bank pull of GAM's fees (landlord_gam_debits, S651) that the landlord's
-- bank later disputes (an ACH "unauthorized" return of a pull that had gone
-- through) used to reach the dispute webhook as a charge nobody could place:
-- one admin notice (dispute_charge_unplaced) and nothing else, so the fees the
-- bank took back read as collected and GAM carried them. Now the pull is
-- marked disputed, every fee it collected is owed again (collected_amount
-- comes back down by what this pull took for it) and is collected the usual
-- way — netted from a payout, or on the next pull — and an admin is told.
--
-- A disputed pull is a pull that came back, so Nic's G1 rule for a failed or
-- returned pull applies ("gam eats no fees of failed pulls ever", on a later
-- return alike): the pull's own $6 cost line — GAM's price for a transfer that
-- collects — is voided (reason 'bank_debit_failed', kept on record), and what
-- the pull actually cost GAM — Stripe's fee on the pull and Stripe's dispute
-- fee — is billed to the landlord at cost, as its own GAM charge (kind
-- bank_debit_failed_cost, source 'gam_bank_debit_disputed'). Read from Stripe;
-- when it cannot be read yet, the nightly sweep asks again and an admin is told
-- after three days. Code: services/landlordGamDebit handleGamDebitDispute,
-- billDisputedPullCost, readDisputedPullCosts.
--
-- The pull stays 'succeeded' — it did go through, and its collection records
-- (landlord_gam_charge_collections) stay as written: keep-everything, and the
-- day it paid stays the day it paid. A disputed pull's collection rows no
-- longer count toward their charges' collected_amount: Σ collections of pulls
-- with disputed_at IS NULL (and of payout batches) = collected_amount.
--
-- Expand-only: six nullable columns, two checks that every existing row meets
-- (all are NULL), one partial unique index. No backfill needed — no pull has
-- been disputed on production. Idempotent.

ALTER TABLE landlord_gam_debits ADD COLUMN IF NOT EXISTS disputed_at timestamptz;
ALTER TABLE landlord_gam_debits ADD COLUMN IF NOT EXISTS stripe_dispute_id text;
ALTER TABLE landlord_gam_debits ADD COLUMN IF NOT EXISTS dispute_reopened_amount numeric(12,2);
ALTER TABLE landlord_gam_debits ADD COLUMN IF NOT EXISTS dispute_cost_amount numeric(12,2);
ALTER TABLE landlord_gam_debits ADD COLUMN IF NOT EXISTS dispute_cost_charge_id uuid REFERENCES landlord_gam_charges(id);
ALTER TABLE landlord_gam_debits ADD COLUMN IF NOT EXISTS dispute_cost_read_at timestamptz;

-- Disputed together: when, which dispute, and what came back owed. Only a pull
-- that went through can be disputed.
ALTER TABLE landlord_gam_debits DROP CONSTRAINT IF EXISTS landlord_gam_debits_disputed_shape;
ALTER TABLE landlord_gam_debits ADD CONSTRAINT landlord_gam_debits_disputed_shape
  CHECK ((disputed_at IS NULL) = (stripe_dispute_id IS NULL)
     AND (disputed_at IS NULL) = (dispute_reopened_amount IS NULL)
     AND (disputed_at IS NULL OR status = 'succeeded')
     AND (dispute_reopened_amount IS NULL OR dispute_reopened_amount >= 0));

-- What the disputed pull cost GAM: read once, on a disputed pull only, and
-- billed (a charge) only when it is more than nothing — the shape of
-- failure_cost_* on a failed pull.
ALTER TABLE landlord_gam_debits DROP CONSTRAINT IF EXISTS landlord_gam_debits_dispute_cost_shape;
ALTER TABLE landlord_gam_debits ADD CONSTRAINT landlord_gam_debits_dispute_cost_shape
  CHECK ((dispute_cost_amount IS NULL OR dispute_cost_amount >= 0)
     AND ((dispute_cost_amount IS NULL) = (dispute_cost_read_at IS NULL))
     AND (dispute_cost_read_at IS NULL OR disputed_at IS NOT NULL)
     AND (dispute_cost_charge_id IS NULL OR dispute_cost_amount > 0));

CREATE UNIQUE INDEX IF NOT EXISTS landlord_gam_debits_stripe_dispute_id_key
  ON landlord_gam_debits (stripe_dispute_id) WHERE stripe_dispute_id IS NOT NULL;

COMMENT ON COLUMN landlord_gam_debits.disputed_at IS
  '10/13 (Nic): when the landlord''s bank disputed this pull and took the money back — every fee it collected was made owed again (collected_amount reduced by what this pull took for it), its own $6 cost line voided (Nic G1), and an admin told. The pull stays succeeded and its landlord_gam_charge_collections rows stay as written; they no longer count toward collected_amount. NULL = not disputed.';
COMMENT ON COLUMN landlord_gam_debits.stripe_dispute_id IS
  '10/13: the Stripe dispute that took this pull back (connect_disputes.stripe_dispute_id). Set with disputed_at.';
COMMENT ON COLUMN landlord_gam_debits.dispute_reopened_amount IS
  '10/13: what the dispute made owed again across the pull''s charges (its own $6 cost line is voided instead, not counted here). Set with disputed_at.';
COMMENT ON COLUMN landlord_gam_debits.dispute_cost_amount IS
  '10/13 (Nic G1, "gam eats no fees of failed pulls ever"): what the disputed pull actually cost GAM — Stripe''s fee on the pull plus Stripe''s dispute fee — billed to the landlord at cost. NULL = not read from Stripe yet (the nightly sweep asks again).';
COMMENT ON COLUMN landlord_gam_debits.dispute_cost_charge_id IS
  '10/13: the landlord_gam_charges row (kind bank_debit_failed_cost, source_type gam_bank_debit_disputed) that bills dispute_cost_amount. NULL when it cost nothing.';
COMMENT ON COLUMN landlord_gam_debits.dispute_cost_read_at IS
  '10/13: when dispute_cost_amount was read from Stripe. NULL = not read yet.';
