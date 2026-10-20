-- 10/20 (Nic): A STAY HAS NO LATE FEE, SO TAKE THE $15 OFF THE TWO LIVE ONES.
--
-- RV 10 and RV 11 at Mountain View RV Ranch were stamped on 10/6 by the
-- register selling a 30+ night stay, and both hold late_fee_enabled = true, a
-- 5-day grace and a $15 flat fee. Nobody ever chose that $15 (Nic, 10/19: "I
-- never set $5 or $15 flat ... I don't know how the $15 ever came to be") — it
-- was a schema DEFAULT on properties.late_fee_* that the old code copied.
--
-- This file first re-stamped them with the park's recorded RV policy, which was
-- the wrong answer. Asked to confirm, Nic went further:
--
--   "It's gone, but they paid when they arrived, so why would there ever be a
--    late fee? Stays are paid ahead of time, so they should never have late
--    fees. It's not the same as a lease. Stays are paid for the duration at the
--    time they show up. That's the whole distinction we made with somebody that
--    didn't want a lease but wanted to stay 6 months. They would have to pay
--    for 6 months all up front."
--
-- So the figure was not merely wrong, the whole idea was: a stay is money in
-- hand on arrival, so there is no debt for a penalty to sit on. Its utilities
-- follow it out — a closing read, then a bill the desk sends as a pay link —
-- and charging a late fee on that penalizes somebody who already paid for
-- every night they had.
--
-- STAYS ONLY. A utility service agreement with a booking behind it is a stay
-- (services/stayTerms createStayAgreement). One with booking_id NULL is the
-- landlord-facing kind — the neighbor GAM supplies power to, with no stay and
-- nothing paid up front, billed month after month — and that one keeps its per
-- (property, unit type) policy exactly as it is. The code now matches this
-- split on the same column.
--
-- WHY THIS IS NOT A REPRICE. S558's rule is that the instrument is the charge:
-- a stamped fee is never changed under a payer who agreed to it. Nothing here
-- was agreed to. The figure was never a decision, and nothing has been billed
-- against it — the WHERE clause REFUSES to touch an agreement carrying any
-- invoice, so if a bill has been issued since this was written, this migration
-- leaves that row alone and the question comes back to Nic instead of money
-- moving quietly.
--
-- NARROW ON PURPOSE. It only touches a STAY agreement that still carries the
-- dead default's exact fingerprint ($15 flat, 5-day grace, no accrual, no cap)
-- and has no invoice. One a landlord or a fixed door stamped is left alone, so
-- this cannot sweep up a real decision.
--
-- No schema change. No backfill of anything else. Idempotent: run twice and the
-- second run matches nothing, because the fingerprint is gone. The change
-- journal (audit_utility_service_agreements) records what each row said before,
-- which is the audit trail for a money column.
--
-- late_fee_initial_type is NOT NULL, so it keeps a value; with no amount behind
-- it the engine writes nothing (jobs/lateFees qualifyingInvoicesSql), which is
-- the same inert no-fee shape lateFeePolicyToAgreementStamp(null) produces.

UPDATE utility_service_agreements sa
   SET late_fee_enabled        = FALSE,
       late_fee_grace_days     = NULL,
       late_fee_initial_amount = NULL,
       late_fee_initial_type   = 'flat',
       late_fee_accrual_amount = NULL,
       late_fee_accrual_type   = NULL,
       late_fee_accrual_period = NULL,
       late_fee_accrual_from   = 'grace_end',
       late_fee_cap_amount     = NULL,
       late_fee_cap_type       = NULL,
       updated_at              = NOW()
 WHERE sa.booking_id IS NOT NULL
   -- The dead default's exact fingerprint, and nothing else.
   AND sa.late_fee_enabled = TRUE
   AND sa.late_fee_grace_days = 5
   AND sa.late_fee_initial_amount = 15.00
   AND sa.late_fee_initial_type = 'flat'
   AND sa.late_fee_accrual_amount IS NULL
   AND sa.late_fee_cap_amount IS NULL
   AND sa.late_fee_accrual_from = 'grace_end'
   -- Nothing has been billed under it. If something has, leave it and ask.
   AND NOT EXISTS (
     SELECT 1 FROM invoices i WHERE i.service_agreement_id = sa.id);
