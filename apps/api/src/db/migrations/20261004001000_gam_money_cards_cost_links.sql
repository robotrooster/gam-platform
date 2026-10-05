-- 10/3 (Nic: "Is that actually accurate?") — the admin money cards.
--
-- Two facts the cards need and the database did not keep, and one index the
-- cards' reads need. All expand-only: nullable / derived columns and an index,
-- no constraint that old code could trip, so the running build keeps working
-- before the code that reads them ships.
--
-- 1. stripe_processing_costs.stripe_payment_intent_id
--    A bank payment's Stripe fee is the `fee` on that payment's own balance
--    transaction (0.5% capped $3 — $2.33 on Mireya Fierro's $466), stored here
--    as a 'bank_debit_fee' row. Nothing tied the row to the payment it came
--    from, so the Processing Margin card could not:
--      - show what Stripe took on each payment (the per-payment list), or
--      - keep the fee of a bank payment that is still clearing out of the
--        month's costs while its $6 is, by Nic's rule (10/3), not yet earned —
--        on 10/3 the card counted $5.15 of Stripe fees on Fierro's and Randall
--        Cox's clearing payments against no revenue at all.
--    The nightly sync (services/stripeCosts.syncStripeCosts) now records the
--    PaymentIntent of the charge each fee row came from. NULL for the daily
--    card aggregates (they belong to a whole day's volume, never one payment).
--    Backfill: the six bank-fee rows in production are linked by
--    scripts/oct3_gam_money_card_data.ts (from the 10/3 Stripe pull); the sync
--    fills any row it sees again within its lookback.
--
-- 2. platform_transfer_intents.gam_fees_kept_amount
--    The weekly payout nets what a landlord owes GAM out of the money on its
--    way to them (services/landlordPassthrough reserve: transfer = gross owed −
--    reversals netted − GAM charges taken). The record kept the gross, the
--    reversals and the transfer, but not the GAM charges taken — Mountain View's
--    Sep 21 payout (intent 5c65eec4) shows $495 owed and $413 sent, and the $82
--    September platform fee kept back could only be inferred. It is now stored,
--    as exactly that identity, so no writer can ever leave it out or get it
--    wrong. Backfills itself (generated column): 5c65eec4 reads $82.00, every
--    other payout so far $0.00.
--    What it is, exactly (10/4 review): the GAM charges (landlord_gam_charges)
--    netted from this payout, and nothing else. GAM fees carried as negative
--    payout lines (held_payout_items: a fee the landlord covers on a payment
--    made with credit, Stripe's kept fee on a refund or a dispute) are already
--    netted inside gross_owed and are listed as their own lines; a business
--    payout's gross_owed is its amount, so it reads $0 here. Not "everything
--    GAM kept back".
ALTER TABLE stripe_processing_costs ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;

CREATE INDEX IF NOT EXISTS idx_stripe_costs_payment_intent
  ON stripe_processing_costs (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

COMMENT ON COLUMN stripe_processing_costs.stripe_payment_intent_id IS
  '10/3: the PaymentIntent of the charge this fee came from (bank-payment and per-charge card fees only; NULL for daily card aggregates and monthly charges). Ties a bank payment to what Stripe took on it.';

ALTER TABLE platform_transfer_intents
  ADD COLUMN IF NOT EXISTS gam_fees_kept_amount numeric(12,2)
  GENERATED ALWAYS AS (gross_owed - netted_amount - amount) STORED;

COMMENT ON COLUMN platform_transfer_intents.gam_fees_kept_amount IS
  '10/3: the GAM charges (landlord_gam_charges: platform fee, bank-debit cost) netted from this payout: gross owed less reversals netted less the amount sent. GAM fees carried as negative payout lines (held_payout_items) are inside gross_owed and listed as their own lines, not here. Mountain View 2026-09-21: $82.';

-- 3. payments by PaymentIntent (10/3 review, pass 2)
--    Both cards read the fee a landlord covers on a tenant's payment from the
--    banking spreads booked on the bill lines that PaymentIntent paid
--    (services/stripeCosts remittanceFeeColumnsSql: platform_revenue_ledger
--    JOIN payments ON payments.stripe_payment_intent_id = the remittance's),
--    once per remittance — over every settled remittance ever on each admin
--    Overview load. payments had no index on stripe_payment_intent_id, so each
--    remittance seq-scanned payments: remittances × payments, slow at the 11k-
--    unit scale. Partial (most bill lines carry no PaymentIntent). No backfill.
CREATE INDEX IF NOT EXISTS idx_payments_stripe_payment_intent
  ON payments (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
