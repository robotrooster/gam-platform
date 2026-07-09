-- Add PROPANE to the payments.entry_description CHECK (S533).
--
-- Propane tank-fill installments bill as payments rows with
-- entry_description='PROPANE' — the marker drives the late-fee
-- exemption (lateFees.ts ignores invoices whose only unpaid children
-- are PROPANE) and keeps propane distinguishable from metered-utility
-- charges in reporting. Mirrors PAYMENT_ENTRY_DESCRIPTIONS in
-- packages/shared (single-source rule) — extend both together.
-- NACHA-shape compliant (uppercase, ≤10 chars).
--
-- No backfill needed: no existing rows carry the new value.

ALTER TABLE payments DROP CONSTRAINT payments_entry_description_check;
ALTER TABLE payments ADD CONSTRAINT payments_entry_description_check
    CHECK (entry_description = ANY (ARRAY['RENT'::text, 'SUBSCRIP'::text, 'DEPOSIT'::text, 'UTILITY'::text, 'ONTIMEPAY'::text, 'LATEFEE'::text, 'FLEXPAY'::text, 'PROPANE'::text]));
