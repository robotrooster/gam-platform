-- 10/13 — TWO NEW REASONS A GAM CHARGE IS TAKEN BACK: A DISPUTE GAM WON, AND
-- A DISPUTE'S COST RE-BILLED
--
-- Nic, 10/13 (afternoon): "Won GAM pull dispute: AUTOMATIC (back to collected;
-- anything collected twice credited back). Dispute fee unknown → bill $15."
--
-- What a disputed GAM fee pull cost GAM (kind bank_debit_failed_cost, source
-- 'gam_bank_debit_disputed', 20261015130100) is billed to the landlord at
-- cost. Two things now take that charge back (voided, kept on record —
-- services/landlordGamDebit rebillDisputeCost, migration 20261015180000):
--   dispute_won            — Stripe decided the dispute for GAM: the dispute's
--                            cost charge is taken back (what Stripe kept of its
--                            fee, if anything, is billed again on its own)
--   dispute_cost_rebilled  — the charge replaced by a new one at the corrected
--                            amount: Stripe stated its dispute fee after $15
--                            (its usual fee) had been billed in its place
--
-- Values match @gam/shared LANDLORD_GAM_CHARGE_VOID_REASONS
-- (db/migrations.gamChargeCollections.test.ts holds them equal).
--
-- Expand-only: the CHECK only gets wider; every row that passes today still
-- passes, and code that never writes the new values is unaffected. No
-- backfill needed. Idempotent.

ALTER TABLE landlord_gam_charges DROP CONSTRAINT IF EXISTS landlord_gam_charges_void_reason_check;
ALTER TABLE landlord_gam_charges ADD CONSTRAINT landlord_gam_charges_void_reason_check
  CHECK (void_reason IS NULL OR void_reason IN ('bank_debit_not_made', 'screening_payment_taken_back', 'bank_debit_failed',
                                                'dispute_won', 'dispute_cost_rebilled'));
