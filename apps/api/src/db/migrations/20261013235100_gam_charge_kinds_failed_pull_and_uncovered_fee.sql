-- 10/12 (Nic) — TWO NEW THINGS A LANDLORD CAN OWE GAM, AND ONE NEW REASON A
-- GAM CHARGE IS TAKEN BACK.
--
-- G1 — "gam eats no fees of failed pulls ever." A bank pull of GAM's fees that
-- fails (refused on the spot, or returned by the bank days later) costs GAM
-- what Stripe charged for it. That cost is now owed by the landlord, at cost,
-- as its own line: kind 'bank_debit_failed_cost' (services/landlordGamDebit).
-- The $6 'bank_debit_cost' line raised for that pull — GAM's price for a
-- transfer that collects — is taken back when the pull fails later, as it
-- already was when Stripe refused it on the spot: void_reason
-- 'bank_debit_failed' (the transfer was made and came back), beside the
-- existing 'bank_debit_not_made' (Stripe refused it outright).
--
-- G5 — a processing fee the landlord covers for the tenant that is bigger than
-- the money GAM holds from that payment (landlord covers the $6 ACH on a $4
-- payment: $2 uncovered). Allocation withholds what it can and the rest is a
-- GAM charge, kind 'uncovered_processing_fee', collected from the next payout
-- or bank pull like every other GAM charge (services/allocation).
--
-- Values match @gam/shared LANDLORD_GAM_CHARGE_KINDS and
-- LANDLORD_GAM_CHARGE_VOID_REASONS.
--
-- Expand-only: both CHECKs only get wider; every row that passes today still
-- passes, and code that never writes the new values is unaffected.
-- No backfill needed.

ALTER TABLE landlord_gam_charges DROP CONSTRAINT IF EXISTS landlord_gam_charges_kind_check;
ALTER TABLE landlord_gam_charges ADD CONSTRAINT landlord_gam_charges_kind_check
  CHECK (kind IN ('subscription', 'manual_payment_fee', 'bank_debit_cost', 'device_installment', 'screening_fee',
                  'bank_debit_failed_cost', 'uncovered_processing_fee'));

ALTER TABLE landlord_gam_charges DROP CONSTRAINT IF EXISTS landlord_gam_charges_void_reason_check;
ALTER TABLE landlord_gam_charges ADD CONSTRAINT landlord_gam_charges_void_reason_check
  CHECK (void_reason IS NULL OR void_reason IN ('bank_debit_not_made', 'screening_payment_taken_back', 'bank_debit_failed'));

COMMENT ON COLUMN landlord_gam_charges.kind IS
  'subscription = the monthly platform fee. manual_payment_fee = a fee on a payment taken outside the platform (history). bank_debit_cost = S651, the $6 price of the bank pull that collects GAM''s fees, its own line. device_installment = a card reader piece. screening_fee = a background check paid inside a stay. bank_debit_failed_cost = 10/12, what a failed or returned bank pull actually cost GAM (Stripe''s fees on it), passed on at cost. uncovered_processing_fee = 10/12, the part of a processing fee the landlord covers that was more than the money GAM held from that payment.';
