-- S616 (Nic) — what Stripe actually charged, stored.
--
--   "I paid two real dollars two separate times. Actually, it was two dollars
--    and thirty three cents, and then it was eight dollars, between testing card
--    charge and ACH charge... we're not seeing money processed on the admin
--    portal... are we just tracking the rent volume and not the stripe charge
--    volume?"
--
-- Yes, we were, and nothing on GAM's side recorded otherwise. Both his payments
-- stored $2.00 — the rent obligation — while Stripe charged $2.33 (card: $2.00
-- + $0.33) and $8.00 (ACH: $2.00 + $6.00). The processing fee was computed at
-- charge time, sent to Stripe, and then discarded.
--
-- The consequence is bigger than a wrong chart: NOTHING COULD RECONCILE. Stripe
-- says $10.33 moved; GAM says $4.00 of obligations; no record bridged them, so
-- there was no way to tell a missing payment from a fee difference from a bug.
-- On a platform whose whole job is moving other people's money, that is the
-- number you must be able to tie out.
--
-- Stored on tenant_remittances because that is already ONE ROW PER STRIPE
-- CHARGE — the obligation-to-money boundary. payments cannot hold it: a single
-- charge settles many payment rows FIFO, so a fee stored there would have to be
-- split or duplicated, and either way stops matching the one figure Stripe has.
ALTER TABLE tenant_remittances
  ADD COLUMN IF NOT EXISTS gross_amount           numeric(12,2),
  ADD COLUMN IF NOT EXISTS processing_fee_amount  numeric(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN tenant_remittances.gross_amount IS
  'S616: what Stripe actually charged the tenant — the obligation plus any '
  'processing fee they bear. NULL on rows written before S616, which is why it '
  'is nullable: a backfilled guess would be indistinguishable from a real '
  'figure, and the point of this column is being able to tie out.';
COMMENT ON COLUMN tenant_remittances.processing_fee_amount IS
  'S616: the processing fee the TENANT bore on top, which is zero when the '
  'property routes the fee to the landlord. gross_amount − this = the '
  'obligation collected.';
