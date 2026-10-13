-- 10/12 (Nic) — A GAM CHARGE TAKEN BACK IS VOIDED, NEVER DELETED (ledger design P0, §16.3).
--
-- Keep-everything: GAM never erases money records. Two code paths still
-- hard-DELETEd a landlord_gam_charges row:
--   - services/landlordGamDebit: the $6 cost line of a bank pull Stripe refused
--     on the spot (and it found the row by a ten-minute time window, not by id);
--   - services/stayTerms voidScreeningPrepayment: the landlord-held background
--     check fee when the stay's payment was taken back before the check ran.
-- Production lost one such row on 9/26 (the cost line of the failed pull
-- 64e9c460, whose charge_ids still name it). Both now set voided_at and
-- void_reason instead, and every reader of what a landlord owes skips voided
-- rows (it used to skip them by their absence).
--
-- void_reason values match @gam/shared LANDLORD_GAM_CHARGE_VOID_REASONS.
--
-- Expand-only. No backfill: the deleted row is gone, and nothing else was ever
-- voided.

ALTER TABLE landlord_gam_charges
  ADD COLUMN IF NOT EXISTS voided_at   timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason text;

ALTER TABLE landlord_gam_charges DROP CONSTRAINT IF EXISTS landlord_gam_charges_void_reason_check;
ALTER TABLE landlord_gam_charges ADD CONSTRAINT landlord_gam_charges_void_reason_check
  CHECK (void_reason IS NULL OR void_reason IN ('bank_debit_not_made', 'screening_payment_taken_back'));

-- A void says why, and only a void carries a reason.
ALTER TABLE landlord_gam_charges DROP CONSTRAINT IF EXISTS landlord_gam_charges_void_is_stamped;
ALTER TABLE landlord_gam_charges ADD CONSTRAINT landlord_gam_charges_void_is_stamped
  CHECK ((voided_at IS NULL) = (void_reason IS NULL));

COMMENT ON COLUMN landlord_gam_charges.voided_at IS
  '10/12 (ledger P0): set when GAM takes the charge back (it is then owed by nobody); the row is kept. Readers of what a landlord owes skip voided rows.';
COMMENT ON COLUMN landlord_gam_charges.void_reason IS
  '10/12: why the charge was voided — @gam/shared LANDLORD_GAM_CHARGE_VOID_REASONS.';
